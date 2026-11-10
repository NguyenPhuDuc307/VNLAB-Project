#!/usr/bin/env bash
# Lưu thông tin Getfly CRM vào .env trên VPS rồi khởi động lại app.
# Chạy trên máy anh:  ./scripts/getfly-setup.sh
# API key nhập ẩn, chỉ đi thẳng qua ssh vào .env trên VPS (không lưu trên máy, không in ra màn hình).
set -euo pipefail
HOST=${HOST:-aws-vps}
DIR=${DIR:-/home/ducnp/project}
read -r -p "Địa chỉ Getfly [https://acs.getflycrm.com]: " BASE
BASE=${BASE:-https://acs.getflycrm.com}
read -r -s -p "Getfly API key (Getfly > Cài đặt > API): " KEY; echo
[ -n "$KEY" ] || { echo "Chưa nhập API key"; exit 1; }
printf 'GETFLY_BASE_URL=%s\nGETFLY_API_KEY=%s\n' "$BASE" "$KEY" | ssh "$HOST" "cd '$DIR' && touch .env && grep -v '^GETFLY_' .env > .env.tmp; cat >> .env.tmp && mv .env.tmp .env && chmod 600 .env && docker compose up -d app >/dev/null && echo '✓ Đã lưu cấu hình Getfly và khởi động lại app'"
