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
  /**
   * The free-case terms, or null for an ordinary paid case.
   *
   * Part of the public case view because the terms are not a secret — a
   * visitor who is not signed in should still be able to read what a free
   * case would cost them in top-ups before deciding to register. What is
   * absent here is the viewer's own standing against those terms, which is
   * per-player and therefore lives behind authentication.
   */
  free: FreeCaseTerms | null;
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
  /**
   * Who won it. Carried so the feed can link to their profile without a
   * lookup per card. Nullable because the feed is replayed from a Redis
   * backlog that predates this field: an old entry links nowhere rather than
   * breaking the strip.
   */
  userId: string | null;
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

/** What a free case asks of a player before it opens. */
export interface FreeCaseTerms {
  /** Minimum top-up over the last 24 hours, in minor units; 0 means none. */
  minDeposit: number;
  /** How many openings are allowed within a rolling 24 hours. */
  maxOpens: number;
}

/**
 * One player measured against one free case's terms.
 *
 * Every number is over the same rolling 24 hours the terms are written in, so
 * the page can show the shortfall rather than only a refusal.
 */
export interface FreeCaseStatus {
  caseSlug: string;
  terms: FreeCaseTerms;
  /** Topped up by this player over the last 24 hours, in minor units. */
  deposited: number;
  /** Openings of this case by this player over the last 24 hours. */
  opened: number;
  canOpen: boolean;
  /**
   * When the oldest opening in the window falls out of it, which is the
   * moment another one becomes available. Null when the limit is not what is
   * blocking them — including when nothing is.
   */
  nextOpenAt: string | null;
}

/**
 * A player as a stranger sees them.
 *
 * Deliberately thin. Everything about a player that is nobody else's business
 * — balance, trade URL, transactions, top-ups, inventory — is absent by
 * construction rather than by filtering, so a field cannot leak into it by
 * somebody widening a `select` somewhere else.
 */
export interface PublicProfileView {
  id: string;
  username: string;
  avatarUrl: string | null;
  steamId: string | null;
  /** When they joined; the page shows the month, not the day. */
  createdAt: string;
  /** Their recent notable drops — the same ones the live feed would show. */
  drops: LiveDrop[];
}

/** One skin in the player's own Steam inventory, as the deposit page lists it. */
export interface DepositCandidate {
  /** The asset in the player's Steam inventory; the offer is built from these. */
  assetId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  exterior: string | null;
  /** What the market says it is worth, in minor units. */
  marketPrice: number;
  /** What the site would credit for it, after the payout rate. */
  payout: number;
  /**
   * Why it cannot be deposited, or null when it can. A skin Steam marks as
   * untradable, or one with no price, is listed rather than hidden: a player
   * whose knife is missing from the list needs to know it is the trade hold
   * and not a bug.
   */
  blockedReason: 'untradable' | 'no-price' | null;
}

/** What the player would get for a selection, before they commit to it. */
export interface DepositQuote {
  items: DepositCandidate[];
  total: number;
  /** The payout rate the quote was made at, in basis points. */
  rateBps: number;
  minValue: number;
  maxItems: number;
}

export type ItemDepositStatus =
  | 'PENDING'
  | 'OFFER_SENT'
  | 'ACCEPTED'
  | 'CREDITED'
  | 'DECLINED'
  | 'FAILED'
  | 'CANCELLED';

/** A deposit request as the player is shown it. */
export interface ItemDepositView {
  id: string;
  status: ItemDepositStatus;
  totalValue: number;
  rateBps: number;
  tradeOfferId: string | null;
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  items: Array<{
    assetId: string;
    marketHashName: string;
    imageUrl: string | null;
    rarity: ItemRarity;
    marketPrice: number;
    payout: number;
  }>;
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
