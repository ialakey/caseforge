/**
 * Populates the catalogue with themed cases.
 *
 * Contents are neither invented nor hard-coded from memory: items are picked
 * by searching the Steam market, so each one is guaranteed to have an image
 * and a real price. A mistyped skin name would otherwise create a "priceless"
 * item that quietly wrecks the case economy.
 *
 * From there a case is assembled exactly the way it would be by hand in the
 * CRM: autoBalance spreads the odds for a target RTP, the price is derived
 * from the loot table, and saving goes through AdminService — with the same
 * ticket range validation and the same refusal to store a loss-making case.
 *
 * Run:  pnpm --filter @caseforge/api seed:cases
 * Slow by nature: Steam throttles, 3.5 seconds between requests.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  autoBalance,
  judgeRtp,
  suggestCasePrice,
  type SteamMarketItem,
} from '@caseforge/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { SteamMarketService } from '../src/steam/steam-market.service';
import { ItemSyncService } from '../src/steam/item-sync.service';
import { AdminService } from '../src/admin/admin.service';

interface CaseBlueprint {
  slug: string;
  name: string;
  nameEn: string;
  /** Market search queries — the candidate pool is drawn from them. */
  searches: string[];
  itemCount: number;
  targetRtp: number;
  sortOrder: number;
  /**
   * Which slice of the price-sorted pool the items are taken from. Lets the
   * same weapon produce both a budget case and a premium one.
   */
  band?: { from: number; to: number };
}

const BLUEPRINTS: CaseBlueprint[] = [
  // --- Price tiers ---
  { slug: 'pocket', name: 'Карманный', nameEn: 'Pocket', searches: ['P250', 'MP9', 'Nova'], itemCount: 7, targetRtp: 0.92, sortOrder: 10, band: { from: 0, to: 0.45 } },
  { slug: 'budget', name: 'Бюджетный', nameEn: 'Budget', searches: ['Glock-18', 'MAC-10', 'Galil AR'], itemCount: 7, targetRtp: 0.91, sortOrder: 11, band: { from: 0, to: 0.55 } },
  { slug: 'standard', name: 'Стандарт', nameEn: 'Standard', searches: ['FAMAS', 'SG 553', 'AUG'], itemCount: 8, targetRtp: 0.9, sortOrder: 12 },
  { slug: 'premium', name: 'Премиум', nameEn: 'Premium', searches: ['AWP', 'AK-47'], itemCount: 8, targetRtp: 0.89, sortOrder: 13, band: { from: 0.5, to: 1 } },
  { slug: 'all-in', name: 'ALL IN', nameEn: 'ALL IN', searches: ['Karambit', 'Butterfly Knife', 'M9 Bayonet'], itemCount: 7, targetRtp: 0.87, sortOrder: 14, band: { from: 0.4, to: 1 } },

  // --- By weapon ---
  { slug: 'ak47', name: 'Арсенал AK-47', nameEn: 'AK-47 Arsenal', searches: ['AK-47'], itemCount: 8, targetRtp: 0.9, sortOrder: 20 },
  { slug: 'm4', name: 'Арсенал M4', nameEn: 'M4 Arsenal', searches: ['M4A4', 'M4A1-S'], itemCount: 8, targetRtp: 0.9, sortOrder: 21 },
  { slug: 'awp', name: 'Снайперский', nameEn: 'Sniper', searches: ['AWP'], itemCount: 8, targetRtp: 0.9, sortOrder: 22 },
  { slug: 'deagle', name: 'Desert Eagle', nameEn: 'Desert Eagle', searches: ['Desert Eagle'], itemCount: 7, targetRtp: 0.91, sortOrder: 23 },
  { slug: 'pistols', name: 'Пистолетный', nameEn: 'Pistols', searches: ['USP-S', 'Glock-18', 'Five-SeveN'], itemCount: 8, targetRtp: 0.91, sortOrder: 24 },
  { slug: 'smg', name: 'Пистолеты-пулемёты', nameEn: 'SMGs', searches: ['MP9', 'MAC-10', 'UMP-45', 'MP7'], itemCount: 8, targetRtp: 0.91, sortOrder: 25 },
  { slug: 'shotguns', name: 'Дробовики', nameEn: 'Shotguns', searches: ['Nova', 'XM1014', 'MAG-7', 'Sawed-Off'], itemCount: 7, targetRtp: 0.92, sortOrder: 26 },
  { slug: 'p90', name: 'P90', nameEn: 'P90', searches: ['P90'], itemCount: 7, targetRtp: 0.91, sortOrder: 27 },
  { slug: 'heavy', name: 'Тяжёлое', nameEn: 'Heavy', searches: ['Negev', 'M249'], itemCount: 6, targetRtp: 0.92, sortOrder: 28 },

  // --- Knives and gloves ---
  { slug: 'knives', name: 'Ножи', nameEn: 'Knives', searches: ['Karambit', 'Bayonet', 'Flip Knife'], itemCount: 7, targetRtp: 0.88, sortOrder: 30 },
  { slug: 'gloves', name: 'Перчатки', nameEn: 'Gloves', searches: ['Sport Gloves', 'Driver Gloves', 'Specialist Gloves'], itemCount: 7, targetRtp: 0.88, sortOrder: 31 },

  // --- Themed ---
  { slug: 'asiimov', name: 'Asiimov', nameEn: 'Asiimov', searches: ['Asiimov'], itemCount: 6, targetRtp: 0.9, sortOrder: 40 },
  { slug: 'hyper-beast', name: 'Hyper Beast', nameEn: 'Hyper Beast', searches: ['Hyper Beast'], itemCount: 6, targetRtp: 0.9, sortOrder: 41 },
  { slug: 'doppler', name: 'Doppler', nameEn: 'Doppler', searches: ['Doppler'], itemCount: 6, targetRtp: 0.88, sortOrder: 42 },
  { slug: 'neon', name: 'Неон', nameEn: 'Neon', searches: ['Neon Rider', 'Neon Revolution', 'Nightwish'], itemCount: 7, targetRtp: 0.9, sortOrder: 43 },
];

/** Below this listing count an item counts as illiquid: its price is noise. */
const MIN_LISTINGS = 3;

/**
 * Only skins go into a case.
 *
 * Searching by weapon name matches more than the weapon: a "Karambit" query
 * also returns "Sealed Graffiti | Karambit" worth three roubles. Such an item
 * becomes the cheapest in the case, takes nearly every ticket and collapses
 * the case price — a "Knives" case at 22 roubles that almost always drops
 * graffiti.
 *
 * The tell for a skin is the exterior in the name: weapons, knives and gloves
 * have one; graffiti, stickers, containers, agents and music kits do not.
 */
function isSkin(item: SteamMarketItem): boolean {
  return item.exterior !== null;
}

/**
 * Picks items spread across the price range.
 *
 * A case where everything costs about the same is dull: the whole point is a
 * cheap floor and a rare expensive ceiling. So candidates are sorted by price
 * and sampled evenly across the range.
 */
function pickSpread(candidates: SteamMarketItem[], count: number, band?: { from: number; to: number }) {
  const sorted = [...candidates].sort(
    (a, b) => (a.referencePriceUsd ?? 0) - (b.referencePriceUsd ?? 0),
  );

  const from = Math.floor(sorted.length * (band?.from ?? 0));
  const to = Math.ceil(sorted.length * (band?.to ?? 1));
  const slice = sorted.slice(from, Math.max(to, from + count));
  if (slice.length <= count) return slice;

  const picked: SteamMarketItem[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(slice[Math.round((i * (slice.length - 1)) / (count - 1))]!);
  }
  // An even step can produce duplicates on a short list.
  return [...new Map(picked.map((i) => [i.marketHashName, i])).values()];
}

async function main(): Promise<void> {
  const logger = new Logger('SeedCases');
  // 'log' is mandatory: the script writes progress at that level and the run
  // takes minutes — without it there is no sign the process is alive.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const prisma = app.get(PrismaService);
  const market = app.get(SteamMarketService);
  const itemSync = app.get(ItemSyncService);
  const admin = app.get(AdminService);

  const actor = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!actor) throw new Error('No administrator exists — run pnpm db:seed first');

  // --- 1. Find candidates ---
  const uniqueSearches = [...new Set(BLUEPRINTS.flatMap((b) => b.searches))];
  logger.log(`Searching ${uniqueSearches.length} queries...`);

  const pool = new Map<string, SteamMarketItem[]>();
  for (const query of uniqueSearches) {
    try {
      const found = (await market.search(query, 100)).filter(
        (i) => isSkin(i) && i.listings >= MIN_LISTINGS && (i.referencePriceUsd ?? 0) > 0,
      );
      pool.set(query, found);
      logger.log(`  "${query}": ${found.length} liquid items`);
    } catch (err) {
      logger.warn(`  "${query}": ${String(err)}`);
      pool.set(query, []);
    }
  }

  // --- 2. Compose each case ---
  const composition = new Map<string, SteamMarketItem[]>();
  for (const blueprint of BLUEPRINTS) {
    const candidates = [
      ...new Map(
        blueprint.searches.flatMap((q) => pool.get(q) ?? []).map((i) => [i.marketHashName, i]),
      ).values(),
    ];
    const picked = pickSpread(candidates, blueprint.itemCount, blueprint.band);

    if (picked.length < 3) {
      logger.warn(`Case "${blueprint.name}" skipped: only ${picked.length} items found`);
      continue;
    }
    composition.set(blueprint.slug, picked);
  }

  // --- 3. Import the items with real prices ---
  const allNames = [
    ...new Set([...composition.values()].flat().map((i) => i.marketHashName)),
  ];
  logger.log(`Importing ${allNames.length} items from Steam (3.5s each)...`);

  const CHUNK = 25;
  for (let i = 0; i < allNames.length; i += CHUNK) {
    const chunk = allNames.slice(i, i + CHUNK);
    const res = await itemSync.importItems(chunk);
    logger.log(
      `  ${Math.min(i + CHUNK, allNames.length)}/${allNames.length}: ` +
        `new ${res.imported}, updated ${res.updated}, failed ${res.failed.length}`,
    );
  }

  // --- 4. Assemble and save the cases ---
  let created = 0;
  for (const blueprint of BLUEPRINTS) {
    const picked = composition.get(blueprint.slug);
    if (!picked) continue;

    const dbItems = await prisma.item.findMany({
      where: { marketHashName: { in: picked.map((i) => i.marketHashName) } },
    });
    // An item without a confirmed price does not go in: it would skew the RTP
    // with an invented number.
    const priced = dbItems
      .map((i) => ({ ...i, price: i.priceOverride ?? i.marketPrice }))
      .filter((i) => i.price > 0 && i.priceUpdatedAt !== null);

    if (priced.length < 3) {
      logger.warn(`Case "${blueprint.name}" skipped: only ${priced.length} items have a price`);
      continue;
    }

    // The case price follows from the contents: rough odds inversely
    // proportional to price first, then price = expected return / target RTP.
    const weights = priced.map((i) => 1 / i.price);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const rough = priced.map((i, idx) => ({
      rangeFrom: 0,
      rangeTo: Math.max(0, Math.round((weights[idx]! / totalWeight) * 1_000_000) - 1),
      price: i.price,
    }));
    const casePrice = Math.max(100, suggestCasePrice(rough, blueprint.targetRtp));

    const balanced = autoBalance(priced, casePrice, blueprint.targetRtp);
    if (!balanced.ok) {
      logger.warn(`Case "${blueprint.name}" skipped: ${balanced.reason}`);
      continue;
    }

    // The case image is the picture of its priciest item.
    const top = priced.reduce((a, b) => (a.price > b.price ? a : b));

    await admin.upsertCase(
      actor.id,
      {
        slug: blueprint.slug,
        name: blueprint.name,
        nameEn: blueprint.nameEn,
        price: casePrice,
        // These demo cases are ordinary paid ones; free cases come from the
        // catalogue importer, where the survey says the price is zero.
        isFree: false,
        imageUrl: top.imageUrl,
        isActive: true,
        sortOrder: blueprint.sortOrder,
        items: priced.map((item, idx) => ({
          itemId: item.id,
          rangeFrom: balanced.ranges[idx]!.rangeFrom,
          rangeTo: balanced.ranges[idx]!.rangeTo,
        })),
      },
      null,
    );

    created += 1;
    const verdict = judgeRtp(balanced.actualRtp);
    logger.log(
      `  ${blueprint.name}: ${priced.length} items, ` +
        `price ${(casePrice / 100).toFixed(2)}, ${verdict.message}`,
    );
  }

  logger.log(`Done. Cases created or updated: ${created} of ${BLUEPRINTS.length}.`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
