/**
 * The DoctorMcKay ecosystem is plain JavaScript and ships no types.
 * Only the slice of the API the worker actually uses is declared here — more
 * honest than an `any` over the whole module: a drift from the real library
 * surfaces at compile time rather than in production on the first withdrawal.
 */

declare module 'steam-user' {
  class SteamUser {
    logOn(details: { accountName: string; password: string; twoFactorCode?: string }): void;
    logOff(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
  }
  export = SteamUser;
}

declare module 'steamcommunity' {
  class SteamCommunity {
    setCookies(cookies: string[]): void;
    startConfirmationChecker(pollInterval: number, identitySecret: string): void;
    acceptConfirmationForObject(
      identitySecret: string,
      objectId: string,
      callback: (err?: Error) => void,
    ): void;
  }
  export = SteamCommunity;
}

declare module 'steam-totp' {
  const SteamTotp: {
    generateAuthCode(sharedSecret: string): string;
    getConfirmationKey(identitySecret: string, time: number, tag: string): string;
    time(offset?: number): number;
  };
  export = SteamTotp;
}

declare module 'steam-tradeoffer-manager' {
  interface TradeOffer {
    id: string;
    escrowEnds: Date | null;
    state: number;
    addMyItem(item: { appid: number; contextid: string; assetid: string }): void;
    /** Asks for an item out of the *other* side's inventory — a deposit. */
    addTheirItem(item: { appid: number; contextid: string; assetid: string }): void;
    setMessage(message: string): void;
    send(callback: (err: Error | null, status: string) => void): void;
  }

  class TradeOfferManager {
    constructor(options: {
      steam: unknown;
      community?: unknown;
      language?: string;
      pollInterval?: number;
    });
    setCookies(cookies: string[], callback: (err?: Error) => void): void;
    createOffer(tradeUrlOrSteamId: string): TradeOffer;
    getOffer(id: string, callback: (err: Error | null, offer: TradeOffer) => void): void;
    getUserDetails(
      tradeUrl: string,
      callback: (err: Error | null, me: unknown, them: { escrowDays: number }) => void,
    ): void;
    getInventoryContents(
      appid: number,
      contextid: number,
      tradableOnly: boolean,
      callback: (
        err: Error | null,
        inventory: Array<{ assetid: string; market_hash_name: string }>,
      ) => void,
    ): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export = TradeOfferManager;
}
