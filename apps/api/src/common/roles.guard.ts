import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@caseforge/shared';
import { ROLES_KEY } from './roles.decorator';
import type { AuthenticatedUser } from './current-user.decorator';

/**
 * Roles are ordered: ADMIN passes anywhere SUPPORT or ANALYST is allowed.
 */
const RANK: Record<UserRole, number> = {
  USER: 0,
  ANALYST: 1,
  SUPPORT: 2,
  ADMIN: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Authentication required');

    const minRank = Math.min(...required.map((r) => RANK[r]));
    if (RANK[user.role] < minRank) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
