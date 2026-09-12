import { Inject, Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import Redis from 'ioredis';
import { type LiveDrop, ItemRarity } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { REDIS_PUBLISHER } from '../common/redis.module';

export const DROPS_CHANNEL = 'drops:live';

/**
 * Not every drop reaches the global feed: at peak that is tens of thousands of
 * events per second, of which a handful interest anyone. Rarity is the filter.
 */
const FEED_RARITIES = new Set<ItemRarity>([
  ItemRarity.RESTRICTED,
  ItemRarity.CLASSIFIED,
  ItemRarity.COVERT,
  ItemRarity.EXTRAORDINARY,
]);

export interface PublishDropInput {
  openingId: string;
  userId: string;
  caseName: string;
  caseSlug: string;
  item: Item;
  price: number;
}

@Injectable()
export class DropsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
  ) {}

  async publish(input: PublishDropInput): Promise<void> {
    if (!FEED_RARITIES.has(input.item.rarity as ItemRarity)) return;

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { username: true, avatarUrl: true },
    });

    const drop: LiveDrop = {
      openingId: input.openingId,
      username: user?.username ?? 'Player',
      avatarUrl: user?.avatarUrl ?? null,
      caseName: input.caseName,
      caseSlug: input.caseSlug,
      itemName: input.item.name,
      itemImageUrl: input.item.imageUrl,
      rarity: input.item.rarity as ItemRarity,
      price: input.price,
      createdAt: new Date().toISOString(),
    };

    // Through Redis rather than straight into the socket: there are several
    // API instances and the feed must be the same one for everybody.
    await this.publisher.publish(DROPS_CHANNEL, JSON.stringify(drop));
  }

  /** Recent notable drops, so the feed is not empty on page load. */
  async recent(limit = 20): Promise<LiveDrop[]> {
    const openings = await this.prisma.caseOpening.findMany({
      where: { item: { rarity: { in: [...FEED_RARITIES] } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: true, item: true, case: true },
    });

    return openings.map((o) => ({
      openingId: o.id,
      username: o.user.username,
      avatarUrl: o.user.avatarUrl,
      caseName: o.case.name,
      caseSlug: o.case.slug,
      itemName: o.item.name,
      itemImageUrl: o.item.imageUrl,
      rarity: o.item.rarity as ItemRarity,
      price: o.itemPrice,
      createdAt: o.createdAt.toISOString(),
    }));
  }
}
