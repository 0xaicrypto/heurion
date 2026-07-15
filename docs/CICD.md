# CI/CD runbook

How push-to-main turns into a running container on the VPS, and how to
recover when it doesn't.

## TL;DR

```
git push origin main
```

`.github/workflows/deploy-server.yml` runs:

1. **web-build** — installs `packages/web` deps, runs lint + TypeScript
   check + production build, uploads `dist/` as an artifact
2. **smoke** — Python imports + ABI-in-wheel + create_app() + 6 more checks
3. **pytest** — server + SDK tests
4. **docker-build** — downloads the web `dist/` artifact, builds the
   image, boots it, polls `/healthz`, re-runs the smoke script INSIDE
   the image
5. **publish** — pushes `ghcr.io/<owner>/nexus-server:sha-<short>` and
   `:latest` to GHCR (only on main)
6. **deploy** — SSH to the VPS, runs `scripts/deploy/vps_deploy.sh`,
   which pulls the new image, recreates the container, polls
   `/healthz`, and rolls back to the previous image on failure

There is also `.github/workflows/web-ci.yml`, which runs on every PR and
push that touches `packages/web/**`. It performs the same lint + type
check + build steps so regressions in the browser UI are caught before
they reach main.

Total: ~5 minutes warm cache, ~20 minutes cold cache (first build of
the day or after a Dockerfile change).

## One-time setup

### GitHub repo secrets

Repo Settings → Secrets and variables → Actions → New repository secret:

| Secret           | Value                                                 |
|------------------|-------------------------------------------------------|
| `VPS_HOST`       | `165.227.135.198`                                     |
| `VPS_USER`       | `jimmy`                                               |
| `VPS_SSH_KEY`    | The full contents of an SSH private key whose public half is in the VPS user's `~/.ssh/authorized_keys`. Generate dedicated for CI; don't reuse a personal key. |

### GitHub repo permissions

Repo Settings → Actions → General → **Workflow permissions**:

- Read and write permissions

This is what lets the CI job push the image to GHCR using the
auto-issued `GITHUB_TOKEN` instead of forcing us to manage a separate
PAT for publishing.

### VPS one-time setup

The VPS needs to be able to pull from GHCR. Two options:

**Option A: public package** — Make the GHCR package public the first
time it's published. After the first deploy succeeds, go to
`https://github.com/<owner>?tab=packages`, click the package, then
Settings → Change visibility → Public. The VPS doesn't need any
credentials this way.

**Option B: private package** — Generate a PAT with `read:packages`
scope and authenticate the VPS once:

```bash
# On the VPS, as the same user the deploy script runs as
echo "$GHCR_PAT" | docker login ghcr.io -u <github-username> --password-stdin
```

The login persists in `~/.docker/config.json`. Recommended for any
repo that's actually private.

### VPS docker-compose checklist

`~/nexus/` on the VPS should already be a clone of this repo with:

```
~/nexus/
├── docker-compose.yml         # uses ${NEXUS_IMAGE:-nexus-server:latest}
├── .env.production            # not committed; SERVER_PRIVATE_KEY etc.
├── .env -> .env.production    # symlink (compose reads .env by default)
├── Caddyfile
└── scripts/deploy/vps_deploy.sh
```

The deploy job runs `bash scripts/deploy/vps_deploy.sh` from `~/nexus`
on the VPS, so make sure that path exists and is up to date with the
repo (the script itself is delivered by your existing
`git pull` step on every deploy, but the FIRST time you'll need to
clone manually).

### Sudo without password

`vps_deploy.sh` runs `sudo docker compose ...`. Either:

1. Add `jimmy ALL=(ALL) NOPASSWD: /usr/bin/docker` to `/etc/sudoers.d/jimmy`
2. OR add the deploy user to the `docker` group:
   `sudo usermod -aG docker jimmy && newgrp docker`
   and remove the `sudo` calls from `vps_deploy.sh`.

Option 2 is cleaner; option 1 is more conservative if the VPS hosts
other services.

## Deploying

### Normal flow

```bash
# Local
git checkout main && git pull
git push   # CI runs, deploy auto-triggers if main passes
```

GitHub Actions UI shows the run in the **Actions** tab. The deploy
job is gated to the **production** environment, so it shows up in the
deployments list with a permalink to `https://heurion.org/healthz`.

### Re-running a deploy without a new commit

`workflow_dispatch` is wired up. Actions tab → Deploy Server → Run
workflow → main → Run. Useful when GHCR was the failure point, not the
code, or when you want to re-verify after editing a secret.

### Manual deploy from the VPS

If GitHub Actions is down but you need to ship:

```bash
ssh jimmy@165.227.135.198
cd ~/nexus
git pull
bash scripts/deploy/vps_deploy.sh ghcr.io/<owner>/nexus-server:latest
```

Tags you can pass:

- `:latest` — moves with main; convenient but doesn't pin
- `:sha-<short>` — pin to a specific commit (recoverable rollback target)

## Rollback

Automatic rollback fires inside `vps_deploy.sh` if `/healthz` doesn't
respond within ~90s of the new image starting. The previous image is
read from `~/nexus/.last-good-image` (updated after every successful
deploy) so a chain of bad deploys never loses the known-good target.

### Manual rollback

```bash
ssh jimmy@165.227.135.198
cd ~/nexus
cat .last-good-image                              # see what we'd roll to
bash scripts/deploy/vps_deploy.sh "$(cat .last-good-image)"
```

Or pin to an arbitrary historical tag:

```bash
bash scripts/deploy/vps_deploy.sh \
  ghcr.io/<owner>/nexus-server:sha-3a5f8b1
```

(Find the sha in the GitHub Actions history or in `git log`.)

## Failure modes + first-line diagnosis

### CI fails at "smoke"

A packaging regression (ABI not in wheel, subpackage not installable,
NEXUS_NETWORK accepts a typo, etc.). The smoke script's output names
the specific check that failed; fix the underlying file
(`packages/sdk/pyproject.toml` for ABI/JSON inclusion,
`packages/server/nexus_server/config.py` for network validation, etc.).

### CI fails at "docker-build" (healthz timeout)

The container booted but `/healthz` never responded. Common causes:

- Missing env var that `create_app()` insists on at startup
- `nexus_server.main:create_app` raised during initialisation
- Container is crash-looping (check `docker logs` in the workflow output)

### CI fails at "publish" with permissions error

GitHub Actions → Workflow permissions wasn't set to "Read and write".
Re-check the one-time-setup step above.

### deploy step times out at the SSH stage

Either:

- VPS is unreachable (firewall, host down) — try `ssh jimmy@VPS` from
  your laptop
- The SSH key in `VPS_SSH_KEY` doesn't match `authorized_keys` on the VPS
- `VPS_HOST` or `VPS_USER` is wrong

### Deploy succeeds locally but fails healthz on the VPS

`vps_deploy.sh` rolls back automatically and fails the workflow.
After it lands, SSH in and dig:

```bash
sudo docker compose logs --tail 200 nexus-server
sudo docker compose exec nexus-server env | grep -i nexus
```

Common: an `.env.production` value out of sync with the new image's
expectations (e.g. a new required env var was added in code).

## Things to add later

- **Staging environment** — a second VPS running `:latest` with a
  test wallet, hit by post-deploy integration tests before promoting
  to production. For a single-operator project not worth it yet.
- **Alerting** — pipe deploy failures to Slack / email via the GitHub
  Actions notifications config. Today the only signal is "the Actions
  tab has a red X".
- **Smoke tests against the deployed instance** — extend `vps_deploy.sh`
  to hit `https://heurion.org/healthz` AND a couple of
  authenticated endpoints with a CI bot account before declaring
  success. Catches issues that only surface behind Caddy or with TLS.
- **Image signing** — sign images with cosign + verify on pull, so a
  compromised GHCR account can't ship a malicious image to the VPS.
