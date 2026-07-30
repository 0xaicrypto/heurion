# Contributing

## Workflow

Every bug fix or feature follows the same TDD cycle:

```
Issue → Branch → Fix + Tests → PR → CI → Merge → Delete branch
```

### 1. Create an Issue

Use the **Bug report** or **Feature / Enhancement** template in
`.github/ISSUE_TEMPLATE/`. The TDD test-cases table **must** be filled
before any code is written — this defines the acceptance criteria.

### 2. Create a Branch

```bash
git checkout main
git pull origin main
git checkout -b fix/<short-description>   # or feat/<short-description>
```

Branch naming:
- `fix/` — bug fixes
- `feat/` — new features
- `chore/` — maintenance, CI, docs

### 3. Fix & Write Tests

- Implement the fix or feature.
- Write or update tests per the issue's test-case table.
- Run tests locally before pushing:

  ```bash
  # TypeScript server
  cd packages/server-ts && pnpm test

  # Web frontend
  cd packages/web && pnpm test

  # Python server
  cd packages/server && pytest
  ```

### 4. Create a Pull Request

```bash
git add -A && git commit -m "type: short description"
git push origin HEAD
```

Open a PR against `main` using `gh` or the GitHub UI. The PR body
should link to the issue and summarise the changes.

### 5. Wait for CI

The CI pipeline (`deploy-server.yml`) runs:

1. **typecheck** — `tsc --noEmit` on `packages/server-ts`
2. **test** — `vitest run` (regression suite)
3. **build-worker-image** — Build & push Execution Plane worker
4. **staging** — Deploy to staging VPS + regression test suite
5. **deploy** — Deploy to production VPS (blocked if staging fails)
6. **deploy-execution-plane** — Deploy worker to sandbox VPS

All required checks must pass before merging.

### 6. Merge & Clean Up

```bash
# Squash merge via GitHub UI, or:
gh pr merge <number> --squash

# Delete the branch after merge
git branch -d <branch-name>
git push origin --delete <branch-name>
```

## TDD Guidelines

- **Test cases first**: the issue's test-case table defines what
  "done" means. Implement until all cases pass.
- **Existing tests must not break**: run the full regression suite
  before pushing.
- **Each PR should be focused**: one bug/feature per PR. Avoid
  mixing unrelated changes.

## CI Status

| Workflow | Badge |
|----------|-------|
| Deploy server | [![Deploy](https://github.com/0xaicrypto/heurion/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/0xaicrypto/heurion/actions/workflows/deploy-server.yml) |
| E2E tests | [![E2E](https://github.com/0xaicrypto/heurion/actions/workflows/e2e-tests.yml/badge.svg)](https://github.com/0xaicrypto/heurion/actions/workflows/e2e-tests.yml) |
| TS server CI | [![server-ts-ci](https://github.com/0xaicrypto/heurion/actions/workflows/server-ts-ci.yml/badge.svg)](https://github.com/0xaicrypto/heurion/actions/workflows/server-ts-ci.yml) |
| Web CI | [![web-ci](https://github.com/0xaicrypto/heurion/actions/workflows/web-ci.yml/badge.svg)](https://github.com/0xaicrypto/heurion/actions/workflows/web-ci.yml) |

## Questions

Open a GitHub Discussion or ask in the team channel. See
[`docs/CICD.md`](docs/CICD.md) for the full deployment runbook.
