# Engineering Standards

These are non-negotiable rules. A change that violates one of them is
NOT considered "done" — it ships as red, not green.

If you're an AI assistant working on this codebase: when in doubt,
default to the strict interpretation. The cost of one extra test / one
extra migration / one extra build-script line is far smaller than the
cost of debugging a "works on my machine" bug surfaced by a user.

---

## Rule 1 — Install & configuration MUST be solved by the .dmg

**Statement**: every installation, configuration, and dependency
concern must be solvable end-to-end by `./scripts/build-macos.sh` +
double-clicking the resulting `.dmg`. No "step 2: manually run pip
install …" instructions to end users. Ever.

**Why**: every manual step in user-facing instructions is a future bug
that surfaces months later when one user skips it. The `.dmg` is the
contract. If the contract is broken, fix the build script — not the
user.

**Concretely:**

- All Python dependencies must be declared in
  `packages/server/pyproject.toml`. The build script runs
  `pip install -e` on every build (no "skip when warm" shortcut) and
  verifies every declared dep is importable before invoking
  PyInstaller. A missing dep aborts the build, not the user's launch.
- All environment defaults (LLM keys, relay URLs, feature flags) ship
  via `packages/desktop-v2/src-tauri/resources/default.env`,
  regenerated from `packages/server/.env` at build time. The Tauri
  shell seeds / delta-merges this on first launch.
- All bundled resources (alembic migrations, MONAI Bundles, prompt
  files) are listed under `bundle.resources` in `tauri.conf.json` AND
  the PyInstaller spec's `datas` list. If you add a runtime data
  dependency, both lists get updated in the same PR.
- The PyInstaller spec's `hiddenimports` must contain every module
  loaded by dynamic import (Alembic versions, MCP plugins, etc.).
- If a user-facing diagnostic step would be required ("check if alembic
  is installed in your venv"), the build script's verify stage is
  missing that check. Add it.

**What this excludes**: third-party tooling the developer must have
installed once on the build host (Xcode CLT, brew, rustup). These are
declared in `scripts/build-macos.sh` Stage 1 and auto-installed if
missing. End users never see them.

---

## Rule 2 — All DB modifications go through migrations

**Statement**: every change to the SQL schema OR the persisted data
state must land as a numbered Alembic migration under
`packages/server/nexus_server/migrations/versions/`. The runner
applies all pending migrations at server startup.

**Why**: the desktop is a long-lived state machine. We need:

- **Reproducibility** — `SELECT version_num FROM alembic_version` tells
  us exactly which schema a user is on.
- **Atomicity** — every migration runs in a transaction. Either the DB
  jumps forward cleanly or it stays where it was. No half-states.
- **Replay** — Rev-8 invariant. Projections must be rebuildable from
  the event log. Ad-hoc `ALTER TABLE` in a router method makes that
  guarantee impossible to test.

**Two kinds, same framework:**

| Kind | Example | Where it lives |
|---|---|---|
| Schema | `ALTER TABLE uploads ADD COLUMN memory_status TEXT` | `versions/NNNN_xxx.py::upgrade()` via `op.execute()` |
| Data backfill | `UPDATE uploads SET memory_status='pending' WHERE …` | Same file, same function — when conceptually one change. Separate file when the backfill is slow. |

**Out of scope (NOT migrations)**:

- **Runtime user activity** — patient registration, file upload, chat
  turn, DICOM ingest. These mutate user data via routers + ingesters,
  not migrations.
- **Per-user event log schema** (`twin_event_log`). Different DB,
  different governance. See `m3-memory-architecture.md §16.6.3`.

**Smell test**: if the code path is "developer commits → users get the
change on next launch", it's a migration. If it's "user does X → DB
changes for that user", it's runtime.

---

## Rule 3 — Unit + integration tests on every code change

**Statement**: every changed file — scripts, backend, frontend — ships
with tests that exercise the changed behavior. Untested code is
not "done", regardless of whether it appears to work locally.

**Why**: the past 24 hours have produced ~12 user-visible bugs that
existing tests would have caught (`instance_count` typo,
`extract_dir` typo, FK-constraint-on-zero, missing alembic import,
build-script's hardcoded `import` check). Cost of writing the test:
2–5 minutes. Cost of debugging via screenshot ping-pong: 30–60
minutes per cycle.

**Concretely:**

| Change type | Test type | Where |
|---|---|---|
| New FastAPI endpoint | Integration via Starlette TestClient — happy path + auth + 4xx + 5xx + cross-user isolation | `packages/server/tests/test_<router>.py` |
| New ingester / pipeline | Integration covering event-log → projection → API round-trip | same |
| New SQL migration | Test: empty DB → upgrade head → assert table+column exists; existing DB → upgrade head → assert backfill ran correctly | `tests/test_migrations.py` |
| New React component | Component test (`@testing-library/react`) covering the props it renders and the events it emits | `packages/desktop-v2/src/**/*.test.tsx` |
| New build-script stage | Shell-level test like `src-tauri/tests/test_env_seed_merge.sh` — uses tempdirs, asserts on outputs | `packages/desktop-v2/src-tauri/tests/` |
| Fix to existing bug | Regression test: a test that would have failed BEFORE the fix and passes AFTER | colocate with the unit being fixed |

**Definition of done**:

```
pytest                            # backend
pnpm test                         # frontend (when wired)
bash src-tauri/tests/*.sh         # build pipeline
./scripts/build-macos.sh          # the whole thing, end-to-end
```

…all four exit 0. No "I'll add the test in a follow-up". Follow-ups
don't happen.

**Exception we DO allow** — purely cosmetic CSS / copy changes that
have no behavior. Everything else, no exceptions.

---

## Living document

Add a rule when you spot a repeating failure mode that this doc would
have prevented. Remove a rule only when its violation history has been
zero for 90 days.
