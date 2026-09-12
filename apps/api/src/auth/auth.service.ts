import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import {
  UserRole,
} from '@caseforge/shared';
import {
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { SteamOpenIdService } from '../steam/steam-openid.service';
import { loadConfig } from '../common/config';
import type { AuthenticatedUser } from '../common/current-user.decorator';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly steam: SteamOpenIdService,
  ) {}

  /**
   * Finds or creates a user by SteamID and immediately issues a starting seed
   * pair — without an active server seed no case can be opened.
   */
  async loginWithSteam(steamId64: string, ip: string | null): Promise<TokenPair> {
    const profile = await this.steam.fetchProfile(steamId64);

    const user = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { steamId64 } });

      if (existing) {
        if (existing.isBanned) {
          throw new ForbiddenException(existing.banReason ?? 'Account is banned');
        }
        return tx.user.update({
          where: { id: existing.id },
          data: {
            username: profile.username,
            avatarUrl: profile.avatarUrl,
            lastLoginAt: new Date(),
            lastLoginIp: ip,
          },
        });
      }

      // The first admin is bootstrapped from the environment so nobody has to
      // touch the database by hand.
      const bootstrapAdmin =
        this.config.BOOTSTRAP_ADMIN_STEAM_ID !== '' &&
        this.config.BOOTSTRAP_ADMIN_STEAM_ID === steamId64;

      const created = await tx.user.create({
        data: {
          steamId64,
          username: profile.username,
          avatarUrl: profile.avatarUrl,
          role: bootstrapAdmin ? UserRole.ADMIN : UserRole.USER,
          registrationIp: ip,
          lastLoginIp: ip,
          lastLoginAt: new Date(),
        },
      });

      const serverSeed = generateServerSeed();
      await tx.serverSeed.create({
        data: {
          userId: created.id,
          seed: serverSeed,
          seedHash: hashServerSeed(serverSeed),
          isActive: true,
        },
      });
      await tx.clientSeed.create({
        data: { userId: created.id, seed: generateClientSeed(), isActive: true },
      });

      this.logger.log(`New user ${created.id} (steam ${steamId64})`);
      return created;
    });

    return this.issueTokens({ id: user.id, steamId64: user.steamId64, role: user.role as UserRole });
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Refresh token is invalid');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.isBanned) throw new ForbiddenException(user.banReason ?? 'Account is banned');

    return this.issueTokens({ id: user.id, steamId64: user.steamId64, role: user.role as UserRole });
  }

  private async issueTokens(user: AuthenticatedUser): Promise<TokenPair> {
    // TTLs arrive as strings from the environment; jsonwebtoken types
    // expiresIn as a template literal that an arbitrary string cannot satisfy.
    const accessTtl = this.config.JWT_ACCESS_TTL as SignOptions['expiresIn'];
    const refreshTtl = this.config.JWT_REFRESH_TTL as SignOptions['expiresIn'];

    const payload = { sub: user.id, steamId64: user.steamId64, role: user.role };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.JWT_ACCESS_SECRET,
        expiresIn: accessTtl,
      }),
      this.jwt.signAsync(
        { sub: user.id },
        { secret: this.config.JWT_REFRESH_SECRET, expiresIn: refreshTtl },
      ),
    ]);
    return { accessToken, refreshToken };
  }
}
