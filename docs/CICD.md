# CI/CD runbook

How push-to-main deploys Heurion to the VPS via PM2 + Nginx, and how to
recover when it doesn't.

## TL;DR

```
git push origin main
```

`.github/workflows/deploy-server.yml` runs:

1. **typecheck** — `tsc --noEmit` on `packages/server-ts`
2. **test** — `vitest run` (30+ unit tests)
3. **staging** — deploys to staging on VPS via `scripts/deploy-staging.sh`,
   then runs `scripts/regression-test.sh` against `http://localhost:8002`
   (61 API regression tests). **Deploy to production is blocked on failure.**
4. **cloudflare-ssl** — ensures Cloudflare SSL mode is "Full"
5. **deploy** — runs `scripts/deploy.sh` on VPS, which `git pull`s,
   installs deps, runs Prisma generate, restarts PM2, and health-checks

Total: ~3 minutes.

## VPS layout

```
~/heurion/
├── packages/server-ts/   # TypeScript backend (PM2)
│   ├── prisma/           # SQLite DB + schema
│   └── data/             # uploads, twins, cache
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
DEEPSEEK_KEY=sk-... bash scripts/deploy-staging.sh
bash scripts/regression-test.sh http://localhost:8002
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
