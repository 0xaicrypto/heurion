#!/usr/bin/env bash
# Pre-push hook — run typecheck + tests before pushing
set -e

echo "=== TypeScript Check ==="
cd packages/server-ts
npx tsc --noEmit && echo "  ✓ tsc" || { echo "  ✗ tsc failed — fix type errors before pushing"; exit 1; }

echo "=== Tests ==="
npx vitest run 2>&1 | tail -5
EXIT_CODE=${PIPESTATUS[0]}
if [ $EXIT_CODE -ne 0 ]; then
  echo "  ✗ tests failed — fix tests before pushing"
  exit 1
fi

echo "=== All checks passed ==="
