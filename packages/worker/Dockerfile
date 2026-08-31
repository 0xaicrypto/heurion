FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json tsconfig.json ./
RUN pnpm install

COPY src/ ./src/
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

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

EXPOSE 8001
CMD ["node", "dist/server.js"]
