import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Item } from '@prisma/client';
import { judgeRtp, type SteamMarketItem } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { CacheNamespace, CacheService } from '../common/cache.service';
import { FxService } from '../common/fx.service';
import { SteamMarketService } from './steam-market.service';

/**
 * How many items one cron run refreshes.
 *
 * The limit comes from Steam, not from the database: at 3.5 seconds between
 * requests, 40 items take roughly two and a half minutes.
 */
const SYNC_BATCH_SIZE = 40;

export interface ImportResult {
  imported: number;
  updated: number;
  failed: Array<{ marketHashName: string; reason: string }>;
  items: Item[];
}

@Injectable()
export class ItemSyncService {
  private readonly logger = new Logger(ItemSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly fx: FxService,
    private readonly market: SteamMarketService,
  ) {}

  /**
   * Imports items from Steam into the catalogue.
   *
   * Metadata comes from the search cache, the price from a separate
   * priceoverview call. An item with no price is still stored, but with a zero
   * price it cannot go into a case: autoBalance rejects such an item with an
   * explicit error rather than treating it as free.
   */
  async importItems(marketHashNames: string[]): Promise<ImportResult> {
    const unique = [...new Set(marketHashNames.map((n) => n.trim()).filter(Boolean))];
    const result: ImportResult = { imported: 0, updated: 0, failed: [], items: [] };

    for (const marketHashName of unique) {
      try {
        const meta = await this.market.getItemMeta(marketHashName);
        if (!meta) {
          result.failed.push({ marketHashName, reason: 'Item not found on the Steam market' });
          continue;
        }

        const price = await this.market.fetchPrice(marketHashName);

        const existing = await this.prisma.item.findUnique({ where: { marketHashName } });

        const saved = await this.prisma.item.upsert({
          where: { marketHashName },
          create: {
            marketHashName,
            name: meta.name,
            imageUrl: meta.imageUrl,
            rarity: meta.rarity,
            weaponType: meta.weaponType,
            exterior: meta.exterior,
            marketPrice: price ?? 0,
            priceUpdatedAt: price === null ? null : new Date(),
          },
          update: {
            name: meta.name,
            imageUrl: meta.imageUrl,
            rarity: meta.rarity,
            weaponType: meta.weaponType,
            exterior: meta.exterior,
            // Never overwrite a price with zero: an empty market response
            // usually means "no listings right now", not "worthless".
            ...(price === null ? {} : { marketPrice: price, priceUpdatedAt: new Date() }),
          },
        });

        if (existing) result.updated += 1;
        else result.imported += 1;
        result.items.push(saved);

        if (price === null) {
          this.logger.warn(`No price for ${marketHashName} — stored without one`);
        }
      } catch (err) {
        result.failed.push({
          marketHashName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Imports items straight from a search response.
   *
   * The difference from `importItems` is the price. That one asks Steam for a
   * settlement-currency price per item, which is a request each and therefore
   * three and a half seconds each; this one takes the reference price the
   * search already returned and converts it at the live rate. One search
   * answers for a hundred items, so seeding a catalogue of thousands becomes
   * minutes instead of hours.
   *
   * The trade is precision: a converted reference price is Steam's lowest
   * listing rather than the median the price endpoint reports, so it runs a
   * little low. That is acceptable for seeding — the hourly synchronisation
   * replaces every one of them with a proper median, and an item priced a
   * little low is an item a case is a little generous about, never one that
   * quietly loses money.
   *
   * Items without a reference price are refused rather than stored at zero:
   * a case built on an invented price is a case with an invented RTP.
   */
  async importFromMarket(items: readonly SteamMarketItem[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, failed: [], items: [] };
    // The rate is optional in the type because a rate table can be missing a
    // currency; without it there is nothing to convert from and the import
    // refuses every item rather than inventing prices.
    const usdRate = this.fx.getRates().USD ?? 0;

    for (const item of items) {
      const usdCents = item.referencePriceUsd ?? 0;
      if (usdCents <= 0 || !Number.isFinite(usdRate) || usdRate <= 0) {
        result.failed.push({ marketHashName: item.marketHashName, reason: 'No reference price' });
        continue;
      }

      // referencePriceUsd is in cents and the rate is base-currency units per
      // dollar, so the product is already in base minor units.
      const price = Math.round(usdCents * usdRate);

      const existing = await this.prisma.item.findUnique({
        where: { marketHashName: item.marketHashName },
      });

      const saved = await this.prisma.item.upsert({
        where: { marketHashName: item.marketHashName },
        create: {
          marketHashName: item.marketHashName,
          name: item.name,
          imageUrl: item.imageUrl,
          rarity: item.rarity,
          weaponType: item.weaponType,
          exterior: item.exterior,
          marketPrice: price,
          priceUpdatedAt: new Date(),
        },
        update: {
          imageUrl: item.imageUrl,
          rarity: item.rarity,
          weaponType: item.weaponType,
          exterior: item.exterior,
          // An item that already has a price keeps it: this path is a seed,
          // and the scheduled synchronisation knows better than a search does.
          ...(existing?.priceUpdatedAt ? {} : { marketPrice: price, priceUpdatedAt: new Date() }),
        },
      });

      if (existing) result.updated += 1;
      else result.imported += 1;
      result.items.push(saved);
    }

    return result;
  }

  /** Refreshes one item's price, triggered from the admin panel. */
  async refreshPrice(itemId: string): Promise<{ price: number | null; item: Item }> {
    const item = await this.prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    const price = await this.market.fetchPrice(item.marketHashName);
    if (price === null) return { price: null, item };

    const updated = await this.prisma.item.update({
      where: { id: itemId },
      data: { marketPrice: price, priceUpdatedAt: new Date() },
    });
    return { price, item: updated };
  }

  /**
   * Scheduled price synchronisation.
   *
   * Only items that actually sit in active cases are refreshed: the catalogue
   * may be large, but only those affect the economy. Stalest prices go first.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async syncPrices(): Promise<{ checked: number; changed: number; enriched: number }> {
    const cooldown = await this.market.cooldownRemaining();
    if (cooldown > 0) {
      this.logger.warn(`Price sync skipped: Steam is paused for another ${cooldown}s`);
      return { checked: 0, changed: 0, enriched: 0 };
    }

    const items = await this.prisma.item.findMany({
      where: { caseItems: { some: { case: { isActive: true } } } },
      orderBy: [{ priceUpdatedAt: { sort: 'asc', nulls: 'first' } }],
      take: SYNC_BATCH_SIZE,
    });

    let changed = 0;
    let enriched = 0;

    for (const item of items) {
      try {
        const price = await this.market.fetchPrice(item.marketHashName);
        if (price !== null && price !== item.marketPrice) {
          await this.prisma.item.update({
            where: { id: item.id },
            data: { marketPrice: price, priceUpdatedAt: new Date() },
          });
          changed += 1;
        }

        // Items created outside the import path (seed, manual insert) stay
        // without an image forever unless it is filled in here. The request
        // runs once per item — after that imageUrl is set.
        if (!item.imageUrl) {
          const meta = await this.market.getItemMeta(item.marketHashName);
          if (meta?.imageUrl) {
            await this.prisma.item.update({
              where: { id: item.id },
              data: {
                imageUrl: meta.imageUrl,
                rarity: meta.rarity,
                weaponType: meta.weaponType ?? item.weaponType,
                exterior: meta.exterior ?? item.exterior,
              },
            });
            enriched += 1;
          }
        }
      } catch (err) {
        this.logger.warn(`Could not update ${item.marketHashName}: ${String(err)}`);
        break; // hit the limit — no point walking the rest of the list
      }
    }

    // Recalculation always runs, not only when prices moved: it also fills in
    // missing case images, and it costs a handful of queries.
    await this.recalculateActiveCases();
    // Prices, images and RTPs have moved: whatever the catalogue cache is
    // holding is now describing the previous hour.
    await this.cache.invalidate(CacheNamespace.CATALOGUE);
    if (enriched > 0) this.logger.log(`Item images filled in: ${enriched}`);
    return { checked: items.length, changed, enriched };
  }

  /**
   * Recomputes the RTP of active cases after items are re-priced.
   *
   * A case assembled at 92% RTP can drift past 100% after a knife's price
   * jumps and start losing money — that has to surface within the hour, not in
   * a monthly report.
   */
  async recalculateActiveCases(): Promise<void> {
    const cases = await this.prisma.case.findMany({
      where: { isActive: true },
      include: { items: { include: { item: true } } },
    });

    for (const gameCase of cases) {
      // A case with no image is a hole on the showcase. Until it has its own,
      // borrow the priciest item's picture — that is what sells the case
      // anyway. An explicitly set image is left alone.
      if (!gameCase.imageUrl) {
        const withImage = gameCase.items.filter((ci) => ci.item.imageUrl);
        if (withImage.length > 0) {
          const top = withImage.reduce((a, b) => {
            const priceOf = (x: typeof a) => x.item.priceOverride ?? x.item.marketPrice;
            return priceOf(a) > priceOf(b) ? a : b;
          });
          await this.prisma.case.update({
            where: { id: gameCase.id },
            data: { imageUrl: top.item.imageUrl },
          });
          this.logger.log(`Case "${gameCase.name}" took the image of "${top.item.name}"`);
        }
      }

      const expected = gameCase.items.reduce((sum, ci) => {
        const price = ci.item.priceOverride ?? ci.item.marketPrice;
        const chance = (ci.rangeTo - ci.rangeFrom + 1) / 1_000_000;
        return sum + chance * price;
      }, 0);
      const rtp = gameCase.price > 0 ? expected / gameCase.price : 0;

      await this.prisma.case.update({
        where: { id: gameCase.id },
        data: { rtpCached: rtp, rtpCalculatedAt: new Date() },
      });

      const verdict = judgeRtp(rtp);
      if (!verdict.allowed) {
        this.logger.error(`Case "${gameCase.name}" after re-pricing: ${verdict.message}`);
      } else if (!verdict.healthy) {
        this.logger.warn(`Case "${gameCase.name}": ${verdict.message}`);
      }
    }
  }
}
