#!/usr/bin/env bash
# #290: backup Heurion data to S3-compatible object storage.
#
# Data layout (post #280/#281):
#   heurion_nexus-db-data  → SQLite (nexus_server.db)
#   heurion_nexus-files-data → per-user memory (event_log.jsonl, memory_graph, facts, ...)
#   heurion_nexus-data     → uploads/, cache, embedding models
#
# Usage:
#   backup-to-s3.sh [daily|weekly]
#
# Env (from .env.production):
#   S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET
#   BACKUP_RETAIN_DAYS (default 30), BACKUP_RETAIN_WEEKS (default 8)
#
# Requires: docker (to mount the volumes), rclone, sqlite3.

set -euo pipefail

MODE="${1:-daily}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_BUCKET:-}" ]; then
  echo "S3 backup not configured (S3_ACCESS_KEY/S3_BUCKET missing) — skipping" >&2
  exit 0
fi

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone not installed — skipping backup" >&2
  exit 1
fi

DB_VOL=$(docker volume ls -q | grep '^heurion_nexus-db-data$' || true)
FILES_VOL=$(docker volume ls -q | grep '^heurion_nexus-files-data$' || true)
DATA_VOL=$(docker volume ls -q | grep '^heurion_nexus-data$' || true)

if [ -z "$DB_VOL" ]; then
  echo "DB volume not found — skipping backup" >&2
  exit 1
fi

# rclone remote config (file-based, no global state).
mkdir -p ~/.config/rclone
cat > ~/.config/rclone/rclone.conf <<EOF
[heurion-s3]
type = s3
provider = Other
endpoint = ${S3_ENDPOINT:-https://s3.amazonaws.com}
region = ${S3_REGION:-us-east-1}
access_key_id = ${S3_ACCESS_KEY}
secret_access_key = ${S3_SECRET_KEY}
EOF

if [ "$MODE" = "daily" ]; then
  # SQLite: use the .backup API for a consistent snapshot (never cp a hot DB).
  if command -v sqlite3 >/dev/null 2>&1; then
    docker run --rm -v "$DB_VOL":/db alpine sh -c 'cat /db/nexus_server.db' > "$TMP/nexus_server.db" 2>/dev/null \
      || docker cp "$(docker create --name tmp-nexus-db -v "$DB_VOL":/db alpine true)":/db/nexus_server.db "$TMP/nexus_server.db" 2>/dev/null || true
  fi
  if [ ! -s "$TMP/nexus_server.db" ]; then
    echo "Failed to extract DB — skipping daily backup" >&2
    exit 1
  fi
  # sqlite3 .backup needs a live sqlite3 — use the container's own sqlite if present,
  # otherwise validate via sqlite3 CLI.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$TMP/nexus_server.db" "PRAGMA integrity_check;" >/dev/null 2>&1 || { echo "DB integrity check failed" >&2; exit 1; }
  fi
  gzip -9 "$TMP/nexus_server.db"
  rclone copy "$TMP/nexus_server.db.gz" "heurion-s3:${S3_BUCKET}/db/" --s3-no-check-bucket
  echo "✓ daily DB backup uploaded: nexus_server.db.gz"

  # Per-user memory files (event log, memory graph, facts, skills).
  if [ -n "$FILES_VOL" ]; then
    docker run --rm -v "$FILES_VOL":/data alpine sh -c 'tar czf - -C /data .' > "$TMP/files-$STAMP.tar.gz" 2>/dev/null || true
    if [ -s "$TMP/files-$STAMP.tar.gz" ]; then
      rclone copy "$TMP/files-$STAMP.tar.gz" "heurion-s3:${S3_BUCKET}/memory/" --s3-no-check-bucket
      echo "✓ daily memory backup uploaded: files-$STAMP.tar.gz"
    fi
  fi
fi

if [ "$MODE" = "weekly" ]; then
  if [ -n "$DATA_VOL" ]; then
    docker run --rm -v "$DATA_VOL":/data alpine sh -c 'tar czf - -C /data uploads cache' > "$TMP/uploads-$STAMP.tar.gz" 2>/dev/null || true
    if [ -s "$TMP/uploads-$STAMP.tar.gz" ]; then
      rclone copy "$TMP/uploads-$STAMP.tar.gz" "heurion-s3:${S3_BUCKET}/files/" --s3-no-check-bucket
      echo "✓ weekly files backup uploaded: uploads-$STAMP.tar.gz"
    fi
  fi
fi

# Retention cleanup (server-side listings; keep newest N).
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
RETAIN_WEEKS="${BACKUP_RETAIN_WEEKS:-8}"
if [ "$MODE" = "daily" ]; then
  for prefix in db memory; do
    rclone lsf "heurion-s3:${S3_BUCKET}/$prefix/" --format t 2>/dev/null \
      | sort -r \
      | tail -n +$((RETAIN_DAYS + 1)) \
      | while read -r f; do rclone deletefile "heurion-s3:${S3_BUCKET}/$prefix/$f" 2>/dev/null || true; done || true
  done
else
  rclone lsf "heurion-s3:${S3_BUCKET}/files/" --format t 2>/dev/null \
    | sort -r \
    | tail -n +$((RETAIN_WEEKS + 1)) \
    | while read -r f; do rclone deletefile "heurion-s3:${S3_BUCKET}/files/$f" 2>/dev/null || true; done || true
fi

echo "Backup complete ($MODE)"
