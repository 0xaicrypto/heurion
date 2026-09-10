FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json tsconfig.json ./
RUN pnpm install

COPY src/ ./src/
RUN pnpm run build

FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# #565: EMBEDDING_QUANTIZED must match runtime (default false) — precache
# defaults to quantized=true and 404s on model_quantized.onnx, silently
# skipping the cache. Precache the same artifact the server loads.
RUN EMBEDDING_QUANTIZED=false node dist/precache.js || echo 'model precache failed (HF 429/timeout) — will download at runtime'

# #937: non-root 运行（nexus, UID 1000）— 与 DEPLOY.md 安全声明对齐。
# node 基础镜像自带 UID/GID 1000 的 node 用户 — 改名复用（新建会 GID 冲突）。
# transformers.js 缓存目录（cwd 相对 ./.cache）随 /app 一起 chown，运行期
# 下载兜底（HF 429 后重取）可写。
RUN groupmod -n nexus node \
    && usermod -l nexus -d /home/nexus -m node \
    && mkdir -p /app/.cache && chown -R nexus:nexus /app

USER nexus
EXPOSE 8003
CMD ["node", "dist/index.js"]
