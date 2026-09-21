/**
 * `REDIS_URL` as connection options.
 *
 * ioredis takes the URL as it stands, so most of this project hands it over
 * untouched. BullMQ does not: its `connection` is an options object, and a
 * queue built from `{ host, port }` alone quietly loses the password, the
 * database number and the TLS that `rediss://` asked for. On a laptop, where
 * Redis has no password and only one database, that difference is invisible —
 * which is exactly why it has to be got right here rather than discovered on
 * the first deployment whose Redis wants a password, when the symptom is a
 * withdrawal queue that accepts jobs nobody ever runs.
 *
 * No `node:*` imports, so this stays part of the isomorphic entry point.
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

/** Redis' own default, used when the URL names no port. */
const DEFAULT_REDIS_PORT = 6379;

export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);

  const options: RedisConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_REDIS_PORT : Number(parsed.port),
  };

  // `redis://:secret@host` is the ordinary form — no user, just a password —
  // so an empty username is left out rather than sent as "".
  if (parsed.username !== '') options.username = decodeURIComponent(parsed.username);
  if (parsed.password !== '') options.password = decodeURIComponent(parsed.password);

  // The path is the database number: "/2", or "/" and nothing for the default.
  const db = parsed.pathname.replace(/^\//, '');
  if (db !== '' && Number.isInteger(Number(db))) options.db = Number(db);

  // An empty object is how ioredis is told to connect over TLS with the
  // platform's own trust store, which is what `rediss://` means.
  if (parsed.protocol === 'rediss:') options.tls = {};

  return options;
}
