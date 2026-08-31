# syntax=docker/dockerfile:1.6
# Heurion Execution Plane worker.
# Build from the REPO ROOT (context: .) so the shared @heurion/contracts
# package is available for pnpm install (file:../contracts dependency):
#   docker build -t heurion-worker:latest -f packages/worker/Dockerfile .

FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@10 --activate

# Contracts first (file: dependency of the worker) — build its dist, then the
# worker can resolve @heurion/contracts from node_modules.
COPY packages/contracts ./packages/contracts
RUN cd packages/contracts && pnpm install --frozen-lockfile && pnpm run build

COPY packages/worker ./packages/worker
WORKDIR /build/packages/worker
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    # #771: 翻页预览 — LibreOffice（pptx/docx→PDF）+ poppler（PDF→PNG）。
    # 缺失时 preview_file job 返回 PREVIEW_UNAVAILABLE，控制面优雅降级为仅下载。
    libreoffice-impress libreoffice-writer poppler-utils \
    # 中文幻灯片渲染字体（CJK 缺字会变成方块）。
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/packages/worker/dist ./dist
COPY --from=builder /build/packages/worker/node_modules ./node_modules
COPY --from=builder /build/packages/worker/package.json ./

EXPOSE 8001
CMD ["node", "dist/server.js"]
