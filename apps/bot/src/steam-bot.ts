import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import TradeOfferManager from 'steam-tradeoffer-manager';
import SteamTotp from 'steam-totp';
import type { SteamBot } from '@prisma/client';
import { decryptSecret } from './crypto.ts';

/** CS2: appId 730, inventory context 2. */
export const CS2_APP_ID = 730;
export const CS2_CONTEXT_ID = 2;

export interface SendOfferParams {
  tradeUrl: string;
  /** assetIds of the items in the bot's inventory. */
  assetIds: string[];
  message: string;
}

export interface SendOfferResult {
  tradeOfferId: string;
  /** Steam put the offer in escrow — the item arrives in a few days. */
  escrow: boolean;
}

/**
 * Wrapper around a single Steam account in the farm.
 *
 * Three libraries instead of one is not redundancy: steam-user holds the Steam
 * client connection, steamcommunity owns the web session and the mobile
 * confirmations, and tradeoffer-manager runs on top of both.
 */
export class SteamBotClient {
  private readonly client = new SteamUser();
  private readonly community = new SteamCommunity();
  private readonly manager: TradeOfferManager;
  private readonly identitySecret: string;
  private readonly sharedSecret: string;
  private readonly record: SteamBot;

  private loggedIn = false;

  constructor(record: SteamBot) {
    this.record = record;
    this.sharedSecret = decryptSecret(record.encryptedSharedSecret);
    this.identitySecret = decryptSecret(record.encryptedIdentitySecret);

    this.manager = new TradeOfferManager({
      steam: this.client,
      community: this.community,
      language: 'en',
      // Offer status polling: Valve will not serve it any more often anyway.
      pollInterval: 10_000,
    });
  }

  get id(): string {
    return this.record.id;
  }

  get steamId64(): string {
    return this.record.steamId64;
  }

  get isReady(): boolean {
    return this.loggedIn;
  }

  async login(): Promise<void> {
    const password = decryptSecret(this.record.encryptedPassword);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.client.off('loggedOn', onLoggedOn);
        reject(err);
      };
      const onLoggedOn = () => {
        this.client.off('error', onError);
        resolve();
      };

      this.client.once('error', onError);
      this.client.once('loggedOn', onLoggedOn);

      this.client.logOn({
        accountName: this.record.username,
        password,
        twoFactorCode: SteamTotp.generateAuthCode(this.sharedSecret),
      });
    });

    // Cookies arrive in a separate event after a successful login — without
    // them neither the web session nor trade offers work.
    await new Promise<void>((resolve, reject) => {
      this.client.once('webSession', (_sessionId: string, cookies: string[]) => {
        this.manager.setCookies(cookies, (err?: Error) => {
          if (err) return reject(err);
          this.community.setCookies(cookies);
          // Mobile auto-confirmation: without it every offer would hang.
          this.community.startConfirmationChecker(20_000, this.identitySecret);
          this.loggedIn = true;
          resolve();
        });
      });
    });
  }

  logout(): void {
    this.loggedIn = false;
    this.client.logOff();
  }

  /** The bot inventory — the truth about what can actually be handed out. */
  async loadInventory(): Promise<Array<{ assetId: string; marketHashName: string }>> {
    return new Promise((resolve, reject) => {
      this.manager.getInventoryContents(
        CS2_APP_ID,
        CS2_CONTEXT_ID,
        true,
        (err: Error | null, inventory: Array<{ assetid: string; market_hash_name: string }>) => {
          if (err) return reject(err);
          resolve(
            inventory.map((i) => ({ assetId: i.assetid, marketHashName: i.market_hash_name })),
          );
        },
      );
    });
  }

  /**
   * Checks the trade hold BEFORE sending an offer.
   *
   * If the recipient has no mobile authenticator (or enabled it recently),
   * Steam holds the items in escrow for up to 15 days. Finding that out after
   * sending means a request that is formally "sent" but in fact stuck.
   */
  async getEscrowDays(tradeUrl: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.manager.getUserDetails(
        tradeUrl,
        (err: Error | null, _me: unknown, them: { escrowDays: number }) => {
          if (err) return reject(err);
          resolve(them.escrowDays);
        },
      );
    });
  }

  async sendOffer(params: SendOfferParams): Promise<SendOfferResult> {
    const offer = this.manager.createOffer(params.tradeUrl);
    for (const assetId of params.assetIds) {
      offer.addMyItem({ appid: CS2_APP_ID, contextid: String(CS2_CONTEXT_ID), assetid: assetId });
    }
    offer.setMessage(params.message);

    const status = await new Promise<string>((resolve, reject) => {
      offer.send((err: Error | null, state: string) => (err ? reject(err) : resolve(state)));
    });

    if (status === 'pending') {
      // The offer needs a mobile confirmation — confirm it ourselves.
      await new Promise<void>((resolve, reject) => {
        this.community.acceptConfirmationForObject(
          this.identitySecret,
          offer.id,
          (err?: Error) => (err ? reject(err) : resolve()),
        );
      });
    }

    return { tradeOfferId: String(offer.id), escrow: Boolean(offer.escrowEnds) };
  }

  async getOfferState(tradeOfferId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.manager.getOffer(tradeOfferId, (err: Error | null, offer: { state: number }) =>
        err ? reject(err) : resolve(offer.state),
      );
    });
  }
}

/** Steam trade offer state codes. */
export const TradeOfferState = {
  Invalid: 1,
  Active: 2,
  Accepted: 3,
  Countered: 4,
  Expired: 5,
  Canceled: 6,
  Declined: 7,
  InvalidItems: 8,
  CreatedNeedsConfirmation: 9,
  CanceledBySecondFactor: 10,
  InEscrow: 11,
} as const;
