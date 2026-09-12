import { rollFromHmac } from './tickets.ts';

/**
 * Client-side re-check of an opening, on Web Crypto.
 *
 * The whole point of provably fair is that the player does not have to trust
 * the server: this code runs in their browser and redoes the computation from
 * scratch. Web Crypto is asynchronous, hence the Promise — the synchronous
 * server-side twin lives in `@caseforge/shared/node`.
 */

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', data));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

export interface VerificationResult {
  hashMatches: boolean;
  rollMatches: boolean;
  computedRoll: number;
}

export async function verifyOpeningAsync(params: {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  expectedRoll: number;
}): Promise<VerificationResult> {
  const [hash, hmac] = await Promise.all([
    sha256Hex(params.serverSeed),
    hmacSha256Hex(params.serverSeed, `${params.clientSeed}:${params.nonce}`),
  ]);
  const computedRoll = rollFromHmac(hmac);

  return {
    hashMatches: hash === params.serverSeedHash,
    rollMatches: computedRoll === params.expectedRoll,
    computedRoll,
  };
}
