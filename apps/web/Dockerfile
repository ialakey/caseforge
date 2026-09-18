# The storefront.
#
# Same shape as the API image and for the same reasons — see the comments there
# about why the build context is the repository root. What differs is that Next
# bakes `NEXT_PUBLIC_*` into the client bundle at build time, so the API URL is
# a build argument rather than a runtime variable. An image built for one
# deployment cannot be pointed at another's API by changing the environment.

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

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_WS_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL

RUN pnpm --filter @caseforge/shared build \
 && pnpm --filter @caseforge/web build

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
COPY --from=build --chown=app:app /repo/apps/web/.next ./apps/web/.next
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=app:app /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=app:app /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=app:app /repo/apps/web/next.config.mjs ./apps/web/next.config.mjs

USER app
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
