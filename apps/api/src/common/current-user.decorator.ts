import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { UserRole } from '@caseforge/shared';

export interface AuthenticatedUser {
  id: string;
  steamId64: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser =>
    ctx.switchToHttp().getRequest().user,
);
