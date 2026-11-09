#!/usr/bin/env bash
# ============================================================================
#  Deploy Project (project.vnlab.id.vn) lên VPS — build ngay trên VPS.
#
#    ./deploy.sh          # đẩy mã nguồn, build, dựng lại app, cập nhật site trên Edge
#    ./deploy.sh site     # chỉ cập nhật deploy/edge.caddy trên Edge
#
#  Cấu hình: DEPLOY_SSH (mặc định aws-vps), DEPLOY_ROOT (mặc định /home/ducnp/project)
#  Cần VNLab Edge (repo Edge) đã chạy trên VPS, và PROJECT_LOGTO_APP_ID trong .env
#  trên VPS (id app Logto "VNLab Project" do bootstrap ở repo Account tạo).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${DEPLOY_SSH:-aws-vps}"
REMOTE_ROOT="${DEPLOY_ROOT:-/home/ducnp/project}"
EDGE_SITES="${EDGE_SITES:-/home/ducnp/edge/caddy/sites}"
SITE_NAME=project
# Khoá công khai age dùng chung cho mọi bản sao lưu VNLab (khoá bí mật ở máy nhà).
BACKUP_AGE_RECIPIENT=age1pxes5ydsxx3lyhquss0gwypwwl4sc0fmj08dj5cmfjlpac9t7vnqew3f89
export COPYFILE_DISABLE=1

info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# `caddy reload` kiểm tra cấu hình trước khi áp: hỏng thì Edge vẫn chạy bản cũ,
# và file trả về như trước để lần reload sau của project khác không vấp.
publish_site() {
  local dst="$EDGE_SITES/$SITE_NAME.caddy"
  info "cập nhật site trên Edge"
  ssh "$SSH_HOST" "test -d '$EDGE_SITES' && { cp -p '$dst' '$dst.prev' 2>/dev/null || true; }" \
    || die "chưa có Edge trên VPS ($EDGE_SITES) — deploy repo Edge trước"
  ssh "$SSH_HOST" "cat > '$dst.new' && mv '$dst.new' '$dst'" < "$ROOT/deploy/edge.caddy"
  if ! ssh "$SSH_HOST" "docker exec edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"; then
    ssh "$SSH_HOST" "if [ -f '$dst.prev' ]; then mv '$dst.prev' '$dst'; else rm -f '$dst'; fi"
    die "Edge từ chối $SITE_NAME.caddy — đã trả file cũ"
  fi
  ssh "$SSH_HOST" "rm -f '$dst.prev'"
  ok "Edge đã nạp $SITE_NAME.caddy"
}

if [ "${1:-}" = site ]; then publish_site; exit 0; fi

info "đẩy mã nguồn → $SSH_HOST:$REMOTE_ROOT"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_ROOT' && rm -rf '$REMOTE_ROOT/src' && mkdir -p '$REMOTE_ROOT/src'"
tar --no-xattrs -C "$ROOT" -czf - --exclude=./node_modules --exclude=./dist --exclude=./.git \
  --exclude=./deploy --exclude=./.env . | ssh "$SSH_HOST" "tar -C '$REMOTE_ROOT/src' -xzf -"
tar --no-xattrs -C "$ROOT/deploy" -czf - compose.yaml backup.sh | ssh "$SSH_HOST" "tar -C '$REMOTE_ROOT' -xzf -"

# Bí mật sinh MỘT lần vào .env trên VPS và giữ nguyên về sau.
info "kiểm tra .env"
ssh "$SSH_HOST" "set -eu
  cd '$REMOTE_ROOT'
  touch .env && chmod 600 .env
  for key in POSTGRES_PASSWORD PROJECT_JWT_SECRET; do
    if ! grep -q \"^\$key=.\" .env; then
      printf '%s=%s\\n' \"\$key\" \"\$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')\" >> .env
      echo \"đã sinh \$key\"
    fi
  done
  # Không tự sinh: id app Logto do bootstrap (repo Account) tạo, và khoá dịch vụ phải trùng bên Account.
  grep -q '^PROJECT_LOGTO_APP_ID=.' .env || { echo 'thiếu PROJECT_LOGTO_APP_ID trong .env — chạy bootstrap ở repo Account rồi đặt id app project' >&2; exit 1; }
  grep -q '^ACCOUNT_SERVICE_TOKEN=.' .env || echo 'chưa có ACCOUNT_SERVICE_TOKEN — VNLab Account chưa chỉnh được quyền Project (đặt tay, trùng bên Account)'
  # Khoá Google service account cho đồng bộ Sheets: chưa có thì tạo file rỗng để compose mount được (tính năng báo chưa cấu hình).
  [ -e google-sa.json ] || { : > google-sa.json; chmod 600 google-sa.json; echo 'chưa có google-sa.json — đồng bộ Google Sheets tắt'; }
  # Container chạy user node (uid 1000): file khoá phải đọc được từ uid đó.
  sudo chown 1000:1000 google-sa.json 2>/dev/null || true"

info "build + dựng lại trên VPS"
ssh "$SSH_HOST" "set -eu
  cd '$REMOTE_ROOT'
  docker network inspect vnlab-edge >/dev/null 2>&1 || { echo 'thiếu network vnlab-edge — deploy repo Edge trước' >&2; exit 1; }
  docker compose config -q
  nice -n 10 docker compose build app
  docker compose up -d --wait --wait-timeout 120"
publish_site

info "cài lịch sao lưu hằng ngày"
ssh "$SSH_HOST" "set -eu
  chmod 700 '$REMOTE_ROOT/backup.sh'
  sudo tee /etc/systemd/system/project-backup.service >/dev/null <<UNIT
[Unit]
Description=Sao lưu PostgreSQL Project
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=\$(whoami)
Environment=BACKUP_AGE_RECIPIENT=$BACKUP_AGE_RECIPIENT
ExecStart=$REMOTE_ROOT/backup.sh
Nice=10
UNIT
  sudo tee /etc/systemd/system/project-backup.timer >/dev/null <<UNIT
[Unit]
Description=Sao lưu PostgreSQL Project hằng ngày

[Timer]
OnCalendar=*-*-* 19:50:00 UTC
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now project-backup.timer >/dev/null"

ssh "$SSH_HOST" "docker image prune -f; docker builder prune -f --filter until=168h" >/dev/null 2>&1 || true
ok "Project đã deploy"
