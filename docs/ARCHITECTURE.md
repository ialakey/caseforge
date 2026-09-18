# Architecture: a CS2 case site

[Русская версия](ARCHITECTURE.ru.md)

This document answers the question "what do sites like this actually run on" and
records the decisions taken for this project.

---

## 1. What easydrop / case-battle / csgoroll and friends actually use

None of them publish source, but the stack reads clearly from HTTP headers,
front-end bundles, WebSocket frame formats, and from which libraries exist for
the job at all. The picture across the industry:

| Layer | What is usually there | Why that |
|---|---|---|
| Front end | Next.js / Nuxt, occasionally a plain Vue SPA | SEO on case pages plus a fast TTFB; after that the app lives as a WebSocket-driven SPA |
| API | Node.js (NestJS/Express) or Go, occasionally legacy PHP | see the note on Steam libraries below |
| Realtime | WebSocket + Redis Pub/Sub | the drop feed, battles and balances are pushed, not polled |
| Database | PostgreSQL | transactions and money; MySQL turns up in older projects |
| Cache/queues | Redis + BullMQ (Node) / Asynq (Go) | throttling, locks, the trade-offer queue, idempotency |
| Steam bots | **always Node.js** | see below |
| Infrastructure | Docker, Nginx/Traefik, Cloudflare | Cloudflare here is not "for speed" but a mandatory anti-DDoS layer |
| Payments | local PSPs plus crypto | card acquirers dislike these projects; crypto is almost always present |

### Why the Steam side is Node and not Python

This is the main technical fact that decides the stack. Item trading does not go
through the official Web API — that can only read inventories and history — but
through emulating the Steam client and calling internal `steamcommunity.com`
endpoints. Exactly one living, maintained set of libraries exists for that: the
DoctorMcKay ecosystem on Node.

- `steam-user` — signing into Steam as a client, sessions, refresh tokens
- `steamcommunity` — `steamcommunity.com` cookies and session, mobile confirmations
- `steam-tradeoffer-manager` — creating, tracking and confirming trade offers
- `steam-totp` — Steam Guard codes and confirmation keys from `shared_secret`
- `globaloffensive` — a CS2 game-coordinator connection: float, pattern, stickers, inspection

Python counterparts (`steam`, `steampy`) exist but lag noticeably: they are fixed
less promptly after Valve changes something, and their coverage of mobile
authenticator confirmations is weaker. For a project where the bot farm is the
till, being a week behind Valve's latest change means a week without withdrawals.

**Conclusion:** the trading layer has to be Node. Hence the decision to write the
whole backend in TypeScript rather than carry two languages, two data models and
a bridge between them.

---

## 2. The chosen stack

```
apps/web           Next.js 15 (App Router), React 19, Tailwind, Zustand, socket.io-client
apps/api           NestJS 11 on Fastify, Prisma 6, Postgres 16, Redis 7, BullMQ, socket.io
apps/bot           Node worker: consumer of the withdrawal queue — market purchases and the Steam bot farm
packages/shared    shared types, zod schemas, translations, provable fairness (used by both API and front end)
```

One language across the project, shared types between front and back, a single tsconfig.

### Why NestJS rather than bare Express/Fastify

By composition this project is a CRM plus a game core: dozens of modules, roles,
guards, validation, queues, websockets, cron. Nest supplies DI and modularity out
of the box, which over a year saves more than its overhead costs. It runs on
Fastify, so the RPS difference against plain Fastify is a few percent.

### Why not Go

Go would win on RPS for battles and websockets, but: the bot farm would still be
Node, meaning two languages; the barrier to entry is higher; and for MVP-scale
load (up to ~5k concurrent sockets per instance) Node on Fastify is not the
bottleneck — Postgres is. If the game core ever does saturate, it can be split
out into Go as a separate service later; the module boundaries allow it.

---

## 3. Domain and data model

The key entities (full schema in `apps/api/prisma/schema.prisma`):

- **User** — keyed by `steamId64`, holds the balance, role and ban status
- **Item** — the CS2 item catalogue: `marketHashName`, rarity, type, price
- **CaseCategory** — a shelf in the catalogue ("free cases", "by rarity",
  "collections"). Data rather than an enum, because grouping is merchandising:
  an operator adds a shelf for a holiday and removes it afterwards, and neither
  should be a deploy
- **Case** — a case: price, image, active flag, base and optional English name,
  a description in both locales, the shelf it sits on, and — for a free case —
  the top-up threshold and the opening limit that ration it in place of a price
- **CaseItem** — an item inside a case with its **ticket range** (`rangeFrom`..`rangeTo`)
- **CaseOpening** — a recorded opening: seed pair, nonce, roll, item dropped
- **InventoryItem** — an item on a user's account, with a state machine
- **Transaction** — the ledger of every balance movement, the single source of truth about money
- **Upgrade** — a staked upgrade: stake, target, chance, roll, outcome
- **Contract** — several items traded for one: stake, solved outcome table, roll, reward
- **DailyBonus** — one spin of the wheel: slice, roll, and whether it is still unspent
- **Battle / BattleCase / BattlePlayer** — a case battle: the agreement, its case
  list with frozen prices, and its seats. What actually dropped lives in the
  `CaseOpening` rows that point back at the battle
- **Giveaway / GiveawayEntry** — a skin given away to one entrant, drawn on the
  same seed machinery as a case opening. The seed hash is published while
  entries are open and the seed itself only afterwards; the client seed is a
  hash of the entrant list, so the effect of the seed cannot be known before
  entries close
- **PromoCode / PromoRedemption** — a top-up promotion and each use of it
- **Referral** — who invited whom, written once and never re-pointed
- **ReferralEarning** — one commission accrual, off the ledger until it is claimed
- **Setting** — a runtime setting, keyed by the shared registry
- **Payment** — one attempt to put money on a balance. The row exists before the
  player reaches a checkout and survives whatever happens there, so a provider
  that confirms twice — or confirms something the site never heard of — meets a
  record that already knows its own state
- **ItemDeposit / ItemDepositItem** — skins handed to the site for balance: the
  mirror of a withdrawal, with the valuation frozen on the request so a market
  move while the offer waits in Steam cannot change what was promised
- **KycApplication / KycDocument** — an identity check and its papers. One row
  per player rather than one per attempt: what matters operationally is the
  current standing. The document bytes are deliberately not in Postgres — a
  scan in a column is a scan in every backup, replica and slow-query log
- **Withdrawal** — a withdrawal request, carrying the channel that fills it
- **WithdrawalItem** — one line of a request: what it asked for, recorded once
- **MarketAccount** — one market.csgo.com key the site buys through
- **MarketPurchase** — one skin bought on market.csgo.com for one withdrawn item
- **SteamBot** — a farm bot: status, inventory capacity, limits
- **ServerSeed / ClientSeed** — provable fairness
- **AuditLog** — every operator action

### Money

Every amount is an **integer in minor units** (`Int`), never a `Float`. Each
balance change creates a `Transaction` row; the balance on `User` is a
denormalised cache that must agree with the sum of transactions. Reconciliation
runs as a nightly cron; a mismatch is an alert.

Debiting is a conditional update rather than read-compute-write:

```sql
UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1
```

Zero affected rows means insufficient funds. That removes the race between two
concurrent openings from two tabs — the classic way to drive a site negative.

---

## 4. Provable fairness

The industry-standard scheme, verifiable by the user by hand.

1. The server generates a `serverSeed` (32 random bytes) and publishes only
   `sha256(serverSeed)`. The seed stays active until the user rotates it.
2. The user sets a `clientSeed` (or receives a random one) and may change it at any time.
3. The seed pair has a `nonce` counter, incremented on every opening.
4. The roll:

```
hmac = HMAC_SHA256(key = serverSeed, message = `${clientSeed}:${nonce}`)
roll = parseInt(hmac.slice(0, 8), 16) % 1_000_000
```

5. The `CaseItem` whose range covers `roll` is the drop.
6. Rotating the server seed reveals the old one in full — any past roll can then
   be recomputed and checked against the published hash.

The ticket space is exactly `1_000_000`. The ranges of a case's items must cover
`[0, 999999]` with no gaps and no overlaps; that is checked when a case is saved
in the admin panel and by a dedicated test. This form — ranges rather than
weights — was chosen because it is trivial to verify by hand and does not depend
on the order in which items are iterated.

Important: `serverSeed` must not depend on the item or on the user, and the drop
decision has no business looking at the player's balance. Any nudging breaks
verifiability — if the economy needs tuning, it is tuned through ranges, not by
hacking the roll.

---

## 5. Economy and RTP

A case's RTP = `Σ(item chance × item price) / case price`. It is computed from the
ticket ranges and current item prices and shown in the admin panel on every edit.
The working corridor is 85–95%; above 100% a case loses money, below 80% nobody
buys it. The hard ceiling is 98%: above that the server simply refuses to save
the case.

### How the odds are solved

"The case must be profitable" is one equation with N unknowns — infinitely many
solutions. That needs a model, and the one adopted is the natural one for cases:
**the pricier the item, the rarer it is**.

Formally: an item's weight is `w_i = price_i^(-k)` and its chance is
`s_i = w_i / Σw`. At `k = 0` every item is equally likely; as `k` grows the cheap
ones crowd out the expensive ones. Expected return decreases monotonically in
`k`, so the right exponent is found by binary search against the target RTP
(`packages/shared/src/balancing.ts`).

The achievable RTP range is hard-bounded by the prices of the extreme items: no
distribution returns less than the cheapest item or more than the priciest. If
the target lies outside that band, the builder does not silently fudge it — it
says what to change: the case price or the contents.

The inverse problem — "here is a loot table, what should the case cost" — is
trivial: `price = expected drop value / target RTP`. That is also how a case is
assembled in practice: contents first, price second.

### Price drift

Item prices move. A case assembled at 92% RTP can be at 105% a month later after
a knife's price jumps. Therefore:

- an hourly job pulls prices from the Steam market for items in active cases,
- after every re-pricing the RTP of all active cases is recomputed,
- leaving the corridor is logged as a warning; exceeding 98% as an error.

A log line is an alert, not a repair, and drift is silent until somebody reads
it. `pnpm --filter @caseforge/api rebalance-cases` is the repair: it recomputes
every case's RTP from today's prices and re-solves the ones that have left the
corridor. It moves the odds and never the price — a price is an operator's
decision that a player may have seen yesterday, while the odds are a derived
quantity that was already wrong. A case it cannot solve at the current price is
reported rather than repriced, because that is a decision about what the case
is. It saves through the same admin path the CRM uses, so ranges are re-checked,
the audit entry is written and the catalogue cache is dropped.

**Free cases are exempt from all of this.** RTP is what comes back per unit
staked, and nothing is staked — the ratio is a division by zero. A free case is
rationed by a top-up threshold and an opening limit over a rolling 24 hours
instead, both checked when it is opened rather than when it is saved, and it
carries no cached RTP at all rather than a zero that would read as a case that
pays nothing.

**Unconfirmed prices** are tracked separately: an item whose price Steam never
returned carries an invented number yet counts towards the RTP like any other.
Those items are flagged in the CRM.

The same job backfills missing images: items created outside the import path
(seed, manual insert) have none, and a missing image makes the showcase look
broken. A case without its own image borrows the picture of its priciest item —
that is what sells the case anyway. An explicitly set image is left alone.

---

## 6. Upgrade

The player stakes a skin against a pricier one. The chance is derived from prices
rather than assigned: `chance = stakeValue / targetValue × UPGRADE_RTP`, with the
same RTP the cases use. Under that definition the expected value of an upgrade
equals the stake times RTP at any multiplier — the upgrade economy automatically
matches the case economy and needs no separate balancing.

The outcome comes from the same roll as a case opening:
`roll < chance × TICKET_SPACE`, over the same seed pair and the shared `nonce`
counter. That is not code reuse for its own sake but a product property: the user
has one fairness page for every mechanic, and an upgrade is verified the same way
a drop is.

The stake is consumed regardless of the outcome — it is a stake, not a deposit.
The consumption is a conditional `updateMany` on `status = AVAILABLE`: if the item
has meanwhile gone to a sale or a withdrawal, the upgrade does not happen rather
than granting the item twice.

The bounds beyond which an upgrade is refused: a multiplier below 1.05 (a swap
with a fee dressed up as an improvement), a chance above 85% (a near-certain
swap), and a price gap wide enough to push the chance below 0.5%.

---

## 6a. Contracts

A contract takes between 3 and 10 items and returns exactly one. Unlike an
upgrade there is no winning and losing branch: a contract always pays out, the
only question is what. The reward is drawn from a pool of catalogue items priced
between 0.1x and 5x the staked sum, and the outcome is the same roll a case
opening uses, over the same seed pair and shared `nonce` counter.

### How the outcome table is solved

The pool is not weighted by hand. Hand-tuning it would make the contract a
second economy sitting next to the cases with maths of its own, and every
repricing of the catalogue would silently move the margin. Instead the weights
are solved so that the expected reward equals `stakeValue × CONTRACT_RTP`, with
the same RTP the cases and the upgrade run on.

Weights follow an exponential tilt, `w_i ∝ exp(-alpha × u_i)`, where `u_i` is the
outcome's price on a log scale normalised to `[0, 1]` across the pool. Alpha is
found by bisection: the expected value falls monotonically in alpha — its
derivative is minus the variance of the tilted distribution — so a single
bracket converges. Alpha = 0 would be a uniform pool; a positive alpha leans on
the cheap outcomes, which is where it lands, since the target sits below the
middle of the band.

The consequence worth stating: the margin is a constant of the system, not a
property of the catalogue. Whatever items happen to be priced inside the band,
the solver places the expected value on the same number.

Fractional weights become whole tickets by largest remainder, so the ranges tile
`[0, TICKET_SPACE - 1]` exactly — the same invariant `validateTicketRanges`
enforces on a case. An outcome that would round down to zero tickets cannot be
won, and drawing it on the reel would be a lie, so it is dropped and the pool
re-solved over what is left.

### What is stored

The solved table is snapshotted onto the contract row as JSON, with each
outcome's item id, price and ticket range. The pool is derived from a live
catalogue, so it cannot be rebuilt later from prices that have since moved:
without the snapshot the roll would still be reproducible but would no longer
mean anything.

The staked items are consumed regardless of the outcome, through the same
conditional `updateMany` on `status = AVAILABLE` an upgrade uses — an item that
has meanwhile gone to a sale or a withdrawal fails the claim and the contract
does not happen.

A contract is refused rather than played on bad odds when the catalogue is too
thin inside the band, or when it holds nothing above the payout the table has to
average to.

---

## 6b. The daily bonus wheel

One spin every 24 hours, for money, a discount, a free opening, or a skin.

The wheel is a ticket table like a case, rolled from the same seed pair and the
same shared `nonce` counter. This is the one table in the project that really is
authored by hand rather than solved, and the reason is that a solver needs a
single number to optimise: with prizes as different as a rouble credit and a
knife, there is none. What is bounded instead is the cost — `wheelGrantCost()`
sums the slices that hand something over, and a test fails if re-tuning ever
pushes it past the ceiling.

The slices are drawn from the very ticket ranges they are rolled against, so a
three-percent prize occupies three percent of the rim. A wheel drawn in equal
wedges over unequal odds is the oldest lie in the genre.

### The cooldown

A rolling day, not a calendar one: a calendar reset hands whoever lives in the
right timezone two spins a few hours apart, and turns midnight into a load spike
nobody asked for.

It is claimed with a conditional `UPDATE` on `users.lastBonusAt` rather than read
and then written. Between a read and a write two requests fired together both
pass the check and the player spins twice on one day; zero affected rows means
somebody else already took it. The column is denormalised for exactly this
reason — deriving the last spin from the bonus table would be tidier and would
not be claimable in one statement.

### Instant prizes and vouchers

Money and skins are settled inside the spin's transaction and the row is born
already consumed. A balance credit goes through `Transaction` like every other
movement, so the nightly reconciliation still adds up.

A discount and a free opening are vouchers: the row stays open until an opening
spends it. Spending happens inside the opening's own transaction, before the
debit — resolving it earlier would let a concurrent opening take the voucher in
between and charge this one a discounted price for nothing. The claim is the same
conditional `updateMany` the inventory uses, so a voucher cannot be spent twice.

When several vouchers are open, the opening takes whichever saves most on that
basket. First-in-first-out would be simpler and worse: it burns a half-price
voucher on the cheapest case in the catalogue while a free opening waits behind
it. The chosen voucher comes back on the response, because a reward that vanishes
with the price quietly changing is indistinguishable from a bug.

### The skin prize

A `FREE_ITEM` slice has to turn into a specific skin, and that choice is made
from the same roll that picked the slice rather than from a second, hidden draw —
the candidate list is ordered by id, which is stable in a way that ordering by a
drifting price is not. If the catalogue holds nothing inside the ceiling the
slice is honoured in money instead: paying nothing at all is the one outcome the
wheel must never have.

---

## 6c. Case battles

Several players buy the same list of cases and open it side by side; one of them
keeps every item that dropped. In the standard mode that is the biggest total, in
the crazy mode the smallest — the same cases, the opposite goal.

Everybody pays the full list price of the list. Nobody is charged less for
playing against somebody else, which means the site's margin is exactly what it
would have been had the same cases been opened solo: the expected return is the
weighted RTP of the cases in the battle, and the pot only moves *between* the
players. A battle is a redistribution, not a second economy.

### Where the randomness comes from

Nowhere new. Every drop in a battle is an ordinary `CaseOpening` row, rolled from
the opening player's own seed pair over their own `nonce` block, exactly as a
solo opening is. The rows carry `battleId` and `battleRound` and nothing else
that a solo opening does not have.

A battle-wide seed was the obvious alternative and is the wrong trade. The site
already publishes a commitment per player and reveals it on rotation; a second
scheme alongside it would be a second thing to get wrong, and it would not buy
anything a player cannot already do — each of them verifies their own drops in
their own profile, with the same arithmetic as any other drop, and the totals
are then addition over numbers that are already on the record.

It also means battles need no special case anywhere else: the RTP report, the
per-case margin, the live drop feed and the player's own opening history all pick
them up without knowing that battles exist.

### Seats

A seat is claimed with a conditional `UPDATE` on a denormalised counter:

```sql
UPDATE battles SET "filledSlots" = "filledSlots" + 1
WHERE id = $1 AND status = 'WAITING' AND "filledSlots" < slots
RETURNING "filledSlots"
```

`RETURNING` hands back the player's own 1-based seat number, and no rows means
somebody else took the last seat. Counting the seats and then inserting one lets
two players fired together both see the same seat free. The debit that pays for
it is the same conditional `UPDATE` an opening uses, in the same transaction, so
a battle that fills up while a player is joining rolls their debit back rather
than refunding it afterwards.

### Settlement

Filling the last seat plays the battle out inside that same transaction. Four
seats over thirty rounds is a hundred and twenty openings, a hundred and twenty
inventory rows and a seed reservation per player — the largest write the site
makes, and the reason its timeout is raised. It is not splittable: a battle that
could pay some players and not others has no meaning.

The ids of the openings and of the inventory items are generated up front so each
side goes in with one `createMany` rather than a round trip per row while the
transaction holds locks. Seeds are reserved in a fixed order across players,
because two battles filling at the same instant can share a player and a
consistent order is what keeps their transactions from taking each other's locks
the wrong way round.

Every item is then created **in the winner's inventory while still pointing at the
opening that rolled it**. The opening's `userId` stays whoever rolled it, and
that gap between roller and owner is precisely what a battle is; recording only
one of the two would lose either the provenance or the ownership.

### Ties

Two seats opening the same cases can land on the same total, and with cheap cases
it happens often enough to need a rule. The rule is sudden death on the single
best drop — the single worst in the crazy mode — and, if even that matches, the
earlier seat wins. Both steps are functions of drops already on the record, so
the outcome stays reproducible from the stored rolls; a fresh random draw would
not be.

### Battles that never fill

A battle waiting for a second player holds the host's money, and the host may
well have closed the tab. A sweeper cancels anything that has waited longer than
the configured window and refunds every seat in full, through the ledger. The
transition is claimed with a conditional `UPDATE` from `WAITING`, which is what
stops a refund racing a settlement — a battle that filled a moment ago is being
played, and the sweeper must not be able to give its entries back underneath it.
Switching battles off in the settings makes the same sweeper clear the lobby
outright, which is what flipping that switch during an incident is asking for.

---

## 7. Steam integration

### 7.1 Sign-in and profile

Steam **does not support OAuth** — only OpenID 2.0. The flow: redirect to
`steamcommunity.com/openid/login`, come back with parameters, then a mandatory
server-side verification through `check_authentication` (without it the
parameters are trivially forged). The response yields `steamId64`, and we issue
our own JWT pair.

Important: OpenID reports **only the SteamID64** — neither nickname nor avatar is
in the response, and both have to be read separately. There are two sources:

| | `GetPlayerSummaries` (Web API) | `/profiles/<id>?xml=1` |
|---|---|---|
| Key | needs `STEAM_API_KEY` | none |
| Returns | nickname, avatar, registration date, status | the same |
| Limits | 100k requests per day per key | like an ordinary page |

The Web API is the primary path, the XML the fallback. The XML is not a
development shim: if the key expires or the Web API is down, the user still sees
their own nickname and avatar instead of `user_123456`. Parsing the XML needs
care — the profile embeds nested friend lists with their own `<steamID>` and
`<avatarFull>`, and naively taking the first match substitutes somebody else's
avatar.

The key point: **Steam never returns an e-mail address** by either route. It will
never be known unless the user types it in. Every account-recovery path is built
around the Steam account.

### 7.1a Sessions

The JWT pair is short access token plus long refresh token: the access token
carries the user id and role and is checked on every request without touching
the database, so it has to expire quickly for a ban or a role change to take
effect. The refresh token lives in an httpOnly cookie for a month and is the
only thing that can mint a new one.

That split only works if something spends the refresh token. The browser does it
transparently: a 401 from any call triggers one refresh and one replay of the
original request, and a failed refresh is what ends the session — not a normal
15-minute expiry. Concurrent 401s share a single in-flight refresh, because a
page load fires several calls at once and each starting its own refresh would
rotate the cookie repeatedly, leaving the losers of the race replaying with a
token that had already been superseded. That failure mode is indistinguishable,
from the player's side, from being logged out at random.

The websocket reads its token during the handshake only, so it takes the token
through a callback and reconnects when the token changes; pinning it at page
load would refuse every reconnect made after the first expiry.

---

## 7a. The inventory lifecycle

An item on an account is a row with a status, and the row is never deleted:

`AVAILABLE` → `SOLD` | `WITHDRAWN` | `LOCKED` | `UPGRADED` | `CONTRACTED`

Only `AVAILABLE` can be acted on. `LOCKED` belongs to a withdrawal in flight;
the other three are terminal and make up the history the interface shows on its
own tab. Deleting the row instead would be smaller, and wrong twice over: a
player who sold a knife still wants to see what they got for it, and support
cannot investigate a complaint about an item that disappeared from the
interface at the moment it was disposed of.

Every transition is a conditional `updateMany` on `status = AVAILABLE`, which is
both the check and the claim. An item that has meanwhile gone to a sale, a
withdrawal or a contract simply falls out of the affected rows, and the mismatch
between the affected count and the number of ids requested is what the caller
rejects on. Nothing here relies on having read the row first.

**Selling everything** resolves its own set inside the transaction from the
filter the interface was showing, rather than from a list of ids the browser had
loaded. Ids would cap the operation at the page the player happened to have
open and would race with anything that changed in between; the filter cannot.
The total comes back from the server for the same reason — the confirmation
dialog can only ever quote an estimate of it.

**Withdrawing from the inventory starts a purchase.** The item goes to `LOCKED`
and a request is queued; it becomes `WITHDRAWN` only when the market confirms
that a seller handed the skin over, and returns to `AVAILABLE` if the purchase
fails. The interface therefore cannot say "withdrawn" at the moment of the
press — it says a request was made, which is the only thing that is true yet.
The mechanism is section 7.6.

**Filters.** Two axes: the tab (available, withdrawing, history, all) and a price
band. The band edges are fixed in the base currency rather than in whatever the
player is displaying. A band that moved with the exchange rate would re-sort the
inventory every time the rates refreshed, and an item could sit in one band on
Monday and another on Tuesday without its price having changed at all. The
labels are rendered through the usual money formatter, so the edges still read
in the player's chosen currency — round in the base currency, converted
elsewhere.

---

### 7.2 The market: prices and images

Prices and images come from the Community Market, which offers two endpoints with
different properties:

| | `market/search/render` | `market/priceoverview` |
|---|---|---|
| Returns | name, image, rarity, listing count | the price only |
| Currency | **always dollars**, the `currency` parameter is ignored | honours `currency` |
| Query | keywords | an exact `market_hash_name` |

Hence the split: search is used to pick items and read metadata, while the price
in the project's currency always comes from `priceoverview`.

Three things that are easy to get burned by:

1. **Search does not accept a `market_hash_name`.** The `|` character and the
   exterior parentheses return zero results even for items that are definitely
   listed. The name has to be normalised into keywords (`toSearchQuery`).
2. **Knives and gloves carry a `★` prefix.** `Karambit | Doppler (Factory New)`
   does not exist as far as Steam is concerned; `★ Karambit | Doppler (Factory New)` does.
3. **Take the median, not the minimum.** `lowest_price` swings with individual
   dumped listings, and a case priced off it undervalues its items.

Request frequency is capped at roughly 20 per minute, beyond which comes a 429 and
a ban of several minutes. So requests are serialised with a 3.5 second interval,
search results are cached for an hour and prices for half an hour, and a 429 puts
the service to sleep for five minutes. Negative results are cached too: an item
with no listings would otherwise hit Steam on every sync.

### 7.3 Display currency

Storage and settlement stay in the base currency. The currency switch converts at
render time only, using a rate from the Central Bank of Russia's public daily
feed — no key, refreshed every six hours, cached in Redis, and falling back to the
previous value when the feed is unreachable. Nothing is ever re-priced and no
ledger row holds a converted amount: treating a display rate as a settlement rate
is exactly how a site ends up selling items below cost after a currency move.

### 7.4 Trade URL

The user pastes their trade URL; `partner` and `token` are parsed out of it. It is
validated by shape, and in practice by the first offer that uses it.

### 7.5 Delivery channels

Two, chosen by the `withdrawals.provider` setting and **stamped on the request
when it is created**. Reading the setting again at processing time would mean an
operator flipping the switch could leave requests half-filled by one channel and
polled by the other.

**MARKET** (the default). The site holds no inventory. Each withdrawn item is
bought on market.csgo.com, and the buying account names the player's
`partner`/`token` as the recipient so the seller delivers directly. What the site
carries is a price rather than a warehouse: no capital tied up in skins, no slot
ceiling, and nothing that cannot be handed out because no bot happens to own it.

There is a pool of accounts rather than one, and the reason is the rate limit:
the market **deletes** an API key that exceeds five requests a second. That is
not a throttle to back off from — it is the key ceasing to exist, taking with it
the ability to ask about any purchase it made. So the client stays well under
the limit, which caps a key at about four requests a second, and a single
withdrawal costs a search, a buy and a poll every few seconds until the seller
delivers. Extra keys raise the ceiling because the limit is counted per key, so
each account gets its own client with its own queue — one shared queue would
throttle them collectively and give back exactly the ceiling the second key was
bought to remove.

Accounts are not interchangeable after the fact, which is the part that shapes
the code. `get-buy-info-by-custom-id` answers for the key that made the purchase
and reports every other purchase as unknown, and the money came out of that
account's balance. So a purchase is bound to its account **before** `buy-for` is
called, polling is grouped by account, and a retry goes back to the key that
made the first attempt. Asking a different key would get a truthful "never heard
of it" about a purchase that had been paid for — and the retry would then buy
the skin a second time.

Keys are encrypted under `BOT_SECRETS_KEY` and decrypted only in the worker, the
same as the Steam bots' secrets. The back office never holds one: the worker
writes balance and health snapshots, and the panel reads those.

**BOTS** (section 7.5.1). A farm of Steam accounts holding the inventory. Kept
because an operator already running one should not be forced to migrate, and
because an account with its own inventory is the only way to deliver something
the market is not selling.

#### 7.5.1 The bot farm

One bot is one Steam account with the mobile authenticator enabled and with
`shared_secret`/`identity_secret` available (needed to auto-confirm offers). The
constraints the whole withdrawal design is built around:

- **a Steam inventory holds 1000 slots**, so several bots are needed along with routing a request to whichever bot actually holds the item;
- **a 7-day trade hold** applies if the recipient has no mobile authenticator or enabled it recently — checked BEFORE sending the offer, otherwise the item sits in escrow;
- a bot that recently changed its password or device goes on hold by itself;
- Valve rate-limits offer creation, so a throttled queue is mandatory.

Bot secrets (`shared_secret`, `identity_secret`, passwords) are not stored in the
database in the clear: an external secret store in production, encrypted under an
environment key in development.

### 7.6 Withdrawing an item

```
request → validation (trade URL, limits, anti-fraud)
        → items → LOCKED, one Withdrawal row, one BullMQ job
        → MARKET: one MarketPurchase per item
             search-item-by-hash-name → buy-for(partner, token, price ceiling)
             poll get-list-buy-info-by-custom-id → stage 2 or 5
        → BOTS:   pick a bot holding every item → offer → auto-confirm → poll
        → delivered → WITHDRAWN, failed → back to AVAILABLE
```

**Idempotency.** On the bot channel the job is idempotent by `withdrawalId`: a
retry does not create a second offer. On the market channel that is not enough,
because the unit of money is the purchase, not the request. Each `MarketPurchase`
row is unique on its inventory item and travels as the market's `custom_id`, so a
retry after a lost reply first asks the market what happened to that id. Without
it, a dropped connection between the charge and the response buys the skin twice
and pays for both.

**A request is no longer atomic.** Three items are three sellers, each able to
fail alone, so the request's status is *computed* from its lines every time a
purchase moves — hence `PARTIAL`. The lines are a table of their own rather than
`InventoryItem.withdrawalId`, because that column says which request holds an
item *now* and is cleared on a refund: reading history from it would make a
request that gave everything back list nothing at all, and one that refunded a
single item report itself `COMPLETED`. The rule the computation enforces is one-directional:
an item returns to the player's inventory only when the purchase for it is known
not to have happened. A purchase that is merely unfinished keeps its item locked,
and a purchase that was paid for is never written off on a timer. The money is
already gone and the seller may still deliver; the site says so to an operator
rather than guessing, and the guess that would be cheap to make — refund the item
— is exactly the one that hands out a skin twice.

**Price.** The ceiling per item is `max(current catalogue price, credited price)`
raised by `withdrawals.market.maxOverpayBps`. The current price rather than the
credited one because the player owns an item, not an amount, and a skin that has
doubled must still be withdrawable; the credited price as a floor so an item an
operator has marked down does not become impossible to take out. Past the ceiling
the purchase is refused and the item comes back — a refusal, not a loss.

**Units.** The market quotes roubles in kopecks but dollars and euros in
thousandths, and reports balances and amounts paid as floats in whole units. All
three conversions live in one module with tests, and an account whose currency
differs from the settlement currency is refused rather than converted through the
display rate (see 7.3).

---

## 8. Opening a batch of cases

Up to ten cases at once. The whole batch is one transaction: either every case is
paid for and every item granted, or nothing happens at all, including the `nonce`
counter.

The key detail is reserving the `nonce`. Incrementing it one at a time in a loop is
not an option: a concurrent upgrade or an opening from another tab would slot into
the middle and take a number out of our batch, and the nonce has to be contiguous
or the history stops recomputing in order. So a block of numbers is claimed in a
single `UPDATE ... SET nonce = nonce + N RETURNING nonce`, and the batch occupies
the last N numbers before the returned value.

One ledger row is written per batch rather than ten: reconciliation looks at the
sum, and ten rows for a single click would only clutter the history.

The rate limit counts cases rather than requests — one "×10" button press is ten
openings, and script protection has to see it that way.

---

## 9. Realtime

`socket.io` with the Redis adapter, so several API instances share rooms.

Channels:
- `drops:live` — the global drop feed (rare items only, otherwise it is a flood at peak)
- `user:{id}` — personal: balance, withdrawal status, inventory
- `battles:events` — battle changes, fanned out to everybody

Battle events are deliberately *not* batched and *not* per-battle rooms. They are
rare — a creation, a seat, a settlement — and the lobby is one shared view, so a
seat has to leave every other browser at once; three hundred milliseconds of
buffering would only make a taken seat look free. A battle page filters the
broadcast by id and re-reads the battle when it hears about its own.

At peak the drop feed is the hottest channel. It is aggregated: events collect in a
buffer and are broadcast in batches roughly every 300 ms rather than one by one.
That is the difference between 50k and 2k messages per second for an identical user
experience.

---

## 10. Load

Traffic for sites like this is sharply uneven: an ordinary day, then a 20x spike
during a streamer's giveaway. Capacity has to be planned off the spike, and the
plan has to be runnable — everything below is in the repository rather than in a
future ticket, behind `pnpm infra:up:scale` and measured by `pnpm test:load`.

### Connection pooling

**PgBouncer in transaction mode.** Node keeps a connection pool per process, so
Postgres's `max_connections` is spent by the number of API instances times their
pool size, and it runs out long before the database is actually busy. Transaction
pooling ties a server connection to a transaction rather than to a client, which
turns a thousand idle application connections into a couple of dozen real ones.

Two things have to be right for Prisma to live behind it. Prepared statements
are per-session and a transaction pooler hands out a different session every
time: pgbouncer has tracked them since 1.21, so `max_prepared_statements` is set
on the pooler and `?pgbouncer=true` on the URL as the belt to that braces. And
migrations must not go through it at all — they open long sessions, create types
and take locks that transaction pooling cannot carry across statements — so the
schema declares `directUrl`, which is where `DIRECT_DATABASE_URL` points. It
defaults to `DATABASE_URL`, so a single-server deployment configures nothing.

`connection_limit` in the URL is worth setting explicitly behind a pooler: a
small pool per instance is the entire point, and Prisma's default of
`cores * 2 + 1` per process is not.

### The read replica

A streaming standby, and a second Prisma client that points at it. Where
`REPLICA_DATABASE_URL` is unset the read client *is* the primary client, so
nothing branches on configuration and one box needs none.

The rule for using it cannot be expressed as a type, so it is a rule: **the
replica serves what an operator or a spectator reads, never what the player
asking has just written.** Replication lag is small but real, and a read across
it shows a player an inventory without the item they just won. What reads the
replica: every CRM report and listing, the public catalogue, the battle lobby,
the drop feed. What stays on the primary: anything inside a transaction, the
inventory, the balance, and a single battle — the player who just took a seat is
handed that very battle back.

`pnpm infra:replica:init` prepares a **running** primary for a standby: a stock
`postgres` container has neither a replication role nor a `pg_hba` line that
admits one, and both have to be added without recreating a database that already
holds a seeded catalogue. `pg_hba` needs an explicit `replication` entry —
`all` in the database column is the one place where `all` does not mean all.

### What is cached, and what deliberately is not

The catalogue is the most requested read on the site and its answer is identical
for everybody, so it is cached in Redis. Invalidation is by version counter
rather than by deleting keys: the counter is part of every key in the namespace,
bumping it orphans the namespace at once, and because the counter lives in Redis
every API instance sees the bump. An operator saving a case, an RTP
recalculation and the hourly price sync all bump it; the TTL is only the backstop
for a bump that never arrived.

The opening path does not read that cache. It loads the case inside its own
transaction, because a stale price there is a stale amount of money.

The drop feed keeps its own backlog as a Redis list, written as drops happen.
Every socket that connects asks for the recent drops, and answering that from
Postgres is a four-table join per connection — during the reconnect storm after
a deploy, the most pointless load on the database on the whole site. The database
is read only to warm the list.

Settings are cached in-process for fifteen seconds, and a write clears the cache
locally, so an operator sees their own change immediately and other instances
within the TTL.

### Indexes

The ones that matter are on the ticket and price reads, not on the ledger: a
contract's reward pool and the wheel's free-skin slice both ask for active items
inside a price band that can span fiftyfold, and without `(isActive,
marketPrice)` the planner walks the whole catalogue on every contract preview.
`case_openings` carries its own composite indexes for the report aggregates and
one for the battle view.

### Health

`GET /api/health` is what a balancer polls and what an operator opens first. It
reports the reachability and latency of Postgres and Redis, and the replica's
replay lag in seconds — because behind a balancer the interesting failure is not
a dead process, which stops answering by itself, but an instance that answers
happily while its replica is an hour behind. "Degraded" travels in the body
rather than as a status code: a lagging replica is a reason to look, not a reason
to take the instance out of rotation.

### Load testing

`pnpm test:load` is a dependency-free generator in the repository, with the
site's own scenarios rather than a generic "hit / with 100 VUs":

| Scenario | What it does |
|---|---|
| `browse` | public reads only — catalogue, case page, lobby, config, health |
| `open` | the write path: one case opened per request, per throwaway player |
| `battles` | two throwaway players create and fill a two-round battle |
| `mixed` | four parts browse to one part open |

It reports p50/p90/p99 and every non-2xx status separately, which matters more
than it sounds: a run where a third of the requests are 429 is a rate-limit
measurement, and reading it as latency is how people conclude a site is fast
when it is refusing work. The throwaway players and everything they did are
deleted afterwards.

What the numbers are not: capacity. The generator shares the machine with the
API and the database and competes with what it is measuring, so they are
comparative — before and after a change — and a real figure needs load offered
from somewhere else.

Deferred until there are real numbers: sharding, splitting the game core out into
Go, partitioning `case_openings` (needed somewhere past 50–100 million rows).

---

## 11. CRM / admin panel

A separate section of the application behind role-based access (`ADMIN`, `SUPPORT`,
`ANALYST`).

- **Dashboard** — GGR, deposits, withdrawals, online, conversion, per-case margin
- **Cases** — the builder: Steam market search with images and prices, a case image,
  auto-solved odds for a target RTP, a suggested case price, a live margin verdict,
  ticket-range coverage validation
- **Items** — the catalogue, prices, manual price overrides
- **Users** — balance, history, manual balance adjustment (always through `Transaction` + `AuditLog`), bans
- **Withdrawals** — the request queue, manual intervention, re-sending an offer
- **Market** — the buying account's balance and checks, purchase counts, what
  delivery has cost against what was authorised, and purchases paid for but not
  delivered. Read-only: the worker is the only thing that spends money
- **Bots** — farm status, inventories, login errors, holds
- **Reports** — exports by period, cohorts, top players
- **Settings** — feature flags, limits, copy, promo codes

Two rules with no exceptions: every operator action is written to `AuditLog` with a
before/after snapshot, and none of them changes a balance outside `Transaction`.

The panel is English only. Translating an internal tool doubles the maintenance for
an audience of a few people.

---

## 11a. Runtime settings

Everything an operator can change without a deploy is declared once, in
`packages/shared/src/settings.ts`, with its group, its type, its bounds and its
default. The admin panel renders its form from that registry rather than from a
field written per setting, so adding a knob is a line in one file and nothing
else. The alternative — a bespoke form control, a validator and a reader per
setting — is three places to keep in step and the reason most back offices end
up with settings that exist in the database and nowhere in the interface.

Values are cached in the API for fifteen seconds. The settings are read on
nearly every request — the rate limit, the sell fee, the wheel — and a query
apiece for data that changes a few times a month is pure waste. A write updates
the writing instance at once, so an operator sees their change take hold while
they are still looking at the panel; other instances pick it up within the TTL.

A stored value that fails to parse reverts to its default and is logged rather
than throwing. The panel validates on the way in, which is where a bad value
should be rejected loudly; by the time it is being read, refusing to serve the
site is not an improvement on serving it with a default.

### What is deliberately not configurable

`TICKET_SPACE`, the seed algorithm and the shape of a roll. These are not tuning
parameters but the terms of a promise: every past opening was published against
them, and they are what a player recomputes when they check one. An operator who
could edit them could make yesterday's drops stop verifying — which is not a
setting but a way of breaking the only claim the site makes.

The case ticket ranges are the same kind of thing and are edited where they
belong, in the case builder, through validation that refuses a case whose ranges
do not tile the space.

---

## 11b. Promo codes

A code adds to a top-up rather than discounting it. Once a real payment provider
sits behind the button the charged sum has to match the sum the provider was told
about, and a code that changed it would put the two out of step; adding on top
keeps the promotion entirely on our side of the transaction.

The credit is a second ledger row rather than a larger deposit row. What the
player paid and what the promotion gave them are different kinds of money, and a
report that cannot separate them cannot say what the promotion cost.

Two limits, enforced differently because they race differently. The per-player
limit is a count of redemption rows inside the deposit's transaction. The global
limit is a conditional `UPDATE` on a denormalised counter: counting rows and then
inserting lets two top-ups fired together both see the last use available and
both take it. The rows remain the source of truth; the counter exists so the cap
can be claimed in one statement.

Codes are deactivated, never deleted. The redemptions point at them, and a player
asking why their balance moved deserves a row that still explains it.

---

## 11c. Referrals

A player hands out a link, whoever follows it is bound to them on sign-up, and a
share of what that person then spends is credited to the inviter.

### Binding

The invite arrives as `?ref=CODE` on any page and the visitor is not signed in
yet — they are about to be sent to Steam and back, which discards everything the
page was holding. So the code is parked in the browser and redeemed by a call
that lands moments after sign-in.

That leaves the endpoint open at any later point, which is why the rule that
protects it is not timing but history: a code is refused once the account has any
activity on it. A player who has already opened a case or moved money is not
somebody's fresh recruit, and without that rule an established account could be
attributed to whoever asked last. On top of it, a player cannot use their own
code, and a sign-up from the inviter's own address is flagged on the binding —
not refused, because households and mobile carriers share addresses, but left
where an operator can see it.

One inviter per player, enforced by a unique `refereeId` rather than by a check:
two claims fired together both pass a check, and only the constraint decides.

### Accrual, and why it is not the ledger

Commission accrues into `ReferralEarning` rows that are not on any balance and
not in the ledger until they are claimed. A commission credited as it is earned
would be a `Transaction` row per opening per inviter, and the ledger is what the
nightly reconciliation walks; accruing into rows of their own and paying out in
one entry keeps the ledger proportional to the number of payouts rather than to
the number of drops.

The rate is stored on each row. It is a setting, and an operator lowering it must
not rewrite what was already earned.

A refunded battle seat takes its accrual back with it, or creating and cancelling
battles would be a free way to pay an inviter. Only pending rows are removed: an
accrual that has already been paid out is money on somebody's balance, and
clawing that back would be a debit they never agreed to.

### Payout

The pending rows are claimed with an `UPDATE ... RETURNING` and the floor is
checked against what came back, not against a `SUM` read beforehand. The other
order pays out a different number from the one it checked whenever an accrual
lands in between — and for an inviter with active recruits, that is the normal
case. A refusal throws, which rolls the claim back and leaves the pot as it was.

The payout itself is a single `REFERRAL` ledger entry: it is the one point at
which accrued commission becomes money.

---

## 11d. Appearance as configuration

What the site is called, what colour it is, which sections exist and what the
banner says are settings, served to the browser at runtime. The alternative —
editing Tailwind classes and redeploying — makes the look a developer task,
which is not what it is.

It works because the stylesheet was already built on tokens. Every component
reads `--accent`, `--surface-raised`, `--radius`; the appearance settings are
converted to those custom properties by one function in the shared package and
rendered into the document root by the server. Nothing in a component knows that
a colour is configurable, which is exactly why every component responds to it.

Two rules keep it from becoming a second way to break the site:

**Empty means the shipped default.** A blank headline is not a blank headline on
the page: the front end falls back to the translated string in the dictionary.
So an operator fills in only what they want to differ, a site nobody has
configured looks exactly as it ships — in both languages — and a half-filled
form never produces a half-empty page.

**Appearance cannot reach the odds.** The palette and the banner live in their
own group. The ticket space, the RTP and the wheel live in theirs, where a
change is a change to the game rather than to its paint.

The colours are stored as hex, which is what a colour input produces and what a
brand guide is written in, and converted to the `H S% L%` triple the stylesheet
needs. That conversion is a tested function rather than a format the panel
happens to write: the tokens are bare components precisely so a rule can say
`hsl(var(--accent) / 0.14)`, and a value in the wrong shape would take the whole
palette down.

### The builder

`/admin/appearance` renders the same settings the generic form would, grouped
the way somebody thinks about a page, with two previews. The panel beside the
fields is drawn from the draft and responds to the colour picker immediately;
the iframe below it shows the **saved** state, because that is the honest thing
for it to show — the site as a visitor would get it. Presets exist for the same
reason a starting point always does: a dozen colour pickers and no default is
how a site ends up unreadable.

The metadata follows too. The title and description are generated from the
settings on the server, so a renamed site is renamed in every link anybody
shares afterwards rather than only in the header.

---

## 11e. The analytics contour

The split that everything else follows from: **the database is already the
analytics store for everything that moved money.** Openings, deposits, battles,
referrals and withdrawals are rows with amounts and timestamps, and a report over
them is a query. Re-emitting them as analytics events would create a second set
of numbers that can disagree with the ledger — and when a report and the ledger
disagree, the report is the one nobody trusts again.

So the event stream carries only what the database cannot answer: that somebody
arrived, where from, what they looked at, and where they stopped. Six event
types, no more, and each one is something no table records — a page view, the
press of the Steam button, the top-up dialog opening, a promo code being tried,
the click that starts a battle, an invite link being followed.

The two meet in the funnel: an event-based top, a ledger-based bottom.

```
visitors   →  signups  →  deposited  →  played  →  withdrew
(events)      (users)     (ledger)     (openings) (withdrawals)
```

### What is not collected

No IP address and no user agent. The stream is about behaviour, not identity,
and neither answers a question about behaviour that a coarse `desktop / mobile /
tablet` does not — while both would turn a traffic report into a store of
personal data. The device class is derived from the request header and stored
instead of it.

### Rollups, and why the headline is not the sum of the chart

Daily metrics are summarised once a night into one row per metric per day, which
makes a month of history cheap to read and keeps it after the raw events are
pruned. Today's row is refreshed on demand, because an operator watching a
promotion cannot wait until tomorrow.

The headline numbers are **not** read from those rows. A sum of daily uniques is
not a unique: somebody who visited on Monday and Tuesday is two daily visitors
and one visitor, and a KPI that added the chart up would overcount every
returning player. So the tiles are computed over the whole range with proper
distinct counts, and the charts come from the rollups. Two paths, each correct
for the question it answers.

`pnpm test:smoke:analytics` pins the seam that matters: that `wagered` in a
report equals the sum of `case_openings.casePrice` exactly, and that a rollup
recomputed twice does not double anything.

### Per-feature margin

A roadmap is decided on GGR per feature, and that cannot be counted in clicks:
cases and battles are the stake minus what dropped, an upgrade is the stake
minus the targets that were won, a contract is what went in minus the reward,
and the wheel only ever costs money — that is what it is for. Each row is
measured in its own terms and the table says so, because a single formula
applied to all five would be wrong four times.

---

## 12. Money coming in: top-ups

Today the "Top up" button is backed by a stub — the server credits the entered
amount with no payment at all. It exists so the gameplay loop can be exercised
before payments are wired in, and it is gated by `ENABLE_STUB_DEPOSITS`; in
production it is off by default, because it is literally a "draw yourself some
money" button.

A real top-up works differently, and the difference matters:

1. an invoice is created at the payment provider and the user is sent to its page;
2. the balance changes **only on a webhook** confirming payment, never on the user
   returning to the site — a return is trivially forged;
3. webhook handling is idempotent by payment id: PSPs routinely deliver the same
   webhook several times;
4. the webhook signature is verified before anything is written to the database.

What is already right and will survive replacing the stub: the credit goes through
`Transaction` rather than a direct balance UPDATE, so the nightly reconciliation
stays correct and a deposit shows up as a deposit in reports.

---

## 13. Anti-fraud and security

### What the code does today

**Injection.** Every query goes through Prisma. The three dozen raw ones are
tagged templates, which Prisma sends as a parameterised statement, so a value
can never become syntax. The unsafe variants (`$queryRawUnsafe`,
`$executeRawUnsafe`, `Prisma.raw`) appear nowhere in the repository, and that is
worth keeping true: they are the only way to get a string concatenated into SQL
here.

**Input.** Every body is parsed by a zod schema before a handler sees it, every
`:id` goes through `ParseUUIDPipe`, and pagination is capped at 100 rows a page.
Amounts are read from the database, never from the request: the client sends an
id and a count, and what something costs is looked up.

**Volume.** A ceiling over the whole API, counted per address in Redis so it
means the same thing on every instance: `RATE_LIMIT_MAX` requests per
`RATE_LIMIT_WINDOW_SEC` seconds, 300 a minute by default. Health checks are
exempt, and a Redis outage lets requests through rather than refusing them — a
guard rail that fails closed is an outage. Underneath it sit the tighter
per-feature limits: case opening per account (`limits.openPerWindow` in the back
office) and analytics per address.

**Body size.** One megabyte everywhere, which is already generous for an API
whose largest ordinary payload is a settings object. The single exception is
`POST /api/kyc`, raised to twelve, because identity documents arrive as base64
and a passport photographed on a phone is several megabytes before encoding adds
a third. Raising it globally would let any caller make the server buffer twelve
megabytes at a time.

**Headers.** Helmet on every response: `default-src 'none'` and
`frame-ancestors 'none'` (the API renders no pages and is never meant to be
framed), `nosniff`, HSTS, `no-referrer`. CORS is an explicit allowlist from
`CORS_ORIGINS`, not a reflection of whatever Origin arrived.

**Addresses.** `TRUST_PROXY` is off by default. Exposed directly, the API is the
only thing writing `X-Forwarded-For`, so believing the header would let any
caller choose their own address — a fresh rate-limit bucket per request, and
audit entries under addresses they invented. Turn it on once a reverse proxy is
terminating connections and setting the header itself.

**Sign-in.** Steam OpenID and nothing else: there is no password anywhere in the
system, so there is no password to guess. The callback is not trusted on sight —
it is posted back to `steamcommunity.com` with `check_authentication` and only a
confirmed `is_valid:true` counts, after which the claimed identifier has to match
`https://steamcommunity.com/openid/id/<17 digits>` exactly.

**Sessions.** The access token is a 15-minute HS256 bearer token; the refresh
token is an httpOnly, `SameSite=Lax`, `Secure`-in-production cookie. Every other
endpoint reads the bearer header, which a cross-site page cannot set, and the one
cookie-bearing route is a POST, which `SameSite=Lax` does not send cross-site —
so there is no CSRF surface to protect. A ban is read from the database on every
action that moves value rather than from the token, so it takes effect at once;
a *role* travels in the token, so a demotion takes up to fifteen minutes.

**Ownership.** Every route that takes an id resolves it against the caller —
`findFirst({ where: { id, userId } })` — or sits behind the roles guard. Identity
documents are the strictest case: served through the API rather than off a static
path, behind `ADMIN`/`SUPPORT`, with the path on disk resolved from the row (so
there is no path in the request to traverse with), written `0600`, and answered
`Cache-Control: no-store`.

**Money in.** The payment webhook verifies an HMAC over the raw body before the
JSON is parsed, and crediting is a conditional update, so a replayed callback
credits nothing.

**Markup.** No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` — every
player-supplied string (a nickname, a promo code) goes through React, which
escapes it.

**Secrets.** Both JWT secrets are required and must be at least 32 characters;
neither has a default. `.env` is ignored by git and only `.env.example` is
tracked.

### What the deployment still has to provide

The limiter counts requests inside the process, which is the right place to stop
a script and the wrong place to stop a flood: traffic large enough to saturate
the link has already arrived by the time Node sees it. A CDN or a proxy in front
is what absorbs that — and once there is one, set `TRUST_PROXY=true` so the
limiter counts real addresses instead of the proxy's.

Two things are deliberately not capped. WebSocket connections: the gateways have
no client-to-server handlers at all, so a socket can only receive, but it still
costs memory. And the catalogue response, which is a couple of megabytes of JSON;
it is cached in Redis, so the cost is bandwidth rather than database work.

### Still to build

- multi-accounting: correlation by address, fingerprint, trade URL and payment instrument
- withdrawal limits: daily, plus a rule for the first withdrawal after a first deposit
- chargeback risk: holding withdrawals until a deposit has settled
- Steam account age and profile level, which filter out throwaway accounts
- referral self-dealing beyond what is already checked (a code binds only to an
  account with no history, and a sign-up from the inviter's address is flagged)

Separately: **the legal side.** Buying a case with real money is regulated as
gambling in most jurisdictions, and the requirements (licence, KYC, age
verification, country restrictions) depend on where the company is registered and
which countries the traffic comes from. That has to be settled before payments go
live, not after — geo-blocking and KYC are designed in up front (the verification
fields already exist on `User`).

---

## 14. Roadmap

- **Stage 1 (done).** Monorepo, docker-compose, database schema, Steam OpenID,
  provable fairness, case opening with animation and batch opening, upgrades,
  contracts, inventory, drop feed, RU/EN localisation with a currency switch, a
  CRM with a case builder and Steam price synchronisation.
- **Stage 2 (done).** The bot farm, real withdrawals through market.csgo.com and
  through bots of our own, and deposits of skins the same way round.
- **Stage 3 (done).** Case battles, promo codes, a referral system.
- **Stage 4 (done, with three named limits).** Payments behind a provider port,
  operator-reviewed identity checks, CRM reports and exports. What it does not
  include is worth stating rather than leaving to be discovered:
  - no live payment provider — the port ships with a signed demo adapter, and a
    real one is an adapter plus a merchant account, not a redesign;
  - no third-party identity verification — a provider is a contract, a
    data-processing agreement and a per-check fee, which a codebase does not
    decide on its own;
  - no encryption at rest for identity documents and no retention schedule —
    both properties of the volume and the jurisdiction.
- **Stage 5 (done).** Load testing, PgBouncer, a read replica, caching and
  health checks — section 10.

Outside the roadmap, because they turned out to be needed before stage 4: the
appearance builder (section 11d) and the analytics contour (section 11e). Added
later for the same reason: catalogue shelves with per-case descriptions, free
cases rationed by a top-up threshold, the drop strip above the header, public
player profiles, and a catalogue importer that turns a survey file into a
working catalogue.

### What is left

Nothing on the roadmap. What remains is a short list of things the roadmap
never covered, none of which blocks running the site:

- **No admin page for the catalogue shelves.** They are created by the importer
  and by the API, and a case can be moved between them in the case builder, but
  renaming or reordering a shelf has no interface. The translations for that
  page already exist, which is the tell.
- **Item names are stored in one language.** `Item.name` holds whatever the
  import that created the row was reading — English for the demo catalogue,
  Russian for everything the survey importer brought in. The case grid shows
  `market_hash_name` and is unaffected; the inventory is where the mix shows.
- **`weaponType` is null for anything imported in Russian.** The field is
  written and nothing reads it, so this costs nothing today and would need
  fixing before anything does.
- **Thirteen cases sit below the working corridor.** Not a loss — they are too
  stingy rather than unprofitable — and `rebalance-cases` fixes them in one
  run. Left alone because raising a case's payout is an operator's decision.
