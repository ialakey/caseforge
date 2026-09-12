import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';

/**
 * Scheduled integrity checks. The first and most important is balance
 * reconciliation: User.balance is a denormalised cache and must agree with the
 * sum of transactions. A mismatch means the balance was changed somewhere
 * bypassing the ledger, and that has to surface the same night rather than in
 * a quarterly report.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reconcileBalances(): Promise<void> {
    const mismatches = await this.prisma.$queryRaw<
      Array<{ id: string; balance: number; ledger: bigint }>
    >`
      SELECT u.id, u.balance, COALESCE(SUM(t.amount), 0) AS ledger
      FROM users u
      LEFT JOIN transactions t ON t."userId" = u.id
      GROUP BY u.id, u.balance
      HAVING u.balance <> COALESCE(SUM(t.amount), 0)
    `;

    if (mismatches.length === 0) {
      this.logger.log('Balance reconciliation: no mismatches');
      return;
    }

    for (const row of mismatches) {
      this.logger.error(
        `Balance mismatch for ${row.id}: users.balance=${row.balance}, ledger=${row.ledger}`,
      );
    }
    // This is where a monitoring alert belongs: a balance mismatch is an incident.
  }
}
