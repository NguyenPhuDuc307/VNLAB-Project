# VNLab Project — project.vnlab.id.vn

Kế hoạch dự án kiểu bảng Gantt: dự án → nhóm việc (giai đoạn / phân hệ) → việc với
người phụ trách, người hỗ trợ, tiến độ %, ngày bắt đầu / kết thúc, ngày công. Lưới
ngày theo tuần (T2–CN), cột hôm nay tô màu, kéo thanh để dời ngày hoặc kéo hai mép
để đổi ngày bắt đầu / kết thúc. Dán thẳng từ Excel / Google Sheets để nhập kế hoạch.

React 19 + Vite + Tailwind 4 (poster Ecosystem v4, màu cam đất) + server Node/Hono
TypeScript; dữ liệu ở Postgres riêng (`deploy/compose.yaml`), sao lưu hằng ngày.
Một tiến trình Node phục vụ cả API `/api/*` lẫn SPA đã build.

Task cha có thể chứa các **task con** (tên, phụ trách, tiến độ riêng). Task con dùng
lịch và ngày công của cha; chỉ task cha có thanh Gantt và được tính vào thống kê.
Khi có task con, tiến độ cha tự lấy trung bình cộng (làm tròn %). Sửa task → Task con
để thêm / sửa / xoá; có thể tách tên nhiều dòng thành các task con trước khi lưu.
API / MCP nhận `subtasks: [{ id?, name, assignee?, progress? }]`; khi sửa, gửi toàn bộ
danh sách cần giữ. JSON xuất giữ các task con. Excel / Sheets có hàng task con ngay dưới cha (STT 1.1, 1.2), với phụ trách / tiến độ riêng; ngày và ngày công để trống ở hàng con, thanh Gantt chỉ có ở cha. Tab Dữ liệu có thêm cột Task cha. CSV vẫn là kế hoạch theo task cha.


## Đăng nhập và quyền

- Chỉ đăng nhập bằng **VNLab ID** (Logto `https://auth.vnlab.id.vn`, app SPA riêng
  "VNLab Project" — id do bootstrap ở repo Account tạo, đặt vào `PROJECT_LOGTO_APP_ID`).
  Server tự làm OIDC code + PKCE (`server/sso.ts`); redirect URI
  `https://project.vnlab.id.vn/api/auth/sso/callback`, post-logout `…/api/auth/logged-out`.
  Không có đăng nhập email/mật khẩu cục bộ.
- Vào cửa: role Logto **`project:user`** hoặc **`project:admin`** (cấp ở
  [VNLab Account](https://account.vnlab.id.vn/admin)). Thiếu role → `/api/auth/no-access`.
  Phiên mang mốc `rc`; quá `PROJECT_ROLE_RECHECK_HOURS` (12 giờ) thì API trả
  `401 {reauth: true}` và app tự đi SSO lại để kiểm role.
- Quyền tính năng (`server/permissions.ts`, `server/rbac.ts`): `project.project.create|write|delete`,
  `project.task.write|delete`, `project.data.import|export`, `project.settings.write`.
  `project:user` sửa được ở VNLab Account qua `/api/service/rbac` (hợp đồng chung với
  Stock/Finance/Shop: `Authorization: Bearer <ACCOUNT_SERVICE_TOKEN>` + `X-VNLab-Actor`);
  `project:admin` khoá cứng = mọi quyền.
- Quyền dữ liệu: **chủ dự án** (người tạo) toàn quyền; mời thành viên theo **email VNLab
  ID** với quyền *Được sửa* (nhóm, việc) hoặc *Chỉ xem*. Mời trước khi người đó đăng nhập
  Project cũng được — lời mời tự gắn khi họ vào lần đầu. Không ai (kể cả `project:admin`)
  thấy dự án mình không được mời.
- Mỗi người đồng ý chính sách bảo mật một lần (`POLICY_VERSION`); Cài đặt có tải toàn bộ
  dữ liệu (JSON) và xoá tài khoản (xoá luôn dự án mình là chủ).

## API chính (`server/index.ts`)

| Đường | Việc |
|---|---|
| `GET /api/me`, `POST /api/me/consent`, `PATCH /api/me`, `GET /api/me/export`, `POST /api/me/delete` | tài khoản |
| `GET /api/overview` | dự án đang chạy, việc quá hạn, việc đến hạn trong 7 ngày |
| `GET|POST /api/projects`, `GET|PATCH|DELETE /api/projects/:id` | dự án (kèm `myRole`, thành viên, nhóm, việc) |
| `POST|PATCH|DELETE /api/projects/:id/members[/:email]` (`me` = tự rời) | thành viên |
| `POST|PATCH|DELETE /api/projects/:id/groups[/:gid]`, `PUT …/groups/order` | nhóm việc (`?keepTasks=1` khi xoá) |
| `GET /api/projects/:id/events` | luồng SSE: event `changed` mỗi khi dự án đổi (web, MCP, nhập liệu), `ping` 25 giây/lần; giao diện dùng để cập nhật thời gian thực |
| `POST|PATCH|DELETE /api/projects/:id/tasks[/:tid]`, `PUT …/tasks/order`, `POST …/tasks/sort` | việc; `order` = kéo thả trong nhóm, `sort` = xếp theo ngày (một nhóm hoặc tất cả) |
| `POST /api/projects/:id/import` | nhập hàng loạt `{ groups: [{ name, tasks }] }` (nhóm trùng tên thì gộp) |
| `GET /api/projects/:id/export?format=xlsx|csv|json` | xuất: Excel theo mẫu Gantt (sheet PLAN + Dữ liệu, thanh bằng conditional formatting), CSV, JSON |
| `GET /api/google/status`, `PATCH /api/projects/:id/sheet`, `POST …/sheet/sync` | Google Sheets: trạng thái, liên kết / tự đồng bộ, đồng bộ ngay |
| `GET|POST|DELETE /api/tokens[/:id]`, `GET /api/mcp/tools` | token MCP cá nhân |
| `POST /mcp` | MCP cho AI bên ngoài (bearer `vpj_…`) |
| `/api/service/rbac/*` | API dịch vụ cho VNLab Account |

Ngày công (cột *Ngày*): để trống thì tự tính T2–T6 = 1, T7 và CN theo trọng số của dự án
(mặc định T7 = ½, CN = 0); nhập tay thì giữ nguyên.

## MCP cho AI bên ngoài (`/mcp`)

Claude Code, Codex, Claude Desktop hay client MCP bất kỳ tạo / cập nhật việc trong dự án của
bạn. Cài đặt → **AI bên ngoài (MCP)** → tạo token `vpj_…` (chỉ hiện một lần, server chỉ lưu
băm SHA-256; cần quyền `project.tokens.manage`, mặc định `project:user` có). Endpoint
`https://project.vnlab.id.vn/mcp`, Streamable HTTP không giữ phiên (như Stock), header
`Authorization: Bearer vpj_…`:

```bash
claude mcp add --transport http vnlab-project https://project.vnlab.id.vn/mcp --header "Authorization: Bearer vpj_…"
```

Công cụ (`server/tools.ts`, dùng chung tầng dữ liệu `server/data.ts` với REST nên AI và giao
diện không lệch nhau): `list_projects`, `get_project`, `get_overview`, `find_tasks` (đọc);
`create_project`, `create_group`, `create_task`, `create_tasks` (nhiều việc một lần, tên nhóm
chưa có thì tạo), `update_task`, `delete_task`, `delete_group`, `sort_tasks`, `update_project`, `delete_project`, `set_member`, `remove_member`, `update_group`, `reorder_groups`, `move_task`, `rebaseline_task`, `set_google_sheet`, `sync_google_sheet`, `create_scope`, `update_scope`, `delete_scope`, `reorder_scopes`, `set_ai_context`; đọc thêm `get_task_history`, `get_export_link`, `get_ai_context`. Phạm vi (scope) là tag gắn vào việc, có người phụ trách phạm vi điền tay; hướng dẫn cho AI lưu theo dự án (`ai_context`). Nguyên tắc: thao tác nào làm được trên giao diện thì phải có công cụ MCP tương ứng (xếp việc trong nhóm theo ngày) (ghi). Ngày nhận `YYYY-MM-DD` lẫn `dd/mm/yyyy`,
`2-Nov-26`; không hiểu thì báo lỗi chứ không đoán. Quyền tính năng `project.*` và quyền theo dự
án (chủ / được sửa / chỉ xem) kiểm y như REST; gỡ `project.tokens.manage` ở VNLab Account thì
mọi token của người đó trả 403 ngay; thu hồi token trong Cài đặt → 401.

## Đồng bộ Google Sheets (một chiều app → sheet)

Cài đặt dự án → **Google Sheets**: tạo Google Sheet (link mở Google Sheets với tên đặt sẵn;
Google không cấp dung lượng Drive cho service account nên app không tự tạo file được), Share
**Người chỉnh sửa** cho email service account, dán link → Liên kết. Nút **Đồng bộ Sheets** trên trang dự án (và công cụ MCP
`sync_google_sheet`) ghi tab `PLAN` + `Dữ liệu` đúng bố cục mẫu Gantt như bản Excel (cùng
`server/plan-layout.ts`); các tab khác giữ nguyên. Bật **Tự đồng bộ** thì mỗi thay đổi việc /
nhóm được gộp trong 30 giây rồi ghi. Chiều ngược (sửa trên sheet → app) chưa có: dùng
"Dán từ bảng tính".

Cấu hình một lần: `./scripts/google-sheets-setup.sh` (cần `gcloud auth login`) bật Sheets +
Drive API, tạo service account `vnlab-project-sheets`, đặt khoá vào
`/home/ducnp/project/google-sa.json` trên VPS (compose mount vào
`GOOGLE_SERVICE_ACCOUNT_FILE`). Thiếu khoá thì tính năng báo "chưa cấu hình", app vẫn chạy.
Mã: `server/google.ts` (JWT service account, token cache), `server/sheets.ts` (batchUpdate,
tạo/chia sẻ sheet, tự đồng bộ), test với Google API giả ở `server/sheets.test.ts`.

## Đồng bộ Getfly CRM (một chiều app → Getfly, bấm nút)

`server/getfly.ts` dùng API Getfly v6.1 (`X-API-KEY`). Mỗi dự án đặt một **việc cha** trên Getfly
(dán link `#/tasks/?…task_id=…`, id hoặc mã việc; app tra ra mã + tên dự án Getfly). Bấm “Đồng bộ
Getfly” (hoặc MCP `sync_getfly`): việc mới → tạo dưới việc cha, task con → việc con dưới việc tương ứng,
việc đã đổi → sửa (so băm nội dung đã gửi, không gửi thừa), tiến độ 100% → hoàn thành, việc đã xoá →
xoá trên Getfly. Liên kết lưu ở `getfly_links`. Người phụ trách ghép tay sang username Getfly.
Getfly không có API mở lại việc đã hoàn thành: mở lại bên app thì kết quả đồng bộ báo để sửa tay.
Cấu hình máy chủ: `./scripts/getfly-setup.sh` (ghi `GETFLY_BASE_URL`, `GETFLY_API_KEY` vào `.env` trên VPS).

## Chạy local

```bash
npm install
npm run dev:db        # PGlite nói giao thức Postgres ở :55433 (không cần Docker)
PROJECT_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres PROJECT_DB_POOL=1 PROJECT_DEV_LOGIN=1 npm run dev:server
npm run dev           # Vite :5175, proxy /api -> :3400
npm test              # Logto giả + PGlite + server thật
```

`PROJECT_DEV_LOGIN=1` (chỉ ngoài production) bật nút "Vào bằng tài khoản dev" — tạo
tài khoản `dev@vnlab.local` với role `project:admin`, không cần Logto.

## Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `PROJECT_DATABASE_URL` | ✓ | `postgres://postgres:postgres@localhost:5432/project` | |
| `PROJECT_JWT_SECRET` | ✓ (≥ 32 ký tự) | dev: giá trị cố định | Khoá ký cookie phiên `prj_session`. `deploy.sh` tự sinh |
| `PROJECT_LOGTO_APP_ID` | ✓ | `project` | Id app SPA Logto "VNLab Project" (output bootstrap repo Account) |
| `LOGTO_ENDPOINT` | | `https://auth.vnlab.id.vn` | |
| `PROJECT_ROLE_RECHECK_HOURS` | | `12` | |
| `ACCOUNT_SERVICE_TOKEN` | cho tab Quyền ứng dụng | — | Phải trùng bên VNLab Account; thiếu → `/api/service/rbac` trả 503 |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | cho Google Sheets | — | File JSON khoá service account (hoặc `GOOGLE_SERVICE_ACCOUNT_JSON` nội dung) |
| `PROJECT_SHEET_AUTO_DELAY_MS` | | `30000` | Gộp thay đổi trước khi tự đồng bộ |
| `PROJECT_DEV_LOGIN` | | — | `1` = bật đăng nhập dev (không có tác dụng ở production) |
| `PORT` | | `3400` | |

## Deploy

```bash
./deploy.sh          # đẩy mã nguồn, build trên VPS, dựng lại, cập nhật site trên Edge, cài timer sao lưu
./deploy.sh site     # chỉ cập nhật deploy/edge.caddy
```

Trên VPS project nằm ở `/home/ducnp/project` (`compose.yaml`, `backup.sh`, `src/`, `.env`).
**Lần đầu** (sau khi DNS Cloudflare `project.vnlab.id.vn` → VPS, proxy cam): chạy
`./scripts/rollout.sh` — deploy Account (catalog có `project`), bootstrap Logto ngay trong
container Account (tạo app "VNLab Project" + role `project:user`/`project:admin`, secret M2M
không rời VPS), ghi `PROJECT_LOGTO_APP_ID` và `ACCOUNT_SERVICE_TOKEN` vào `.env`, deploy
Project, deploy Landing, cấp `project:admin` cho các tài khoản `vnlab:admin`, rồi kiểm tra.
`./scripts/rollout.sh plan` chỉ in kế hoạch bootstrap; từng bước chạy riêng được
(`account | bootstrap | env | project | landing | grant | check`).

## Cấu trúc

```
server/index.ts        API + MCP + SPA (Hono)
server/data.ts         tầng dữ liệu dùng chung REST/MCP (quyền theo dự án, ghi dự án/nhóm/việc)
server/tools.ts        công cụ MCP cho AI
server/mcp.ts          MCP Streamable HTTP (@modelcontextprotocol/sdk)
server/db.ts           migration (users, projects, project_members, task_groups, tasks, rbac_*)
server/sso.ts          VNLab ID (Logto) code + PKCE, role gate
server/permissions.ts  danh mục quyền (giao diện import thẳng)
server/rbac.ts         quyền hiệu dụng + API dịch vụ cho Account
server/dates.ts        ngày công theo trọng số cuối tuần
server/plan-layout.ts  bố cục kế hoạch Gantt dùng chung cho Excel và Google Sheets
server/xlsx.ts         vẽ bố cục ra Excel (exceljs)
server/google.ts       Google API bằng service account
server/sheets.ts       đồng bộ sang Google Sheets (Sheets API batchUpdate), tự đồng bộ
src/components/Gantt.tsx   lưới ngày, thanh việc, kéo thả (dời ngày, đổi thứ tự trong nhóm), sửa tại chỗ, toàn màn hình
src/components/*Sheet.tsx  form việc / dự án / thành viên / dán từ bảng tính
src/lib/sheet.ts       phân tích TSV/CSV dán từ bảng tính
src/pages/             Tổng quan, Dự án, Chi tiết dự án, Cài đặt, Đăng nhập
deploy/                compose.yaml, edge.caddy, backup.sh
```
