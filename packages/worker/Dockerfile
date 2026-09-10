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

# #937: 本容器保持 root 运行 — 已知例外（DEPLOY.md 同步注明）：
# headless Chromium 以 --no-sandbox 运行，容器内 root 无法启用 setuid
# sandbox（理由记录于 handlers/figure.ts）；如需非 root 需给 chromium
# 配套 user namespaces/seccomp 方案，单独立项评估。
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    # #771: 翻页预览 — LibreOffice（pptx/docx→PDF）+ poppler（PDF→PNG）。
    # 缺失时 preview_file job 返回 PREVIEW_UNAVAILABLE，控制面优雅降级为仅下载。
    libreoffice-impress libreoffice-writer poppler-utils \
    # #825: 学术内容本地渲染 — headless Chromium(mermaid/MathJax 依赖 DOM)。
    # 缺失时 render_figure 返回 FIGURE_UNAVAILABLE,控制面优雅降级为纯文本。
    # 以 --no-sandbox 运行(容器内 root 无法启用 setuid sandbox,理由记录于
    # handlers/figure.ts);网络出口由 request interception 全拒绝。
    chromium \
    # 中文幻灯片渲染字体（CJK 缺字会变成方块）。
    fonts-noto-cjk \
    # #fix 2026-09: pdfkit 无法嵌入 .ttc 集合（noto-cjk 全是 .ttc）—
    # PDF 导出中文全是方块。fonts-droid-fallback 提供单面 .ttf
    # （DroidSansFallbackFull.ttf）供 pdfkit registerFont 嵌入。
    fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/packages/worker/dist ./dist
COPY --from=builder /build/packages/worker/node_modules ./node_modules
COPY --from=builder /build/packages/worker/package.json ./
# #825: 本地渲染资产(shell.html + mermaid.min.js + tex-svg.js)随仓库进镜像 —
# file:// 加载,运行期零外呼(断网可用);bundle 经典 script 加载(file:// 下
# ES module 被 CORS 拦截,见 shell.html 注释)。
COPY --from=builder /build/packages/worker/assets ./assets

ENV CHROME_PATH=/usr/bin/chromium \
    FIGURE_ASSETS_DIR=/app/assets/figure

EXPOSE 8001
CMD ["node", "dist/server.js"]
