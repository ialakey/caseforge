import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseRedisUrl } from './redis-url.ts';

test('a bare url is host and port', () => {
  assert.deepEqual(parseRedisUrl('redis://localhost:6380'), {
    host: 'localhost',
    port: 6380,
  });
});

test('a url without a port gets the default one', () => {
  assert.equal(parseRedisUrl('redis://redis').port, 6379);
});

test('the password survives, which is the whole point', () => {
  const options = parseRedisUrl('redis://:s3cret@redis.internal:6379');
  assert.equal(options.password, 's3cret');
  assert.equal(options.username, undefined);
});

test('a username is carried too when there is one', () => {
  const options = parseRedisUrl('redis://default:s3cret@redis.internal:6379');
  assert.equal(options.username, 'default');
  assert.equal(options.password, 's3cret');
});

test('a percent-encoded password is decoded', () => {
  assert.equal(parseRedisUrl('redis://:p%40ss%3Aword@host:6379').password, 'p@ss:word');
});

test('the path is the database number', () => {
  assert.equal(parseRedisUrl('redis://host:6379/3').db, 3);
});

test('no path and a bare slash both mean the default database', () => {
  assert.equal(parseRedisUrl('redis://host:6379').db, undefined);
  assert.equal(parseRedisUrl('redis://host:6379/').db, undefined);
});

test('rediss asks for TLS', () => {
  assert.deepEqual(parseRedisUrl('rediss://host:6380').tls, {});
  assert.equal(parseRedisUrl('redis://host:6380').tls, undefined);
});
