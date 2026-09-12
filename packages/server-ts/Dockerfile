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

# #937: 容器以 non-root（nexus, UID 1000）运行 — 与 DEPLOY.md 安全声明对齐。
# node 基础镜像自带 UID/GID 1000 的 node 用户 — 直接改名复用（新建会
# groupadd GID 冲突）。卷目录预建并 chown：首次挂载的 named volume 会
# 继承镜像内目录属主；既有生产卷的属主迁移由 deploy 脚本幂等处理。
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod -n nexus node \
    && usermod -l nexus -d /home/nexus -m node \
    && mkdir -p /data/db /data/twins /data/reactome-diagrams \
    && chown -R nexus:nexus /data

# #989 部署事故根因:#937 non-root 后 node_modules 仍为 root 属主 → 容器内
# prisma CLI(engines 目录)对 nexus 用户拒绝写入 → 启动 syncSchema 的
# db push 静默失败,新列永远落不下去。chown 在 USER 切换前(root)执行。
COPY --from=builder /build/packages/server-ts/dist ./dist
COPY --from=builder /build/packages/server-ts/node_modules ./node_modules
COPY --from=builder /build/packages/server-ts/package.json ./
COPY --from=builder /build/packages/server-ts/prisma ./prisma
COPY --from=builder /build/packages/server-ts/data ./data
RUN chown -R nexus:nexus /app/node_modules /app/prisma /app/data

USER nexus

EXPOSE 8001
# #280: the SQLite DB lives on its own volume at /data/db — ensure the
# parent directory exists before Prisma opens the file.
CMD ["sh", "-c", "mkdir -p /data/db && exec node --import tsx --no-warnings dist/main.js"]
