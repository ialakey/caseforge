<h1 align="center">CaseForge</h1>

<p align="center">
  <b>An open-source CS2 case-opening platform.</b><br>
  Steam sign-in, provable fairness, an RTP-balanced case builder,<br>
  item withdrawal bought on market.csgo.com and an admin CRM.
</p>

<p align="center">
  <a href="https://github.com/ialakey/caseforge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ialakey/caseforge/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <a href="README.ru.md"><img alt="Русская версия" src="https://img.shields.io/badge/README-%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-informational"></a>
</p>

---

Every piece of the loop is here and working: a player signs in with Steam, opens
a case, watches the reel stop on a real item, sells it back or upgrades it, and
requests a withdrawal that is bought on market.csgo.com and delivered to their
trade link by the seller. The odds are provably
fair and re-verifiable in the browser, item prices come from the Steam market,
and the back office computes margin per case before it goes live.

The stack and the architectural decisions are covered in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


<p align="center">
  <img src="docs/screenshots/en/bonus-teaser.png" alt="The landing page with the live drop strip above the header" width="900">
</p>

<p align="center">
  <em>The live drop strip sits above the header on every page, with the best drop of the day pinned to its left. It is clipped rather than scrollable: a new drop pushes the oldest out of sight, so the whole of it is readable without a gesture.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/catalogue.png" alt="The case catalogue grouped into shelves" width="900">
</p>

<p align="center">
  <em>Two hundred cases are a wall, so the catalogue is grouped into shelves with jump links above them. The moment somebody searches, the shelves are dropped and the matches shown flat.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/case-contents.png" alt="A case's contents with the rarity of each item and its exact drop chance" width="900">
</p>

<p align="center">
  <em>Every case publishes its contents: rarity, current price and the exact chance of each item. The odds are the ticket ranges the server rolls against, not a marketing figure.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/case-free.png" alt="A free case with its top-up requirement and daily limit" width="900">
</p>

<p align="center">
  <em>A free case costs nothing and is rationed instead by a top-up threshold and an opening limit over a rolling 24 hours. The terms are shown as progress with the player's own numbers against them, because "you need another $107" is an instruction where a greyed-out button is a dead end.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/profile-public.png" alt="A player's public profile with their recent drops" width="900">
</p>

<p align="center">
  <em>Every drop in the strip links to whoever won it. The public profile carries a name, an avatar, the month they joined and their recent drops — and nothing else: balances, top-ups and trade links are absent from it by construction rather than by filtering.</em>
</p>

---

## Stack

| | |
|---|---|
| `apps/web` | Next.js 15 (App Router), React 19, Tailwind, Zustand, socket.io-client |
| `apps/api` | NestJS 11 on Fastify, Prisma 6, Postgres 16, Redis 7, BullMQ, socket.io |
| `apps/bot` | Node worker: the withdrawal queue consumer — market purchases, and the Steam bot farm |
| `packages/shared` | shared types, zod schemas, translations, ticket logic and provable fairness |

Why TypeScript, and why the trading layer has to run on Node, is covered in
section 1 of the architecture document.

---

## Quick start

Requires Node ≥ 22, pnpm 11 and Docker.

```bash
cp .env.example .env       # no editing needed for a local run
pnpm setup                 # install + docker + shared build + migrations + seed
pnpm dev                   # api on :4000, web on :3000
```

`pnpm setup` runs, in order:

```bash
pnpm install
pnpm infra:up                              # Postgres :5433, Redis :6380
pnpm --filter @caseforge/shared build      # api and web import the built output
pnpm db:migrate
pnpm db:seed                               # only the demo administrator and their seed pair
```

Ports 5433 and 6380 are deliberately non-standard so they do not clash with a
locally installed Postgres or Redis.

The catalogue of 20 themed cases is populated by a separate command. It talks to
Steam and therefore takes about ten minutes:

```bash
pnpm seed:cases
```

Contents are not hard-coded by name: items are picked by searching the market,
so each one is guaranteed to have an image and a real price. From there a case
is assembled the same way it would be by hand in the CRM — auto-balanced to a
target RTP and saved through the same validation.

`db:seed` deliberately creates neither items nor cases. It used to, with guessed
prices, and that turned out to be a trap: after the very first sync the real
Steam prices differed by an order of magnitude, cases went into loss, and
re-running the seed silently overwrote fixes made in the CRM.

#### A whole catalogue from a survey file

`pnpm --filter @caseforge/api seed:catalogue` imports a catalogue described by a
survey file — `apps/api/prisma/data/catalogue.json`: a list of shelves, and a
list of cases with their prices and the item names they hold. It creates the
categories, resolves every name against the Steam market, balances each loot
table to the target RTP and saves the case through the same validation the CRM
uses.

Two things the survey cannot supply are generated. Each case is drawn its own
SVG into `apps/web/public/cases/`, coloured by its shelf and keyed off its slug,
because case art is not something to take from another site. Each description is
composed from the loot table that was just balanced — how many items, which
rarities, the top drop — because case pages elsewhere carry no prose to import.

Steam answers about ten items per request and allows roughly seventeen requests
a minute, so a full run takes upwards of an hour. The resolved pool is cached on
disk, so an interrupted run resumes where it stopped and a second run costs no
Steam requests at all:

```bash
pnpm --filter @caseforge/api seed:catalogue -- --group=collections --dry-run
pnpm --filter @caseforge/api seed:catalogue            # everything not yet imported
```

### Verification

```bash
pnpm test          # unit tests: provable fairness, ticket ranges, balancing, upgrade odds
pnpm typecheck     # every package
pnpm test:smoke    # end-to-end run against a live API
pnpm test:smoke:battles   # battles and referrals, same requirements
pnpm test:smoke:analytics # the appearance builder and the analytics contour
pnpm test:load     # load generator, also against a live API
```

`test:smoke` needs the infrastructure up and the API running. It covers what
unit tests cannot: the atomicity of the balance debit, that the active server
seed never leaks, that an opening recomputes after rotation, that the balance
agrees with the ledger, that roles keep the admin panel closed, that every item
in an active case has an image and a Steam-confirmed price, and that the server
refuses a loss-making case and a case with a gap in its ticket ranges.

`test:smoke:battles` is the same kind of pass over case battles and referrals: it
plays a real battle between two throwaway accounts and re-derives every roll in
it from the seed pair on record, checks that the items all end up with the
winner, that a cancelled battle refunds every seat, and that a referral
commission accrues once, pays out once and takes itself back when the seat it
was charged on is refunded.

### If a case turns red on RTP

Item prices drift, and a case assembled at 90% can wander off. Recovery is two
clicks in the builder: **Fit price to RTP**, then **Solve the odds**, then save.

For the whole catalogue at once there is a script, because a log line is an
alert and not a repair:

```bash
pnpm --filter @caseforge/api rebalance-cases -- --dry-run   # report only
pnpm --filter @caseforge/api rebalance-cases                # re-solve the drifted ones
```

It moves the odds and never the price, and reports rather than repricing a case
it cannot solve at the current price — that is a decision about what the case
is. Free cases are skipped: there is no return on a stake when nothing is
staked.

---

## Language and currency

Two switches in the header: **RU / EN** and **₽ / $**.

With no stored preference the language follows the browser, and the currency
follows the language. Both choices are remembered in `localStorage`.

The currency switch is **display only**. Everything is settled in roubles:
balances, item prices and case prices are stored as integer minor units of the
base currency, and no ledger entry ever holds a converted amount. The dollar
figure is that same number divided by the exchange rate at render time. Treating
a display rate as a settlement rate is how a site ends up selling items below
cost after a currency move.

The rate comes from the Central Bank of Russia's public daily feed — no key, no
quota — refreshed every six hours and cached in Redis. If the feed is
unreachable, the previous rate keeps being served: a stale rate beats a broken
price list.

Interface strings live in one dictionary in `packages/shared/src/i18n.ts`.
Server errors carry a machine-readable `code` alongside an English `message`;
the interface translates the code and falls back to the message for codes a
build does not know yet, so an error added on the backend stays readable before
its translation lands.

Case names are content, not interface text, so they live in the database: each
case has a base name and an optional English one, both editable in the builder.
The CRM itself is English only — translating an internal tool doubles the
maintenance for an audience of a few people.

---

## What already works

- Steam OpenID 2.0 sign-in with server-side verification; the avatar and
  nickname are pulled without a Web API key, through the public profile XML
- **Russian and English interface** with a language switch, and prices in
  roubles or dollars with a currency switch
- **balance top-up** through a stub (demo mode, disabled by a flag)
- **a catalogue grouped into shelves**: categories are data, not an enum, so a
  shelf can be added for a holiday and removed afterwards without a deploy, and
  a case carries a description in both locales under its title
- **free cases**: they cost nothing and are rationed by a top-up threshold and
  an opening limit over a rolling 24 hours instead of by a price, with the terms
  shown to the player as progress rather than as a refusal
- **a live drop strip above the header on every page**, with the best drop of the
  last day pinned to it, and every card linking to the player who won it
- **public player profiles**: a name, an avatar, the month they joined and their
  recent drops, switchable off in one setting
- **a catalogue importer**: a survey file of shelves, cases and item names
  becomes a working catalogue — odds solved, art drawn and descriptions composed
- **case builder in the CRM**: Steam market search, import with image, rarity
  and price, a case image, auto-solved odds for a target RTP, a live margin verdict
- **prices and images from Steam**: hourly synchronisation, RTP recalculation for
  every active case, a warning about prices Steam never confirmed
- **CS-style opening animation**: a reel of items decelerating under a marker,
  the winner highlighted while the rest dim
- **up to 10 cases opened at once**: one reel per case, stopping in sequence
- **instant sale of a drop** straight from the results panel, per item or all at once
- **upgrade**: stake your skin against a pricier one, with the chance derived
  from the price ratio
- **contracts**: trade 3 to 10 items for one, over a reward table solved so the
  expected payout is the same 90% the cases run on
- **case battles**: two to four players open the same list of cases and one of
  them takes every item, with each drop still an ordinary, individually
  verifiable opening, and an unfilled battle refunded in full
- **referrals**: an invite link per player, commission on what the people they
  invited top up and spend, accrued on its own and paid out on request
- **a daily bonus wheel**: one spin a day for money, a discount, a free opening
  or a skin, rolled from the same seed pair as everything else
- **promo codes on a top-up**: percentage or flat, with per-code and per-player
  limits, created in the back office
- **the site builder**: the name, logo, palette, banner, navigation and footer
  are settings served to the browser at runtime, with presets and a live preview
- **analytics**: visitors, funnels, retention cohorts, traffic sources,
  per-feature margin and per-player revenue, with the money read from the ledger
  rather than from a second set of numbers
- **runtime settings**: limits, fees, the top-up bounds and the wheel itself are
  edited in the panel and take effect without a deploy
- the whole interface, **back office included**, switches between Russian and
  English from the header — settings labels and the RTP verdict along with it
- provable fairness: seed pairs, rotation with reveal, and re-verification **in
  the browser** by an independent Web Crypto implementation
- case opening in a single transaction with an atomic debit and nonce reservation
- site inventory: filters by state and price band, selling one item or
  everything on screen at once behind a confirmation, and withdrawal
- nothing is ever deleted from the inventory — a sold, withdrawn or staked item
  keeps its row and changes status, so the history stays readable
- a live drop feed over Redis Pub/Sub, batched every 300 ms
- withdrawal requests: item locking, a BullMQ queue, idempotency by request id
- **withdrawal through market.csgo.com**: a pool of accounts buys each skin and
  the seller delivers it to the player, with an operator-set price ceiling, an
  idempotency key that survives a lost reply, per-item delivery tracking, and
  per-key throttling so the market's rate limit cannot cost you a key
- the bot farm, still available as the alternative channel: bot login, an
  inventory mirror, trade offers, hold checks, status polling
- CRM: a GGR dashboard, per-case margin, a case builder with range validation and
  RTP calculation, balance adjustments through the ledger, an audit log
- nightly reconciliation of balances against the transaction ledger

## What is not there yet

Stages 1 to 3 of the roadmap (section 14 of the architecture document), bar item
deposits. Not implemented: real payments, depositing items from Steam, KYC and
the full CRM reporting of stage 4.

---

## Configuration

The canonical `.env` lives at the monorepo root — api, bot and prisma all read it.

What actually needs filling in before a production run:

| Variable | Why |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | `openssl rand -hex 32` each |
| `STEAM_API_KEY` | https://steamcommunity.com/dev/apikey. Without it the profile falls back to the public XML; sign-in works either way |
| `BOT_SECRETS_KEY` | `openssl rand -hex 32`, exactly 64 hex characters. Encrypts both the market API keys and the Steam bot secrets |
| `BOOTSTRAP_ADMIN_STEAM_ID` | your SteamID64: that account gets the ADMIN role on first sign-in. An account that already exists is promoted with `pnpm grant-admin <SteamID64 \| nickname>` |
| `ENABLE_STUB_DEPOSITS` | `true`/`false`. The stub top-up. On by default in development, **off in production**, enabled only by an explicit `true` |

---

## Profile and balance

After signing in, the header shows the Steam avatar and nickname; the profile
page adds a card with the SteamID and a link to the Steam profile, a trade URL
field and the history.

The session survives the access token. The token is short-lived on purpose, and
the browser renews it against the refresh cookie the moment a call comes back
401, retrying the original request once. A player who leaves a tab open over
lunch comes back signed in; only a refresh that itself fails ends the session.

The trade URL is checked against the account: `partner` in it is the low 32 bits
of the SteamID64, and somebody else's link is rejected before a withdrawal could
follow it.

Items are never deleted from the inventory. Selling, withdrawing or staking one
moves it to another status and it stays on the account as a record of what
happened — a player who sold a knife can still find it and see what they got for
it. The tabs split the inventory by what the player is looking for, and the price
bands narrow it further.

<p align="center">
  <img src="docs/screenshots/en/inventory.png" alt="The inventory filtered to available items, each with a sell and a withdraw button" width="900">
</p>

<p align="center">
  <em>Available items, filtered by state and price band. Selling everything on screen asks for confirmation and names the amount first.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/inventory-history.png" alt="The inventory history tab showing sold, withdrawn and staked items" width="900">
</p>

<p align="center">
  <em>The same inventory on its history tab: sold, withdrawn and staked items keep their row and carry the status that explains where they went.</em>
</p>

**Withdrawal is real.** Pressing it locks the item and queues a request; the
worker buys that exact skin on market.csgo.com and the seller sends it to the
player's trade link. The item stays on record as `LOCKED` until the market
confirms delivery, and goes back to `AVAILABLE` if the purchase fails. See
[Withdrawal](#withdrawal) below.

**Top-up is a stub.** The button credits the entered amount with no payment at
all. It exists so the gameplay loop can be exercised before a payment provider
is wired in. The credit still goes through `Transaction`, so the nightly balance
reconciliation stays correct. The real flow will be different: an invoice at a
PSP, a redirect, and a balance change only on a payment webhook, idempotent by
payment id. In production the stub is off by default.

---

## Upgrade

`/upgrade` — the player stakes a skin against a pricier one: win and they get
the expensive item, lose and they forfeit their own.

The chance is not set by hand but derived from prices:
`chance = stake / target × 90%`. The same 90% the cases run on, so the upgrade
lives in one economy with them instead of becoming a separate game with its own
maths. The expected value works out to exactly `90%` of the stake at any
multiplier — there is a test for that.

Bounds: the target must be at least 1.05x pricier (below that it is a swap with
a fee, not an improvement), the chance is capped at 85%, and an excessive price
gap is rejected. The range of available targets is computed with the same
formula as the chance, so the list never offers an option the server will refuse.

The outcome comes from the same roll as a case opening — the same seed pair and
the shared `nonce` counter. The upgrade needs no fairness page of its own: it is
verified exactly the same way.

---

## Contracts

`/contract` — the player throws between 3 and 10 items in and gets exactly one
back. Unlike an upgrade there is no losing branch: a contract always pays out,
the only question is what.

<p align="center">
  <img src="docs/screenshots/en/contract.png" alt="A contract with five staked items and the full table of possible outcomes" width="900">
</p>

<p align="center">
  <em>The staked items, the reward band they imply, and the table the roll will actually run against — every outcome with the chance the server computed for it.</em>
</p>

The table is not authored by hand. Rewards are drawn from the catalogue in a band
of 0.1x to 5x the staked sum, and the weights are solved so the expected reward
equals `stake × 90%` — the same margin the cases and the upgrade run on. The
weights follow an exponential tilt over the pool, with the exponent found by
bisection. The point of the construction is that the margin becomes a constant of
the system rather than a property of whatever happens to be priced inside the
band.

The solved table is snapshotted onto the contract row. The pool comes from a live
catalogue and cannot be rebuilt later from prices that have since moved — without
the snapshot the roll would stay reproducible but would no longer mean anything.

---

## Daily bonus

`/bonus` — one spin of the wheel every 24 hours. The prizes are money, a cut off
the next opening, a free opening up to a price ceiling, or a skin.

<p align="center">
  <img src="docs/screenshots/en/bonus-wheel.png" alt="The daily bonus wheel with its eight prize slices and the spin button" width="900">
</p>

<p align="center">
  <em>The wheel is a ticket table like a case, and the slices are drawn from the very ranges they are rolled against — the 30% prize takes up 30% of the rim and the 3% one is a sliver.</em>
</p>

<p align="center">
  <img src="docs/screenshots/en/bonus-teaser.png" alt="The landing page with the daily bonus offered under the banner" width="900">
</p>

<p align="center">
  <em>The landing page says outright that a spin is waiting. A reward the player has to go looking for is a reward most of them never claim.</em>
</p>

The wheel is not a game of its own. It is a ticket table exactly like a case,
rolled from the same seed pair and the same shared `nonce` counter, so a spin is
checked the way a drop is. The slices are drawn in proportion to their real
ticket ranges, which is why the rare ones look thin.

The cooldown is a rolling day rather than a calendar one — a calendar reset hands
whoever lives in the right timezone two spins a few hours apart. It is claimed
with a conditional `UPDATE` rather than read and then written: between a read and
a write, two requests fired together both pass the check.

Money and skins are settled the moment the wheel stops. A discount and a free
opening are vouchers: they sit on the account until an opening spends them. An
opening takes whichever voucher saves the most on that particular basket — a
first-in-first-out queue would burn a half-price voucher on the cheapest case in
the catalogue while a free opening sat behind it — and says which one it spent,
so a reward never disappears without explanation.

---

## Case battles

`/battles`. Line up a list of cases, pick two to four seats, and everybody opens
that same list at once. One of them keeps every item that dropped: in the
standard mode the biggest total, in the crazy mode the smallest.

Each seat pays the full list price, so a battle does not change the site's
margin — the pot moves between the players, and the expected return is the
weighted RTP of the cases in it.

<p align="center">
  <img src="docs/screenshots/en/battles.png" alt="The battle lobby: open battles with their mode, seats and entry price" width="900">
</p>

<p align="center">
  <em>The lobby. A seat taken in another browser disappears from this one without a reload, and the host of a battle nobody joined can call it off.</em>
</p>


**Every drop in a battle is an ordinary case opening.** The roll comes from the
opening player's own seed pair and their own nonce, so each player verifies their
own drops in their profile with the same arithmetic as a solo opening; a battle
adds a comparison at the end, not a second source of randomness. The items are
created in the winner's inventory while still pointing at the opening that rolled
them, so the record keeps both who rolled an item and who owns it.

The last seat to be taken plays the whole battle out in one transaction, and the
reels then play it back round by round. A tie is decided by the single best drop
— the worst one in the crazy mode — and then by the earlier seat: both are
functions of rolls already on the record.

<p align="center">
  <img src="docs/screenshots/en/battle.png" alt="A finished four-player battle with every drop, the totals and the winner" width="900">
</p>

<p align="center">
  <em>A played battle. Every tile is an ordinary opening with its own roll and nonce, so each player can verify their own column in their profile.</em>
</p>


A battle nobody joins is cancelled by a sweeper after a configurable wait and
every seat is refunded in full through the ledger, so the worst case for a host
is a wait rather than a loss.

---

## Promo codes

Created in the back office at `/admin/promo`. A code is a percentage of the
top-up or a flat credit, with an optional minimum top-up, a cap on the bonus, a
total number of uses and a per-player limit.

<p align="center">
  <img src="docs/screenshots/en/admin-promo.png" alt="The promo code page of the back office with the code list" width="900">
</p>

<p align="center">
  <em>Codes are created and edited by code name, and the list shows how many times each has been redeemed against its cap.</em>
</p>

A code **adds to** the top-up rather than discounting it. That matters once a
real payment provider is behind the button: the sum charged has to be the sum
the provider was told about, and a code that changed it would put the two out of
step. Adding on top keeps the whole promotion on our side of the transaction.

The bonus is its own ledger row rather than being folded into the deposit. What
the player paid and what the promotion gave them are different kinds of money,
and a report that cannot tell them apart cannot measure what the promotion cost.

Limits are enforced with a conditional `UPDATE` on the counter rather than by
counting rows and then writing: between a count and an insert, two top-ups fired
together both see the last use available and both take it.

---

## Referrals

`/referral`. Every player has an invite code and a link that carries it. Somebody
following that link is bound to the inviter when they sign in, and a share of
what they then spend is credited to the inviter: a percentage of their top-ups
and a percentage of what they pay to open cases, a battle seat included. Both
rates, and the smallest payout, are runtime settings.

Commission accrues into its own rows and lands on the balance only when the
inviter claims it, as a single ledger entry. That keeps the ledger proportional
to the number of payouts rather than to the number of drops — and it is why the
referral page shows "accrued" and "paid out" as two different numbers.

An invite binds once and only to an account with no history on it: a player who
has already opened a case or moved money is not somebody's fresh recruit. A
player cannot use their own code, and a sign-up from the inviter's own address is
flagged for an operator rather than refused, because a household shares an
address. A refunded battle seat takes its commission back with it.

<p align="center">
  <img src="docs/screenshots/en/referral.png" alt="The referral page: the invite link, the code, what has accrued and who was invited" width="900">
</p>

<p align="center">
  <em>Accrued and paid out are two different numbers, because commission sits in rows of its own until it is claimed.</em>
</p>


---

## The site builder

`/admin/appearance`. The name, the logo, the palette, the banner, which sections
exist in the navigation and what the footer says are settings, not code — they
are served to the browser at runtime and take effect on the next page load.

<p align="center">
  <img src="docs/screenshots/en/admin-appearance.png" alt="The appearance builder with the palette fields, the live preview and the site preview" width="900">
</p>

<p align="center">
  <em>The panel on the right is drawn from the draft and follows the colour picker immediately; the frame below it shows the saved site, which is what a visitor would get.</em>
</p>

The stylesheet was already built on tokens, so nothing in a component knows that
a colour is configurable — which is exactly why every component responds to one.
Five presets give a starting point, and every field stays editable afterwards.

**An empty field means the shipped default.** A blank headline falls back to the
translated string, so an operator fills in only what they want to differ and a
site nobody has configured looks exactly as it ships — in both languages.
Appearance cannot reach the odds: the ticket space, the RTP and the wheel live in
their own groups, where a change is a change to the game rather than to its
paint.

Two of the groups are about what exists rather than what it looks like. **Drop
feed** switches the strip above the header on or off and decides whether the
best drop of the day is pinned beside it. **Player profiles** decides whether
`/u/<id>` exists at all: with it off the API answers 404 and the cards in the
strip stop being links, so the rule is enforced on the server rather than by
hiding a link in the browser.

---

## Analytics

`/admin/analytics`. Visitors, sessions, signups, active players, turnover, GGR,
actual RTP, deposits, withdrawals, per-player revenue, battles and referral
commission — over any of three periods, each against the period before it.

<p align="center">
  <img src="docs/screenshots/en/admin-analytics.png" alt="The analytics dashboard with its KPI tiles, the daily chart, the funnel and the per-feature margin" width="900">
</p>

<p align="center">
  <em>Every tile carries its change against the previous period of the same length: a number with nothing to compare it to is a number nobody can act on.</em>
</p>

Behind it is one rule: **the ledger is the analytics store for everything that
moved money.** A report over openings and transactions is a query, so that is
what it is; the event stream carries only what the database cannot answer —
arrivals, sources, page views, and the clicks that never became a purchase. The
funnel is where the two meet, with an event-based top and a ledger-based bottom.

The dashboard also has traffic sources with their conversion, weekly retention
cohorts, the top players by turnover, per-feature margin, device split, and the
raw event stream for when a number needs explaining. Daily rollups keep a month
of history cheap to read; the headline numbers are computed over the range
itself, because a sum of daily uniques is not a unique.

No IP addresses and no user agents are stored.

---

## Runtime settings

`/admin/settings`. Maintenance mode, the top-up bounds, the sell-back fee, the
opening rate limit, the wheel's cooldown and slices, the battle limits and how
long an unfilled one waits, both referral commission rates and the smallest
payout, and the whole withdrawal policy — which channel delivers, how far above
the credited price a purchase may go, the minimum seller delivery rate — are
stored in the database and read at request time, so changing one is a save
rather than a deploy.

<p align="center">
  <img src="docs/screenshots/en/admin-settings.png" alt="The settings page of the back office, grouped by area" width="900">
</p>

<p align="center">
  <em>Each field is rendered from the registry, key and all — so a setting added in the shared package appears here with no change to the panel. The battles, referrals and appearance groups all arrived exactly that way; the last of them has a builder of its own, and the link says so.</em>
</p>

The form is generated from a registry declared once in
`packages/shared/src/settings.ts` — each setting names its group, its type, its
bounds and its default. Adding a knob is a line in that file; the admin panel
picks it up with no change of its own.

**What is deliberately not configurable:** the ticket space, the seed algorithm
and the shape of a roll. Those are not tuning parameters but the terms of a
promise — every past opening was published against them, and an operator able to
edit them could make yesterday's drops stop verifying.

---

## Working with cases in the CRM

`/admin/cases` lists the cases with their RTP and margin; `/admin/cases/new`
opens the builder.

How a case is assembled:

1. **Search for an item** on the Steam market, right inside the builder. Results
   are cached for an hour: Steam throttles requests.
2. **Add it** — the item is imported into the catalogue together with its image,
   rarity and price in the settlement currency.
3. **Balance** — set a target RTP and press *Solve the odds*: ticket ranges are
   laid out so the expected return matches the target, the pricier the item the
   rarer it is. *Fit price to RTP* solves the inverse problem, computing the case
   price for the odds already set.
4. **Save** — the server independently recomputes the RTP from database prices
   and refuses the case if the return exceeds 98% or the ranges do not tile the
   ticket space.

Alongside the loot table the builder carries the case's **shelf**, its
**description** in both locales, and — behind one checkbox — the **free case**
terms: the minimum top-up over the last 24 hours and how many openings are
allowed in that window. Marking a case free sets its price to zero and takes
the RTP and margin readouts off the page, because there is no return on a stake
when nothing is staked. The pair is checked at the edge: a free case priced
above zero and a paid case priced at nothing are both refused.

The balancing model: an item's weight is inversely proportional to its price
raised to `k`, and `k` is found by binary search against the target RTP. The
achievable RTP range is bounded by the cheapest and priciest item — if the
target falls outside it, the builder says what to change.

A separate check covers **unconfirmed prices**. An item whose price Steam never
returned (no listings, a wrong name) keeps whatever number was put into it by
hand, yet counts towards the RTP like any other. Such items are flagged both in
the case list and in the builder.

One detail about names: knives and gloves carry a `★` prefix on the market
(`★ Karambit | Marble Fade (Factory New)`). Without the star Steam does not know
the item, and neither the price nor the image will resolve.

---

## Withdrawal

The site holds no skins of its own. A withdrawal is a purchase: a market.csgo.com
account buys the exact item the player is taking out and names their trade link
as the recipient, so the seller delivers it directly. This is
how most case sites work now, and the reason is arithmetic rather than fashion —
a bot farm has to hold every skin it might ever hand out, funded up front and
capped at 1000 slots per account, and it still fails the moment somebody wins
something no bot owns.

```
player presses Withdraw
  -> items -> LOCKED, one Withdrawal row, one BullMQ job         (api)
  -> per item: search-item-by-hash-name, then buy-for with the
     player's partner/token and a price ceiling                  (worker)
  -> poll get-list-buy-info-by-custom-id until stage 2 or 5      (worker)
  -> delivered -> WITHDRAWN, cancelled -> back to AVAILABLE
```

What the design is actually about:

- **Never paying twice.** Each purchase row's own id travels as the market's
  `custom_id`, and the row is unique on the inventory item. A job that dies
  between the account being charged and the reply arriving is resolved by asking
  the market about that id, not by buying again — and asking the *same account*,
  since a key only answers for its own purchases.
- **More than one account.** The market deletes a key that exceeds five requests
  a second, so one key caps how fast the whole site can hand items out. Each
  account is throttled on its own, purchases go to the least recently used one
  that can afford them, and every purchase is bound to its account before the
  money moves.
- **Never refunding an item that is on its way.** An item returns to the
  inventory only when the purchase for it is known not to have happened. A
  purchase that is merely unfinished keeps its item locked, and one that was
  paid for is never written off on a timer — it is shown to an operator instead.
- **A price ceiling.** The player was credited a price when the item dropped; the
  market charges what it charges today. `withdrawals.market.maxOverpayBps` is how
  far apart those may be before the site refuses and hands the item back.
- **Requests are not atomic.** Three items are three sellers. A request can end
  `PARTIAL`, and the profile page says which item went where.

Currency matters more than it looks: the market quotes roubles in kopecks but
dollars and euros in *thousandths*, and reports balances as floats in whole
units. An account whose currency differs from the site's settlement currency is
refused outright rather than converted through a display rate.

The channel is chosen by the `withdrawals.provider` setting and stamped on each
request when it is made, so switching it never strands anything in flight.

Register an account — as many as you need:

```bash
MARKET_ACCOUNT_LABEL=main MARKET_ACCOUNT_KEY=... pnpm --filter @caseforge/bot add-market-account
```

The key is read from the environment rather than the command line, and stored
encrypted under `BOT_SECRETS_KEY`; only the worker ever decrypts one. The back
office reports balance and health from snapshots the worker writes, and can take
an account out of rotation, but never sees a key.

---

## Steam bots

The alternative channel, kept because a site that has already funded a farm
should not be forced off it, and because an account holding its own inventory is
the only way to deliver something the market is not selling.

A bot is a separate Steam account with the mobile authenticator enabled.
`shared_secret` and `identity_secret` come from the maFile; without them offers
cannot be auto-confirmed.

```bash
cd apps/bot
BOT_STEAM_ID=7656119... BOT_USERNAME=... BOT_PASSWORD=... \
BOT_SHARED_SECRET=... BOT_IDENTITY_SECRET=... \
pnpm add-bot
```

Secrets are never stored in the clear: the script encrypts them with AES-256-GCM
under `BOT_SECRETS_KEY`, and they are decrypted only inside the bot worker.

The constraints the withdrawal logic is built around (details in section 7.4 of
the architecture document): a Steam inventory holds 1000 slots, a trade hold of
up to 15 days applies to a recipient without a mobile authenticator, and Valve
rate-limits offer creation.

---

## Scaling and load

Everyday development needs neither a connection pooler nor a replica, so
`pnpm infra:up` starts Postgres and Redis and nothing else. The shape the site
is meant to run under load lives behind a compose profile:

```bash
pnpm infra:replica:init    # prepares the running primary: replication role + pg_hba
pnpm infra:up:scale        # adds PgBouncer (:6433) and a streaming replica (:5434)
pnpm infra:replica:status  # who is streaming, and how far behind
```

Then point the API at them — the three lines are commented out in `.env.example`:

```env
DATABASE_URL="postgresql://csgo:csgo@localhost:6433/csgo_case?schema=public&pgbouncer=true&connection_limit=10"
DIRECT_DATABASE_URL="postgresql://csgo:csgo@localhost:5433/csgo_case?schema=public"
REPLICA_DATABASE_URL="postgresql://csgo:csgo@localhost:5434/csgo_case?schema=public"
```

**PgBouncer** runs in transaction mode: Node keeps a pool per process, so
Postgres's connection limit is spent by instances times pool size long before
the database is busy. Migrations bypass it through `DIRECT_DATABASE_URL`, because
they open long sessions and take locks that transaction pooling cannot carry.

**The replica** serves the reads that tolerate lag — CRM reports, the public
catalogue, the battle lobby, the drop feed — and nothing a player has just
written. With `REPLICA_DATABASE_URL` unset every read goes to the primary and no
code path changes.

**`GET /api/health`** reports Postgres, Redis and the replica's replay lag, for a
load balancer and for whoever is on call.

Load is generated from inside the repository, with no tool to install first:

```bash
pnpm test:load                                            # 20s of browsing, 50 concurrent
pnpm test:load -- --scenario=mixed --concurrency=100 --duration=30
pnpm test:load -- --scenario=battles --users=8
```

The generator shares the machine with the API and the database, so its numbers
are comparative — before and after a change — rather than a capacity figure.
Section 10 of the architecture document explains what is cached, what is
deliberately not, and why.

---

## Layout

```
apps/
  api/
    prisma/schema.prisma     data model, money as integer minor units
    prisma/seed.ts           the administrator only; the catalogue comes from Steam
    src/auth/                Steam OpenID + JWT
    src/cases/               case opening — the core of the project
    src/upgrade/             upgrade: odds, roll, stake consumption
    src/contracts/           contracts: solved outcome table, roll, reward
    src/bonus/               the daily wheel: cooldown, roll, vouchers
    src/battles/             case battles: seats, settlement, the refund sweeper
    src/promo/               promo codes: rules, preview, redemption
    src/referral/            referrals: binding, commission, payout
    src/inventory/           inventory: filters, selling
    src/drops/               batched WebSocket feed
    src/withdrawals/         withdrawal requests and queueing
    src/market/              the market.csgo.com account, for the back office
    src/admin/               CRM: reports, case builder, audit
    src/analytics/           the event stream, the nightly rollups and the reports
    src/steam/               OpenID, the Steam market, price and image sync
    src/common/              config, Prisma, the read client, the Redis cache, health, roles, nightly reconciliation
    test/smoke.mjs           end-to-end run against a live API
    test/battle-smoke.mjs    battles and referrals against a live API
    test/analytics-smoke.mjs the appearance builder and the analytics contour
    test/load.mjs            load generator: browse, open, battles, mixed
  bot/
    src/market-pool.ts       the market accounts: throttling, balances, whose turn it is
    src/market-processor.ts  buying on market.csgo.com and settling a request
    src/settings-reader.ts   the runtime settings, as the worker reads them
    src/crypto.ts            bot secret encryption
    src/steam-bot.ts         wrapper over steam-user / steamcommunity / tradeoffer-manager
    src/bot-pool.ts          the farm: who can hand out which items
    src/withdrawal-processor.ts  idempotent request handling on the bot channel
    scripts/add-bot.ts       bot registration
    scripts/add-market-account.ts  market key registration
  web/
    src/app/                 home, case, battles, upgrade, contract, bonus, referral, profile, CRM
    src/app/admin/cases/     case list and builder
    src/components/          drop feed, opening reel, cards, switches
    src/lib/                 API client, auth store, settings store, socket
tools/
  infra/
    init-replication.mjs   prepares a running primary for a standby
    replica-status.mjs     who is streaming, and how far behind
packages/
  shared/
    src/i18n.ts              interface dictionary, RU and EN
    src/errors.ts            error codes shared by the API and the interface
    src/money.ts             minor units, display currencies, formatting
    src/tickets.ts           ticket space, range validation, RTP
    src/balancing.ts         auto-solved odds for a target RTP, margin verdict
    src/upgrade.ts           upgrade odds and bounds
    src/contract.ts          contract reward table: the tilt and its solver
    src/bonus.ts             the wheel: slices, ticket ranges, cooldown
    src/appearance.ts        the theme, its CSS variables and the presets
    src/analytics.ts         event contract, metric keys, funnel and retention maths
    src/battle.ts            battle limits, entry price, standings and tiebreaks
    src/promo.ts             promo code rules and what one is worth
    src/referral.ts          invite codes, commission and the binding rules
    src/settings.ts          the settings registry: types, bounds, defaults
    src/inventory.ts         inventory statuses, filters and price bands
    src/steam-market.ts      market response parsing: prices, rarity, images
    src/provably-fair.ts     server-side cryptography (node:crypto)
    src/verify.ts            in-browser re-verification (Web Crypto)
```

`@caseforge/shared` is split on purpose: the main entry point is isomorphic and
the server-side cryptography sits behind the `@caseforge/shared/node` subpath.
Otherwise `node:crypto` ends up in the browser bundle and the front-end build
fails.

---

## Legal note

Buying cases with real money is regulated as gambling in most jurisdictions:
a licence, KYC, age verification and country restrictions are all required.
That has to be settled before payments go live — section 13 of the architecture
document.

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to get the project running and what the review looks for.

## License

[PolyForm Noncommercial 1.0.0](LICENSE), with a required attribution notice —
see [NOTICE](NOTICE).

**Noncommercial use is free**: personal projects, study, research, hobby work,
and use by charities, schools, public research bodies and governments.

**Commercial use needs written permission** from the author. Running this, or
anything derived from it, as a business or for revenue is not covered by the
licence on its own — ask first: <prosoulk2017@gmail.com>.

**The attribution is a licence term, not a courtesy.** Under the licence's
Notices section, anyone passing on any part of this software must also pass on
the `Required Notice:` line and the link to this repository, and keep them
visible in whatever they ship or deploy.

Releases published before this change went out under MIT. A licence change is
not retroactive, so those versions stay MIT for anyone who already has them;
everything from that commit onwards is under the terms above.

The legal note further up still applies to running any of it for real money.
