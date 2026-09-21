/**
 * End-to-end smoke test for case battles and referrals, against a LIVE API.
 *
 * Covers what the unit tests cannot: that a seat is really paid for, that a
 * full battle really rolls every player's drops from their own seed pair, that
 * the winner really ends up owning all of them, that a cancelled battle gives
 * the money back, and that a referral commission is accrued and paid exactly
 * once.
 *
 * Run:  node test/battle-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run, at least one
 * case in the catalogue and the API running on port 4000.
 */
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { TICKET_SPACE, battleStandings } from '@caseforge/shared';

config({ path: path.join(import.meta.dirname, '../../../.env') });

const API = 'http://localhost:4000';

/**
 * The cheapest case a player can actually buy.
 *
 * Not simply the cheapest: a free case is priced at 0 and therefore sorts
 * first, but it is rationed by a deposit threshold and a 24-hour opening limit
 * rather than by a price. Opening one here is refused outright, and a battle
 * built from one has an entry price of nothing — which is a wager no
 * commission can be a share of.
 */
function cheapestPaid(cases) {
  const paid = cases.filter((c) => c.price > 0 && !c.free);
  if (paid.length === 0) {
    throw new Error('No purchasable case in the catalogue — run pnpm seed:cases');
  }
  return paid.reduce((a, b) => (a.price <= b.price ? a : b));
}

/** HS256 by hand — see the note in smoke.mjs. */
function signJwt(payload, secret, ttlSeconds = 900) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSeconds });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const prisma = new PrismaClient();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ok: ' + msg);
  } else {
    failures += 1;
    console.log('  FAILED: ' + msg);
  }
}

/**
 * A throwaway player with a balance and a seed pair.
 *
 * The balance is granted through the ledger rather than by writing the column,
 * so the nightly reconciliation still agrees while the test is running.
 */
const created = [];
async function makePlayer(label, balance) {
  const steamId64 = `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
  const user = await prisma.user.create({
    data: { steamId64, username: `smoke-${label}-${randomUUID().slice(0, 6)}`, balance },
  });
  const seed = randomBytes(32).toString('hex');
  await prisma.serverSeed.create({
    data: {
      userId: user.id,
      seed,
      seedHash: createHash('sha256').update(seed).digest('hex'),
      isActive: true,
    },
  });
  await prisma.clientSeed.create({
    data: { userId: user.id, seed: randomBytes(8).toString('hex'), isActive: true },
  });
  if (balance > 0) {
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'ADMIN_ADJUSTMENT',
        amount: balance,
        balanceAfter: balance,
        comment: 'smoke test float',
      },
    });
  }
  created.push(user.id);

  const token = signJwt(
    { sub: user.id, steamId64: user.steamId64, role: user.role },
    process.env.JWT_ACCESS_SECRET,
  );
  return {
    user,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

const json = async (res) => {
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const cases = await (await fetch(`${API}/api/cases`)).json();
if (!Array.isArray(cases) || cases.length === 0) {
  throw new Error('No cases in the catalogue — run pnpm seed:cases');
}
const cheapest = cheapestPaid(cases);
const ROUNDS = 2;
const entryPrice = cheapest.price * ROUNDS;

console.log(`\nUsing "${cheapest.name}" at ${cheapest.price}, ${ROUNDS} rounds per seat`);

const host = await makePlayer('host', entryPrice * 4);
const rival = await makePlayer('rival', entryPrice * 4);

console.log('\n1. The lobby is public, creating a battle is not');
{
  const anon = await fetch(`${API}/api/battles`);
  assert(anon.status === 200, `anonymous lobby answered ${anon.status}`);

  const refused = await fetch(`${API}/api/battles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slots: 2, cases: [{ caseId: cheapest.id, count: ROUNDS }] }),
  });
  assert(refused.status === 401, `anonymous create refused with ${refused.status}`);
}

console.log('\n2. Creating a battle charges the host for a seat');
let battleId;
{
  const before = (await prisma.user.findUnique({ where: { id: host.user.id } })).balance;
  const { status, body } = await json(
    await fetch(`${API}/api/battles`, {
      method: 'POST',
      headers: host.headers,
      body: JSON.stringify({
        mode: 'STANDARD',
        slots: 2,
        cases: [{ caseId: cheapest.id, count: ROUNDS }],
      }),
    }),
  );
  assert(status === 201 || status === 200, `create answered ${status}`);
  battleId = body?.battle?.id;

  assert(body?.battle?.status === 'WAITING', 'the battle is waiting for a rival');
  assert(body?.battle?.entryPrice === entryPrice, `entry price is ${entryPrice}`);
  assert(body?.battle?.rounds === ROUNDS, `the battle has ${ROUNDS} rounds`);
  assert(body?.battle?.filledSlots === 1, 'the host took the first seat');
  assert(body?.balanceAfter === before - entryPrice, 'the host was charged exactly the entry');

  const entry = await prisma.transaction.findFirst({
    where: { userId: host.user.id, type: 'BATTLE_ENTRY', referenceId: battleId },
  });
  assert(entry?.amount === -entryPrice, 'the debit went through the ledger as BATTLE_ENTRY');
}

console.log('\n3. A seat cannot be taken twice, and not without money');
{
  const again = await json(
    await fetch(`${API}/api/battles/${battleId}/join`, {
      method: 'POST',
      headers: host.headers,
    }),
  );
  assert(again.body?.code === 'BATTLE_ALREADY_JOINED', 'the host cannot join their own battle twice');

  const pauper = await makePlayer('pauper', 0);
  const broke = await json(
    await fetch(`${API}/api/battles/${battleId}/join`, {
      method: 'POST',
      headers: pauper.headers,
    }),
  );
  assert(broke.body?.code === 'INSUFFICIENT_FUNDS', 'an empty balance cannot take a seat');
  assert(
    (await prisma.battlePlayer.count({ where: { battleId } })) === 1,
    'the refused join left the battle with one seat',
  );
}

console.log('\n4. The last seat plays the battle out');
{
  const { body } = await json(
    await fetch(`${API}/api/battles/${battleId}/join`, {
      method: 'POST',
      headers: rival.headers,
    }),
  );
  const battle = body?.battle;
  assert(battle?.status === 'FINISHED', 'filling the last seat settled the battle');
  assert(battle?.drops?.length === ROUNDS * 2, `there are ${ROUNDS * 2} drops`);

  // Every drop is an ordinary opening, rolled from the opening player's own
  // seed pair. That is the whole fairness claim of a battle, so it is checked
  // by recomputing the roll rather than by trusting the row.
  const openings = await prisma.caseOpening.findMany({
    where: { battleId },
    include: { serverSeed: true, clientSeed: true, case: { include: { items: true } } },
  });
  assert(openings.length === ROUNDS * 2, 'the openings are recorded against the battle');

  let rollsMatch = 0;
  let rangesMatch = 0;
  for (const opening of openings) {
    const hmac = createHmac('sha256', opening.serverSeed.seed)
      .update(`${opening.clientSeed.seed}:${opening.nonce}`)
      .digest('hex');
    if (parseInt(hmac.slice(0, 8), 16) % TICKET_SPACE === opening.roll) rollsMatch += 1;

    const line = opening.case.items.find((item) => item.itemId === opening.itemId);
    if (line && opening.roll >= line.rangeFrom && opening.roll <= line.rangeTo) rangesMatch += 1;
  }
  assert(rollsMatch === openings.length, 'every roll recomputes from its seed pair');
  assert(rangesMatch === openings.length, 'every drop lies inside its ticket range');

  const rounds = new Set(openings.map((o) => o.battleRound));
  assert(rounds.size === ROUNDS, 'the rounds are numbered 1..n and each was played once per seat');

  // The winner is the seat the shared rule picks, and the items follow it.
  const players = await prisma.battlePlayer.findMany({ where: { battleId } });
  const tallies = players.map((player) => ({
    slot: player.slot,
    drops: openings.filter((o) => o.userId === player.userId).map((o) => o.itemPrice),
  }));
  const expected = battleStandings(tallies, 'STANDARD')[0];
  const winner = players.find((player) => player.isWinner);
  assert(winner?.slot === expected.slot, 'the biggest total won');
  assert(winner?.totalValue === expected.total, 'the winning total was recorded');

  const inventory = await prisma.inventoryItem.findMany({
    where: { openingId: { in: openings.map((o) => o.id) } },
  });
  assert(inventory.length === openings.length, 'every drop became an inventory item');
  assert(
    inventory.every((item) => item.userId === winner.userId),
    'all of them belong to the winner, whoever rolled them',
  );

  const stored = await prisma.battle.findUnique({ where: { id: battleId } });
  const potValue = openings.reduce((sum, o) => sum + o.itemPrice, 0);
  assert(stored.totalValue === potValue, 'the pot is the sum of everything that dropped');
  assert(stored.winnerId === winner.userId, 'the battle points at the winning player');
}

console.log('\n5. A battle nobody joined gives the money back');
{
  const before = (await prisma.user.findUnique({ where: { id: host.user.id } })).balance;
  const { body } = await json(
    await fetch(`${API}/api/battles`, {
      method: 'POST',
      headers: host.headers,
      body: JSON.stringify({ slots: 2, cases: [{ caseId: cheapest.id, count: ROUNDS }] }),
    }),
  );
  const cancelled = body.battle.id;

  const foreign = await json(
    await fetch(`${API}/api/battles/${cancelled}/cancel`, {
      method: 'POST',
      headers: rival.headers,
    }),
  );
  assert(foreign.body?.code === 'BATTLE_NOT_CANCELLABLE', 'only the host may call a battle off');

  const res = await json(
    await fetch(`${API}/api/battles/${cancelled}/cancel`, {
      method: 'POST',
      headers: host.headers,
    }),
  );
  assert(res.body?.status === 'CANCELLED', 'the host cancelled it');
  const after = (await prisma.user.findUnique({ where: { id: host.user.id } })).balance;
  assert(after === before, 'the entry came back in full');

  const refund = await prisma.transaction.findFirst({
    where: { userId: host.user.id, type: 'BATTLE_REFUND', referenceId: cancelled },
  });
  assert(refund?.amount === entryPrice, 'the refund went through the ledger');
}

console.log('\n6. An invite binds once, and only to a fresh account');
let recruit;
{
  const summary = await (await fetch(`${API}/api/referral`, { headers: host.headers })).json();
  assert(typeof summary.code === 'string' && summary.code.length === 8, 'the host has an invite code');

  // Deliberately penniless: an invite only binds to an account with no
  // history at all, and the float this test hands its other players is itself
  // a ledger entry. The recruit is funded through the API a step later, which
  // is also what the deposit commission is measured on.
  recruit = await makePlayer('recruit', 0);

  const self = await json(
    await fetch(`${API}/api/referral/bind`, {
      method: 'POST',
      headers: host.headers,
      body: JSON.stringify({ code: summary.code }),
    }),
  );
  assert(self.body?.code === 'REFERRAL_SELF', 'nobody can invite themselves');

  const wrong = await json(
    await fetch(`${API}/api/referral/bind`, {
      method: 'POST',
      headers: recruit.headers,
      body: JSON.stringify({ code: 'NOSUCHCODE' }),
    }),
  );
  assert(wrong.body?.code === 'REFERRAL_CODE_INVALID', 'an unknown code is refused');

  const bound = await json(
    await fetch(`${API}/api/referral/bind`, {
      method: 'POST',
      headers: recruit.headers,
      body: JSON.stringify({ code: summary.code.toLowerCase() }),
    }),
  );
  assert(bound.status === 201 || bound.status === 200, 'the code is matched case-insensitively');

  const twice = await json(
    await fetch(`${API}/api/referral/bind`, {
      method: 'POST',
      headers: recruit.headers,
      body: JSON.stringify({ code: summary.code }),
    }),
  );
  assert(twice.body?.code === 'REFERRAL_ALREADY_BOUND', 'a second invite is refused');
}

console.log('\n7. Commission accrues on what the recruit spends, and is paid once');
{
  const depositAmount = 10_000_00;
  await fetch(`${API}/api/me/deposit`, {
    method: 'POST',
    headers: recruit.headers,
    body: JSON.stringify({ amount: depositAmount }),
  });
  await fetch(`${API}/api/cases/open`, {
    method: 'POST',
    headers: recruit.headers,
    body: JSON.stringify({ caseId: cheapest.id, count: 1 }),
  });

  const accruals = await prisma.referralEarning.findMany({
    where: { referrerId: host.user.id, refereeId: recruit.user.id },
  });
  const deposit = accruals.find((row) => row.kind === 'DEPOSIT');
  const wager = accruals.find((row) => row.kind === 'WAGER');
  assert(deposit?.amount === Math.floor((depositAmount * deposit?.rateBps) / 10_000),
    'the top-up commission is the configured share of the deposit');
  assert(wager !== undefined, 'opening a case accrued a commission too');
  assert(
    accruals.every((row) => row.claimedAt === null),
    'nothing is on the balance until it is claimed',
  );

  const pending = accruals.reduce((sum, row) => sum + row.amount, 0);
  const before = (await prisma.user.findUnique({ where: { id: host.user.id } })).balance;
  const claim = await json(
    await fetch(`${API}/api/referral/claim`, { method: 'POST', headers: host.headers }),
  );
  assert(claim.body?.amount === pending, 'the payout is everything that had accrued');

  const after = (await prisma.user.findUnique({ where: { id: host.user.id } })).balance;
  assert(after === before + pending, 'the balance moved by the payout');

  const entry = await prisma.transaction.findFirst({
    where: { userId: host.user.id, type: 'REFERRAL' },
    orderBy: { createdAt: 'desc' },
  });
  assert(entry?.amount === pending, 'the payout went through the ledger');

  const twice = await json(
    await fetch(`${API}/api/referral/claim`, { method: 'POST', headers: host.headers }),
  );
  assert(
    twice.body?.code === 'REFERRAL_NOTHING_TO_CLAIM',
    'a claimed pot cannot be claimed again',
  );
}

console.log('\n8. A cancelled battle takes its commission back with it');
{
  const { body } = await json(
    await fetch(`${API}/api/battles`, {
      method: 'POST',
      headers: recruit.headers,
      body: JSON.stringify({ slots: 2, cases: [{ caseId: cheapest.id, count: ROUNDS }] }),
    }),
  );
  const doomed = body.battle.id;
  assert(
    (await prisma.referralEarning.count({ where: { referenceId: doomed } })) === 1,
    'taking a seat accrued a commission',
  );

  await fetch(`${API}/api/battles/${doomed}/cancel`, {
    method: 'POST',
    headers: recruit.headers,
  });
  assert(
    (await prisma.referralEarning.count({ where: { referenceId: doomed } })) === 0,
    'refunding the seat removed the accrual with it',
  );
}

console.log('\n9. The ledger still agrees with every balance');
{
  // Scoped to the players this test created: a development database may
  // already carry drift from somebody editing a balance by hand, and that is
  // the nightly reconciliation's business rather than this test's.
  const mismatches = await prisma.$queryRaw`
    SELECT u.id
    FROM users u
    LEFT JOIN transactions t ON t."userId" = u.id
    WHERE u.id = ANY(CAST(${created} AS uuid[]))
    GROUP BY u.id, u.balance
    HAVING u.balance <> COALESCE(SUM(t.amount), 0)
  `;
  assert(mismatches.length === 0, 'no balance drifted away from its transactions');
}

// The throwaway players take their battles, openings, items and accruals with
// them: everything the test wrote hangs off them by a cascading foreign key.
await prisma.user.deleteMany({ where: { id: { in: created } } });
await prisma.$disconnect();

console.log(failures === 0 ? '\nAll battle and referral checks passed\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
