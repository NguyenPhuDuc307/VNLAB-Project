#!/usr/bin/env bash
# Sao lưu database Project — chạy hằng ngày bởi project-backup.timer trên VPS
# (deploy.sh cài). Bản sao mã hoá bằng age, cùng khoá với các project khác, để
# LaunchAgent vn.vnlab.backup-pull trên máy nhà kéo về được.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$ROOT/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose -f "$ROOT/compose.yaml" --env-file "$ROOT/.env" exec -T db \
  pg_dump -U project -d project --format=custom --compress=9 > "$TMP/project.dump"

out="$BACKUP_DIR/project-$STAMP.dump"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$out.age" "$TMP/project.dump"
  chmod 600 "$out.age"
else
  install -m 600 "$TMP/project.dump" "$out"
  echo "[WARN] Backup chưa mã hoá; đặt BACKUP_AGE_RECIPIENT." >&2
fi

find "$BACKUP_DIR" -type f -name 'project-*.dump*' -mtime "+$RETENTION_DAYS" -delete
echo "[OK] $out${BACKUP_AGE_RECIPIENT:+.age}"
