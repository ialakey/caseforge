import { createHash, createHmac, randomBytes } from 'node:crypto';
import { TICKET_SPACE, rollFromHmac } from './tickets.ts';

/**
 * Server side of the provably fair scheme.
 *
 * Uses `node:crypto`, so it is exposed only through the `@caseforge/shared/node`
 * subpath and never reaches the browser bundle. The client-side re-check lives
 * in ./verify.ts on top of Web Crypto.
 */

/** Server seed: 32 random bytes in hex. */
export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

/** Default client seed, used until the player sets their own. */
export function generateClientSeed(): string {
  return randomBytes(8).toString('hex');
}

/** Published before play; the server seed itself is revealed only on rotation. */
export function hashServerSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Roll of an opening.
 *
 * roll = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`) -> first 4 bytes -> % TICKET_SPACE
 */
export function computeRoll(serverSeed: string, clientSeed: string, nonce: number): number {
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`nonce must be a non-negative integer, got ${nonce}`);
  }
  const hmac = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return rollFromHmac(hmac);
}

/** Synchronous recomputation of an opening — used by the server and by tests. */
export function verifyOpening(params: {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  expectedRoll: number;
}): { hashMatches: boolean; rollMatches: boolean; computedRoll: number } {
  const computedRoll = computeRoll(params.serverSeed, params.clientSeed, params.nonce);
  return {
    hashMatches: hashServerSeed(params.serverSeed) === params.serverSeedHash,
    rollMatches: computedRoll === params.expectedRoll,
    computedRoll,
  };
}

export { TICKET_SPACE };
