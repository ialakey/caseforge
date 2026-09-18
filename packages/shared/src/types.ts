export const ItemRarity = {
  CONSUMER: 'CONSUMER',
  INDUSTRIAL: 'INDUSTRIAL',
  MILSPEC: 'MILSPEC',
  RESTRICTED: 'RESTRICTED',
  CLASSIFIED: 'CLASSIFIED',
  COVERT: 'COVERT',
  EXTRAORDINARY: 'EXTRAORDINARY',
} as const;
export type ItemRarity = (typeof ItemRarity)[keyof typeof ItemRarity];

/** CS2 rarity colours — used by the front end and by image generation alike. */
export const RARITY_COLORS: Record<ItemRarity, string> = {
  CONSUMER: '#b0c3d9',
  INDUSTRIAL: '#5e98d9',
  MILSPEC: '#4b69ff',
  RESTRICTED: '#8847ff',
  CLASSIFIED: '#d32ce6',
  COVERT: '#eb4b4b',
  EXTRAORDINARY: '#ffd700',
};

export const UserRole = {
  USER: 'USER',
  ANALYST: 'ANALYST',
  SUPPORT: 'SUPPORT',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export interface PublicUser {
  id: string;
  steamId64: string;
  username: string;
  avatarUrl: string | null;
  role: UserRole;
  balance: number;
  tradeUrl: string | null;
}

export interface CaseItemView {
  id: string;
  itemId: string;
  marketHashName: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
  chance: number;
  rangeFrom: number;
  rangeTo: number;
}

/** A shelf in the catalogue, as the storefront and the panel both read it. */
export interface CaseCategoryView {
  id: string;
  slug: string;
  name: string;
  /** English display name; falls back to `name` when absent. */
  nameEn: string | null;
  sortOrder: number;
}

export interface CaseView {
  id: string;
  slug: string;
  name: string;
  /** English display name; falls back to `name` when absent. */
  nameEn: string | null;
  /**
   * The paragraph under the title, and its English counterpart. Both nullable:
   * the storefront omits the paragraph rather than printing a placeholder.
   */
  description: string | null;
  descriptionEn: string | null;
  price: number;
  imageUrl: string | null;
  isActive: boolean;
  /**
   * The shelf it sits on, or null for an ungrouped case. Null is not an error
   * state: the storefront gathers ungrouped cases into a shelf of their own so
   * a case can never become unreachable by losing its category.
   */
  category: CaseCategoryView | null;
  items: CaseItemView[];
}

export interface OpenCaseResult {
  openingId: string;
  item: CaseItemView;
  inventoryItemId: string;
  roll: number;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
}

/**
 * Result of opening a batch of cases.
 *
 * The balance is deliberately hoisted out of the individual opening: with ten
 * cases the intermediate balances mean nothing — only the total after the whole
 * batch matters.
 */
export interface OpenCaseBatchResult {
  openings: OpenCaseResult[];
  balanceAfter: number;
  /** What was actually charged, after any bonus. */
  totalSpent: number;
  totalWon: number;
  /**
   * The wheel voucher this opening spent, if there was one. Present so the
   * interface can say what happened to a reward the player had been sitting
   * on rather than silently charging them less.
   */
  bonusApplied: {
    segmentKey: string;
    kind: string;
    value: number;
    /** How much it took off, in minor units. */
    saving: number;
  } | null;
}

/** How many cases may be opened at once. */
export const MAX_CASES_PER_OPEN = 10;
export const OPEN_COUNT_PRESETS = [1, 2, 3, 5, 10] as const;

export interface LiveDrop {
  openingId: string;
  username: string;
  avatarUrl: string | null;
  caseName: string;
  caseSlug: string;
  itemName: string;
  itemImageUrl: string | null;
  rarity: ItemRarity;
  price: number;
  createdAt: string;
}

/** WebSocket event names shared by the server and the client. */
export const WS_EVENTS = {
  DROPS_BATCH: 'drops:batch',
  BALANCE_UPDATED: 'user:balance',
  WITHDRAWAL_UPDATED: 'user:withdrawal',
  /**
   * A battle appeared, filled a seat, was played or was called off. Broadcast
   * to everybody: the lobby is a shared room, and a seat taken in one tab has
   * to disappear from every other one.
   */
  BATTLE_UPDATED: 'battle:updated',
} as const;
