/**
 * Writes a case its paragraph, in both locales.
 *
 * The surveyed site has no descriptions — its case pages carry a name, a price
 * and a grid of contents, nothing else — so there is no prose to import and
 * this composes it instead. What makes the result worth reading rather than
 * filler is that every clause is a fact about the loot table that was just
 * balanced: how many items are in it, what the best outcome is, which rarities
 * it spans, whether a knife or a pair of gloves is actually reachable.
 *
 * One thing is deliberately left out: the price. A description is written once
 * and the price is not — the solver raises it when the loot table cannot
 * support it, an operator discounts it, and every player reads it in their own
 * currency. A sentence with a number in it would be wrong within a week, so
 * the paragraph describes the contents and lets the price label do its own job.
 */
import { type ItemRarity } from '@prisma/client';

/** Ordered floor to ceiling, so a loot table's span can be read off it. */
const RARITY_ORDER: ItemRarity[] = [
  'CONSUMER',
  'INDUSTRIAL',
  'MILSPEC',
  'RESTRICTED',
  'CLASSIFIED',
  'COVERT',
  'EXTRAORDINARY',
];

/**
 * Two forms per tier, because the sentence needs both.
 *
 * `from` is the genitive the range sentence takes — «от армейского до
 * тайного» — and `nominative` is the label a single-tier case is described
 * with. One form cannot do both jobs without producing «предметов тайное».
 */
const RARITY_RU: Record<ItemRarity, { from: string; nominative: string }> = {
  CONSUMER: { from: 'ширпотреба', nominative: 'ширпотреб' },
  INDUSTRIAL: { from: 'промышленного', nominative: 'промышленное' },
  MILSPEC: { from: 'армейского', nominative: 'армейское' },
  RESTRICTED: { from: 'запрещённого', nominative: 'запрещённое' },
  CLASSIFIED: { from: 'засекреченного', nominative: 'засекреченное' },
  COVERT: { from: 'тайного', nominative: 'тайное' },
  EXTRAORDINARY: { from: 'экстраординарного', nominative: 'экстраординарное' },
};

const RARITY_EN: Record<ItemRarity, string> = {
  CONSUMER: 'Consumer Grade',
  INDUSTRIAL: 'Industrial Grade',
  MILSPEC: 'Mil-Spec',
  RESTRICTED: 'Restricted',
  CLASSIFIED: 'Classified',
  COVERT: 'Covert',
  EXTRAORDINARY: 'Extraordinary',
};

/**
 * The opening sentence, by shelf.
 *
 * Keyed by our category slugs. Each shelf gets its own framing because the
 * shelves genuinely differ in what a player wants to know first: on a free
 * case that it costs nothing, on an ALL IN case that it is one weapon and a
 * wide spread, on a collection that the contents are a real CS2 collection.
 */
const OPENING: Record<string, { ru: (name: string) => string; en: (name: string) => string }> = {
  // The survey calls this shelf "free cases", and here they are not free:
  // a case price must be positive, and the solver raises anything priced
  // below its own cheapest skin. So the copy promises the cheapest entry
  // rather than a free one — the shelf keeps the source's name, but a
  // paragraph that told a player this costs nothing would simply be a lie.
  free: {
    ru: () => 'Стартовый кейс: самый дешёвый вход — минимальная ставка и живой набор скинов.',
    en: () => 'An entry-level case: the cheapest way in, with a real line-up inside.',
  },
  rarity: {
    ru: (name) => `Кейс одного класса редкости: «${name}» собран по раритетности.`,
    en: (name) => `A single-rarity case: “${name}” is built by grade.`,
  },
  standard: {
    ru: (name) => `Классический кейс CS2 «${name}» с оригинальным набором предметов.`,
    en: (name) => `The classic CS2 case “${name}”, with its original line-up.`,
  },
  house: {
    ru: (name) => `Авторская сборка «${name}» — набор собран вручную, а не взят из игры.`,
    en: (name) => `“${name}” is a house build: the line-up is hand-picked, not taken from the game.`,
  },
  weapons: {
    ru: (name) => `Кейс на одно оружие: в «${name}» падают только его скины.`,
    en: (name) => `A single-weapon case: “${name}” drops nothing but its own skins.`,
  },
  creators: {
    ru: (name) => `Кейс от автора — «${name}» собран под его аудиторию.`,
    en: (name) => `A creator case: “${name}” is built for their audience.`,
  },
  farm: {
    ru: () => 'Фарм-кейс: минимальная ставка, частые дропы, длинная дистанция.',
    en: () => 'A farm case: a minimal stake, frequent drops, and a long grind.',
  },
  'all-in': {
    ru: (name) => `ALL IN — «${name}» с широким разбросом: дешёвый пол и дорогой потолок.`,
    en: (name) => `ALL IN: “${name}” has a wide spread — a cheap floor and an expensive ceiling.`,
  },
  collections: {
    ru: (name) => `Коллекция «${name}» — предметы из одноимённого набора CS2.`,
    en: (name) => `The “${name}” collection: items from the CS2 set of the same name.`,
  },
};

export interface CopyItem {
  /** Localised name, as the base locale shows it. */
  name: string;
  /** English `market_hash_name`. */
  marketHashName: string;
  rarity: ItemRarity;
  price: number;
}

/**
 * True when an item is a knife or a pair of gloves.
 *
 * Worth its own sentence: for most players the only question about a case is
 * whether a knife can come out of it, and the answer is in the loot table
 * rather than in the name. Detected from the market name — Steam marks both
 * with a star — rather than from rarity, because `EXTRAORDINARY` covers
 * gloves and knives but a knife is also what `★` always means.
 */
function isSpecial(item: CopyItem): boolean {
  return item.marketHashName.startsWith('★') || item.rarity === 'EXTRAORDINARY';
}

/** Russian plural for «предмет», which needs three forms. */
function itemsRu(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} предметов`;
  if (mod10 === 1) return `${count} предмет`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} предмета`;
  return `${count} предметов`;
}

export interface CaseCopyInput {
  name: string;
  categorySlug: string | null;
  /** The balanced loot table — the description is written from it. */
  items: CopyItem[];
}

/**
 * Composes the description in both locales.
 *
 * Three sentences at most: what kind of case it is, what is in it, and what
 * the best outcome is. A fourth would be padding — the contents grid sits
 * directly under the paragraph and says everything else better.
 */
export function renderCaseCopy(input: CaseCopyInput): {
  description: string;
  descriptionEn: string;
} {
  const items = [...input.items].sort((a, b) => b.price - a.price);
  const best = items[0];

  const opening =
    OPENING[input.categorySlug ?? ''] ??
    ({
      ru: (name: string) => `Кейс «${name}».`,
      en: (name: string) => `The “${name}” case.`,
    } as const);

  const ru: string[] = [opening.ru(input.name)];
  const en: string[] = [opening.en(input.name)];

  // The span, described by its two ends. Naming every rarity present would
  // list five words the contents grid already colour-codes.
  const present = RARITY_ORDER.filter((r) => items.some((i) => i.rarity === r));
  const floor = present[0];
  const ceiling = present[present.length - 1];

  if (floor && ceiling && floor !== ceiling) {
    ru.push(
      `Внутри ${itemsRu(items.length)} — от ${RARITY_RU[floor].from} ` +
        `до ${RARITY_RU[ceiling].from}.`,
    );
    en.push(
      `${items.length} item${items.length === 1 ? '' : 's'} inside, ` +
        `from ${RARITY_EN[floor]} to ${RARITY_EN[ceiling]}.`,
    );
  } else if (ceiling) {
    ru.push(`Внутри ${itemsRu(items.length)} класса «${RARITY_RU[ceiling].nominative}».`);
    en.push(
      `${items.length} ${RARITY_EN[ceiling]} item${items.length === 1 ? '' : 's'} inside.`,
    );
  }

  if (best) {
    const specials = items.filter(isSpecial).length;
    if (specials > 0) {
      ru.push(
        `Лучший дроп — ${best.name}; ножи и перчатки в наборе есть (${specials} шт.).`,
      );
      en.push(
        `Top drop: ${best.marketHashName} — and knives or gloves are in the pool (${specials}).`,
      );
    } else {
      ru.push(`Лучший дроп — ${best.name}.`);
      en.push(`Top drop: ${best.marketHashName}.`);
    }
  }

  return { description: ru.join(' '), descriptionEn: en.join(' ') };
}
