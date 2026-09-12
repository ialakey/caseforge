import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '@caseforge/shared';

/**
 * Domain errors carry a machine-readable code alongside the message.
 *
 * The interface translates the code and falls back to the message for codes it
 * does not know yet. Without the code the front end would have to match on
 * English prose, which breaks the moment the wording is edited.
 */
export function badRequest(code: ErrorCode, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

export function forbidden(code: ErrorCode, message: string): ForbiddenException {
  return new ForbiddenException({ code, message });
}

export function notFound(code: ErrorCode, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}
