import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Public } from '../auth/public.decorator';
import { PrismaService } from './prisma.service';
import { PRISMA_READ } from './prisma-read';
import { REDIS_CLIENT } from './redis.module';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSec: number;
  /** Which instance answered. Useful the moment there is more than one. */
  instance: string;
  postgres: { ok: boolean; latencyMs: number | null };
  redis: { ok: boolean; latencyMs: number | null };
  /**
   * Null when no replica is configured. `lagSeconds` is how far behind the
   * primary the replica's last replayed transaction is — the number that says
   * whether a cached report is minutes out of date.
   */
  replica: { ok: boolean; latencyMs: number | null; lagSeconds: number | null } | null;
}

/**
 * What a load balancer polls and what an operator opens first.
 *
 * Deliberately not just `200 OK`: behind a balancer the interesting failure is
 * not a dead process — that stops answering on its own — but an instance that
 * answers while its database is gone or its replica has fallen an hour behind.
 * Both are visible here, and both are reported with a body rather than a status
 * code, because "degraded" must not take the instance out of rotation: a
 * lagging replica is a reason to look, not a reason to stop serving.
 */
@Controller('api/health')
export class HealthController {
  private readonly startedAt = Date.now();
  private readonly replicaConfigured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    // With no replica configured the read client *is* the primary, and probing
    // it twice would report a replica that does not exist.
    this.replicaConfigured = this.read !== (this.prisma as unknown as PrismaClient);
  }

  @Public()
  @Get()
  async check(): Promise<HealthReport> {
    const [postgres, redis, replica] = await Promise.all([
      timed(() => this.prisma.$queryRaw`SELECT 1`),
      timed(() => this.redis.ping()),
      this.replicaConfigured ? this.probeReplica() : Promise.resolve(null),
    ]);

    const report: HealthReport = {
      status: postgres.ok && redis.ok && (replica === null || replica.ok) ? 'ok' : 'degraded',
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      instance: process.env.HOSTNAME ?? 'local',
      postgres: { ok: postgres.ok, latencyMs: postgres.latencyMs },
      redis: { ok: redis.ok, latencyMs: redis.latencyMs },
      replica,
    };
    return report;
  }

  private async probeReplica(): Promise<HealthReport['replica']> {
    const probe = await timed(async () => {
      // Null on anything that is not in recovery — a replica URL pointed at a
      // primary by mistake reports no lag rather than a wrong number.
      const rows = await this.read.$queryRaw<Array<{ lag: number | null }>>`
        SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag
      `;
      return rows[0]?.lag ?? null;
    });

    return {
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      lagSeconds: probe.ok && typeof probe.value === 'number' ? round(probe.value) : null,
    };
  }
}

async function timed<T>(
  probe: () => Promise<T>,
): Promise<{ ok: boolean; latencyMs: number | null; value?: T }> {
  const started = performance.now();
  try {
    const value = await probe();
    return { ok: true, latencyMs: round(performance.now() - started), value };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
