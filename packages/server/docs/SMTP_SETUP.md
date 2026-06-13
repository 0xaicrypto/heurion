# Configuring `send_email_now` with a Gmail bot account

The agent's `send_email_now` tool sends email via SMTP. The recommended
setup is a dedicated Gmail account that exists ONLY to be the agent's
sending identity. Five-minute setup, no third-party dependencies.

## 1 · Create the bot Gmail

* Sign up at https://accounts.google.com/signup
* Pick a clear name: e.g. `nexus-agent.bot@gmail.com`
* Add a recovery phone — you'll need it for 2FA

## 2 · Enable 2-Factor Authentication (REQUIRED for App Passwords)

* Visit https://myaccount.google.com/security
* Under **How you sign in to Google**, click **2-Step Verification**
* Follow the prompts (SMS or Authenticator app)

App Passwords don't exist as an option until 2FA is on.

## 3 · Generate an App Password

* Visit https://myaccount.google.com/apppasswords
* App name: `Nexus Agent` (any label is fine — for your records)
* Click **Create** — Google returns a 16-character password
  (4 groups of 4 separated by spaces, e.g. `abcd efgh ijkl mnop`)
* COPY this immediately. Google won't show it again.

## 4 · Add to your Nexus `.env`

The desktop server reads its environment from
`~/Library/Application Support/RuneProtocol/.env`. Add:

```bash
NEXUS_SMTP_HOST=smtp.gmail.com
NEXUS_SMTP_PORT=587
NEXUS_SMTP_USER=nexus-agent.bot@gmail.com
NEXUS_SMTP_PASSWORD=abcdefghijklmnop          # 16 chars, NO spaces
NEXUS_SMTP_FROM=Nexus Agent <nexus-agent.bot@gmail.com>

# OPTIONAL: lock the bot to specific recipients while iterating.
# Comma-separated, case-insensitive. Empty = no restriction.
# Strongly recommended during initial testing.
NEXUS_SMTP_ALLOWED_RECIPIENTS=you@yourname.com,doctor@hospital.org
```

Strip the spaces out of the App Password — Google displays it with
spaces only for readability. `abcd efgh ijkl mnop` → `abcdefghijklmnop`.

## 5 · Restart Nexus

The server reads `.env` at startup. Either:

* Quit Nexus.app and re-open, OR
* Run `bash ~/Library/Application\ Support/RuneProtocol/.../local-backend/stop.sh`
  then re-open the app.

In Nexus's Account view (after the rebuild), the
**Server build** indicator will show the version that picked up the
new env. You can also `grep "send_email_now" ~/Library/Application\ Support/RuneProtocol/server.log`
to verify the tool registered with `smtp_configured=True`.

## 6 · Test

In chat:

> Draft a quick email to me at `you@yourname.com` with subject
> "test from agent" and body "Hi — this is a test send from Nexus."
> Then send it.

Expected: the agent shows you the draft inline, asks for confirmation,
then calls `send_email_now`. The email lands in your inbox within
a few seconds with `From: nexus-agent.bot@gmail.com`.

## Safety notes

* **The agent never sends without confirmation**: the tool's
  description instructs Gemini to show the draft + ask the user
  "send this now?" before invoking. If you observe the agent
  sending without asking, that's a bug — let us know.
* **Allow-list during iteration**: until you trust the agent's
  judgement, keep `NEXUS_SMTP_ALLOWED_RECIPIENTS` set to a tight
  list. Any address outside the list is rejected before SMTP
  is even dialled.
* **App Password ≠ account password**: even if `NEXUS_SMTP_PASSWORD`
  leaks (`.env` checked into Git, machine compromised, …), the
  blast radius is "agent can send Gmail from the bot account".
  Your main Google account stays safe. Revoke the App Password at
  https://myaccount.google.com/apppasswords if compromised.
* **Rate limits**: Gmail caps outbound at ~500/day for free accounts.
  Workspace accounts cap higher. If the agent loops on sending, the
  SMTP tool will start returning 4xx errors before the cap is real-
  worldly hit.

## Troubleshooting

| Error                                         | Fix                                       |
| --------------------------------------------- | ----------------------------------------- |
| `SMTP authentication failed`                  | App Password not enabled / wrong          |
| `Connection refused: smtp.gmail.com:587`      | Firewall blocking outbound :587. Use 465  |
|                                               | (requires code tweak to implicit-TLS)     |
| `Recipient(s) not in allow-list`              | Add the address to `NEXUS_SMTP_ALLOWED_RECIPIENTS` or unset the var  |
| `SMTP not configured` despite setting env     | Server hasn't reloaded — restart Nexus    |
