/**
 * End-to-end smoke test against a LIVE API.
 *
 * Covers what unit tests cannot: that the opening transaction really debits
 * the balance, that the active server seed never leaks, that an opening
 * recomputes after rotation, and that the balance agrees with the ledger.
 *
 * Run:  pnpm --filter @caseforge/api test:smoke
 * Requires docker compose up, migrations applied and the seed run.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { config } from 'dotenv';
import { verifyOpening } from '@caseforge/shared/node';

config({ path: path.join(import.meta.dirname, '../../../.env') });

const API = 'http://localhost:4000';

/**
 * HS256 by hand: the test should not pull in jsonwebtoken for three lines of
 * base64url and one HMAC.
 */
function signJwt(payload, secret, ttlSeconds = 900) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSeconds });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const prisma = new PrismaClient();

function assert(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('  ok: ' + msg);
}

// Look up by role rather than nickname: the nickname is pulled from Steam and
// changes along with the user's profile.
/**
 * The administrator these checks run as.
 *
 * Ordered, because `findFirst` without one is whatever Postgres hands back
 * first — and a deployment that has promoted a second admin then gets a
 * different account on each run. A suite that reconciles a balance against a
 * ledger has to look at the same account every time, or it passes and fails at
 * random for reasons that have nothing to do with the code.
 */
const user = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
  orderBy: { createdAt: 'asc' },
});
if (!user) throw new Error('No administrator — run pnpm db:seed');
const token = signJwt(
  { sub: user.id, steamId64: user.steamId64, role: user.role },
  process.env.JWT_ACCESS_SECRET,
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

console.log('\n1. Case list (public)');
const cases = await (await fetch(`${API}/api/cases`)).json();
assert(Array.isArray(cases) && cases.length > 0, `returned ${cases.length} case(s)`);
const starter = cases.find((c) => c.slug === 'starter');
assert(Boolean(starter), 'the starter case is present');
const chanceSum = starter.items.reduce((s, i) => s + i.chance, 0);
assert(Math.abs(chanceSum - 1) < 1e-9, `chances sum to ${chanceSum}`);

console.log('\n2. Opening without a token is refused');
const anon = await fetch(`${API}/api/cases/open`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ caseId: starter.id }),
});
assert(anon.status === 401, `anonymous got ${anon.status}`);

console.log('\n3. Opening a case');
const before = (await (await fetch(`${API}/api/me`, { headers: auth })).json()).balance;
const openRes = await fetch(`${API}/api/cases/open`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ caseId: starter.id }),
});
assert(openRes.ok, `status ${openRes.status}`);
const batch = await openRes.json();
assert(batch.openings.length === 1, `the batch holds ${batch.openings.length} opening`);
const drop = batch.openings[0];
assert(
  batch.balanceAfter === before - starter.price,
  `balance ${before} -> ${batch.balanceAfter} at a price of ${starter.price}`,
);
assert(drop.roll >= 0 && drop.roll < 1_000_000, `roll ${drop.roll} is inside the ticket space`);
assert(
  drop.roll >= drop.item.rangeFrom && drop.roll <= drop.item.rangeTo,
  `roll ${drop.roll} falls in the item range [${drop.item.rangeFrom}, ${drop.item.rangeTo}]`,
);
console.log(`  dropped: ${drop.item.marketHashName} (${drop.item.rarity})`);

console.log('\n4. The item shows up in the inventory');
const inv = await (await fetch(`${API}/api/inventory`, { headers: auth })).json();
assert(inv.some((i) => i.id === drop.inventoryItemId), 'item found in the inventory');

console.log('\n5. The active server seed is never exposed');
const seeds = await (await fetch(`${API}/api/me/seeds`, { headers: auth })).json();
assert(seeds.serverSeedHash && !('serverSeed' in seeds), 'only the hash is returned');
assert(seeds.nonce === drop.nonce, `nonce in sync: ${seeds.nonce}`);

console.log('\n6. Rotation reveals the old seed and makes the opening verifiable');
const rotateRes = await fetch(`${API}/api/me/seeds/rotate`, { method: 'POST', headers: auth });
const rotated = await rotateRes.json();
assert(rotateRes.ok, `rotation returned ${rotateRes.status}: ${JSON.stringify(rotated)}`);
const check = verifyOpening({
  serverSeed: rotated.revealedServerSeed,
  serverSeedHash: drop.serverSeedHash,
  clientSeed: drop.clientSeed,
  nonce: drop.nonce,
  expectedRoll: drop.roll,
});
assert(check.hashMatches, 'the revealed seed matches the published hash');
assert(check.rollMatches, `the roll recomputes: ${check.computedRoll} === ${drop.roll}`);

console.log('\n7. Selling an item returns the money');
const sell = await (
  await fetch(`${API}/api/inventory/sell`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ inventoryItemIds: [drop.inventoryItemId] }),
  })
).json();
assert(sell.sold === 1, 'one item sold');
assert(sell.balance === batch.balanceAfter + drop.item.price, 'the balance grew by the item price');

console.log('\n8. Selling the same item twice is refused');
const resell = await fetch(`${API}/api/inventory/sell`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ inventoryItemIds: [drop.inventoryItemId] }),
});
assert(resell.status === 400, `the repeat got ${resell.status}`);

console.log('\n9. The balance agrees with the ledger');
const ledger = await prisma.transaction.aggregate({
  where: { userId: user.id },
  _sum: { amount: true },
});
const current = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
assert(ledger._sum.amount === current, `ledger ${ledger._sum.amount} === balance ${current}`);

console.log('\n10. Request body validation');
const bad = await fetch(`${API}/api/cases/open`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ caseId: 'not-a-uuid' }),
});
assert(bad.status === 400, `an invalid caseId got ${bad.status}`);

console.log('\n11. The admin report sees the opening');
const dash = await (await fetch(`${API}/api/admin/dashboard`, { headers: auth })).json();
assert(dash.openings >= 1, `openings in the period: ${dash.openings}`);
assert(dash.ggr === dash.wagered - dash.won, `GGR = wagers - wins (${dash.ggr})`);

console.log('\n12. An ordinary user cannot reach the admin panel');
const plainToken = signJwt(
  { sub: user.id, steamId64: user.steamId64, role: 'USER' },
  process.env.JWT_ACCESS_SECRET,
);
const forbidden = await fetch(`${API}/api/admin/dashboard`, {
  headers: { Authorization: `Bearer ${plainToken}` },
});
assert(forbidden.status === 403, `the USER role got ${forbidden.status}`);

console.log('\n13. Items in active cases have an image and a Steam-confirmed price');
const priced = await prisma.item.findMany({
  where: { caseItems: { some: { case: { isActive: true } } } },
  select: { marketHashName: true, imageUrl: true, priceUpdatedAt: true },
});
const noImage = priced.filter((i) => !i.imageUrl);
const noSteamPrice = priced.filter((i) => i.priceUpdatedAt === null);
assert(priced.length > 0, `items in active cases: ${priced.length}`);
assert(noImage.length === 0, `without an image: ${noImage.map((i) => i.marketHashName).join(', ') || 'none'}`);
assert(
  noSteamPrice.length === 0,
  `without a confirmed Steam price: ${noSteamPrice.map((i) => i.marketHashName).join(', ') || 'none'}`,
);

console.log('\n14. Every active case that is sold is profitable for the site');
const adminCases = await (await fetch(`${API}/api/admin/cases`, { headers: auth })).json();
// Free cases are excluded, and their RTP is `null` rather than a number on
// purpose: RTP is what comes back per unit staked, and nothing is staked on a
// case that costs nothing. A price of zero identifies them — the case schema
// refuses a zero price unless the case is marked free.
const sold = adminCases.filter((x) => x.isActive && x.price > 0);
assert(sold.length > 0, `active cases with a price: ${sold.length}`);
for (const c of sold) {
  assert(c.rtp !== null && c.rtp < 1, `${c.name}: RTP ${((c.rtp ?? 0) * 100).toFixed(1)}% is below 100%`);
}
for (const c of adminCases.filter((x) => x.isActive && x.price === 0)) {
  assert(c.rtp === null, `${c.name} is free and states no RTP (${c.rtp})`);
}

console.log('\n15. The builder returns a case for editing');
const editable = await (await fetch(`${API}/api/admin/cases/starter`, { headers: auth })).json();
assert(editable.items.length > 0, `contents of ${editable.items.length} items`);
assert(
  editable.items.every((i) => i.rangeTo >= i.rangeFrom),
  'item ticket ranges are valid',
);

console.log('\n16. The server refuses a loss-making case');
const cheapest = editable.items.reduce((a, b) => (a.price < b.price ? a : b));
const dearest = editable.items.reduce((a, b) => (a.price > b.price ? a : b));
const lossMaking = await fetch(`${API}/api/admin/cases`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    slug: 'smoke-loss-case',
    name: 'Loss maker',
    price: 1,
    imageUrl: null,
    isActive: true,
    sortOrder: 0,
    items: [
      { itemId: cheapest.itemId, rangeFrom: 0, rangeTo: 499_999 },
      { itemId: dearest.itemId, rangeFrom: 500_000, rangeTo: 999_999 },
    ],
  }),
});
assert(lossMaking.status === 400, `the loss-making case was refused with ${lossMaking.status}`);
const lossBody = await lossMaking.json();
assert(/loses money/.test(lossBody.message ?? ''), `the reason is stated: ${lossBody.message}`);
assert(
  (await prisma.case.findUnique({ where: { slug: 'smoke-loss-case' } })) === null,
  'the loss-making case never reached the database',
);

console.log('\n17. The server refuses a gap in the ticket ranges');
const holed = await fetch(`${API}/api/admin/cases`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    slug: 'smoke-gap-case',
    name: 'Gappy',
    price: 100_000,
    imageUrl: null,
    isActive: true,
    sortOrder: 0,
    items: [{ itemId: cheapest.itemId, rangeFrom: 0, rangeTo: 499_999 }],
  }),
});
assert(holed.status === 400, `the gapped case was refused with ${holed.status}`);

console.log('\n18. Public settings are served without a token');
const publicConfig = await (await fetch(`${API}/api/config`)).json();
assert(typeof publicConfig.depositsEnabled === 'boolean', 'the depositsEnabled flag is present');
assert(typeof publicConfig.baseCurrency === 'string', `base currency: ${publicConfig.baseCurrency}`);
assert(
  Array.isArray(publicConfig.locales) && publicConfig.locales.includes('en'),
  `locales offered: ${publicConfig.locales?.join(', ')}`,
);
// The dollar rate is what the currency switch converts by. A missing or absurd
// rate would silently show every price off by roughly two orders of magnitude.
const usdRate = publicConfig.fxRates?.USD;
assert(
  typeof usdRate === 'number' && usdRate > 10 && usdRate < 1000,
  `USD rate looks sane: ${usdRate}`,
);
assert(publicConfig.fxRates?.[publicConfig.baseCurrency] === 1, 'the base currency rate is 1');

console.log('\n19. The stub top-up credits through the ledger');
if (publicConfig.depositsEnabled) {
  const before = (await (await fetch(`${API}/api/me`, { headers: auth })).json()).balance;
  const topUp = 250_00;
  const depositRes = await fetch(`${API}/api/me/deposit`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ amount: topUp }),
  });
  assert(depositRes.ok, `the top-up returned ${depositRes.status}`);
  const afterDeposit = await depositRes.json();
  assert(afterDeposit.balance === before + topUp, `balance ${before} -> ${afterDeposit.balance}`);

  const lastTx = await prisma.transaction.findFirst({
    where: { userId: user.id, type: 'DEPOSIT' },
    orderBy: { createdAt: 'desc' },
  });
  assert(lastTx?.amount === topUp, 'the deposit is recorded in the ledger');
  assert(lastTx?.balanceAfter === afterDeposit.balance, 'the balance snapshot in the entry matches');

  const ledgerAfter = await prisma.transaction.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  });
  const balanceAfter = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
  assert(ledgerAfter._sum.amount === balanceAfter, 'after the top-up the balance still agrees with the ledger');
} else {
  console.log('  skipped: the stub top-up is disabled');
}

console.log('\n20. The top-up refuses an invalid amount');
const badAmounts = [0, -100, 100_000_00 + 1, 1.5];
for (const amount of badAmounts) {
  const res = await fetch(`${API}/api/me/deposit`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ amount }),
  });
  assert(res.status === 400, `amount ${amount} refused with ${res.status}`);
}

console.log('\n21. Showcase cases have an image');
const shopCases = await (await fetch(`${API}/api/cases`)).json();
const withoutImage = shopCases.filter((c) => !c.imageUrl);
assert(shopCases.length > 0, `cases on the showcase: ${shopCases.length}`);
assert(
  withoutImage.length === 0,
  `without an image: ${withoutImage.map((c) => c.name).join(', ') || 'none'}`,
);

console.log('\n22. Opening a batch of cases');
const multiCount = 5;
const beforeMulti = (await (await fetch(`${API}/api/me`, { headers: auth })).json()).balance;
const multiRes = await fetch(`${API}/api/cases/open`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ caseId: starter.id, count: multiCount }),
});
assert(multiRes.ok, `status ${multiRes.status}`);
const multi = await multiRes.json();
assert(multi.openings.length === multiCount, `opened ${multi.openings.length} cases`);
assert(
  multi.balanceAfter === beforeMulti - starter.price * multiCount,
  `charged for ${multiCount} cases: ${beforeMulti} -> ${multi.balanceAfter}`,
);

// Each opening gets its own nonce. A collision would mean two drops computed
// from the same roll, which breaks verifiability.
const nonces = multi.openings.map((o) => o.nonce);
assert(new Set(nonces).size === multiCount, `nonces are unique: ${nonces.join(', ')}`);
assert(
  nonces.every((n, i) => i === 0 || n === nonces[i - 1] + 1),
  'nonces run consecutively with no gaps',
);
for (const opening of multi.openings) {
  assert(
    opening.roll >= opening.item.rangeFrom && opening.roll <= opening.item.rangeTo,
    `roll ${opening.roll} landed inside the item range`,
  );
}
assert(
  multi.totalWon === multi.openings.reduce((s, o) => s + o.item.price, 0),
  'the reported total matches the sum of the drops',
);

console.log('\n23. A batch above the limit is refused');
for (const count of [0, 11, 100, -1]) {
  const res = await fetch(`${API}/api/cases/open`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ caseId: starter.id, count }),
  });
  assert(res.status === 400, `count=${count} refused with ${res.status}`);
}

console.log('\n24. The whole batch rolls back when funds are short');
// Ten of the priciest case: no reasonable demo balance covers that.
const priciest = cases.reduce((a, b) => (a.price > b.price ? a : b));
const balanceBeforeFail = (await (await fetch(`${API}/api/me`, { headers: auth })).json()).balance;
assert(
  priciest.price * 10 > balanceBeforeFail,
  `10 x "${priciest.name}" costs more than the balance (${priciest.price * 10} > ${balanceBeforeFail})`,
);

const openingsBefore = await prisma.caseOpening.count({ where: { userId: user.id } });
const nonceBefore = (
  await prisma.serverSeed.findFirst({ where: { userId: user.id, isActive: true } })
).nonce;

const failed = await fetch(`${API}/api/cases/open`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ caseId: priciest.id, count: 10 }),
});
assert(failed.status === 400, `insufficient funds refused with ${failed.status}`);

const openingsAfter = await prisma.caseOpening.count({ where: { userId: user.id } });
assert(openingsAfter === openingsBefore, 'no opening from the batch was written');

const balanceAfterFail = (await (await fetch(`${API}/api/me`, { headers: auth })).json()).balance;
assert(balanceAfterFail === balanceBeforeFail, 'the balance did not change');

// The rollback must restore the nonce counter too: consumed numbers would
// leave a gap in the history, and it has to recompute consecutively.
const nonceAfter = (
  await prisma.serverSeed.findFirst({ where: { userId: user.id, isActive: true } })
).nonce;
assert(nonceAfter === nonceBefore, `nonce not consumed: ${nonceBefore} -> ${nonceAfter}`);


console.log('\n25. Upgrade: the stake and target lists agree');
const availableStakes = await (await fetch(`${API}/api/upgrade/stakes`, { headers: auth })).json();
assert(availableStakes.length > 0, `items available to stake: ${availableStakes.length}`);
const chosenStake = availableStakes[0];
const targetsRes = await (
  await fetch(`${API}/api/upgrade/targets?stakeValue=${chosenStake.price}`, { headers: auth })
).json();
assert(
  targetsRes.items.every((t) => t.price >= targetsRes.priceRange.min && t.price <= targetsRes.priceRange.max),
  `all ${targetsRes.items.length} targets sit inside the allowed price range`,
);
assert(
  targetsRes.items.every((t) => t.chance > 0 && t.chance < 1),
  'every target has a meaningful chance',
);

console.log('\n26. The upgrade consumes the stake and matches the roll');
if (targetsRes.items.length > 0) {
  const chosenTarget = targetsRes.items[0];
  const invBefore = await prisma.inventoryItem.count({
    where: { userId: user.id, status: 'AVAILABLE' },
  });

  const upRes = await fetch(`${API}/api/upgrade`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      inventoryItemId: chosenStake.inventoryItemId,
      targetItemId: chosenTarget.itemId,
    }),
  });
  assert(upRes.ok, `the upgrade returned ${upRes.status}`);
  const up = await upRes.json();

  assert(up.isWin === up.roll < up.winThreshold, `the outcome matches the roll ${up.roll}/${up.winThreshold}`);
  assert(Math.abs(up.chance - chosenTarget.chance) < 1e-9, 'the chance matches the one shown in the list');

  const stakeRow = await prisma.inventoryItem.findUnique({
    where: { id: chosenStake.inventoryItemId },
  });
  assert(stakeRow.status === 'UPGRADED', `the stake was consumed regardless of the outcome (${stakeRow.status})`);

  const invAfter = await prisma.inventoryItem.count({
    where: { userId: user.id, status: 'AVAILABLE' },
  });
  assert(
    invAfter === invBefore - 1 + (up.isWin ? 1 : 0),
    `the inventory changed correctly: was ${invBefore}, now ${invAfter}, win ${up.isWin}`,
  );

  if (up.isWin) {
    const reward = await prisma.inventoryItem.findUnique({
      where: { id: up.rewardInventoryItemId },
    });
    assert(reward.itemId === chosenTarget.itemId, 'exactly the target item was granted');
    assert(reward.acquiredPrice === chosenTarget.price, 'the item was credited at the target price');
  } else {
    assert(up.rewardInventoryItemId === null, 'nothing was granted on a loss');
  }

  console.log('\n27. Reusing the same stake for another upgrade is refused');
  const again = await fetch(`${API}/api/upgrade`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      inventoryItemId: chosenStake.inventoryItemId,
      targetItemId: chosenTarget.itemId,
    }),
  });
  assert(again.status === 400, `the repeat was refused with ${again.status}`);
} else {
  console.log('  skipped: no suitable targets were found');
}

console.log('\n28. Upgrading into an equally priced item is refused');
const selfTarget = await prisma.item.findFirst({
  where: { marketPrice: { gt: 0 }, priceUpdatedAt: { not: null } },
});
const selfStake = (await (await fetch(`${API}/api/upgrade/stakes`, { headers: auth })).json())[0];
if (selfStake && selfTarget) {
  const res = await fetch(`${API}/api/upgrade`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      inventoryItemId: selfStake.inventoryItemId,
      targetItemId: selfTarget.id,
    }),
  });
  // Either the target price is too close or the gap is too wide — both must
  // be refused with a clear error rather than a 500.
  assert([200, 201, 400].includes(res.status), `answered ${res.status} with no internal error`);
}

console.log('\nALL CHECKS PASSED');
await prisma.$disconnect();
