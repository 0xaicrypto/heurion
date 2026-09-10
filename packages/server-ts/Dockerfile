# syntax=docker/dockerfile:1.6
# Heurion TypeScript server.
# Build from the REPO ROOT (context: .) so the shared @heurion/contracts
# package is available for pnpm install:
#   docker build -t nexus-server:latest -f packages/server-ts/Dockerfile .
# Run:   docker run --rm -p 8001:8001 nexus-server:latest

FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@10 --activate

# Contracts first (file: dependency of server-ts) — build its dist, then the
# server can resolve @heurion/contracts from node_modules.
COPY packages/contracts ./packages/contracts
RUN cd packages/contracts && pnpm install --frozen-lockfile && pnpm run build

COPY packages/server-ts ./packages/server-ts
WORKDIR /build/packages/server-ts
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN npx prisma generate

# ── Runtime ──
FROM node:22-bookworm-slim
WORKDIR /app

# fonts-droid-fallback: 单面 .ttf 中文字体(DroidSansFallbackFull.ttf) —
# pdfkit/fontkit 不支持 .ttc 集合,noto-cjk 包不可用;无字体时 PDF 中文
# 全部渲染为空白方块(生产乱码根因)。
# #937: 容器以 non-root（nexus, UID 1000）运行 — 与 DEPLOY.md 安全声明对齐。
# 卷目录预建并 chown：首次挂载的 named volume 会继承镜像内目录属主；
# 既有生产卷为 root 属主，上线本镜像前需一次性 chown（见 DEPLOY.md 迁移注记）。
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r -g 1000 nexus && useradd -r -u 1000 -g nexus -m nexus \
    && mkdir -p /data/db /data/twins /data/reactome-diagrams \
    && chown -R nexus:nexus /data

USER nexus

COPY --from=builder /build/packages/server-ts/dist ./dist
COPY --from=builder /build/packages/server-ts/node_modules ./node_modules
COPY --from=builder /build/packages/server-ts/package.json ./
COPY --from=builder /build/packages/server-ts/prisma ./prisma
COPY --from=builder /build/packages/server-ts/data ./data

EXPOSE 8001
# #280: the SQLite DB lives on its own volume at /data/db — ensure the
# parent directory exists before Prisma opens the file.
CMD ["sh", "-c", "mkdir -p /data/db && exec node --import tsx --no-warnings dist/main.js"]
