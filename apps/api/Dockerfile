# The API, built out of the workspace it lives in.
#
# One build stage and one runtime stage. The build stage needs the whole
# monorepo — the API imports `@caseforge/shared` from source and the Prisma
# client is generated, not vendored — and the runtime stage needs none of that
# machinery, only what came out of it.
#
# Built from the repository root: `docker build -f apps/api/Dockerfile .`
# The context has to be the root because pnpm resolves workspace links across
# the whole tree, and a context of `apps/api` cannot see `packages/shared`.

FROM node:22-alpine AS build
WORKDIR /repo

# pnpm 11 asks before purging a modules directory and refuses to assume an
# answer without a TTY — which a build never has.
ENV CI=true

# Corepack pins pnpm to the version in package.json, so the image is built by
# the same package manager the lockfile was written by.
RUN corepack enable

# Manifests first, so a change to source does not invalidate the dependency
# layer. Every workspace manifest is needed: pnpm refuses to install from a
# lockfile whose workspace set does not match.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot/package.json apps/bot/

# The Prisma schema comes in with the manifests rather than with the source: the
# API's postinstall runs `prisma generate`, which needs it. It costs a little
# cache — editing the schema now reinstalls — and the alternative is an install
# that fails before any source is present.
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts

# `prisma generate` runs on postinstall and only wants a URL it can parse — it
# never connects at build time.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db?schema=public"
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @caseforge/shared build \
 && pnpm --filter @caseforge/api exec prisma generate \
 && pnpm --filter @caseforge/api build

# No production prune. `pnpm install --prod` re-runs postinstall, and the API's
# postinstall is `prisma generate` — whose CLI is a dev dependency and has just
# been removed. Pruning with scripts disabled has its own trap: the prune
# reinstalls @prisma/client and takes the generated engine with it, leaving an
# image that starts and then fails on the first query. A larger image that
# certainly works beats a smaller one that fails at runtime.


FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Not root. The API writes only to KYC_STORAGE_DIR, and that is a volume whose
# ownership the deployment sets.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /repo/node_modules ./node_modules
COPY --from=build --chown=app:app /repo/package.json ./package.json
COPY --from=build --chown=app:app /repo/packages/shared ./packages/shared
COPY --from=build --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=app:app /repo/apps/api/package.json ./apps/api/package.json
# The schema and the migrations travel with the image so a deployment can run
# `prisma migrate deploy` from the same artefact it is about to start.
COPY --from=build --chown=app:app /repo/apps/api/prisma ./apps/api/prisma

USER app
WORKDIR /repo/apps/api
EXPOSE 4000

# Answered by the health controller, which checks Postgres and Redis rather
# than merely proving the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
