/**
 * Grants or revokes a role, by SteamID64 or by nickname.
 *
 * `BOOTSTRAP_ADMIN_STEAM_ID` only applies the first time an account signs in,
 * so the account that was created before that variable was set — which is the
 * usual case on a development database — cannot be promoted by editing the
 * environment. This script is the way out, and it is also how a second
 * operator, an analyst or a support agent is appointed once the site is
 * running.
 *
 * Run:  pnpm --filter @caseforge/api grant-admin <steamId64 | nickname> [ROLE]
 *       ROLE is ADMIN (default), ANALYST, SUPPORT or USER.
 *
 * It prints what it is about to do and what the account looked like before, so
 * a mistyped nickname is visible rather than silently promoting somebody else.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { UserRole } from '@caseforge/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';

const ROLES = [UserRole.ADMIN, UserRole.ANALYST, UserRole.SUPPORT, UserRole.USER] as const;

async function main(): Promise<void> {
  const logger = new Logger('GrantAdmin');
  const [identifier, role = UserRole.ADMIN] = process.argv.slice(2);
  // Narrowed below by the membership check; argv is plain strings.
  const requested = role as UserRole;

  if (!identifier) {
    logger.error('Usage: grant-admin <steamId64 | nickname> [ADMIN|ANALYST|SUPPORT|USER]');
    process.exit(1);
  }
  if (!(ROLES as readonly string[]).includes(requested)) {
    logger.error(`Unknown role "${requested}". One of: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  // 'log' has to be in the list: everything this script reports, it reports
  // through the Nest logger, and without it a successful run says nothing.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const prisma = app.get(PrismaService);

  // A 17-digit number is a SteamID64; anything else is treated as a nickname,
  // which is not unique — hence the refusal below rather than a guess.
  const bySteamId = /^\d{17}$/.test(identifier);
  const matches = await prisma.user.findMany({
    where: bySteamId ? { steamId64: identifier } : { username: identifier },
    select: { id: true, username: true, steamId64: true, role: true },
  });

  if (matches.length === 0) {
    logger.error(
      `No account matches "${identifier}". Sign in through Steam once, then run this again.`,
    );
    await app.close();
    process.exit(1);
  }
  if (matches.length > 1) {
    logger.error(
      `"${identifier}" matches ${matches.length} accounts. Use the SteamID64 instead:\n` +
        matches.map((u) => `  ${u.steamId64}  ${u.username}  (${u.role})`).join('\n'),
    );
    await app.close();
    process.exit(1);
  }

  const user = matches[0]!;
  if (user.role === requested) {
    logger.log(`${user.username} (${user.steamId64}) is already ${requested}`);
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { role: requested } });
    logger.log(`${user.username} (${user.steamId64}): ${user.role} -> ${requested}`);
  }

  logger.log(
    'The role travels in the access token, so the panel appears after the next ' +
      'token refresh — reload the site, or sign out and back in.',
  );

  await app.close();
}

void main();
