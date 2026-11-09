#!/usr/bin/env bash
# ============================================================================
#  Đưa VNLab Project lên production LẦN ĐẦU — chạy từ máy nhà (cần ssh aws-vps).
#
#    ./scripts/rollout.sh            # toàn bộ, đúng thứ tự:
#                                    #   1 deploy Account (catalog có Project)
#                                    #   2 bootstrap Logto trong container Account → app "VNLab Project" + role project:*
#                                    #   3 ghi PROJECT_LOGTO_APP_ID + ACCOUNT_SERVICE_TOKEN vào ~/project/.env trên VPS
#                                    #   4 deploy Project   5 deploy Landing   6 cấp project:admin cho các vnlab:admin
#                                    #   7 kiểm tra https://project.vnlab.id.vn
#    ./scripts/rollout.sh plan       # chỉ in kế hoạch bootstrap (không ghi gì)
#    ./scripts/rollout.sh <bước>     # account | bootstrap | env | project | landing | grant | check
#
#  Secret Logto (M2M) nằm trong env của container Account trên VPS và không rời VPS;
#  ACCOUNT_SERVICE_TOKEN được chép từ ~/account/.env sang ~/project/.env ngay trên VPS.
#  Yêu cầu trước: DNS project.vnlab.id.vn đã trỏ (Cloudflare, proxy cam).
# ============================================================================
set -euo pipefail

SSH_HOST="${DEPLOY_SSH:-aws-vps}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSONAL="$(cd "$ROOT/.." && pwd)"
ACCOUNT_DIR="${ACCOUNT_DIR:-$PERSONAL/Account}"
LANDING_DIR="${LANDING_DIR:-$PERSONAL/Landing}"
REMOTE_ACCOUNT=/home/ducnp/account
REMOTE_PROJECT=/home/ducnp/project

info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Chạy một file .mjs trong container Account (stdin), có thể kèm biến môi trường.
in_account() { # in_account <file.mjs> [ENV=...]
  local file="$1"; shift
  local envs=()
  for kv in "$@"; do envs+=(-e "$kv"); done
  ssh "$SSH_HOST" "cd '$REMOTE_ACCOUNT' && docker compose exec -T ${envs[*]:-} app node --input-type=module" < "$file"
}

step_account() {
  info "1/7 deploy VNLab Account"
  [ -x "$ACCOUNT_DIR/deploy.sh" ] || die "không thấy $ACCOUNT_DIR/deploy.sh"
  (cd "$ACCOUNT_DIR" && ./deploy.sh)
}

step_plan() {
  info "bootstrap Logto — kế hoạch (dry-run)"
  in_account "$ROOT/scripts/rollout/bootstrap.mjs"
}

step_bootstrap() {
  info "2/7 bootstrap Logto (ghi)"
  in_account "$ROOT/scripts/rollout/bootstrap.mjs" APPLY=1 | tee /tmp/vnlab-project-bootstrap.log
}

step_env() {
  info "3/7 ghi .env cho Project trên VPS"
  local id=""
  if [ -f /tmp/vnlab-project-bootstrap.log ]; then
    id="$(grep -E '^(CREATED|EXISTING) project ' /tmp/vnlab-project-bootstrap.log | sed -E 's/.*id=([A-Za-z0-9]+).*/\1/' | tail -1 || true)"
  fi
  if [ -z "$id" ]; then
    id="$(in_account "$ROOT/scripts/rollout/bootstrap.mjs" | grep -E '^EXISTING project ' | sed -E 's/.*id=([A-Za-z0-9]+).*/\1/' | tail -1 || true)"
  fi
  [ -n "$id" ] || die "chưa có app Logto 'project' — chạy ./scripts/rollout.sh bootstrap trước"
  ok "PROJECT_LOGTO_APP_ID=$id"
  ssh "$SSH_HOST" "set -eu
    mkdir -p '$REMOTE_PROJECT' && touch '$REMOTE_PROJECT/.env' && chmod 600 '$REMOTE_PROJECT/.env'
    grep -q '^PROJECT_LOGTO_APP_ID=.' '$REMOTE_PROJECT/.env' || echo 'PROJECT_LOGTO_APP_ID=$id' >> '$REMOTE_PROJECT/.env'
    if ! grep -q '^ACCOUNT_SERVICE_TOKEN=.' '$REMOTE_PROJECT/.env'; then
      grep '^ACCOUNT_SERVICE_TOKEN=.' '$REMOTE_ACCOUNT/.env' >> '$REMOTE_PROJECT/.env' && echo 'đã chép ACCOUNT_SERVICE_TOKEN từ Account' || echo 'Account chưa có ACCOUNT_SERVICE_TOKEN — tab Quyền ứng dụng sẽ 503 (đặt tay sau)'
    fi
    cut -d= -f1 '$REMOTE_PROJECT/.env'"
}

step_project() {
  info "4/7 deploy VNLab Project"
  (cd "$ROOT" && ./deploy.sh)
}

step_landing() {
  info "5/7 deploy Landing (trang /project, logo, ảnh OG)"
  [ -x "$LANDING_DIR/deploy.sh" ] || die "không thấy $LANDING_DIR/deploy.sh"
  (cd "$LANDING_DIR" && ./deploy.sh)
}

step_grant() {
  info "6/7 cấp project:admin cho các tài khoản vnlab:admin"
  in_account "$ROOT/scripts/rollout/grant.mjs"
}

step_check() {
  info "7/7 kiểm tra"
  curl -fsS --max-time 15 https://project.vnlab.id.vn/healthz >/dev/null && ok "healthz OK"
  curl -fsS --max-time 15 https://project.vnlab.id.vn/api/auth/status; echo
  curl -fsS --max-time 15 -o /dev/null -w 'landing /project -> %{http_code}\n' https://vnlab.id.vn/project
  curl -fsS --max-time 15 -o /dev/null -w 'account -> %{http_code}\n' https://account.vnlab.id.vn/healthz
  ok "Mở https://project.vnlab.id.vn và đăng nhập VNLab ID."
}

case "${1:-all}" in
  all) step_account; step_bootstrap; step_env; step_project; step_landing; step_grant; step_check ;;
  plan) step_plan ;;
  account) step_account ;;
  bootstrap) step_bootstrap ;;
  env) step_env ;;
  project) step_project ;;
  landing) step_landing ;;
  grant) step_grant ;;
  check) step_check ;;
  *) die "bước không hợp lệ: $1 (all | plan | account | bootstrap | env | project | landing | grant | check)" ;;
esac
