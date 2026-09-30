# Heurion 2.0 本地/单机镜像：server + dsh 子进程 + office 依赖 + 前端静态资源
FROM node:24-bookworm-slim

# office 运行时：python-docx/pptx/openpyxl/pandas（预装，模型不需要也不应自行安装）
# LibreOffice 无界面版用于渲染/转 PDF；Noto CJK 保证中文排版与渲染
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates \
      libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui \
      fonts-noto-cjk fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/office \
    && /opt/office/bin/pip install --no-cache-dir python-docx python-pptx openpyxl pandas
ENV PATH=/opt/office/bin:$PATH

RUN npm install -g pnpm@12.5.1

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @heurion2/web build \
    && chmod -R a+rX /app \
    && mkdir -p /app/data && chown -R node:node /app/data

USER node
ENV HEURION_DATA_DIR=/app/data \
    PORT=8787 \
    WEB_DIST=/app/apps/web/dist
EXPOSE 8787
CMD ["pnpm", "--filter", "@heurion2/server", "start"]
