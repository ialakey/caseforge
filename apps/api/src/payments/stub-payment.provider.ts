import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../common/config';
import type {
  CreatePaymentRequest,
  PaymentIntent,
  PaymentProvider,
  WebhookResult,
} from './payment-provider';

/**
 * The demo provider: no money, the whole shape.
 *
 * It exists so the payment path is exercised end to end without a merchant
 * account — a payment is created, the player is sent to a page, a signed
 * webhook comes back and the balance moves. Everything a real adapter has to
 * get right is already here, which is what makes adding one a matter of
 * translating field names rather than designing a flow.
 *
 * The signature is real. A stub that skipped it would let the one endpoint on
 * this site that credits money from an unauthenticated request stay untested,
 * and that is the endpoint least worth discovering a mistake in.
 */
@Injectable()
export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';

  private readonly config = loadConfig();

  isConfigured(): boolean {
    // The stub is only ever available where stub top-ups are: a deployment
    // that has switched them off must not be able to mint balance through a
    // provider whose whole job is to say yes.
    return this.config.ENABLE_STUB_DEPOSITS === true;
  }

  createPayment(request: CreatePaymentRequest): Promise<PaymentIntent> {
    // Our own id doubles as the provider's. A real provider issues its own,
    // which is why the two are separate fields in the first place.
    return Promise.resolve({
      providerRef: request.paymentId,
      redirectUrl: `${request.returnUrl}?payment=${request.paymentId}`,
      providerStatus: 'pending',
    });
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookResult | null {
    const signature = headers['x-signature'] ?? '';
    if (!this.verify(rawBody, signature)) return null;

    let payload: { paymentId?: string; outcome?: string; amount?: number };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      return null;
    }
    if (!payload.paymentId) return null;

    const outcome: WebhookResult['outcome'] =
      payload.outcome === 'succeeded' || payload.outcome === 'failed' ||
      payload.outcome === 'cancelled'
        ? payload.outcome
        : 'unknown';

    return {
      providerRef: payload.paymentId,
      outcome,
      providerStatus: payload.outcome ?? 'unknown',
      amount: payload.amount,
    };
  }

  /** The signature this provider would send, exposed so tests can forge one. */
  sign(rawBody: string): string {
    return createHmac('sha256', this.secret()).update(rawBody).digest('hex');
  }

  private verify(rawBody: string, signature: string): boolean {
    const expected = this.sign(rawBody);
    // Constant-time, and length-checked first because `timingSafeEqual` throws
    // on a length mismatch rather than returning false.
    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  /**
   * The signing key.
   *
   * Derived from the server's JWT secret rather than read from an environment
   * variable of its own: a provider that handles no money does not deserve one
   * more required secret in `.env.example`. Derived and not reused directly —
   * the same bytes signing both sessions and webhooks means a flaw in either
   * use is a flaw in both, and a domain string costs nothing to add.
   */
  private secret(): Buffer {
    return createHmac('sha256', this.config.JWT_ACCESS_SECRET)
      .update('caseforge:stub-payment-webhook')
      .digest();
  }
}
