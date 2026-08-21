# =============================================================================
# Outreach Engine — production image
#
# One image runs both services. The web container starts Next.js; the worker
# container runs `npm run worker` from the same build, so the two can never
# drift out of sync.
# =============================================================================

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- deps: install once, cached until package files change --------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# --- builder -----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Placeholders only: Next needs the vars to exist at build time, and nothing
# secret is read during the build. Real values arrive at runtime from .env.
ENV DATABASE_URL="postgres://build:build@localhost:5432/build"
ENV NEXTAUTH_SECRET="build-time-placeholder-value-not-used"
ENV ANTHROPIC_API_KEY="build-time-placeholder"

RUN npm run build

# --- runner ------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Next's standalone output ships only the modules actually imported.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The worker and migrations run from source via tsx, so they need the TS files,
# the full dependency tree, and the migration SQL.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
