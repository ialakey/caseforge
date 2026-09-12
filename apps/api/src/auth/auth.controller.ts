import { BadRequestException, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { SteamOpenIdService } from '../steam/steam-openid.service';
import { Public } from './public.decorator';
import { loadConfig } from '../common/config';

const REFRESH_COOKIE = 'refresh_token';

@Controller('api/auth')
export class AuthController {
  private readonly config = loadConfig();

  constructor(
    private readonly auth: AuthService,
    private readonly steam: SteamOpenIdService,
  ) {}

  @Public()
  @Get('steam')
  redirectToSteam(@Res() reply: FastifyReply): void {
    reply.redirect(this.steam.buildAuthUrl(), 302);
  }

  @Public()
  @Get('steam/return')
  async steamReturn(
    @Query() query: Record<string, string>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const steamId64 = await this.steam.verifyCallback(query);
    const tokens = await this.auth.loginWithSteam(steamId64, request.ip ?? null);

    this.setRefreshCookie(reply, tokens.refreshToken);
    // The access token rides in the URL fragment: it stays out of proxy logs
    // and out of the Referer header.
    reply.redirect(`${this.config.WEB_URL}/auth/callback#token=${tokens.accessToken}`, 302);
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string }> {
    const token = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    if (!token) throw new BadRequestException('Refresh token missing');

    const tokens = await this.auth.refresh(token);
    this.setRefreshCookie(reply, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Public()
  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply): { ok: true } {
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.NODE_ENV === 'production',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
  }
}
