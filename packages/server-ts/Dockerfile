# syntax=docker/dockerfile:1.6
# Heurion TypeScript server.
# Build: docker build -t nexus-server:latest -f Dockerfile .
# Run:   docker run --rm -p 8001:8001 nexus-server:latest

FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY . ./
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN npx prisma generate

# ── Runtime ──
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
COPY --from=builder /build/prisma ./prisma
COPY --from=builder /build/data ./data

EXPOSE 8001
# #280: the SQLite DB lives on its own volume at /data/db — ensure the
# parent directory exists before Prisma opens the file.
CMD ["sh", "-c", "mkdir -p /data/db && exec node --import tsx --no-warnings dist/main.js"]
