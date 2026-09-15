import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type SettingKey,
  SETTING_KEYS,
  parseSetting,
  settingDef,
  validateSetting,
} from '@caseforge/shared';
import { PrismaService } from './prisma.service';

/**
 * How long a value may be stale, in milliseconds.
 *
 * Settings are read on nearly every request — the rate limit, the sell fee, the
 * wheel — and hitting the database each time would be a query per read for data
 * that changes a few times a month. The cache is refreshed wholesale rather
 * than per key, because there are a dozen settings in total and one query for
 * all of them beats a dozen lazy ones.
 *
 * Fifteen seconds is the compromise: an operator who saves a change sees it
 * take hold while they are still looking at the panel, and a write clears the
 * cache anyway, so the delay only ever applies to another instance of the API.
 */
const CACHE_TTL_MS = 15_000;

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<SettingKey, unknown>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Warm on boot so the first request does not pay for the load, and so a
    // malformed row is reported at startup rather than under traffic.
    await this.refresh().catch((err) =>
      this.logger.error(`Could not load settings: ${String(err)}`),
    );
  }

  /**
   * Current value of a setting.
   *
   * Synchronous on purpose: the callers are inside request handlers and even
   * inside transactions, and an await per setting would spread asynchrony
   * through code that has no other reason for it. Freshness is handled by
   * `ensureFresh`, which callers invoke once per request rather than per read.
   */
  get<T>(key: SettingKey): T {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    return settingDef(key).default as T;
  }

  /** Refreshes the cache if it has gone stale. Cheap when it has not. */
  async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_TTL_MS) return;
    // Several concurrent requests finding the cache stale must not each issue
    // their own reload; they all wait on the first one.
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  /** Reads a setting, refreshing first. The convenience form for a handler. */
  async read<T>(key: SettingKey): Promise<T> {
    await this.ensureFresh();
    return this.get<T>(key);
  }

  /** Every setting, for the admin panel. */
  async all(): Promise<Record<SettingKey, unknown>> {
    await this.ensureFresh();
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, this.get(k)])) as Record<
      SettingKey,
      unknown
    >;
  }

  /**
   * Writes a batch of settings.
   *
   * Validated before anything is stored: a half-applied batch would leave the
   * site in a state the operator never asked for. The values that come back are
   * the parsed ones, so the caller writes an audit entry describing what was
   * actually saved rather than what was submitted.
   */
  async setMany(
    entries: Record<string, unknown>,
  ): Promise<{ ok: true; saved: Record<string, unknown> } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    const parsed: Array<{ key: SettingKey; value: unknown }> = [];

    for (const [key, raw] of Object.entries(entries)) {
      if (!(SETTING_KEYS as string[]).includes(key)) {
        errors.push(`${key}: unknown setting`);
        continue;
      }
      const result = validateSetting(key as SettingKey, raw);
      if (result.ok) parsed.push({ key: key as SettingKey, value: result.value });
      else errors.push(...result.errors.map((e) => `${key}: ${e}`));
    }
    if (errors.length > 0) return { ok: false, errors };

    await this.prisma.$transaction(
      parsed.map(({ key, value }) =>
        this.prisma.setting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue },
          update: { value: value as Prisma.InputJsonValue },
        }),
      ),
    );

    // Apply locally at once; other instances pick it up within the TTL.
    for (const { key, value } of parsed) this.cache.set(key, value);
    this.loadedAt = Date.now();

    return { ok: true, saved: Object.fromEntries(parsed.map((p) => [p.key, p.value])) };
  }

  private async refresh(): Promise<void> {
    const rows = await this.prisma.setting.findMany();
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const next = new Map<SettingKey, unknown>();
    for (const key of SETTING_KEYS) {
      const { value, usedDefault } = parseSetting(key, stored.get(key));
      if (usedDefault && stored.has(key)) {
        // A stored value that will not parse is a real problem — it means the
        // site is running on a default the operator did not choose — so it is
        // logged rather than swallowed.
        this.logger.warn(`Setting "${key}" is stored but invalid; using the default`);
      }
      next.set(key, value);
    }

    this.cache = next;
    this.loadedAt = Date.now();
  }
}
