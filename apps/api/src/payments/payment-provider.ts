/**
 * What a payment provider has to be able to do.
 *
 * Deliberately two methods. Every provider worth integrating — YooKassa,
 * CloudPayments, a crypto gateway — differs in its field names, its signature
 * scheme and its vocabulary of statuses, and agrees on the shape of the
 * problem: send the player somewhere to pay, then be told whether they did.
 * Everything else belongs inside an adapter.
 *
 * The site never trusts a redirect back from a checkout. A player returning to
 * the success page proves only that they can type a URL; the webhook, with its
 * signature, is the only thing that moves money. That split is the whole reason
 * this interface has a `verifyWebhook` rather than a `confirm`.
 */
export interface PaymentIntent {
  /** The provider's own id, which later webhooks are matched on. */
  providerRef: string;
  /** Where to send the player to pay. */
  redirectUrl: string;
  /** Whatever the provider called the state it started in, for support. */
  providerStatus?: string;
}

export interface CreatePaymentRequest {
  /** Our payment id, passed through so a webhook can name it back. */
  paymentId: string;
  /** In minor units of the settlement currency. */
  amount: number;
  currency: string;
  /** Where the provider should send the player afterwards. */
  returnUrl: string;
  description: string;
}

/**
 * What an adapter made of a webhook.
 *
 * `unknown` is a real outcome and not an error: providers send notifications
 * for states this site does not care about, and answering 200 to those is how
 * a provider is told to stop retrying them.
 */
export interface WebhookResult {
  providerRef: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  /** What the provider actually said, verbatim. */
  providerStatus: string;
  /**
   * The amount the provider says was paid, when it says. Checked against the
   * payment: a confirmation for less money than was asked is not a
   * confirmation, and finding that out later is finding it out too late.
   */
  amount?: number;
}

export interface PaymentProvider {
  /** The key this adapter is registered and stored under. */
  readonly name: string;

  /** Whether it is configured well enough to be used at all. */
  isConfigured(): boolean;

  createPayment(request: CreatePaymentRequest): Promise<PaymentIntent>;

  /**
   * Authenticates a webhook and says what it means.
   *
   * Given the raw body, not a parsed one: signatures are computed over exact
   * bytes, and a body that has been through `JSON.parse` and back is a
   * different sequence of bytes. Returns null when the signature does not
   * check out — the caller answers 401 and credits nothing.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookResult | null;
}
