# CI/CD runbook

How push-to-main deploys Heurion to the VPS via PM2 + Nginx, and how to
recover when it doesn't.

## TL;DR

```
git push origin main
```

`.github/workflows/deploy-server.yml` runs:

1. **typecheck** — `tsc --noEmit` on `packages/server-ts`
2. **test** — `vitest run` (245+ unit tests)
3. **build-worker-image** — builds the Execution Plane worker image
   (`Dockerfile.worker`) and pushes it to GHCR.
4. **staging** — deploys the Control Plane to staging on VPS via
   `scripts/deploy-staging.sh`, then runs `scripts/regression-test.sh`
   against `http://localhost:8002`. **Deploy to production is blocked on failure.**
5. **cloudflare-ssl** — ensures Cloudflare SSL mode is "Full"
6. **deploy** — runs `scripts/deploy.sh` on the Control Plane VPS, which
   `git pull`s, installs deps, runs Prisma generate, restarts PM2, and
   health-checks.
7. **deploy-execution-plane** — runs `scripts/deploy-worker.sh` on the
   sandbox worker VPS to pull the new worker image and restart
   `docker-compose.worker.yml`.

Total: ~5 minutes.

## VPS layout

### Control Plane

```
~/heurion/
├── packages/server-ts/   # TypeScript backend (PM2)
│   ├── prisma/           # SQLite DB + schema
│   └── data/             # uploads, twins, cache
├── packages/web/dist     # Web UI static build
├── scripts/
│   ├── deploy.sh         # Production deploy
│   ├── deploy-staging.sh # Staging deploy (port 8002)
│   └── regression-test.sh
└── .env.production
```

- **Nginx** proxies `https://heurion.org` → `localhost:8001` (production)
  and `https://staging.heurion.org:443` → `localhost:8002` (staging)
- **PM2** manages server processes: `heurion` (prod) and `heurion-staging`
- **Cloudflare** handles SSL termination + CDN

### Execution Plane (separate sandbox VPS)

```
~/heurion/
├── docker-compose.worker.yml   # MedSci-Sidecar / plugin worker
├── scripts/deploy-worker.sh    # Worker deploy script
└── secrets/                    # Docker Secrets (not committed)
```

- **Docker Compose** runs the worker container + Redis job queue.
- **Docker Secrets** mount LLM keys and `SERVER_SECRET` under `/run/secrets/`.
- The worker is **not** exposed to the public internet; only the Control Plane
  can reach it (restrict via worker host firewall / VPC).

## Deploying

### Normal flow

```bash
git push origin main
```

### Manual deploy

```bash
ssh root@174.138.31.245
cd ~/heurion
bash scripts/deploy.sh
```

### Staging deploy

```bash
ssh root@174.138.31.245
cd ~/heurion
DEEPSEEK_KEY=sk-... GEMINI_KEY=sk-... bash scripts/deploy-staging.sh
bash scripts/regression-test.sh http://localhost:8002
```

### Execution Plane deploy

```bash
ssh root@<worker-vps-ip>
cd ~/heurion
WORKER_IMAGE_TAG=<sha> SERVER_SECRET=... DEEPSEEK_KEY=sk-... GEMINI_KEY=sk-... bash scripts/deploy-worker.sh
```

## Rollback

```bash
ssh root@174.138.31.245
cd ~/heurion
git log --oneline -5    # find last good commit sha
git checkout <sha>
bash scripts/deploy.sh
```

## Failure modes

### Regression tests fail

61 API tests run against staging. If any fail, production deploy is
blocked. Fix the failure, push a new commit. Check the GitHub Actions
log for the specific failing test.

### Deploy timeout at SSH stage

- VPS unreachable (firewall, host down) — check `ssh root@174.138.31.245`
- VPS_SSH_KEY secret doesn't match `authorized_keys`

### PM2 won't start

```bash
ssh root@174.138.31.245
pm2 logs heurion --lines 50
```

Common: missing env var, Prisma migration needed, port conflict.

### Health check fails

`scripts/deploy.sh` polls `/healthz` for up to 30s. If it never responds:
- Check Nginx config: `nginx -t && systemctl restart nginx`
- Check PM2 status: `pm2 status`
- Check env vars: `pm2 env 0 | grep -i key`
