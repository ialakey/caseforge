/**
 * Is the replica actually streaming, and how far behind is it?
 *
 * Both halves of the answer live in different places: the primary knows who is
 * connected and how much WAL they have acknowledged, and only the standby
 * knows when it last replayed anything. A replica can be connected and still
 * minutes behind on replay, which is exactly the state that makes a cached
 * report wrong, so both are printed.
 *
 * Run:  pnpm infra:replica:status
 */
import { execFileSync } from 'node:child_process';

const PRIMARY = process.env.PG_CONTAINER ?? 'csgo_case_pg';
const REPLICA = process.env.PG_REPLICA_CONTAINER ?? 'csgo_case_pg_replica';
const DB_USER = process.env.POSTGRES_USER ?? 'csgo';
const DB_NAME = process.env.POSTGRES_DB ?? 'csgo_case';

function psql(container, user, sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', user, '-d', DB_NAME, '-tAF', ' | ', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

try {
  const senders = psql(
    PRIMARY,
    DB_USER,
    `SELECT application_name, client_addr, state, sync_state,
            pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_bytes_behind
     FROM pg_stat_replication`,
  );
  console.log('\nPrimary — pg_stat_replication:');
  console.log(senders === '' ? '  (nobody is streaming)' : '  ' + senders.replace(/\n/g, '\n  '));
} catch (err) {
  console.error(`Could not ask the primary (${PRIMARY}): ${String(err).split('\n')[0]}`);
  process.exit(1);
}

try {
  const standby = psql(
    REPLICA,
    'replicator',
    `SELECT pg_is_in_recovery() AS in_recovery,
            COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::numeric(10,3), 0)
              AS lag_seconds,
            pg_last_wal_replay_lsn() AS replayed_to`,
  );
  console.log('\nReplica:');
  console.log('  ' + standby.replace(/\n/g, '\n  '));
  console.log(
    '\nLag is measured against the last transaction the standby replayed, so an idle\n' +
      'primary makes it grow: nothing new to replay is not the same as falling behind.\n',
  );
} catch (err) {
  console.error(
    `\nCould not ask the replica (${REPLICA}): ${String(err).split('\n')[0]}\n` +
      'Start it with pnpm infra:up:scale, and run pnpm infra:replica:init first.',
  );
  process.exit(1);
}
