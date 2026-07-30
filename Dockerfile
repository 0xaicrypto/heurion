# syntax=docker/dockerfile:1.6
#
# Heurion server — single-image deploy (Python + Node).
#
# Two stages:
#   1. builder  — installs Python deps via uv into a venv.  Dependency
#                 resolution and source install are split into separate
#                 layers so a source-only change reuses the cached deps.
#   2. runtime  — derived from BASE_IMAGE which pre-installs Python 3.11,
#                 Node 22, uv, and the nexus user.
#
# Why Node lives in the runtime image: the agent is supposed to install
# new MCP servers + skills at chat time via manage_skill / manage_mcp,
# both of which shell out to `npx`. If Node isn't here, those tools
# fail with "npx not found" and the user has to redeploy.
#
# BASE_IMAGE can be overridden in CI to use a pre-built base
# (ghcr.io/0xaicrypto/nexus-base) that already has Node + uv,
# skipping their install on every build.
ARG BASE_IMAGE=python:3.11-slim-bookworm

# ── Stage 1: build (Python deps via uv) ────────────────────────────
FROM $BASE_IMAGE AS builder

RUN uv venv /opt/venv

WORKDIR /build

# ── Layer group: dependency resolution ─────────────────────────────
# These layers only invalidate when pyproject.toml changes.

# 1a. Copy dependency manifests only.
COPY packages/sdk/pyproject.toml      packages/sdk/pyproject.toml
COPY packages/nexus/pyproject.toml    packages/nexus/pyproject.toml
COPY packages/server/pyproject.toml   packages/server/pyproject.toml
COPY README.md                        README.md

# 1b. Create minimal package stubs so pip can resolve and install
#     dependencies without the real source code.
RUN mkdir -p packages/sdk/nexus_core \
             packages/nexus/nexus \
             packages/server/nexus_server \
 && touch    packages/sdk/nexus_core/__init__.py \
             packages/nexus/nexus/__init__.py \
             packages/server/nexus_server/__init__.py

# 1c. Resolve + download all dependencies, install stub packages.
#     This layer is cached by type=gha as long as pyproject.toml files
#     stay the same.  On a cache hit uv install is instant.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
        ./packages/sdk \
        ./packages/nexus \
        ./packages/server

# 1d. Embedding extras (torch + onnxruntime ~1GB) in a separate layer.
#     Only invalidates when packages/server/pyproject.toml changes,
#     so source-only edits skip re-downloading these heavy packages.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python "./packages/server[embedding]"

# ── Layer group: source snapshots ──────────────────────────────────
# These layers invalidate on every source change but the --no-deps
# install is fast (rebuilds wheels, no network).

# 2a. Copy real source (overwrites the stubs created above).
COPY packages/sdk    packages/sdk
COPY packages/nexus  packages/nexus
COPY packages/server packages/server

# 2b. Re-install without dependencies — only replaces stub wheels
#     with real ones.  Dependencies were already resolved in step 1c
#     and are unaffected by --no-deps.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --no-deps \
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
