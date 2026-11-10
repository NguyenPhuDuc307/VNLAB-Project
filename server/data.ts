// Tầng dữ liệu dùng chung cho REST (index.ts) và MCP (tools.ts): kiểm quyền theo
// dự án (chủ / được sửa / chỉ xem) và mọi lệnh ghi đều đi qua đây để hai đường
// không bao giờ lệch nhau. Lỗi ném ra là HTTPException (REST trả thẳng, MCP đổi
// thành thông báo cho AI).
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql } from './db.ts';
import { dayNumber, isDate, today, workDays } from './dates.ts';

export type UserRow = {
  id: string; logtoSub: string; email: string; name: string; avatar: string | null; appRoles: string[];
  consentAt: Date | null; consentVersion: string | null;
};
export type MemberRole = 'owner' | 'editor' | 'viewer';
export type ProjectRow = {
  id: string; ownerId: string; name: string; code: string; customer: string; description: string; startDate: string | null;
  color: string; satWeight: number; sunWeight: number; archived: boolean; createdAt: Date; updatedAt: Date;
  sheetId: string | null; sheetAuto: boolean; sheetSyncedAt: Date | null; sheetError: string | null;
  exportColumns: string[] | null;
};
export type Subtask = { id: string; name: string; assignee: string; progress: number };
export type TaskRow = {
  subtasks: Subtask[];
  id: string; projectId: string; groupId: string | null; name: string; assignee: string; support: string; progress: number;
  startDate: string | null; endDate: string | null; days: number | null; note: string; sort: number; createdAt: Date; updatedAt: Date;
  baselineStart: string | null; baselineEnd: string | null;
};

export const zId = z.uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải dạng YYYY-MM-DD').refine(isDate, 'Ngày không hợp lệ');
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Màu phải dạng #rrggbb');
export const zText = (max: number) => z.string().trim().max(max);
export const zWeight = z.union([z.literal(0), z.literal(0.5), z.literal(1)]);

export const notFound = () => new HTTPException(404, { message: 'Không tìm thấy' });
export const forbidden = (msg: string) => new HTTPException(403, { message: msg });
export const bad = (msg: string) => new HTTPException(400, { message: msg });

// ---------------------------------------------------------------- quyền theo dự án

/** Dự án + vai trò của tôi trong đó; không phải chủ/thành viên thì 404 (không lộ là dự án có tồn tại). */
export async function projectOf(user: Pick<UserRow, 'id' | 'email'>, id: string): Promise<ProjectRow & { myRole: MemberRole }> {
  if (!zId.safeParse(id).success) throw bad('Mã dự án không hợp lệ');
  const [p] = await sql<(ProjectRow & { myRole: MemberRole | null })[]>`
    select p.*, case when p.owner_id = ${user.id} then 'owner' else (
      select m.role from project_members m where m.project_id = p.id and (m.user_id = ${user.id} or lower(m.email) = ${user.email.toLowerCase()})
      order by m.user_id is null limit 1
    ) end as my_role
    from projects p where p.id = ${id}`;
  if (!p || !p.myRole) throw notFound();
  return p as ProjectRow & { myRole: MemberRole };
}

export const canEdit = (role: MemberRole) => role === 'owner' || role === 'editor';
export const editable = (p: { myRole: MemberRole }) => {
  if (!canEdit(p.myRole)) throw forbidden('Bạn chỉ được xem dự án này');
};
export const owned = (p: { myRole: MemberRole }) => {
  if (p.myRole !== 'owner') throw forbidden('Chỉ chủ dự án mới làm được việc này');
};
/** Phát khi dự án đổi (mọi lệnh ghi) — server/sheets.ts nghe để tự đồng bộ Google Sheet. */
export const projectEvents = new EventEmitter();
projectEvents.setMaxListeners(0); // mỗi tab đang mở dự án là một listener SSE
/** Ai đang ghi (web hay MCP) — đặt ở middleware / route, đọc lại trong touch() để báo cho giao diện biết nguồn thay đổi. */
export type Actor = { source: 'web' | 'mcp'; actor: string; actorId: string; action?: string };
export const actorContext = new AsyncLocalStorage<Actor>();
export const touch = async (projectId: string) => {
  await sql`update projects set updated_at = now() where id = ${projectId}`;
  projectEvents.emit('changed', projectId, actorContext.getStore() ?? null);
};

// ---------------------------------------------------------------- đọc

export const projectView = (p: ProjectRow) => ({
  id: p.id, ownerId: p.ownerId, name: p.name, code: p.code, customer: p.customer, description: p.description, startDate: p.startDate,
  color: p.color, satWeight: Number(p.satWeight), sunWeight: Number(p.sunWeight), archived: p.archived,
  createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(p.updatedAt).toISOString(),
  sheetId: p.sheetId ?? null, sheetUrl: p.sheetId ? `https://docs.google.com/spreadsheets/d/${p.sheetId}/edit` : null,
  sheetAuto: !!p.sheetAuto, sheetSyncedAt: p.sheetSyncedAt ? new Date(p.sheetSyncedAt).toISOString() : null, sheetError: p.sheetError ?? null,
  exportColumns: p.exportColumns ?? null,
});

export const taskView = (t: Record<string, unknown>) => ({
  id: t.id as string, projectId: t.projectId as string, groupId: (t.groupId as string | null) ?? null, name: t.name as string,
  subtasks: (t.subtasks ?? []) as Subtask[],
  assignee: t.assignee as string, support: t.support as string, progress: t.progress as number,
  startDate: (t.startDate as string | null) ?? null, endDate: (t.endDate as string | null) ?? null,
  days: t.days == null ? null : Number(t.days), note: t.note as string, sort: t.sort as number,
  /** Kế hoạch gốc (ngày lúc lập); khác ngày hiện tại = việc đã được dời / gia hạn. */
  baselineStart: (t.baselineStart as string | null) ?? null, baselineEnd: (t.baselineEnd as string | null) ?? null,
});

/** Chênh lệch kế hoạch so với gốc (ngày): dương = gia hạn / lùi, âm = rút ngắn / sớm hơn. */
export const planShift = (t: { startDate: string | null; endDate: string | null; baselineStart: string | null; baselineEnd: string | null }) => {
  if (!t.baselineEnd || !t.endDate) return null;
  const end = dayNumber(t.endDate) - dayNumber(t.baselineEnd);
  const start = t.startDate && t.baselineStart ? dayNumber(t.startDate) - dayNumber(t.baselineStart) : 0;
  return end === 0 && start === 0 ? null : { end, start };
};

/** Ngày công hiển thị: nhập tay thì lấy, không thì tính từ khoảng ngày theo trọng số dự án. */
export const effortOf = (t: { days: number | null; startDate: string | null; endDate: string | null }, p: { satWeight: number; sunWeight: number }) =>
  t.days != null ? t.days : t.startDate && t.endDate ? workDays(t.startDate, t.endDate, Number(p.satWeight), Number(p.sunWeight)) : 0;

export type Stats = { taskCount: number; doneCount: number; overdueCount: number; progress: number; firstStart: string | null; lastEnd: string | null };
export const statsOf = async (projectId: string): Promise<Stats> => {
  const [s] = await sql<Stats[]>`
    select count(*)::int as task_count,
           count(*) filter (where t.progress >= 100)::int as done_count,
           count(*) filter (where t.end_date < ${today()} and t.progress < 100)::int as overdue_count,
           coalesce(round(avg(t.progress)), 0)::int as progress,
           min(t.start_date) as first_start, max(t.end_date) as last_end
    from tasks t where t.project_id = ${projectId}`;
  return s;
};

/** Mọi dự án tôi là chủ hoặc được mời, kèm thống kê. */
export async function myProjects(u: Pick<UserRow, 'id' | 'email'>) {
  const rows = await sql<(ProjectRow & { myRole: MemberRole; ownerName: string; ownerEmail: string; memberCount: number })[]>`
    with mine as (
      select distinct on (x.id) x.* from (
        select p.*, 'owner'::text as my_role from projects p where p.owner_id = ${u.id}
        union all
        select p.*, m.role as my_role from projects p join project_members m on m.project_id = p.id
        where p.owner_id <> ${u.id} and (m.user_id = ${u.id} or lower(m.email) = ${u.email.toLowerCase()})
      ) x order by x.id, x.my_role
    )
    select mine.*, o.name as owner_name, o.email as owner_email,
      (select count(*)::int from project_members m where m.project_id = mine.id) as member_count
    from mine join users o on o.id = mine.owner_id
    order by mine.archived, mine.updated_at desc`;
  const out = [];
  for (const p of rows) out.push({ ...projectView(p), myRole: p.myRole, owner: { name: p.ownerName, email: p.ownerEmail }, memberCount: p.memberCount, stats: await statsOf(p.id) });
  return out;
}

export async function projectBundle(id: string) {
  const [p] = await sql<ProjectRow[]>`select * from projects where id = ${id}`;
  const groups = await sql<{ id: string; name: string; sort: number; collapsed: boolean }[]>`select id, name, sort, collapsed from task_groups where project_id = ${id} order by sort, created_at`;
  // Thứ tự hiển thị: theo nhóm (nhóm chưa phân xếp cuối), rồi thứ tự trong nhóm — cột STT khi xuất CSV cũng theo đây.
  const tasks = await sql`
    select t.* from tasks t left join task_groups g on g.id = t.group_id
    where t.project_id = ${id}
    order by (t.group_id is null), g.sort, g.created_at, t.sort, t.created_at`;
  return { ...projectView(p), groups, tasks: tasks.map(taskView) };
}

export async function projectMembers(p: ProjectRow) {
  const [owner] = await sql`select name, email, avatar from users where id = ${p.ownerId}`;
  const members = await sql`
    select m.email, m.role, m.user_id, m.created_at, u.name, u.avatar
    from project_members m left join users u on u.id = m.user_id
    where m.project_id = ${p.id} order by m.created_at`;
  return {
    owner: { name: owner.name as string, email: owner.email as string, avatar: (owner.avatar as string | null) ?? null },
    members: members.map((m) => ({ email: m.email as string, role: m.role as 'editor' | 'viewer', userId: (m.userId as string | null) ?? null, name: (m.name as string) ?? '', avatar: (m.avatar as string | null) ?? null, createdAt: new Date(m.createdAt as Date).toISOString() })),
  };
}

/** Tổng quan: dự án đang chạy, việc quá hạn và việc trong 7 ngày tới trong mọi dự án của tôi. */
export async function overview(u: Pick<UserRow, 'id' | 'email'>) {
  const projects = (await myProjects(u)).filter((p) => !p.archived);
  const ids = projects.map((p) => p.id);
  const t = today();
  const lists = ids.length ? await sql`
    select t.*, p.name as project_name, p.color as project_color
    from tasks t join projects p on p.id = t.project_id
    where t.project_id in ${sql(ids)} and t.progress < 100 and t.end_date is not null
      and t.end_date <= (${t}::date + 7)
    order by t.end_date, t.sort` : [];
  const view = (r: Record<string, unknown>) => ({ ...taskView(r), projectName: r.projectName as string, projectColor: r.projectColor as string });
  return {
    today: t,
    projects,
    overdue: lists.filter((r) => (r.endDate as string) < t).map(view),
    upcoming: lists.filter((r) => (r.endDate as string) >= t).map(view),
  };
}

/** Một việc kèm dự án chứa nó — 404 nếu không thấy hoặc không có quyền xem dự án. */
export async function taskOf(user: Pick<UserRow, 'id' | 'email'>, taskId: string) {
  if (!zId.safeParse(taskId).success) throw bad('Mã việc không hợp lệ');
  const [t] = await sql<TaskRow[]>`select * from tasks where id = ${taskId}`;
  if (!t) throw notFound();
  const p = await projectOf(user, t.projectId);
  return { task: t, project: p };
}

// ---------------------------------------------------------------- ghi: dự án

export const projectSchema = z.object({
  name: zText(160).min(1, 'Nhập tên dự án'),
  code: zText(40).default(''),
  customer: zText(160).default(''),
  description: zText(2000).default(''),
  startDate: zDate.nullable().default(null),
  color: zColor.default('#4274bc'),
  satWeight: zWeight.default(0.5),
  sunWeight: zWeight.default(0),
});
export type ProjectInput = z.infer<typeof projectSchema>;

export async function createProject(ownerId: string, b: ProjectInput) {
  const [p] = await sql<ProjectRow[]>`insert into projects ${sql({ ...b, ownerId })} returning *`;
  return p;
}

// ---------------------------------------------------------------- ghi: nhóm việc

export async function createGroup(projectId: string, name: string) {
  const [g] = await sql<{ id: string; name: string; sort: number; collapsed: boolean }[]>`
    insert into task_groups (project_id, name, sort)
    values (${projectId}, ${name}, (select coalesce(max(sort), -1) + 1 from task_groups where project_id = ${projectId}))
    returning id, name, sort, collapsed`;
  await touch(projectId);
  return g;
}

/** Nhóm theo tên (không phân biệt hoa thường), hoặc null. */
export async function findGroup(projectId: string, name: string) {
  const [g] = await sql<{ id: string; name: string }[]>`select id, name from task_groups where project_id = ${projectId} and lower(name) = ${name.trim().toLowerCase()} limit 1`;
  return g ?? null;
}

export async function groupBelongs(projectId: string, groupId: string | null | undefined) {
  if (!groupId) return;
  const [g] = await sql`select id from task_groups where id = ${groupId} and project_id = ${projectId}`;
  if (!g) throw bad('Nhóm không thuộc dự án này');
}

/** keepTasks: giữ lại việc trong nhóm (chuyển thành "chưa phân nhóm"); mặc định xoá cả việc. */
export async function deleteGroup(projectId: string, groupId: string, keepTasks: boolean) {
  await sql.begin(async (tx) => {
    if (keepTasks) await tx`update tasks set group_id = null where group_id = ${groupId} and project_id = ${projectId}`;
    const rows = await tx`delete from task_groups where id = ${groupId} and project_id = ${projectId} returning id`;
    if (!rows.length) throw notFound();
  });
  await touch(projectId);
}

// ---------------------------------------------------------------- ghi: việc

export const subtaskFields = z.strictObject({
  id: zId.optional(), name: zText(300).min(1), assignee: zText(160).default(''), progress: z.number().int().min(0).max(100).default(0),
});
const normalizeSubtasks = (items: z.infer<typeof subtaskFields>[]): Subtask[] => {
  const out = items.map((s) => ({ ...s, id: s.id ?? randomUUID() }));
  if (new Set(out.map((s) => s.id)).size !== out.length) throw bad('Mã task con bị trùng');
  return out;
};
const subtaskProgress = (items: Subtask[], fallback: number) => items.length ? Math.round(items.reduce((sum, s) => sum + s.progress, 0) / items.length) : fallback;
export const taskFields = z.object({
  subtasks: z.array(subtaskFields).max(100).optional(),
  groupId: zId.nullable(),
  name: zText(300).min(1, 'Nhập tên việc'),
  assignee: zText(160),
  support: zText(300),
  progress: z.number().int().min(0).max(100),
  startDate: zDate.nullable(),
  endDate: zDate.nullable(),
  days: z.number().min(0).max(9999).nullable(),
  note: zText(4000),
});
export const taskCreate = taskFields.partial({ groupId: true, assignee: true, support: true, progress: true, startDate: true, endDate: true, days: true, note: true });
export type TaskCreate = z.infer<typeof taskCreate>;
export type TaskPatch = Partial<z.infer<typeof taskFields>>;

export const checkDates = (t: { startDate?: string | null; endDate?: string | null }) => {
  if (t.startDate && t.endDate && t.endDate < t.startDate) throw bad('Ngày kết thúc phải từ ngày bắt đầu trở đi');
};

export async function insertTask(projectId: string, b: TaskCreate) {
  checkDates(b);
  await groupBelongs(projectId, b.groupId);
  const groupId = b.groupId ?? null;
  const both = !!(b.startDate && b.endDate);
  const subtasks = normalizeSubtasks(b.subtasks ?? []);
  const [t] = await sql`
    insert into tasks (project_id, group_id, name, assignee, support, progress, start_date, end_date, days, note, subtasks, baseline_start, baseline_end, sort)
    values (${projectId}, ${groupId}, ${b.name}, ${b.assignee ?? ''}, ${b.support ?? ''}, ${subtaskProgress(subtasks, b.progress ?? 0)}, ${b.startDate ?? null}, ${b.endDate ?? null}, ${b.days ?? null}, ${b.note ?? ''}, ${sql.json(subtasks)},
      ${both ? b.startDate! : null}, ${both ? b.endDate! : null},
      (select coalesce(max(sort), -1) + 1 from tasks where project_id = ${projectId} and group_id is not distinct from ${groupId}))
    returning *`;
  await touch(projectId);
  return taskView(t);
}

/** Trường được ghi lịch sử khi đổi. */
const TRACKED: (keyof TaskPatch)[] = ['name', 'groupId', 'assignee', 'support', 'progress', 'startDate', 'endDate', 'days', 'note', 'subtasks'];
const asText = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function updateTask(projectId: string, taskId: string, b: TaskPatch, actorId: string | null = null) {
  if (!Object.keys(b).length) throw bad('Không có gì để sửa');
  if (b.groupId !== undefined) await groupBelongs(projectId, b.groupId);
  const t = await sql.begin(async (tx) => {
    const [cur] = await tx<TaskRow[]>`select * from tasks where id = ${taskId} and project_id = ${projectId} for update`;
    if (!cur) throw notFound();
    const subtasks = normalizeSubtasks(b.subtasks ?? cur.subtasks ?? []);
    const update = { ...b, progress: subtaskProgress(subtasks, b.progress ?? cur.progress), ...(b.subtasks !== undefined ? { subtasks } : {}) };
    const next = { ...cur, ...update };
    checkDates(next);
    const changes = TRACKED.filter((k) => k in update && asText((cur as Record<string, unknown>)[k]) !== asText(update[k]));
    const patch: Record<string, unknown> = { ...update, updatedAt: new Date() };
    if (b.subtasks !== undefined) patch.subtasks = tx.json(subtasks);
    if (!cur.baselineStart && !cur.baselineEnd && next.startDate && next.endDate) { patch.baselineStart = next.startDate; patch.baselineEnd = next.endDate; }
    const [row] = await tx`update tasks set ${tx(patch)} where id = ${taskId} returning *`;
    for (const k of changes) {
      await tx`insert into task_history (task_id, project_id, user_id, field, old_value, new_value) values (${taskId}, ${projectId}, ${actorId}, ${k}, ${asText((cur as Record<string, unknown>)[k])}, ${asText(update[k])})`;
    }
    return row;
  });
  await touch(projectId);
  return taskView(t);
}

/** Lấy ngày hiện tại làm kế hoạch gốc mới (sau khi đã thống nhất điều chỉnh). */
export async function rebaselineTask(projectId: string, taskId: string, actorId: string | null = null) {
  const [cur] = await sql<TaskRow[]>`select * from tasks where id = ${taskId} and project_id = ${projectId}`;
  if (!cur) throw notFound();
  if (!cur.startDate || !cur.endDate) throw bad('Việc chưa có đủ ngày bắt đầu và kết thúc');
  const t = await sql.begin(async (tx) => {
    const [row] = await tx`update tasks set baseline_start = ${cur.startDate}, baseline_end = ${cur.endDate}, updated_at = now() where id = ${taskId} returning *`;
    await tx`insert into task_history (task_id, project_id, user_id, field, old_value, new_value) values (${taskId}, ${projectId}, ${actorId}, 'baseline', ${cur.baselineStart && cur.baselineEnd ? `${cur.baselineStart}..${cur.baselineEnd}` : null}, ${`${cur.startDate}..${cur.endDate}`})`;
    return row;
  });
  await touch(projectId);
  return taskView(t);
}

export type HistoryRow = { id: number; at: string; field: string; oldValue: string | null; newValue: string | null; user: string | null };
export async function taskHistory(projectId: string, taskId: string, limit = 100): Promise<HistoryRow[]> {
  const rows = await sql`
    select h.id, h.at, h.field, h.old_value, h.new_value, u.name as user_name, u.email as user_email
    from task_history h left join users u on u.id = h.user_id
    where h.task_id = ${taskId} and h.project_id = ${projectId}
    order by h.at desc, h.id desc limit ${limit}`;
  return rows.map((r) => ({ id: Number(r.id), at: new Date(r.at).toISOString(), field: r.field as string, oldValue: (r.oldValue as string | null) ?? null, newValue: (r.newValue as string | null) ?? null, user: (r.userName as string) || (r.userEmail as string) || null }));
}

export async function deleteTask(projectId: string, taskId: string) {
  const rows = await sql`delete from tasks where id = ${taskId} and project_id = ${projectId} returning id`;
  if (!rows.length) throw notFound();
  await touch(projectId);
}

/** Sắp xếp lại việc trong một nhóm; việc chuyển từ nhóm khác sang cũng đi qua đây. */
export async function reorderTasks(projectId: string, groupId: string | null, ids: string[]) {
  await groupBelongs(projectId, groupId);
  await sql.begin(async (tx) => {
    for (const [i, id] of ids.entries()) await tx`update tasks set group_id = ${groupId}, sort = ${i} where id = ${id} and project_id = ${projectId}`;
  });
  await touch(projectId);
}

/** Sắp xếp việc trong nhóm theo ngày bắt đầu (trống xếp cuối), rồi kết thúc, rồi tên. groupId undefined = mọi nhóm. */
// ---------------------------------------------------------------- dùng chung REST / MCP: dự án, thành viên, nhóm

/** Sửa thông tin dự án (đã kiểm quyền ở nơi gọi). Phát `changed` để giao diện / Google Sheet cập nhật. */
export async function updateProject(p: ProjectRow & { myRole: MemberRole }, patch: Record<string, unknown>) {
  if (!Object.keys(patch).length) return p;
  const [row] = await sql<ProjectRow[]>`update projects set ${sql({ ...patch, updatedAt: new Date() })} where id = ${p.id} returning *`;
  projectEvents.emit('changed', p.id, actorContext.getStore() ?? null);
  return { ...row, myRole: p.myRole };
}

/** Mời / đổi vai trò thành viên theo email (chỉ chủ dự án). */
export async function upsertMember(p: ProjectRow, email: string, role: 'editor' | 'viewer', invitedBy: string) {
  email = email.trim().toLowerCase();
  const [owner] = await sql`select email from users where id = ${p.ownerId}`;
  if (owner.email.toLowerCase() === email) throw bad('Đây là chủ dự án rồi');
  const [existing] = await sql`select id from users where lower(email) = ${email} order by last_login_at desc nulls last limit 1`;
  await sql`
    insert into project_members (project_id, email, user_id, role, invited_by) values (${p.id}, ${email}, ${existing?.id ?? null}, ${role}, ${invitedBy})
    on conflict (project_id, email) do update set role = excluded.role`;
  await touch(p.id);
  return { email, role, known: !!existing };
}

export async function setMemberRole(p: ProjectRow, email: string, role: 'editor' | 'viewer') {
  const rows = await sql`update project_members set role = ${role} where project_id = ${p.id} and lower(email) = ${email.trim().toLowerCase()} returning email`;
  if (!rows.length) throw notFound();
  await touch(p.id);
}

export async function removeMember(p: ProjectRow, email: string, selfId?: string) {
  const e = email.trim().toLowerCase();
  const rows = await sql`delete from project_members where project_id = ${p.id} and (lower(email) = ${e} ${selfId ? sql`or user_id = ${selfId}` : sql``}) returning email`;
  if (!rows.length) throw notFound();
  await touch(p.id);
}

/** Đổi tên / thu gọn nhóm. Chỉ đổi tên mới phát `changed` (thu gọn là trạng thái hiển thị). */
export async function updateGroup(projectId: string, groupId: string, patch: { name?: string; collapsed?: boolean }) {
  const [g] = await sql`update task_groups set ${sql(patch)} where id = ${groupId} and project_id = ${projectId} returning id, name, sort, collapsed`;
  if (!g) throw notFound();
  if (patch.name !== undefined) await touch(projectId);
  return g as { id: string; name: string; sort: number; collapsed: boolean };
}

export async function deleteProject(projectId: string) {
  await sql`delete from projects where id = ${projectId}`;
  projectEvents.emit('changed', projectId, actorContext.getStore() ?? null);
}

export async function reorderGroups(projectId: string, ids: string[]) {
  await sql.begin(async (tx) => {
    for (const [i, id] of ids.entries()) await tx`update task_groups set sort = ${i} where id = ${id} and project_id = ${projectId}`;
  });
  await touch(projectId);
}

export async function sortTasksByDate(projectId: string, groupId?: string | null) {
  const groups: (string | null)[] = groupId === undefined
    ? [...(await sql<{ id: string }[]>`select id from task_groups where project_id = ${projectId}`).map((g) => g.id), null]
    : [groupId];
  let moved = 0;
  await sql.begin(async (tx) => {
    for (const g of groups) {
      const rows = await tx<{ id: string; sort: number }[]>`
        select id, sort from tasks where project_id = ${projectId} and group_id is not distinct from ${g}
        order by start_date asc nulls last, end_date asc nulls last, lower(name), created_at`;
      // Chỉ đếm việc thật sự đổi chỗ (so với thứ tự hiện tại), còn sort vẫn được đánh lại liền mạch.
      const current = [...rows].sort((x, y) => x.sort - y.sort).map((r) => r.id);
      for (const [i, r] of rows.entries()) {
        if (current[i] !== r.id) moved++;
        if (r.sort !== i) await tx`update tasks set sort = ${i} where id = ${r.id}`;
      }
    }
    // Sắp xếp tất cả: các nhóm cũng xếp theo ngày bắt đầu sớm nhất của việc trong nhóm (nhóm trống xếp cuối).
    if (groupId === undefined) {
      const gs = await tx<{ id: string; sort: number }[]>`
        select g.id, g.sort from task_groups g left join tasks t on t.group_id = g.id
        where g.project_id = ${projectId}
        group by g.id, g.sort
        order by min(coalesce(t.start_date, t.end_date)) asc nulls last, max(coalesce(t.end_date, t.start_date)) asc nulls last, g.sort`;
      const current = [...gs].sort((x, y) => x.sort - y.sort).map((g) => g.id);
      for (const [i, g] of gs.entries()) {
        if (current[i] !== g.id) moved++;
        if (g.sort !== i) await tx`update task_groups set sort = ${i} where id = ${g.id}`;
      }
    }
  });
  if (moved) await touch(projectId);
  return { groups: groups.length, moved };
}

export type ImportGroup = { name: string | null; tasks: Omit<TaskCreate, 'groupId'>[] };

/** Nhập hàng loạt: nhóm trùng tên thì thêm việc vào nhóm đó, chưa có thì tạo. */
export async function importGroups(projectId: string, groups: ImportGroup[]) {
  let created = 0, tasks = 0;
  await sql.begin(async (tx) => {
    for (const g of groups) {
      let groupId: string | null = null;
      if (g.name) {
        const [found] = await tx`select id from task_groups where project_id = ${projectId} and lower(name) = ${g.name.trim().toLowerCase()}`;
        if (found) groupId = found.id;
        else {
          const [row] = await tx`
            insert into task_groups (project_id, name, sort)
            values (${projectId}, ${g.name.trim()}, (select coalesce(max(sort), -1) + 1 from task_groups where project_id = ${projectId})) returning id`;
          groupId = row.id;
          created++;
        }
      }
      for (const t of g.tasks) {
        checkDates(t);
        const both = !!(t.startDate && t.endDate);
        const subtasks = normalizeSubtasks(t.subtasks ?? []);
        await tx`
          insert into tasks (project_id, group_id, name, assignee, support, progress, start_date, end_date, days, note, subtasks, baseline_start, baseline_end, sort)
          values (${projectId}, ${groupId}, ${t.name}, ${t.assignee ?? ''}, ${t.support ?? ''}, ${subtaskProgress(subtasks, t.progress ?? 0)}, ${t.startDate ?? null}, ${t.endDate ?? null}, ${t.days ?? null}, ${t.note ?? ''}, ${tx.json(subtasks)},
            ${both ? t.startDate! : null}, ${both ? t.endDate! : null},
            (select coalesce(max(sort), -1) + 1 from tasks where project_id = ${projectId} and group_id is not distinct from ${groupId}))`;
        tasks++;
      }
    }
  });
  await touch(projectId);
  return { groups: created, tasks };
}
