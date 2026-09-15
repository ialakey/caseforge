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
apps/bot           Node worker: the Steam bot farm, consumer of the withdrawal queue
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
- **Case** — a case: price, image, active flag, base name and optional English name
- **CaseItem** — an item inside a case with its **ticket range** (`rangeFrom`..`rangeTo`)
- **CaseOpening** — a recorded opening: seed pair, nonce, roll, item dropped
- **InventoryItem** — an item on a user's account, with a state machine
- **Transaction** — the ledger of every balance movement, the single source of truth about money
- **Upgrade** — a staked upgrade: stake, target, chance, roll, outcome
- **Contract** — several items traded for one: stake, solved outcome table, roll, reward
- **DailyBonus** — one spin of the wheel: slice, roll, and whether it is still unspent
- **PromoCode / PromoRedemption** — a top-up promotion and each use of it
- **Setting** — a runtime setting, keyed by the shared registry
- **Withdrawal** — a withdrawal request tied to a bot and a trade offer
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

**Withdrawal from the inventory is a stub.** It marks the item `WITHDRAWN` and
does nothing else: no bot, no trade offer, no queue. The real path — locking,
BullMQ, the bot farm, the trade URL — is section 7.6 and is untouched by it. The
stub is deliberately the only code that shortcuts it, so wiring the farm to the
interface later is a deletion rather than an untangling.

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

### 7.5 The bot farm

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
request → validation (trade URL, hold, limits, anti-fraud)
        → BullMQ withdrawals queue
        → pick a bot that holds the item and has free slots
        → create the trade offer
        → auto-confirm via identity_secret
        → poll the offer status
        → accepted / declined / expired → update InventoryItem
```

The whole chain is idempotent by `withdrawalId`: re-running the job does not create
a second offer. That is critical — a queue retry without idempotency means handing
out the item twice.

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
- `battle:{id}` — case battle state

At peak the drop feed is the hottest channel. It is aggregated: events collect in a
buffer and are broadcast in batches roughly every 300 ms rather than one by one.
That is the difference between 50k and 2k messages per second for an identical user
experience.

---

## 10. Load

Traffic for sites like this is sharply uneven: an ordinary day, then a 20x spike
during a streamer's giveaway. Capacity has to be planned off the spike.

Done up front:
- **stateless API** — horizontal scaling behind a load balancer, state only in Postgres and Redis
- **PgBouncer** in transaction mode: Node with a pool per instance burns through Postgres connections very fast
- a **read replica** for storefronts and CRM reports, so a heavy report does not sit on the game core
- **Redis** for prices, case configs, sessions and rate-limit counters
- **queues** for everything that leaves the building (Steam, payments, webhooks) — an external API has no business holding a user's HTTP request open
- **Cloudflare** in front of everything, with L7 protection mandatory

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

- rate limits on case opening and withdrawal requests — per user and per IP
- multi-accounting: correlation by IP, fingerprint, trade URL and payment instrument
- withdrawal limits: daily, plus a rule for the first withdrawal after a first deposit
- chargeback risk: hold withdrawals until a deposit has "settled"
- checking Steam account age and profile level — filters out throwaway accounts
- every incoming amount is validated server-side; the client never sends a price, only an id
- secrets only in the environment or a secret manager; the repository holds `.env.example`

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
- **Stage 2.** The bot farm, real withdrawals, item deposits.
- **Stage 3.** Case battles, promo codes, a referral system.
- **Stage 4.** Payments, KYC, full CRM reporting.
- **Stage 5.** Load testing, PgBouncer, replicas, tuning for the spike.
