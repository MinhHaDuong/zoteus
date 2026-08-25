#!/usr/bin/env bash
# Snapshot the encrypted OAuth store + per-user search indexes from the data volume.
# The store is encrypted at rest (ZOTEUS_OAUTH_TOKEN_SECRET); back up that secret SEPARATELY
# (a backup is useless without it). Restore = stop the service, copy files back into /data, start.
set -euo pipefail

DATA_DIR="${ZOTEUS_DATA_DIR:-/data}"
DEST="${1:-/var/backups/zoteus}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"
ARCHIVE="$DEST/zoteus-$STAMP.tar.gz"

# Both index backends: the legacy JSON artifact and the SQLite database (with its -wal/-shm
# sidecars, which a stopped service has already folded back in).
tar -czf "$ARCHIVE" -C "$DATA_DIR" \
  oauth-store.json \
  $(cd "$DATA_DIR" && ls search-index*.json search-index*.sqlite* 2>/dev/null || true)

echo "wrote $ARCHIVE"
# Retain the 14 most recent.
ls -1t "$DEST"/zoteus-*.tar.gz | tail -n +15 | xargs -r rm -f
