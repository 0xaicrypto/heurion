# Configuration & Port Layout

> #441 — one port per process, env read lazily.

## Ports

| Service | Default port | Notes |
|---|---|---|
| server-ts (control plane) | 8001 | `SERVER_PORT` |
| worker (execution plane) | **8002** | `SERVER_PORT`; docker-compose maps host 8001 → container 8001 explicitly |
| embedding-server | 8003 | `EMBEDDING_SERVER_PORT` |
| python-stats-worker | 8005 | `STATS_PORT` |
| web (vite dev) | 5173 | proxy `/api` → `http://localhost:8001` |

Rule: the control plane owns 8001; nothing else may default to it.

## Env-read discipline

- Module-level `process.env.X` constants are forbidden for service
  coordinates (they freeze the value at import time and make tests /
  hot-reload impossible). Read per call:
  - `execution-plane.service.ts` → `workerUrl()` / `workerToken()` (#448)
  - `stats-engine.ts` → `STATS_WORKER_URL` (#445)
  - `llm-gateway.ts` → `resolveLlmEndpoint()` (#436)
- Server-wide values (port, secret, DB URL) live in `server-ts/src/config.ts`.

## Secrets

- `SERVER_SECRET` — HMAC/JWT signing (#440 chart tokens reuse it).
- `WORKER_API_TOKEN` — worker authentication for the control plane.
- `CHART_TOKEN_TTL_MS` — default 90 days for `<img>` download tokens.
