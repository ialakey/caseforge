import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { promoCodeSchema } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PaymentsService } from './payments.service';

const createPaymentSchema = z.object({
  amount: z.number().int().min(1),
  provider: z.string().trim().max(32).optional(),
  promoCode: promoCodeSchema.nullable().optional(),
});

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('providers')
  providers(): { providers: string[] } {
    return { providers: this.payments.available() };
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createPaymentSchema))
    body: { amount: number; provider?: string; promoCode?: string | null },
  ) {
    return this.payments.create(user.id, body.amount, body.provider, body.promoCode ?? null);
  }

  /**
   * Where a provider confirms a payment.
   *
   * Public, because a payment company does not hold a session — and therefore
   * authenticated by signature instead, inside the adapter. The raw body is
   * what gets verified: a signature is computed over exact bytes, and a body
   * that has been parsed and re-serialised is a different sequence of them.
   *
   * 401 on a signature that does not check out, and 200 on anything that
   * verifies — including notifications this site does not act on. A provider
   * reads a 4xx as "try again tomorrow".
   *
   * `rawBody` is put there by the JSON parser in `main.ts`, which keeps the
   * bytes for this route and no other. Falling back to re-serialising the
   * parsed object would be worse than having nothing: it verifies for the
   * simplest payloads and then fails on the first provider that orders its
   * keys differently or escapes a non-ASCII character, which is a signature
   * check that only appears to work.
   */
  @Public()
  @Post('webhook/:provider')
  @HttpCode(200)
  async webhook(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Req() request: FastifyRequest & { rawBody?: string },
  ): Promise<{ received: true }> {
    const rawBody = request.rawBody;
    if (rawBody === undefined) throw new UnauthorizedException('Webhook rejected');
    const { ok } = await this.payments.handleWebhook(provider, headers, rawBody);
    if (!ok) throw new UnauthorizedException('Webhook rejected');
    return { received: true };
  }
}
