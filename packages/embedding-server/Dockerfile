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

EXPOSE 8003
CMD ["node", "dist/index.js"]
