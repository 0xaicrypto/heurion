# Heurion 平台单机镜像：平台 server（模型 + 操作层 + MCP + 协同网关 + 编辑器页面）+ dsh 子进程
FROM node:24-bookworm-slim

# dsh shell 的计算环境（统计、作图、读资料）。文档编辑只走 MCP，因此不装 python-docx/pptx。
# LibreOffice 无界面版（Writer / Impress）：导出文件的渲染校验、幻灯片渲染；poppler：PDF 转 PNG；Noto CJK 保证中文渲染
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates \
      libreoffice-writer-nogui libreoffice-impress-nogui poppler-utils \
      fonts-noto-cjk fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/compute \
    && /opt/compute/bin/pip install --no-cache-dir pandas matplotlib scipy openpyxl
ENV PATH=/opt/compute/bin:$PATH

RUN npm install -g pnpm@12.5.1

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @heurion2/platform... \
    && pnpm --filter @heurion2/platform build \
    && chmod -R a+rX /app \
    && mkdir -p /app/data && chown -R node:node /app/data

USER node
ENV HEURION_DATA_DIR=/app/data \
    PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@heurion2/platform", "start"]
