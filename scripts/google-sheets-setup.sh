#!/usr/bin/env bash
# ============================================================================
#  Cấp Google service account cho đồng bộ Google Sheets — chạy MỘT lần từ máy nhà
#  (cần `gcloud auth login` với tài khoản có quyền trên project Google Cloud).
#
#    ./scripts/google-sheets-setup.sh                 # project mặc định: vnlab-151618
#    GCP_PROJECT=<id> ./scripts/google-sheets-setup.sh
#
#  Làm gì: bật Sheets API + Drive API, tạo service account vnlab-project-sheets,
#  tạo khoá JSON, đẩy thẳng lên VPS /home/ducnp/project/google-sa.json (chmod 600),
#  xoá bản local, rồi dựng lại container Project để nạp khoá. Khoá không in ra màn hình.
# ============================================================================
set -euo pipefail
GCP_PROJECT="${GCP_PROJECT:-vnlab-151618}"
SA_NAME="${SA_NAME:-vnlab-project-sheets}"
SSH_HOST="${DEPLOY_SSH:-aws-vps}"
REMOTE_ROOT="${DEPLOY_ROOT:-/home/ducnp/project}"
EMAIL="$SA_NAME@$GCP_PROJECT.iam.gserviceaccount.com"
info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

info "bật Sheets API + Drive API trên $GCP_PROJECT"
gcloud services enable sheets.googleapis.com drive.googleapis.com --project "$GCP_PROJECT"

info "service account $EMAIL"
gcloud iam service-accounts describe "$EMAIL" --project "$GCP_PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --project "$GCP_PROJECT" \
       --display-name "VNLab Project → Google Sheets" \
       --description "Ghi kế hoạch dự án từ project.vnlab.id.vn vào Google Sheets được chia sẻ"

info "tạo khoá và đẩy lên VPS (không lưu lại ở máy này)"
KEY="$(mktemp)"
trap 'rm -f "$KEY"' EXIT
gcloud iam service-accounts keys create "$KEY" --iam-account "$EMAIL" --project "$GCP_PROJECT" >/dev/null
# Container chạy user `node` (uid 1000) nên file phải thuộc uid 1000, mode 600.
ssh "$SSH_HOST" "mkdir -p '$REMOTE_ROOT' && umask 077 && cat > '$REMOTE_ROOT/google-sa.json' && chmod 600 '$REMOTE_ROOT/google-sa.json' && sudo chown 1000:1000 '$REMOTE_ROOT/google-sa.json'" < "$KEY"
ok "đã đặt $REMOTE_ROOT/google-sa.json trên VPS"

info "dựng lại container để nạp khoá"
ssh "$SSH_HOST" "cd '$REMOTE_ROOT' && docker compose up -d --force-recreate --wait --wait-timeout 120 app" | tail -2
ok "xong. Trong app: Cài đặt dự án → Google Sheets → 'Tạo Google Sheet mới', hoặc Share sheet có sẵn (Editor) cho: $EMAIL"
