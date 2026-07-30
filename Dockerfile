# syntax=docker/dockerfile:1.6
#
# Heurion server — single-image deploy (Python + Node).
#
# Two stages:
#   1. builder  — installs Python deps via uv into a venv. Pre-cached
#                 in CI layers so most rebuilds skip dependency resolve.
#   2. runtime  — slim Debian + Python 3.11 + Node 22 (for MCP installs)
#                 + a non-root nexus user. App code is copied last so
#                 source changes don't bust the heavier dep layer.
#
# Why Node lives in the runtime image: the agent is supposed to install
# new MCP servers + skills at chat time via manage_skill / manage_mcp,
# both of which shell out to `npx`. If Node isn't here, those tools
# fail with "npx not found" and the user has to redeploy. We ship Node
# so the "agent installs its own tools without code changes" promise
# actually holds.
#
# BASE_IMAGE can be overridden in CI to use a pre-built base
# (ghcr.io/0xaicrypto/nexus-base) that already has Node + uv,
# skipping their install on every build.
ARG BASE_IMAGE=python:3.11-slim-bookworm

# ── Stage 1: build (Python deps via pip) ────────────────────────────
FROM $BASE_IMAGE AS builder

# pip cache mount avoids re-downloading wheels when deps haven't changed.
# Even with Docker layer cache misses, wheels survive in the BuildKit
# cache across builds.
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip wheel

WORKDIR /build

# Copy ONLY pyproject + lock first so dep resolution is cached
# independently of source code changes.
COPY packages/sdk/pyproject.toml      packages/sdk/pyproject.toml
COPY packages/nexus/pyproject.toml    packages/nexus/pyproject.toml
COPY packages/server/pyproject.toml   packages/server/pyproject.toml
COPY README.md                        README.md

# Source code is needed for the install to work — copy now.
COPY packages/sdk    packages/sdk
COPY packages/nexus  packages/nexus
COPY packages/server packages/server

RUN --mount=type=cache,target=/root/.cache/pip \
    /opt/venv/bin/pip install \
        ./packages/sdk \
        ./packages/nexus \
        "./packages/server[embedding]"

# ── Stage 2: runtime ────────────────────────────────────────────────
FROM $BASE_IMAGE AS runtime

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# App code (already installed in the venv).
COPY --from=builder --chown=nexus:nexus /build /app
WORKDIR /app

# Web UI static bundle. Built outside Docker (locally or in CI).
COPY --chown=nexus:nexus packages/web/dist /app/packages/web/dist

# Persistent state lives under /data.
RUN mkdir -p /data/db /data/twins /data/uploads /data/cache \
 && chown -R nexus:nexus /data
VOLUME ["/data"]

ENV NEXUS_TWIN_BASE_DIR=/data/twins \
    UPLOAD_DIR=/data/uploads \
    NEXUS_CACHE_DIR=/data/cache \
    DATABASE_URL=sqlite:////data/db/nexus_server.db \
    NEXUS_WEB_DIST=/app/packages/web/dist \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8001

USER nexus

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8001/healthz || \
        curl --fail --silent http://127.0.0.1:8001/docs || exit 1

EXPOSE 8001

CMD ["uvicorn", "nexus_server.main:create_app", \
     "--host", "0.0.0.0", \
     "--port", "8001", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*", \
     "--factory"]
