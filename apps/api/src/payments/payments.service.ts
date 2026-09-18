import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { PromoService } from '../promo/promo.service';
import { loadConfig } from '../common/config';
import type { PaymentProvider } from './payment-provider';
import { StubPaymentProvider } from './stub-payment.provider';

/**
 * Money top-ups, behind a provider port.
 *
 * The site knows about payments; it does not know about any particular payment
 * company. An adapter translates one provider's field names and signature
 * scheme into the two operations this service uses, and everything that
 * follows — the record, the promotion, the ledger entry, the idempotency — is
 * the same whichever adapter answered.
 *
 * One rule shapes the whole of it: **a redirect never moves money.** A player
 * arriving back on the success page has proved they can type a URL. Only a
 * webhook that survives signature verification credits a balance, and it does
 * so exactly once.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly config = loadConfig();
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly promo: PromoService,
    stub: StubPaymentProvider,
  ) {
    // Registered by name. A real adapter is one more line here and one more
    // class beside it; nothing else in the service learns about it.
    this.register(stub);
  }

  private register(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Providers that are actually usable in this deployment. */
  available(): string[] {
    return [...this.providers.values()].filter((p) => p.isConfigured()).map((p) => p.name);
  }

  /**
   * Starts a payment and hands back somewhere to pay.
   *
   * The record is written before the provider is called, so a provider that
   * answers slowly — or not at all — still leaves a row an operator can find.
   * A payment that never gets a `providerRef` is a payment that never started,
   * and that is a different and more useful thing to see than nothing.
   */
  async create(
    userId: string,
    amount: number,
    providerName: string | undefined,
    promoCode: string | null,
  ): Promise<{ paymentId: string; redirectUrl: string }> {
    await this.settings.ensureFresh();
    if (this.settings.get<boolean>('deposits.enabled') !== true) {
      throw forbidden(ErrorCode.DEPOSITS_DISABLED, 'Top-ups are disabled');
    }

    const min = this.settings.get<number>('deposits.min');
    const max = this.settings.get<number>('deposits.max');
    if (amount < min || amount > max) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `A top-up must be between ${min} and ${max}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBanned: true, banReason: true },
    });
    if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
    if (user.isBanned) {
      throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
    }

    const provider = this.pick(providerName);

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        provider: provider.name,
        amount,
        // The promotion is recorded, not applied. What a code is worth is
        // decided when the money actually lands: a bonus credited against a
        // payment that then failed is a promotion nobody paid for.
        promoCode,
        status: 'PENDING',
      },
    });

    try {
      const intent = await provider.createPayment({
        paymentId: payment.id,
        amount,
        currency: this.config.CURRENCY,
        returnUrl: `${this.config.WEB_URL}/profile`,
        description: `Balance top-up`,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef: intent.providerRef, providerStatus: intent.providerStatus },
      });

      return { paymentId: payment.id, redirectUrl: intent.redirectUrl };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: reason, completedAt: new Date() },
      });
      this.logger.error(`Payment ${payment.id} could not be started: ${reason}`);
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'The payment provider is unavailable');
    }
  }

  /**
   * Handles a provider's notification.
   *
   * Returns whether it was understood; the caller turns that into a status
   * code. A notification that fails verification is answered 401 and changes
   * nothing — the one endpoint on this site that credits money without an
   * authenticated caller is not a place to be generous about what it accepts.
   */
  async handleWebhook(
    providerName: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ ok: boolean }> {
    const provider = this.providers.get(providerName);
    if (!provider || !provider.isConfigured()) return { ok: false };

    const result = provider.verifyWebhook(headers, rawBody);
    if (!result) {
      this.logger.warn(`Rejected a ${providerName} webhook: signature did not verify`);
      return { ok: false };
    }

    const payment = await this.prisma.payment.findUnique({
      where: { provider_providerRef: { provider: providerName, providerRef: result.providerRef } },
    });
    if (!payment) {
      // Acknowledged rather than refused: a notification about something this
      // site has no record of is the provider's to stop sending, and a 4xx
      // would only make it retry for a week.
      this.logger.warn(`${providerName} webhook for unknown payment ${result.providerRef}`);
      return { ok: true };
    }

    if (result.outcome === 'unknown') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerStatus: result.providerStatus },
      });
      return { ok: true };
    }

    if (result.outcome !== 'succeeded') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: result.outcome === 'failed' ? 'FAILED' : 'CANCELLED',
          providerStatus: result.providerStatus,
          completedAt: new Date(),
        },
      });
      return { ok: true };
    }

    // A confirmation for less than was asked is not a confirmation. Catching it
    // here is the difference between a short payment and a free balance.
    if (typeof result.amount === 'number' && result.amount < payment.amount) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          providerStatus: result.providerStatus,
          failureReason: `Provider confirmed ${result.amount}, expected ${payment.amount}`,
          completedAt: new Date(),
        },
      });
      this.logger.error(`Payment ${payment.id}: short confirmation, refused`);
      return { ok: true };
    }

    await this.credit(payment.id, result.providerStatus);
    return { ok: true };
  }

  /**
   * Credits a confirmed payment, once.
   *
   * The conditional update is the idempotency: providers retry, and a second
   * delivery of the same confirmation finds the row already SUCCEEDED and does
   * nothing. No separate "processed" flag to keep in step with the status.
   */
  private async credit(paymentId: string, providerStatus: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'SUCCEEDED', providerStatus, completedAt: new Date() },
      });
      if (claimed.count === 0) return;

      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

      // Redeemed here, inside the same transaction as the credit, for the same
      // reason the stub does it: a bonus and the money it was promised against
      // have to succeed or fail together.
      const promo = payment.promoCode
        ? await this.promo.redeem(tx, payment.userId, payment.promoCode, payment.amount)
        : null;
      const bonus = promo?.bonus ?? 0;

      const updated = await tx.user.update({
        where: { id: payment.userId },
        data: { balance: { increment: payment.amount + bonus } },
        select: { balance: true },
      });

      await tx.transaction.create({
        data: {
          userId: payment.userId,
          type: 'DEPOSIT',
          amount: payment.amount,
          balanceAfter: updated.balance - bonus,
          comment: `Payment ${paymentId} (${payment.provider})`,
        },
      });

      if (bonus > 0) {
        await tx.payment.update({ where: { id: paymentId }, data: { bonus } });
        await tx.transaction.create({
          data: {
            userId: payment.userId,
            type: 'BONUS',
            amount: bonus,
            balanceAfter: updated.balance,
            comment: `Promo ${payment.promoCode} on payment ${paymentId}`,
          },
        });
      }
    });
  }

  /** A player's own payments, newest first. */
  async list(userId: string, limit = 20) {
    return this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        provider: true,
        amount: true,
        bonus: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }

  private pick(name: string | undefined): PaymentProvider {
    const usable = [...this.providers.values()].filter((p) => p.isConfigured());
    if (usable.length === 0) {
      throw forbidden(ErrorCode.DEPOSITS_DISABLED, 'No payment provider is configured');
    }
    if (!name) return usable[0]!;

    const chosen = this.providers.get(name);
    if (!chosen || !chosen.isConfigured()) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `Unknown payment provider "${name}"`);
    }
    return chosen;
  }
}
