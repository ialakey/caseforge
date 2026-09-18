/**
 * Prepares the running primary for a streaming replica.
 *
 * Two things are missing from a stock `postgres:16` container: a role allowed
 * to replicate, and a `pg_hba` line that lets it in from another container.
 * Neither can be done from `docker-compose.yml` against a database that
 * already exists — init scripts only run on an empty volume, and a dev
 * database with a seeded catalogue must not have to be thrown away to gain a
 * replica. So both are applied to the live primary here, idempotently, and the
 * configuration is reloaded rather than restarted.
 *
 * Run:  pnpm infra:replica:init
 * Then: pnpm infra:up:scale   (the replica base-backups itself on first start)
 */
import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.PG_CONTAINER ?? 'csgo_case_pg';
const DB_USER = process.env.POSTGRES_USER ?? 'csgo';
const DB_NAME = process.env.POSTGRES_DB ?? 'csgo_case';
const REPL_USER = process.env.REPLICATION_USER ?? 'replicator';
const REPL_PASSWORD = process.env.REPLICATION_PASSWORD ?? 'replica';

/** `docker exec` with the output captured, so a failure can be explained. */
function exec(args, input) {
  return execFileSync('docker', ['exec', '-i', CONTAINER, ...args], {
    encoding: 'utf8',
    input,
  }).trim();
}

function psql(sql) {
  return exec(['psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', sql]);
}

function main() {
  try {
    exec(['pg_isready', '-U', DB_USER, '-d', DB_NAME]);
  } catch {
    console.error(
      `Postgres container "${CONTAINER}" is not answering. Start it with pnpm infra:up.`,
    );
    process.exit(1);
  }

  // 1. The replication role. ALTER as well as CREATE: a role left over from an
  //    earlier run with a different password would otherwise fail the backup
  //    with an authentication error that looks like a network problem.
  const exists = psql(`SELECT 1 FROM pg_roles WHERE rolname = '${REPL_USER}'`) === '1';
  psql(
    exists
      ? `ALTER ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}'`
      : `CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}'`,
  );
  console.log(`${exists ? 'Updated' : 'Created'} the replication role "${REPL_USER}"`);

  // 2. The pg_hba line. `all` in the database column does not match a
  //    replication connection — that is the one keyword `all` excludes — so
  //    the entry the official image writes is not enough, however permissive
  //    it looks.
  const hbaPath = psql('SHOW hba_file');
  const rule = `host replication ${REPL_USER} all scram-sha-256`;
  const present = exec(['sh', '-c', `grep -Fq "${rule}" ${hbaPath} && echo yes || echo no`]);

  if (present === 'yes') {
    console.log('The replication rule is already in pg_hba.conf');
  } else {
    exec([
      'sh',
      '-c',
      `printf '\\n# added by pnpm infra:replica:init\\n%s\\n' "${rule}" >> ${hbaPath}`,
    ]);
    console.log(`Appended the replication rule to ${hbaPath}`);
  }

  // 3. Reload rather than restart: this runs against a database somebody may
  //    be using.
  psql('SELECT pg_reload_conf()');

  const walLevel = psql('SHOW wal_level');
  const senders = psql('SHOW max_wal_senders');
  console.log(`Primary ready: wal_level=${walLevel}, max_wal_senders=${senders}`);

  if (walLevel !== 'replica' && walLevel !== 'logical') {
    console.error(
      `wal_level is "${walLevel}" — a standby cannot stream from it. ` +
        'Start the primary with -c wal_level=replica.',
    );
    process.exit(1);
  }

  console.log('\nNext:');
  console.log('  pnpm infra:up:scale        # starts PgBouncer and the replica');
  console.log('  pnpm infra:replica:status  # once it has caught up');
  console.log('\nThen point the API at them:');
  console.log(
    '  DATABASE_URL="postgresql://csgo:csgo@localhost:6433/csgo_case?schema=public&pgbouncer=true"',
  );
  console.log('  DIRECT_DATABASE_URL="postgresql://csgo:csgo@localhost:5433/csgo_case?schema=public"');
  console.log('  REPLICA_DATABASE_URL="postgresql://csgo:csgo@localhost:5434/csgo_case?schema=public"');
}

main();
