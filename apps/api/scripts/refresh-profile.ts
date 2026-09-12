/**
 * Refreshes a user's nickname and avatar from Steam.
 *
 * Signing in pulls the profile automatically, but users created by the seed or
 * by a migration have none. The script also confirms the profile source works
 * at all, without visiting the site.
 *
 * Run:  pnpm --filter @caseforge/api refresh-profile [steamId64 ...]
 * With no arguments it refreshes every user that has no avatar.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { SteamOpenIdService } from '../src/steam/steam-openid.service';

async function main(): Promise<void> {
  const logger = new Logger('RefreshProfile');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const prisma = app.get(PrismaService);
  const steam = app.get(SteamOpenIdService);

  const explicit = process.argv.slice(2);
  const users = explicit.length
    ? await prisma.user.findMany({ where: { steamId64: { in: explicit } } })
    : await prisma.user.findMany({ where: { avatarUrl: null } });

  if (users.length === 0) {
    logger.log('Nothing to refresh — every user already has an avatar.');
    await app.close();
    return;
  }

  for (const user of users) {
    const profile = await steam.fetchProfile(user.steamId64);
    await prisma.user.update({
      where: { id: user.id },
      data: { username: profile.username, avatarUrl: profile.avatarUrl },
    });
    logger.log(
      `${user.steamId64}: nickname "${profile.username}", avatar ${profile.avatarUrl ?? 'not found'}`,
    );
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
