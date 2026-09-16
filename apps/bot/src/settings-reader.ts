import type { PrismaClient } from '@prisma/client';
import { SETTING_KEYS, type SettingKey, parseSetting } from '@caseforge/shared';

/**
 * The runtime settings, as the worker sees them.
 *
 * A deliberately smaller twin of the API's SettingsService: the worker is not a
 * Nest application and has no business importing one, but it needs the same
 * values read through the same registry, so that a number an operator types
 * into the panel means exactly what it means on the other side. What it does
 * not have is a writer — the worker only ever reads.
 *
 * The same fifteen seconds of staleness as the API. An operator who lowers the
 * overpay ceiling sees the next withdrawal honour it; one already being bought
 * finishes under the ceiling it started with, which is the honest outcome.
 */
const CACHE_TTL_MS = 15_000;

export class SettingsReader {
  private cache = new Map<SettingKey, unknown>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  // Not a constructor parameter property: the worker runs off the .ts sources
  // under strip-only type removal, which cannot desugar one.
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async read<T>(key: SettingKey): Promise<T> {
    await this.ensureFresh();
    return (this.cache.has(key) ? this.cache.get(key) : parseSetting(key, undefined).value) as T;
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_TTL_MS) return;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async refresh(): Promise<void> {
    const rows = await this.prisma.setting.findMany();
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const next = new Map<SettingKey, unknown>();
    for (const key of SETTING_KEYS) {
      const { value, usedDefault } = parseSetting(key, stored.get(key));
      if (usedDefault && stored.has(key)) {
        console.warn(`[settings] "${key}" is stored but invalid; using the default`);
      }
      next.set(key, value);
    }

    this.cache = next;
    this.loadedAt = Date.now();
  }
}
