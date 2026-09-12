import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@caseforge/shared';
import { loadConfig } from '../common/config';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly config = loadConfig();

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        steamId64: string;
        role: UserRole;
      }>(token, { secret: this.config.JWT_ACCESS_SECRET });
      request.user = { id: payload.sub, steamId64: payload.steamId64, role: payload.role };
      return true;
    } catch {
      // Public endpoints keep working anonymously even with an expired token.
      if (isPublic) return true;
      throw new UnauthorizedException('Token is invalid or expired');
    }
  }
}
