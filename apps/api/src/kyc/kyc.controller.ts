import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { paginationSchema, UserRole } from '@caseforge/shared';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KycService } from './kyc.service';

const DOCUMENT_KINDS = [
  'PASSPORT',
  'ID_CARD',
  'DRIVING_LICENCE',
  'SELFIE',
  'PROOF_OF_ADDRESS',
] as const;

const submitKycSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  dateOfBirth: z.string().trim().min(8).max(32),
  /** ISO 3166-1 alpha-2, so a country is a code and not free text to sort by. */
  country: z.string().trim().length(2),
  documentNo: z.string().trim().min(3).max(64),
  documents: z
    .array(
      z.object({
        kind: z.enum(DOCUMENT_KINDS),
        contentType: z.string().trim().max(64),
        // Capped here as well as after decoding: refusing nine megabytes of
        // base64 before it is decoded costs nothing.
        base64: z.string().min(16).max(9_000_000),
      }),
    )
    .min(1)
    .max(4),
});

const decideSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).nullable().optional(),
});

/** A player's own identity check. */
@Controller('api/kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get('me')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.mine(user.id);
  }

  @Post()
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(submitKycSchema)) body: z.infer<typeof submitKycSchema>,
  ) {
    return this.kyc.submit(user.id, body);
  }
}

/**
 * The review queue, for operators.
 *
 * A separate controller behind the roles guard rather than a branch inside the
 * player one. Identity documents are the most sensitive thing this site holds,
 * and "who may read them" should be answerable by looking at one decorator
 * rather than by following a conditional.
 */
@Controller('api/admin/kyc')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPPORT)
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  list(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.kyc.list(query.status as never, page, perPage);
  }

  @Post(':id/decide')
  @Roles(UserRole.ADMIN)
  decide(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(decideSchema)) body: z.infer<typeof decideSchema>,
  ) {
    return this.kyc.decide(actor.id, id, body.approve, body.note ?? null);
  }

  /**
   * One document, streamed.
   *
   * Through the API rather than off a static path: identity documents behind a
   * guessable URL on a web server are identity documents anybody can guess.
   * The request names a document by id and the path on disk is resolved from
   * the row, so there is no path in the request to traverse with.
   */
  @Get('documents/:id')
  async document(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { bytes, contentType } = await this.kyc.readDocument(id);
    await reply
      .header('Content-Type', contentType)
      // No caching anywhere: a passport scan in a proxy cache is a passport
      // scan outside the system that is supposed to be holding it.
      .header('Cache-Control', 'no-store, private')
      .header('Content-Disposition', 'inline')
      .send(bytes);
  }
}
