import postgres from 'postgres';

const DATABASE_URL = process.env.PROJECT_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/project';

// numeric -> number, date -> 'YYYY-MM-DD' (không để thành Date rồi lệch múi giờ).
const types = {
  numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
};

function connect(url: string) {
  return postgres(url, { max: Number(process.env.PROJECT_DB_POOL ?? 8), idle_timeout: 30, transform: postgres.camel, types, onnotice: () => {} });
}

export let sql = connect(DATABASE_URL);

// Database `project` là Postgres riêng của stack này (service `db` trong
// deploy/compose.yaml). Lần chạy đầu nó có thể chưa có, nên tự tạo qua database
// bảo trì `postgres` thay vì bắt người deploy nhớ thêm một bước tay.
async function ensureDatabase() {
  try {
    await sql`select 1`;
  } catch (err) {
    if ((err as { code?: string }).code !== '3D000') throw err;
    const url = new URL(DATABASE_URL);
    const name = url.pathname.slice(1);
    url.pathname = '/postgres';
    const admin = connect(url.toString());
    await admin.unsafe(`create database "${name.replace(/"/g, '')}"`);
    await admin.end();
    await sql.end();
    sql = connect(DATABASE_URL);
    console.log(`[db] đã tạo database ${name}`);
  }
}

// Mỗi phần tử là một bước migration, chỉ được THÊM vào cuối — không sửa bước cũ.
const MIGRATIONS: string[] = [
  // 1: tài khoản (chỉ qua VNLab ID), dự án, thành viên, nhóm việc, việc, phân quyền.
  `
  create table users (
    id uuid primary key default gen_random_uuid(),
    logto_sub text not null unique,
    email text not null,
    name text not null default '',
    avatar text,
    -- Role Logto project:* chụp lúc đăng nhập VNLab ID (server/rbac.ts).
    app_roles text[] not null default '{}',
    -- Bằng chứng đồng ý xử lý dữ liệu cá nhân (Luật 91/2025/QH15, Điều 9).
    consent_at timestamptz,
    consent_version text,
    created_at timestamptz not null default now(),
    last_login_at timestamptz
  );
  create index on users(lower(email));

  create table projects (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references users(id) on delete cascade,
    name text not null,
    code text not null default '',
    customer text not null default '',
    description text not null default '',
    start_date date,
    color text not null default '#c74a1c',
    -- Trọng số ngày công cuối tuần khi tính cột "Ngày": T7 nửa ngày, CN nghỉ.
    sat_weight numeric(2,1) not null default 0.5 check (sat_weight in (0, 0.5, 1)),
    sun_weight numeric(2,1) not null default 0 check (sun_weight in (0, 0.5, 1)),
    archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index on projects(owner_id);

  -- Mời theo email VNLab ID: user_id gắn khi người đó đăng nhập Project lần đầu
  -- (hoặc ngay lúc mời nếu đã có tài khoản).
  create table project_members (
    project_id uuid not null references projects(id) on delete cascade,
    email text not null,
    user_id uuid references users(id) on delete cascade,
    role text not null check (role in ('editor', 'viewer')),
    invited_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    primary key (project_id, email)
  );
  create index on project_members(user_id);
  create index on project_members(email);

  create table task_groups (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    name text not null,
    sort int not null default 0,
    collapsed boolean not null default false,
    created_at timestamptz not null default now()
  );
  create index on task_groups(project_id, sort);

  create table tasks (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    group_id uuid references task_groups(id) on delete cascade,
    name text not null,
    assignee text not null default '',
    support text not null default '',
    progress int not null default 0 check (progress between 0 and 100),
    start_date date,
    end_date date,
    -- Ngày công ước tính; null = tự tính từ khoảng ngày theo trọng số của dự án.
    days numeric(6,1) check (days >= 0),
    note text not null default '',
    sort int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (start_date is null or end_date is null or end_date >= start_date)
  );
  create index on tasks(project_id, group_id, sort);
  create index on tasks(project_id, end_date);

  -- Phân quyền theo tính năng, quản lý ở VNLab Account (server/rbac.ts).
  -- Chỉ chứa role sửa được — project:admin khoá cứng = mọi quyền, không lưu.
  create table rbac_roles (
    role text primary key,
    permissions text[] not null default '{}',
    updated_at timestamptz
  );
  insert into rbac_roles (role, permissions) values ('project:user', array[
    'project.project.create', 'project.project.write', 'project.project.delete',
    'project.task.write', 'project.task.delete',
    'project.data.export', 'project.data.import',
    'project.settings.write'
  ]);

  create table rbac_audit (
    id bigserial primary key,
    at timestamptz not null default now(),
    actor_sub text not null,
    actor_email text,
    role text not null,
    added text[] not null default '{}',
    removed text[] not null default '{}'
  );
  create index on rbac_audit(at desc);
  `,
  // 2: token MCP cá nhân (vpj_…) cho AI bên ngoài — chỉ lưu băm SHA-256; quyền
  // project.tokens.manage cấp sẵn cho project:user.
  `
  create table api_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    name text not null,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  );
  create index on api_tokens(user_id);
  update rbac_roles set permissions = array_append(permissions, 'project.tokens.manage')
    where role = 'project:user' and not ('project.tokens.manage' = any(permissions));
  `,
  // 3: liên kết Google Sheet (đồng bộ một chiều app -> sheet, server/sheets.ts).
  `
  alter table projects add column sheet_id text;
  alter table projects add column sheet_auto boolean not null default false;
  alter table projects add column sheet_synced_at timestamptz;
  alter table projects add column sheet_error text;
  `,
  // 4: tông màu nhận diện đổi sang xanh xám đá; dự án còn màu mặc định cũ (cam) đổi theo.
  `
  alter table projects alter column color set default '#3f5a80';
  update projects set color = '#3f5a80' where color = '#c74a1c';
  `,
  // 5: kế hoạch gốc (ngày lúc lập, để thấy việc bị gia hạn / dời) và lịch sử thay đổi từng việc.
  `
  alter table tasks add column baseline_start date;
  alter table tasks add column baseline_end date;
  update tasks set baseline_start = start_date, baseline_end = end_date where start_date is not null and end_date is not null;

  create table task_history (
    id bigserial primary key,
    task_id uuid not null references tasks(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    user_id uuid references users(id) on delete set null,
    at timestamptz not null default now(),
    field text not null,
    old_value text,
    new_value text
  );
  create index on task_history(task_id, at desc);
  `,
  // (6) cột xuất / đồng bộ theo dự án — LỖI THỨ TỰ: bước này bị chèn vào giữa khi DB đã ở
  // version 6 nên không chạy trên DB có sẵn; giữ lại cho DB mới, bước 8 bên dưới bù lại
  // (idempotent). Bài học: chỉ THÊM migration vào cuối danh sách.
  `alter table projects add column if not exists export_columns text[];`,
  // 6: màu nhận diện sáng hơn (xanh thép); dự án đang màu mặc định cũ đổi theo.
  `
  alter table projects alter column color set default '#4274bc';
  update projects set color = '#4274bc' where color in ('#3f5a80', '#c74a1c');
  `,
  // 8: bù cột export_columns cho DB đã qua version 6 trước khi bước (6) được thêm.
  `alter table projects add column if not exists export_columns text[];`,
  // 9: đầu việc con chỉ có người phụ trách và tiến độ; lịch thuộc task cha.
  `alter table tasks add column subtasks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(subtasks) = 'array');`,
  // 10: dự án đã liên kết Google Sheet thì tự đồng bộ sau mỗi thay đổi (kể cả qua MCP); liên kết mới mặc định bật.
  `update projects set sheet_auto = true where sheet_id is not null and sheet_auto = false;`,
  // 11: phạm vi (tag) theo dự án — màu, người phụ trách (điền tay); mỗi việc gắn tối đa một phạm vi.
  //     Hướng dẫn / ngữ cảnh cho AI (MCP) lưu theo dự án.
  `
  create table scopes (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    name text not null,
    color text not null default '#4274bc',
    owner text not null default '',
    note text not null default '',
    sort int not null default 0,
    created_at timestamptz not null default now()
  );
  create unique index scopes_project_name on scopes (project_id, lower(name));
  alter table tasks add column scope_id uuid references scopes(id) on delete set null;
  create index on tasks (scope_id);
  alter table projects add column ai_context text not null default '';
  `,
  // 12: đồng bộ sang Getfly CRM — cấu hình theo dự án (việc cha, tên dự án Getfly, ghép tên người -> username)
  //     và liên kết từng việc / task con với mã việc bên Getfly.
  `
  alter table projects
    add column getfly_parent_code text not null default '',
    add column getfly_parent_name text not null default '',
    add column getfly_project_name text not null default '',
    add column getfly_users jsonb not null default '{}'::jsonb,
    add column getfly_synced_at timestamptz,
    add column getfly_error text;
  create table getfly_links (
    project_id uuid not null references projects(id) on delete cascade,
    local_id text not null,
    parent_local text,
    getfly_code text not null,
    getfly_id bigint,
    hash text not null default '',
    completed boolean not null default false,
    synced_at timestamptz not null default now(),
    primary key (project_id, local_id)
  );
  `,
  // 13: Getfly của ACS chạy API v3 — việc cha / dự án / người tạo / người nhận đều theo id số.
  `
  alter table projects
    add column getfly_parent_id bigint,
    add column getfly_project_id text not null default '',
    add column getfly_creator_id text not null default '';
  `,
  // 14: nhóm việc (danh mục) gắn sẵn với một việc có trên Getfly: { groupId: { id, code, name } }; nhóm không gắn thì app tự tạo.
  `alter table projects add column getfly_groups jsonb not null default '{}'::jsonb;`,
  // 15: lựa chọn thu gọn task con khi đồng bộ sang Google Sheets, riêng theo dự án.
  `alter table projects add column sheet_collapse_subtasks boolean not null default true;`,
  // 16: phase trong dự án (VD AMMS Tháng 10 / Tháng 11) — dùng chung cấu hình dự án (thành viên, phạm vi, nhóm, AI, Getfly…);
  //     mỗi việc thuộc tối đa một phase. Nhóm việc (danh mục) dùng chung giữa các phase.
  `
  create table phases (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    name text not null,
    start_date date,
    end_date date,
    note text not null default '',
    sort int not null default 0,
    created_at timestamptz not null default now()
  );
  create unique index phases_project_name on phases (project_id, lower(name));
  alter table tasks add column phase_id uuid references phases(id) on delete set null;
  create index on tasks (phase_id);
  `,
  // 17: bỏ hẳn đồng bộ trạng thái hoàn thành sang Getfly (API không cho) — cột không còn dùng.
  `alter table getfly_links drop column if exists completed;`,
  // 18: liên kết Google Calendar (đồng bộ một chiều app -> lịch, server/gcal.ts): mỗi việc có ngày là một sự kiện cả ngày.
  `
  alter table projects
    add column gcal_id text,
    add column gcal_synced_at timestamptz,
    add column gcal_error text;
  `,
  // 19: ghi chú của việc mặc định là nội bộ; chỉ việc được tích mới gửi ghi chú lên mô tả việc Getfly.
  `alter table tasks add column getfly_note boolean not null default false;`,
  // 20: việc cha của việc (một cấp, cùng nhóm) — trên Getfly việc con nằm dưới việc cha thay vì dưới việc cha của nhóm.
  `
  alter table tasks add column parent_task_id uuid references tasks(id) on delete set null;
  create index on tasks (parent_task_id);
  `,
  // 21: đánh dấu liên kết "nhận việc có sẵn" (việc người dùng tự tạo trên Getfly) — app không bao giờ xoá các việc này.
  // Các liên kết do lượt nhận việc AMMS 25/11/2026 tạo ra trước khi có cột: đánh dấu theo danh sách mã cố định.
  `
  alter table getfly_links add column adopted boolean not null default false;
  update getfly_links set adopted = true where getfly_code in (
    'CVI/2026-11/009102', 'CVI/2026-11/009121', 'CVI/2026-11/009122', 'CVI/2026-11/009124',
    'CVI/2026-11/009125', 'CVI/2026-11/009129', 'CVI/2026-11/009130', 'CVI/2026-11/009131'
  );
  `,
];

export async function migrate() {
  await ensureDatabase();
  await sql`create table if not exists schema_version (version int not null)`;
  const [row] = await sql<{ version: number }[]>`select version from schema_version`;
  let version = row?.version ?? 0;
  if (!row) await sql`insert into schema_version values (0)`;
  for (; version < MIGRATIONS.length; version++) {
    await sql.begin(async (tx) => {
      await tx.unsafe(MIGRATIONS[version]);
      await tx`update schema_version set version = ${version + 1}`;
    });
    console.log(`[db] migration ${version + 1} xong`);
  }
}
