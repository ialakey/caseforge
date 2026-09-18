# The trade worker.
#
# No port and no health endpoint: it consumes a BullMQ queue and polls Steam,
# so "is it alive" is a question for the queue's own metrics rather than for an
# HTTP probe this image could answer honestly.
#
# It holds the encrypted bot secrets in memory while it runs, which is the
# reason it is a separate image from the API rather than a thread inside it: a
# process that can decrypt a Steam account should have as little else in it as
# possible.

FROM node:22-alpine AS build
WORKDIR /repo

# pnpm 11 asks before purging a modules directory and refuses to assume an
# answer without a TTY — which a build never has.
ENV CI=true

RUN corepack enable

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

ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db?schema=public"
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @caseforge/shared build \
 && pnpm --filter @caseforge/api exec prisma generate \
 && pnpm --filter @caseforge/bot build

# No production prune: it re-runs postinstall across the workspace, and the
# API's is `prisma generate` with a CLI that pass has just removed. A larger
# image that certainly works beats a smaller one that fails at runtime.


FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /repo/node_modules ./node_modules
COPY --from=build --chown=app:app /repo/package.json ./package.json
COPY --from=build --chown=app:app /repo/packages/shared ./packages/shared
COPY --from=build --chown=app:app /repo/apps/bot/dist ./apps/bot/dist
COPY --from=build --chown=app:app /repo/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=build --chown=app:app /repo/apps/bot/package.json ./apps/bot/package.json

USER app
WORKDIR /repo/apps/bot
CMD ["node", "dist/main.js"]
