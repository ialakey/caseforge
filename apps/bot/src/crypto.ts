import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Bot secrets (password, shared_secret, identity_secret) are effectively the
 * keys to the till: with them one can sign into the account and drain the whole
 * inventory. They are stored encrypted, and the key lives only in the worker's
 * environment.
 *
 * AES-256-GCM was chosen for its built-in authentication: tampering with the
 * ciphertext in the database is detected on decrypt instead of yielding
 * garbage.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.BOT_SECRETS_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BOT_SECRETS_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

/** Returns base64 of iv || authTag || ciphertext. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Corrupted bot secret ciphertext');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
