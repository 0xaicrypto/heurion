# CI/CD runbook

How push-to-main deploys Heurion to the VPS (Docker Compose + Caddy), and
how to recover when it doesn't.

## TL;DR

```
git push origin main
```

`.github/workflows/deploy-server.yml` runs (concurrency-grouped — one
deploy at a time):

1. **typecheck** — `tsc --noEmit` on `packages/server-ts`
2. **test** — selected `vitest` suites (ingestion, auth, stats, plugins, chat)
3. **build-web** — web dist + docs site (docs failures are non-blocking)
4. **build-server-image / build-embedding-server-image / build-stats-worker**
   — push `ghcr.io/0xaicrypto/nexus-*` images tagged `sha-<short>` + `latest`
5. **golden-crosscheck** — TS statistics cross-checked against a golden
   file generated from Python scipy/lifelines/statsmodels
6. **cloudflare-ssl** — ensures Cloudflare SSL mode is "Full"
7. **deploy** — uploads web dist + `.env.production` + compose/Caddy files
   to the VPS, then runs `scripts/deploy-production-compose.sh`
   (health-gated, non-idempotent-safe). `provision-reactome-diagrams` is
   intentionally NOT a dependency (external resource).

`staging` runs only on manual `workflow_dispatch` (`run_staging: true`):
deploys to `~/heurion` on port 8002 via `scripts/deploy-staging.sh`, runs
`scripts/regression-test.sh http://localhost:8002`, then cleans up PM2.

## VPS layout

### Control Plane (`/opt/heurion`)

```
/opt/heurion/
├── docker-compose.yml        # nexus-server + nexus-embedding-server + nexus-stats-worker
├── Caddyfile                 # HTTPS termination (Let's Encrypt) + reverse proxy
├── packages/web/dist         # Web UI static build (mounted into the server container)
├── scripts/deploy-production-compose.sh
├── .env.production           # secrets + config (written by the deploy job)
└── .deploy.lock              # compose deploy lockfile
```

- **Caddy** terminates TLS (Let's Encrypt) and proxies to `nexus-server:8001`.
- **Cloudflare** sits in front (DNS + SSL "Full" mode).
- SQLite data lives on the `nexus-server` volume.

### Execution Plane (separate sandbox VPS)

```
/opt/heurion-worker/
└── docker-compose.worker.yml   # heurion-worker (document rendering / plugins)
```

- Worker is reached over HTTP with `WORKER_API_TOKEN` (no Redis — #444).
- Uploads render output to an S3-compatible bucket (`S3_*` env).

## Deploying

### Normal flow

```bash
git push origin main
```

- **Control plane**（/opt/heurion）由 `deploy-server.yml` 自动部署。
- **Execution Plane worker**（/opt/heurion-worker）由 `deploy-worker.yml`
  自动部署：worker/contracts 变更 push main 或手动触发 → 构建
  `ghcr.io/0xaicrypto/heurion-worker:<sha>` 推 GHCR → SSH 到 worker VPS
  `docker compose pull && up -d` → localhost:8001/healthz 健康检查。
  需要的 secrets：`WORKER_VPS_HOST`（必填）+ `WORKER_VPS_USER` /
  `WORKER_VPS_SSH_KEY`（缺省回落 `VPS_USER` / `VPS_SSH_KEY`）；
  secrets 未配置时只构建镜像、跳过 SSH 部署（run 日志有明确提示）。

### Manual production deploy

```bash
# run locally (requires GHCR access + VPS SSH key)
NEXUS_IMAGE=ghcr.io/0xaicrypto/nexus-server:sha-<short> \
EMBEDDING_IMAGE=ghcr.io/0xaicrypto/nexus-embedding-server:sha-<short> \
STATS_IMAGE=ghcr.io/0xaicrypto/nexus-stats-worker:sha-<short> \
  bash scripts/deploy-production-compose.sh
```

### Staging deploy (manual)

```bash
ssh <user>@<vps>
cd ~/heurion
DEEPSEEK_KEY=sk-... GEMINI_KEY=sk-... bash scripts/deploy-staging.sh
bash scripts/regression-test.sh http://localhost:8002
```

### Object Storage (DigitalOcean Spaces)

The Execution Plane uploads generated files (DOCX, PPTX, PDFs, plots) to an
S3-compatible bucket. Store credentials in GitHub Secrets for the
`0xaicrypto/heurion` repo: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

> Spaces access keys cannot be created through the DigitalOcean API or CLI,
> so this step must be done in the control panel.

## Rollback

`scripts/deploy-production-compose.sh` 在每次部署前记录当前在跑镜像 ID（容器 inspect，非 tag — CI 固定 `:latest` 时按 tag 回滚只会拉回新镜像），并在 `https://$HOSTNAME/healthz` 健康检查失败（30 次 × 5s 重试）时**自动回滚**：用旧镜像 ID 重建 `nexus-server` + `nexus-embedding-server`，再等健康（成功则提示排查新镜像，仍失败则报人工介入）。

注意：没有 push-based rollback — 你无法 un-push main，最终应带着修复 roll forward。

## Failure modes

### Regression tests fail

The deploy pipeline aborts before image builds. Fix the failure, push a new
commit. Check the GitHub Actions log for the specific failing suite.

### Deploy timeout at SSH stage

- VPS unreachable (firewall, host down) — check `ssh <user>@<vps>`
- `VPS_SSH_KEY` secret doesn't match `authorized_keys`

### Compose deploy fails / health check never passes

```bash
ssh <user>@<vps>
cd /opt/heurion
docker compose logs --tail=100 nexus-server
docker compose ps
```

Common causes:
- Missing env var in `.env.production` (rewritten on every deploy).
- Schema drift: production uses a non-destructive `prisma db push` — a
  data-loss-y drift fails startup loudly by design (#641).
- Port 8001 conflict inside the container network.

### Execution Plane worker won't start

```bash
ssh <user>@<worker-vps>
cd /opt/heurion-worker
docker compose -f docker-compose.worker.yml logs --tail=50 heurion-worker
```

Common causes:
- Missing `S3_*` credentials when the worker tries to upload a file.
- `WORKER_API_TOKEN` mismatch between Control Plane and worker.
- Worker firewall blocks the Control Plane's IP on the worker port.
