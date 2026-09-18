/**
 * Imports a catalogue: shelves, cases, and the items in them.
 *
 * The input is a survey file — a list of groups, a list of cases with their
 * prices, and for each case the items it holds, written the way the surveyed
 * site writes them (which may be in another language). What comes out is our
 * own catalogue: categories, cases priced as the file says, and loot tables
 * balanced by our solver against real Steam prices.
 *
 * Steam allows about seventeen requests a minute and answers roughly ten items
 * to each one, so the whole cost of this script is the number of requests it
 * makes. Three things keep that number down:
 *
 * 1. **One search per weapon family, not per item.** Two thousand item names
 *    collapse into some hundred and forty families, and one answer about
 *    "AK-47" resolves every AK in the survey at once.
 * 2. **Paging a family only while it is still paying.** Each family carries
 *    the set of names this run needs from it; pages stop the moment that set
 *    empties, and after three pages that resolve nothing new. A family whose
 *    skins are all popular costs two requests rather than fifteen.
 * 3. **Asking Steam in the survey's language.** The response then carries the
 *    localised name next to the English `market_hash_name`, which is what maps
 *    «AWP | Гиперзверь» onto `AWP | Hyper Beast` with no dictionary to keep —
 *    and it carries a reference price, so no second request per item is needed.
 *    The hourly synchronisation replaces those with proper medians afterwards.
 *
 * The pool is cached on disk, so a second run costs no Steam requests at all
 * and an interrupted run resumes where it stopped.
 *
 * Two things the survey cannot supply are generated rather than borrowed. The
 * artwork is drawn per case by `case-art.ts` and written into the web app's
 * `public/cases/`, because a case's picture is not something to take from
 * another site. The description is composed by `case-copy.ts` out of the loot
 * table that was just balanced, because the surveyed case pages have no prose
 * on them at all — only a name, a price and a grid of items.
 *
 * Run:  pnpm --filter @caseforge/api seed:catalogue -- [options]
 *
 *   --file=<path>            survey file (default prisma/data/catalogue.json)
 *   --group=<name substring> only these groups
 *   --limit=<n>              only the first n cases of the selection
 *   --items-per-case=<n>     cap the loot table (default 24)
 *   --min-items=<n>          refuse a case with fewer resolved items (default 4)
 *   --rtp=<0.9>              target RTP for the solver
 *   --pages=<n>              search pages per weapon family (default 15; a page is
 *                            whatever Steam returns, currently ten entries)
 *   --refresh-pool           ignore the cached pool and ask Steam again
 *   --art-dir=<path>         where the drawn SVGs go (default apps/web/public/cases)
 *   --no-art                 skip drawing, leave the images alone
 *   --dry-run                resolve and report, write nothing
 *   --force                  rebuild cases that already exist
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  autoBalance,
  judgeRtp,
  toMinor,
  type SteamMarketItem,
} from '@caseforge/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { SteamMarketService } from '../src/steam/steam-market.service';
import { ItemSyncService } from '../src/steam/item-sync.service';
import { AdminService } from '../src/admin/admin.service';
import { caseArtUrl, renderCaseArt } from './case-art';
import { renderCaseCopy } from './case-copy';

interface SurveyFile {
  source: string;
  capturedAt: string;
  groups: Array<{ name: string; sortOrder: number }>;
  /** Every distinct item name in the survey; cases index into this list. */
  names: string[];
  cases: Array<{ group: string; slug: string; name: string; price: number; items: number[] }>;
}

/**
 * Slugs and English names for the shelves.
 *
 * Transliterating a Russian heading would produce `kejsy-yutuberov`, which is
 * a URL nobody can read and a label nobody can translate. The nine known
 * headings are mapped by hand; anything else falls back to a slug derived from
 * its position, so an unknown group still imports.
 */
const GROUP_MAP: Record<string, { slug: string; nameEn: string }> = {
  'Бесплатные кейсы': { slug: 'free', nameEn: 'Free cases' },
  'Кейсы по раритетности': { slug: 'rarity', nameEn: 'By rarity' },
  'Стандартные кейсы': { slug: 'standard', nameEn: 'Standard cases' },
  'Наши сборки': { slug: 'house', nameEn: 'House cases' },
  'По виду оружия': { slug: 'weapons', nameEn: 'By weapon' },
  'Кейсы ютуберов': { slug: 'creators', nameEn: 'Creator cases' },
  'Фарм кейсы': { slug: 'farm', nameEn: 'Farm cases' },
  'ALL IN кейсы': { slug: 'all-in', nameEn: 'ALL IN cases' },
  Коллекции: { slug: 'collections', nameEn: 'Collections' },
};

/** Items this project cannot sell: no exterior means no skin. */
function isSkin(item: SteamMarketItem): boolean {
  return item.exterior !== null;
}

function arg(name: string, fallback?: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (found) return found.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? 'true' : fallback;
}

/** The weapon a survey name belongs to: everything before the first pipe. */
function familyOf(name: string): string {
  const family = name.split('|')[0]!.trim();
  // A star prefix marks a knife or glove; Steam searches better without it.
  return family.replace(/^★\s*/, '').replace(/^StatTrak™\s*/, '');
}

/**
 * Picks items spread across the price range.
 *
 * A case where everything costs the same is dull, and a case with two hundred
 * items is a reel nobody can read. Candidates are sorted by price and sampled
 * evenly, so the cheap floor and the rare ceiling both survive the cap.
 */
function pickSpread<T extends { price: number }>(candidates: T[], count: number): T[] {
  if (candidates.length <= count) return candidates;
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(sorted[Math.round((i * (sorted.length - 1)) / (count - 1))]!);
  }
  return [...new Set(picked)];
}

async function main(): Promise<void> {
  const logger = new Logger('SeedCatalogue');
  // 'log' is mandatory: the run takes minutes and without it there is no sign
  // the process is alive.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // The context is the whole application, which means it also starts the
  // application's cron jobs — and one of them is the hourly price
  // synchronisation. Left running it would spend this script's Steam budget on
  // its own requests, halving the import's throughput, and re-price items
  // underneath a case between the moment its odds are solved and the moment it
  // is saved. Nothing here wants a background job; they are all stopped.
  const scheduler = app.get(SchedulerRegistry);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);

  const prisma = app.get(PrismaService);
  const market = app.get(SteamMarketService);
  const itemSync = app.get(ItemSyncService);
  const admin = app.get(AdminService);

  const actor = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!actor) throw new Error('No administrator exists — run pnpm db:seed first');

  const filePath = path.resolve(arg('file', 'prisma/data/catalogue.json')!);
  const survey = JSON.parse(readFileSync(filePath, 'utf8')) as SurveyFile;
  logger.log(
    `Survey: ${survey.cases.length} cases in ${survey.groups.length} groups, ` +
      `${survey.names.length} distinct items (source ${survey.source}, ${survey.capturedAt})`,
  );

  const itemsPerCase = Number(arg('items-per-case', '24'));
  const minItems = Number(arg('min-items', '4'));
  const targetRtp = Number(arg('rtp', '0.9'));
  const pages = Number(arg('pages', '15'));
  const dryRun = arg('dry-run') === 'true';
  const force = arg('force') === 'true';
  const groupFilter = arg('group');
  const limit = Number(arg('limit', '0'));

  // The artwork belongs to the web app, not to the API — it is served as a
  // static file from `public/`, so the default path reaches across the
  // workspace on purpose. It stays overridable because a deployment that
  // serves its assets from somewhere else should not have to patch a script.
  const drawArt = arg('no-art') !== 'true';
  const artDir = path.resolve(arg('art-dir', '../../apps/web/public/cases')!);

  // --- 1. The shelves --------------------------------------------------------
  const categorySlug = new Map<string, string>();
  for (const [index, group] of survey.groups.entries()) {
    const mapped = GROUP_MAP[group.name] ?? {
      slug: `group-${index + 1}`,
      nameEn: group.name,
    };
    categorySlug.set(group.name, mapped.slug);
    if (dryRun) continue;
    await admin.upsertCategory(
      actor.id,
      {
        slug: mapped.slug,
        name: group.name,
        nameEn: mapped.nameEn,
        sortOrder: group.sortOrder,
        isActive: true,
      },
      null,
    );
  }
  logger.log(`Shelves: ${[...categorySlug.values()].join(', ')}`);

  // --- 2. Which cases are in scope ------------------------------------------
  let selection = survey.cases;
  if (groupFilter) {
    const needle = groupFilter.toLowerCase();
    selection = selection.filter(
      (c) =>
        c.group.toLowerCase().includes(needle) ||
        (categorySlug.get(c.group) ?? '').includes(needle),
    );
  }
  if (!force) {
    const existing = new Set(
      (await prisma.case.findMany({ select: { slug: true } })).map((c) => c.slug),
    );
    const before = selection.length;
    selection = selection.filter((c) => !existing.has(c.slug));
    if (before !== selection.length) {
      logger.log(`${before - selection.length} case(s) already exist and are left alone`);
    }
  }
  if (limit > 0) selection = selection.slice(0, limit);
  logger.log(`Importing ${selection.length} case(s)`);
  if (selection.length === 0) {
    await app.close();
    return;
  }

  // --- 3. The Steam pool, one family at a time -------------------------------
  //
  // Every survey name this run needs, bucketed by weapon family. The buckets
  // are what makes the paging adaptive: a family is asked for more pages only
  // while those pages keep resolving names that are still outstanding.
  const wantedByFamily = new Map<string, Set<string>>();
  for (const entry of selection) {
    for (const index of entry.items) {
      const name = survey.names[index];
      if (!name) continue;
      const family = familyOf(name);
      if (family.length < 2) continue;
      const bucket = wantedByFamily.get(family) ?? new Set<string>();
      bucket.add(name.toLowerCase().trim());
      wantedByFamily.set(family, bucket);
    }
  }
  const families = [...wantedByFamily.keys()];

  const cacheDir = path.join(path.dirname(filePath), '.cache');
  const poolPath = path.join(cacheDir, 'steam-pool.json');
  /** Localised name (lower-cased) -> the market item it resolves to. */
  const pool = new Map<string, SteamMarketItem>();
  const cachedFamilies = new Set<string>();

  if (existsSync(poolPath) && arg('refresh-pool') !== 'true') {
    const cached = JSON.parse(readFileSync(poolPath, 'utf8')) as {
      families: string[];
      items: Array<[string, SteamMarketItem]>;
    };
    for (const family of cached.families) cachedFamilies.add(family);
    for (const [key, item] of cached.items) pool.set(key, item);
    logger.log(`Pool cache: ${pool.size} items over ${cachedFamilies.size} families`);
  }

  const savePool = (): void => {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      poolPath,
      JSON.stringify({ families: [...cachedFamilies], items: [...pool.entries()] }),
    );
  };

  /** How many consecutive fruitless pages end a family. */
  const PATIENCE = 3;

  const missing = families.filter((f) => !cachedFamilies.has(f));
  if (missing.length > 0) {
    logger.log(
      `Asking Steam about ${missing.length} weapon families ` +
        `(3.5s per request, up to ${pages} pages each)...`,
    );
    const startedAt = Date.now();

    for (const [index, family] of missing.entries()) {
      // Names from this family that no page has produced yet. A skin is
      // satisfied by any of its exteriors, which is why this is checked with
      // the same prefix rule the resolver uses rather than by equality.
      const outstanding = new Set(wantedByFamily.get(family) ?? []);
      let cursor = 0;
      let barren = 0;

      for (let page = 0; page < pages; page++) {
        // Asked in the survey's language: the answer then carries the localised
        // name in `name` and the English key in `marketHashName`, which is the
        // whole mapping.
        //
        // 100 is asked for and about ten arrive — Steam caps this endpoint and
        // has changed the cap before. So the cursor advances by what actually
        // came back rather than by the page size we hoped for, and the loop
        // ends when a page is empty, which is the only reliable end-of-list.
        const items = await market.search(family, 100, { start: cursor, locale: 'russian' });
        if (items.length === 0) break;
        cursor += items.length;

        const before = outstanding.size;
        for (const item of items.filter(isSkin)) {
          const localised = item.name.toLowerCase();
          pool.set(localised, item);
          // The English name is indexed too: a survey that already uses it
          // resolves without a second lookup.
          pool.set(item.marketHashName.toLowerCase(), item);

          for (const want of outstanding) {
            if (localised === want || localised.startsWith(`${want} (`)) outstanding.delete(want);
          }
        }

        if (outstanding.size === 0) break;
        // A page that answered nothing this run is not proof the rest are
        // useless — Steam's ordering is its own — but three in a row are.
        barren = outstanding.size === before ? barren + 1 : 0;
        if (barren >= PATIENCE) break;
      }

      cachedFamilies.add(family);
      if ((index + 1) % 5 === 0 || index === missing.length - 1) {
        savePool();
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = Math.round((elapsed / (index + 1)) * (missing.length - index - 1) / 60);
        logger.log(
          `  ${index + 1}/${missing.length} families, pool ${pool.size} keys, ~${eta} min left`,
        );
      }
    }
    savePool();
  }

  /**
   * Resolves a survey name to a market item.
   *
   * Exact match first; then the name without its exterior, because a survey
   * that lists "AK-47 | Redline" means whichever exterior is on sale, and the
   * pool is keyed by the full market name.
   */
  const resolve = (surveyName: string): SteamMarketItem | null => {
    const key = surveyName.toLowerCase().trim();
    const exact = pool.get(key);
    if (exact) return exact;

    // Prefer the cheapest exterior of the same skin: it is the one a player is
    // most likely to actually receive, and it keeps a case affordable.
    let best: SteamMarketItem | null = null;
    for (const [poolKey, item] of pool) {
      if (!poolKey.startsWith(key + ' (')) continue;
      if (!best || (item.referencePriceUsd ?? 0) < (best.referencePriceUsd ?? 0)) best = item;
    }
    return best;
  };

  // --- 4. Case by case -------------------------------------------------------
  let created = 0;
  let skipped = 0;
  let drawn = 0;
  const problems: string[] = [];

  if (drawArt && !dryRun && !existsSync(artDir)) mkdirSync(artDir, { recursive: true });

  for (const [index, entry] of selection.entries()) {
    const names = entry.items.map((i) => survey.names[i] ?? '').filter(Boolean);
    const resolved = [
      ...new Map(
        names
          .map((n) => resolve(n))
          .filter((i): i is SteamMarketItem => i !== null && (i.referencePriceUsd ?? 0) > 0)
          .map((i) => [i.marketHashName, i]),
      ).values(),
    ];

    if (resolved.length < minItems) {
      skipped += 1;
      problems.push(
        `${entry.slug} (${entry.name}): only ${resolved.length}/${names.length} items resolved`,
      );
      continue;
    }

    const picked = pickSpread(
      resolved.map((i) => ({ item: i, price: i.referencePriceUsd ?? 0 })),
      itemsPerCase,
    ).map((p) => p.item);

    if (dryRun) {
      logger.log(
        `  [dry] ${entry.name}: ${picked.length} of ${names.length} items, price ${entry.price}`,
      );
      created += 1;
      continue;
    }

    const shelf = categorySlug.get(entry.group) ?? null;

    // Items first: a case cannot be balanced against prices that are not in
    // the database yet.
    const imported = await itemSync.importFromMarket(picked);
    const dbItems = await prisma.item.findMany({
      where: { marketHashName: { in: picked.map((i) => i.marketHashName) } },
    });
    const priced = dbItems
      .map((i) => ({ itemId: i.id, price: i.priceOverride ?? i.marketPrice }))
      .filter((i) => i.price > 0);

    if (priced.length < minItems) {
      skipped += 1;
      problems.push(`${entry.slug}: only ${priced.length} priced items after import`);
      continue;
    }

    // The survey's price is what the case should cost, and the solver decides
    // the odds that make that price return the target RTP.
    //
    // It can refuse: no distribution returns less than the cheapest item or
    // more than the priciest one, so a target RTP of 90% is unreachable on a
    // case priced below `cheapest / 0.9` or above `priciest / 0.9`. That is
    // not a broken case, it is a price the loot table cannot support — the
    // survey's free cases are the obvious example, priced at nothing while
    // holding real skins. The price is then clamped into the window that does
    // work, and every clamp is reported rather than quietly applied.
    const prices = priced.map((p) => p.price);
    const floor = Math.ceil(Math.min(...prices) / targetRtp);
    const ceiling = Math.floor(Math.max(...prices) / targetRtp);

    // A survey case priced at nothing is a free case, and this project has
    // them: it costs zero and is rationed by a top-up threshold and a daily
    // cooldown instead. The thresholds are not in the survey and are not
    // invented here — they are operator policy, and an upsert that omits them
    // leaves whatever the operator set.
    const isFree = entry.price === 0;

    // The solver still needs a price, even for a free case: it is what shapes
    // the curve that makes cheap skins common and knives rare. The cheapest
    // price the table supports is used as that reference and then thrown
    // away — the case is saved at zero.
    let price = isFree ? floor : toMinor(entry.price);

    if (!isFree && (price < floor || price > ceiling)) {
      const clamped = Math.min(Math.max(price, floor), ceiling);
      problems.push(
        `${entry.slug} (${entry.name}): price ${entry.price} -> ` +
          `${(clamped / 100).toFixed(2)} — at ${targetRtp * 100}% RTP this table ` +
          `only works between ${(floor / 100).toFixed(2)} and ${(ceiling / 100).toFixed(2)}`,
      );
      price = clamped;
    }

    const balanced = autoBalance(priced, price, targetRtp);
    if (!balanced.ok) {
      skipped += 1;
      problems.push(`${entry.slug}: ${balanced.reason}`);
      continue;
    }

    // `ranges` comes back index-aligned with the items that went in, which is
    // what pairs an item id with the odds the solver gave it.
    const table = priced.map((p, i) => ({
      itemId: p.itemId,
      rangeFrom: balanced.ranges[i]!.rangeFrom,
      rangeTo: balanced.ranges[i]!.rangeTo,
    }));

    // `actualRtp`, not the target: rounding shares to whole tickets moves the
    // number, and the one that gets judged has to be the one players face.
    //
    // A free case is exempt, because it has no RTP to judge: nothing is
    // staked, and the reference price above was scaffolding for the curve
    // rather than a claim about what the case costs. This is what used to
    // drop three of the survey's free cases on the floor.
    if (!isFree) {
      const verdict = judgeRtp(balanced.actualRtp);
      if (!verdict.allowed) {
        skipped += 1;
        problems.push(`${entry.slug}: ${verdict.message}`);
        continue;
      }
    }

    // The description is written from the table that was actually balanced,
    // not from the survey's item list: the two differ whenever an item failed
    // to resolve or was dropped by the cap, and a paragraph promising a knife
    // the case cannot drop is worse than no paragraph.
    const byId = new Map(dbItems.map((i) => [i.id, i] as const));
    const copy = renderCaseCopy({
      name: entry.name,
      categorySlug: shelf,
      items: table.flatMap((i) => {
        const item = byId.get(i.itemId);
        if (!item) return [];
        return [
          {
            name: item.name,
            marketHashName: item.marketHashName,
            rarity: item.rarity,
            price: item.priceOverride ?? item.marketPrice,
          },
        ];
      }),
    });

    // Drawn before the upsert, so a case is never saved pointing at a picture
    // that does not exist. The file is rewritten every run: it is derived from
    // the slug, the name and the price, and all three can change.
    let imageUrl: string | null = null;
    if (drawArt) {
      writeFileSync(
        path.join(artDir, `${entry.slug}.svg`),
        renderCaseArt({
          slug: entry.slug,
          name: entry.name,
          categorySlug: shelf,
          priceMinor: price,
        }),
        'utf8',
      );
      imageUrl = caseArtUrl(entry.slug);
      drawn += 1;
    }

    await admin.upsertCase(
      actor.id,
      {
        categorySlug: shelf,
        slug: entry.slug,
        name: entry.name,
        // An English name is not in the survey; the slug is a poor label, so
        // the Russian name stands in both places until somebody translates it.
        nameEn: null,
        description: copy.description,
        descriptionEn: copy.descriptionEn,
        price: isFree ? 0 : price,
        isFree,
        // Our own drawing, not a borrowed picture. Passing null instead would
        // let the price synchronisation fall back to the priciest item's
        // image, which is how the hand-made cases look — but two hundred
        // imported cases all wearing a Steam screenshot read as a spreadsheet
        // rather than a catalogue.
        imageUrl,
        isActive: true,
        sortOrder: index,
        items: table,
      },
      null,
    );

    created += 1;
    logger.log(
      `  ${index + 1}/${selection.length} ${entry.name}: ${table.length} items, ` +
        (isFree
          ? 'free'
          : `${(price / 100).toFixed(2)}, RTP ${(balanced.actualRtp * 100).toFixed(1)}%`) +
        ` (+${imported.imported} new items)`,
    );
  }

  logger.log(
    `Done: ${created} case(s) imported, ${skipped} skipped` +
      (drawArt ? `, ${drawn} picture(s) drawn into ${artDir}` : ', artwork skipped'),
  );
  for (const problem of problems.slice(0, 40)) logger.warn(`  ${problem}`);
  if (problems.length > 40) logger.warn(`  ... and ${problems.length - 40} more`);

  await app.close();
}

void main();
