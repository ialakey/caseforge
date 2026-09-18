import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { loadConfig } from './config';

/**
 * The read-only client.
 *
 * Injected where a query may be served by a replica — reports, the public
 * catalogue, the battle lobby, the drop feed. With `REPLICA_DATABASE_URL`
 * unset it *is* the primary client, so a single-server deployment needs no
 * branching anywhere and no configuration at all.
 *
 * The rule for using it, which cannot be enforced by a type: the replica
 * serves what an operator or a spectator reads, never what the player asking
 * has just written. Replication lag is small but real, and a read-after-write
 * across it shows a player an inventory without the item they just won. Every
 * call site below is chosen on that basis.
 */
export const PRISMA_READ = 'PRISMA_READ';

const logger = new Logger('PrismaRead');

export function createReadClient(primary: PrismaService): PrismaClient {
  const url = loadConfig().REPLICA_DATABASE_URL;
  if (!url) {
    logger.log('No read replica configured; reads go to the primary');
    return primary;
  }

  logger.log('Reads that tolerate replication lag will go to the replica');
  return new PrismaClient({ datasourceUrl: url });
}
