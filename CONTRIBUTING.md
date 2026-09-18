# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting it running

Requires Node ≥ 22, pnpm 11 and Docker.

```bash
cp .env.example .env       # no editing needed for a local run
pnpm setup                 # install + docker + shared build + migrations + seed
pnpm dev                   # api on :4000, web on :3000
```

`pnpm setup` seeds only the demo administrator. The catalogue of themed cases is
populated separately by `pnpm seed:cases`, which talks to the Steam market and
takes about ten minutes.

## Before opening a pull request

```bash
pnpm typecheck     # every package, strict
pnpm test          # unit tests: provable fairness, ticket ranges, balancing, upgrade odds
pnpm format        # prettier
```

`pnpm test:smoke` is the end-to-end pass. It needs the infrastructure up and the
API running, and it is worth running for anything that touches money, openings
or roles.

## What the review looks for

- **Money is integer minor units.** No floats anywhere near a balance, an item
  price or a case price, and no ledger entry ever stores a converted amount. The
  currency switch is display only.
- **Every balance change goes through `Transaction`.** The nightly
  reconciliation compares balances against the ledger; a direct write breaks it.
- **The active server seed never leaves the server** until it is rotated.
  Anything that could leak it before reveal is a blocker.
- **Shared code stays isomorphic.** `node:crypto` lives behind the
  `@caseforge/shared/node` subpath — importing it from the main entry point
  breaks the web build.
- **Code and comments are in English.** Interface strings go in
  `packages/shared/src/i18n.ts` with both RU and EN, and server errors carry a
  machine-readable `code` alongside the message.
- New rules around openings, odds or payouts come with a test.

## Scope

The roadmap lives in section 14 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Payments, item deposits and KYC are all unimplemented on purpose — if you want to
take one on, open an issue first so the design can be agreed before the code.
