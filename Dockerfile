# Long-term runnable image: pinned Node, lockfile install, SQLite volume.
# One container: API + built web static (SERVE_WEB=1).
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
RUN pnpm --filter @tanuki/core build \
 && pnpm --filter @tanuki/api build \
 && pnpm --filter @tanuki/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV TANUKI_DB_PATH=/data/tanuki.db
ENV PORT=8790
ENV HOST=0.0.0.0
ENV SERVE_WEB=1
COPY --from=build /app /app
RUN mkdir -p /data \
 && test -f /app/apps/web/dist/index.html
VOLUME ["/data"]
EXPOSE 8790
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/index.ts"]
