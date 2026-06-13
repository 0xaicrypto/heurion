# Nexus Email Relay

Tiny FastAPI service that holds the shared-support-email SMTP
credentials so Nexus desktop clients never see them. Drops in
between every doctor's Nexus.app and Gmail.

```
Doctor's Nexus.app ──HTTPS+RelayKey──► Fly.io relay ──SMTP+AppPwd──► Gmail
```

Built for the "all doctors share `support@yourdomain.com`" scenario.

## Features

* **API-key auth** — one secret bundled with the Nexus .dmg.
* **Per-user rate limit** — daily cap, defaults to 10/day, configurable.
* **Recipient allow-list** — by exact address OR by domain, server-enforced.
* **Audit log** — every send recorded to SQLite for ops review.
* **Fly.io optimised** — Dockerfile + fly.toml + persistent volume.

## Deploy to Fly.io (5 minutes)

### 0. Prerequisites
* Fly CLI installed: `brew install flyctl`
* Google Workspace bot account with an App Password
  (see [SMTP_SETUP.md](../server/docs/SMTP_SETUP.md))

### 1. One-time setup

```bash
cd packages/relay
flyctl auth login                  # browser opens
flyctl launch --no-deploy          # pick app name when prompted
# When asked about a volume: say yes, name it `relay_data` (1 GB is plenty).
```

`flyctl launch` rewrites `fly.toml` with the app name you picked.
Re-read the file to confirm the `[[mounts]]` section is intact.

### 2. Generate a strong API key

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Save the output — you'll paste it into both the relay (as `RELAY_API_KEY`)
and into the Nexus .dmg build (as `NEXUS_RELAY_API_KEY`).

### 3. Set Fly secrets

```bash
flyctl secrets set \
    RELAY_API_KEY="<paste-from-step-2>" \
    SMTP_USER="support@yourdomain.com" \
    SMTP_PASSWORD="<16-char-app-password-no-spaces>" \
    SMTP_FROM="Nexus Support <support@yourdomain.com>" \
    ALLOWED_DOMAINS="hospital.org,clinic.com" \
    DAILY_LIMIT_PER_USER="10"
```

`fly secrets set` triggers a redeploy automatically. Add or change
secrets anytime — no client update needed.

### 4. Deploy

```bash
flyctl deploy
```

Output ends with the assigned URL: `https://nexus-email-relay.fly.dev`.

### 5. Smoke test

```bash
# Should return JSON with smtp_configured=true, auth_configured=true:
curl https://nexus-email-relay.fly.dev/healthz | jq

# Should send a test email:
curl -X POST https://nexus-email-relay.fly.dev/api/send-email \
  -H "Content-Type: application/json" \
  -H "X-Nexus-Relay-Key: <your-key>" \
  -d '{
    "nexus_user_id": "test-user-01",
    "to":      "you@yourname.com",
    "subject": "Relay smoke test",
    "body":    "If you got this, the relay is live."
  }'
```

Reply should be:

```json
{
  "status": "sent",
  "sent_to": ["you@yourname.com"],
  "daily_quota_remaining": 9
}
```

## Wire Nexus desktop to the relay

In `packages/server/.env` of your Nexus build machine:

```bash
# Make the desktop client talk to the relay instead of SMTP directly.
NEXUS_RELAY_URL=https://nexus-email-relay.fly.dev
NEXUS_RELAY_API_KEY=<paste-from-step-2>

# These are now OBSOLETE for the bundled-creds scenario — leave unset
# or only use them for local dev. The relay holds the real SMTP password.
# NEXUS_SMTP_HOST=...
# NEXUS_SMTP_USER=...
# NEXUS_SMTP_PASSWORD=...
```

Rebuild the .dmg — the relay URL + API key get bundled. The
`send_email_now` tool now POSTs to the relay; the SMTP password
never leaves Fly.io.

## Rotate credentials

```bash
# Bot Gmail compromised? Generate a new App Password, then:
flyctl secrets set SMTP_PASSWORD="<new-16-char-pwd>"

# Relay API key leaked? Generate a new one, then:
flyctl secrets set RELAY_API_KEY="<new-key>"
# AND rebuild .dmg with the new NEXUS_RELAY_API_KEY value
# AND push the new .dmg to users.
```

The old App Password / API key stop working the moment Fly's redeploy
finishes (~30 seconds).

## Read the audit log

```bash
curl -H "X-Nexus-Relay-Key: <your-key>" \
  "https://nexus-email-relay.fly.dev/audit?days=7" | jq .rows[:5]
```

Shows the last 7 days' sends with: timestamp, calling user_id,
recipients, subject, status (`ok` / `rate_limited` / `blocked` /
`smtp_error`), and the source IP.

## Cost

* Fly.io free tier covers a single low-traffic relay (up to 3 shared
  VMs, 256 MB RAM each — relay uses ~50 MB).
* Persistent volume (`relay_data`): 1 GB free.
* If you exceed free tier: ~$1.94/month for a `shared-cpu-1x` machine
  with 256 MB always-on.

## Files in this package

```
main.py            FastAPI app — single file, ~300 lines
requirements.txt   3 deps: fastapi, uvicorn, pydantic
Dockerfile         python:3.12-slim base, ~100 MB image
fly.toml           Fly app config + volume mount + scale-to-zero
.env.example       Local-dev env template
README.md          This file
```
