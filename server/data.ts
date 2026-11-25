// Tầng dữ liệu dùng chung cho REST (index.ts) và MCP (tools.ts): kiểm quyền theo
// dự án (chủ / được sửa / chỉ xem) và mọi lệnh ghi đều đi qua đây để hai đường
// không bao giờ lệch nhau. Lỗi ném ra là HTTPException (REST trả thẳng, MCP đổi
// thành thông báo cho AI).
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type postgres from 'postgres';
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
  sheetId: string | null; sheetAuto: boolean; sheetCollapseSubtasks: boolean; sheetSyncedAt: Date | null; sheetError: string | null;
  gcalId: string | null; gcalSyncedAt: Date | null; gcalError: string | null;
  exportColumns: string[] | null;
  aiContext: string;
  getflyParentCode: string; getflyParentName: string; getflyProjectName: string; getflyUsers: Record<string, string>;
  getflySyncedAt: Date | null; getflyError: string | null;
  getflyParentId: number | null; getflyProjectId: string; getflyCreatorId: string;
  getflyGroups: Record<string, { id: number; code: string; name: string; projectId?: string; projectName?: string }>;
};
export type Subtask = { id: string; name: string; assignee: string; progress: number };
export type TaskRow = {
  subtasks: Subtask[];
  id: string; projectId: string; groupId: string | null; name: string; assignee: string; support: string; progress: number;
  startDate: string | null; endDate: string | null; days: number | null; note: string; getflyNote: boolean; sort: number; createdAt: Date; updatedAt: Date;
  baselineStart: string | null; baselineEnd: string | null;
  scopeId: string | null;
  phaseId: string | null;
  /** Việc cha (cùng dự án, cùng nhóm, chỉ một cấp). */
  parentTaskId: string | null;
};
export type PhaseRow = { id: string; name: string; startDate: string | null; endDate: string | null; note: string; sort: number };
export type ScopeRow = { id: string; name: string; color: string; owner: string; note: string; sort: number };

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
  noteSeen(id);
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
export type Actor = { source: 'web' | 'mcp'; actor: string; actorId: string; action?: string; seen?: Set<string>; emitted?: Set<string> };
export const actorContext = new AsyncLocalStorage<Actor>();
/** Phần của Actor gửi ra giao diện (bỏ các tập theo dõi nội bộ). */
export const actorPublic = (a: Actor | null) => (a ? { source: a.source, actor: a.actor, actorId: a.actorId, action: a.action } : {});
/** Phát `changed` và ghi nhận đã phát cho dự án này trong lệnh hiện tại (MCP dùng để bảo đảm lệnh ghi nào cũng báo). */
export function emitChanged(projectId: string, extra?: { deleted?: boolean; audience?: { name: string; userIds: string[] } | null }) {
  const ctx = actorContext.getStore();
  if (ctx) (ctx.emitted ??= new Set()).add(projectId);
  projectEvents.emit('changed', projectId, ctx ?? null, extra);
}
/** Ghi nhận dự án lệnh hiện tại đã chạm tới (projectOf / tạo mới). */
const noteSeen = (projectId: string) => { const ctx = actorContext.getStore(); if (ctx) (ctx.seen ??= new Set()).add(projectId); };
export const touch = async (projectId: string) => {
  await sql`update projects set updated_at = now() where id = ${projectId}`;
  emitChanged(projectId);
};

// ---------------------------------------------------------------- đọc

export const projectView = (p: ProjectRow) => ({
  id: p.id, ownerId: p.ownerId, name: p.name, code: p.code, customer: p.customer, description: p.description, startDate: p.startDate,
  color: p.color, satWeight: Number(p.satWeight), sunWeight: Number(p.sunWeight), archived: p.archived,
  createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(p.updatedAt).toISOString(),
  sheetId: p.sheetId ?? null, sheetUrl: p.sheetId ? `https://docs.google.com/spreadsheets/d/${p.sheetId}/edit` : null,
  sheetAuto: !!p.sheetAuto, sheetCollapseSubtasks: p.sheetCollapseSubtasks ?? true, sheetSyncedAt: p.sheetSyncedAt ? new Date(p.sheetSyncedAt).toISOString() : null, sheetError: p.sheetError ?? null,
  gcalId: p.gcalId ?? null, gcalUrl: p.gcalId ? `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(p.gcalId)}` : null,
  gcalSyncedAt: p.gcalSyncedAt ? new Date(p.gcalSyncedAt).toISOString() : null, gcalError: p.gcalError ?? null,
  exportColumns: p.exportColumns ?? null,
  aiContext: p.aiContext ?? '',
  getflyParentCode: p.getflyParentCode ?? '', getflyParentName: p.getflyParentName ?? '', getflyProjectName: p.getflyProjectName ?? '',
  getflyUsers: (p.getflyUsers ?? {}) as Record<string, string>,
  getflySyncedAt: p.getflySyncedAt ? new Date(p.getflySyncedAt).toISOString() : null, getflyError: p.getflyError ?? null,
  getflyParentId: p.getflyParentId == null ? null : Number(p.getflyParentId), getflyProjectId: p.getflyProjectId ?? '', getflyCreatorId: p.getflyCreatorId ?? '',
  getflyGroups: (p.getflyGroups ?? {}) as ProjectRow['getflyGroups'],
});

export const taskView = (t: Record<string, unknown>) => ({
  id: t.id as string, projectId: t.projectId as string, groupId: (t.groupId as string | null) ?? null, name: t.name as string,
  scopeId: (t.scopeId as string | null) ?? null,
  phaseId: (t.phaseId as string | null) ?? null,
  /** Việc cha cùng nhóm (một cấp); null = việc gốc của nhóm. */
  parentTaskId: (t.parentTaskId as string | null) ?? null,
  subtasks: (t.subtasks ?? []) as Subtask[],
  assignee: t.assignee as string, support: t.support as string, progress: t.progress as number,
  startDate: (t.startDate as string | null) ?? null, endDate: (t.endDate as string | null) ?? null,
  days: t.days == null ? null : Number(t.days), note: t.note as string, sort: t.sort as number,
  /** Gửi ghi chú lên mô tả việc Getfly (mặc định ghi chú là nội bộ). */
  getflyNote: t.getflyNote === true,
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
  const scopes = await sql<ScopeRow[]>`select id, name, color, owner, note, sort from scopes where project_id = ${id} order by sort, created_at`;
  const phases = await sql<PhaseRow[]>`select id, name, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, note, sort from phases where project_id = ${id} order by sort, start_date nulls last, created_at`;
  return { ...projectView(p), groups, scopes, phases, tasks: tasks.map(taskView) };
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

/** Lịch chung: mọi việc có ngày ở các dự án đang chạy mà tôi thấy được, kèm màu / mã / quyền của dự án. */
export async function calendar(u: Pick<UserRow, 'id' | 'email'>) {
  const projects = (await myProjects(u)).filter((p) => !p.archived);
  const ids = projects.map((p) => p.id);
  const rows = ids.length ? await sql`
    select t.* from tasks t left join task_groups g on g.id = t.group_id
    where t.project_id in ${sql(ids)} and (t.start_date is not null or t.end_date is not null)
    order by (t.group_id is null), g.sort, t.sort, t.created_at` : [];
  const groups = ids.length ? await sql<{ id: string; name: string }[]>`select id, name from task_groups where project_id in ${sql(ids)}` : [];
  return {
    today: today(),
    projects: projects.map((p) => ({ id: p.id, name: p.name, code: p.code, color: p.color, myRole: p.myRole })),
    groups: Object.fromEntries(groups.map((g) => [g.id, g.name])) as Record<string, string>,
    tasks: rows.map(taskView),
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
  emitChanged(p.id);
  return p;
}

// ---------------------------------------------------------------- ghi: nhóm việc

type GetflyGroupParent = ProjectRow['getflyGroups'][string];

export async function createGroup(projectId: string, name: string, getflyParent?: GetflyGroupParent | null) {
  const g = await sql.begin(async (tx) => {
    const [g] = await tx<{ id: string; name: string; sort: number; collapsed: boolean }[]>`
      insert into task_groups (project_id, name, sort)
      values (${projectId}, ${name}, (select coalesce(max(sort), -1) + 1 from task_groups where project_id = ${projectId}))
      returning id, name, sort, collapsed`;
    if (getflyParent) await tx`update projects set getfly_groups = coalesce(getfly_groups, '{}'::jsonb) || ${tx.json({ [g.id]: getflyParent })}::jsonb where id = ${projectId}`;
    return g;
  });
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
  scopeId: zId.nullable(),
  phaseId: zId.nullable(),
  parentTaskId: zId.nullable(),
  name: zText(300).min(1, 'Nhập tên việc'),
  assignee: zText(160),
  support: zText(300),
  progress: z.number().int().min(0).max(100),
  startDate: zDate.nullable(),
  endDate: zDate.nullable(),
  days: z.number().min(0).max(9999).nullable(),
  note: zText(4000),
  getflyNote: z.boolean(),
});
export const taskCreate = taskFields.partial({ phaseId: true, scopeId: true, groupId: true, parentTaskId: true, assignee: true, support: true, progress: true, startDate: true, endDate: true, days: true, note: true, getflyNote: true });
export type TaskCreate = z.infer<typeof taskCreate>;
export type TaskPatch = Partial<z.infer<typeof taskFields>>;

/** Việc cha hợp lệ: cùng dự án, cùng nhóm, không phải chính nó, bản thân không có cha, và việc này chưa có việc con (chỉ một cấp). */
type Tx = postgres.TransactionSql<{ numeric: number; date: string }>;
async function checkParent(db: Tx, projectId: string, taskId: string | null, groupId: string | null, parentId: string | null | undefined) {
  if (!parentId) return;
  if (parentId === taskId) throw bad('Việc không thể là việc cha của chính nó');
  const [parent] = await db<{ groupId: string | null; parentTaskId: string | null }[]>`select group_id, parent_task_id from tasks where id = ${parentId} and project_id = ${projectId}`;
  if (!parent) throw bad('Việc cha không thuộc dự án này');
  if ((parent.groupId ?? null) !== (groupId ?? null)) throw bad('Việc cha phải cùng nhóm');
  if (parent.parentTaskId) throw bad('Việc cha đã là việc con của việc khác (chỉ một cấp)');
  if (taskId) {
    const [child] = await db`select id from tasks where parent_task_id = ${taskId} limit 1`;
    if (child) throw bad('Việc này đang có việc con nên không gắn làm việc con được (chỉ một cấp)');
  }
}
/** Bỏ việc cha khi việc con và việc cha không còn cùng dự án / cùng nhóm (đổi nhóm, chuyển dự án…). */
export async function clearBrokenParents(db: Tx, projectIds: string[]) {
  await db`
    update tasks c set parent_task_id = null from tasks p
    where c.parent_task_id = p.id and c.project_id in ${db(projectIds)}
      and (c.project_id <> p.project_id or c.group_id is distinct from p.group_id or p.parent_task_id is not null)`;
}

export const checkDates = (t: { startDate?: string | null; endDate?: string | null }) => {
  if (t.startDate && t.endDate && t.endDate < t.startDate) throw bad('Ngày kết thúc phải từ ngày bắt đầu trở đi');
};

export async function insertTask(projectId: string, b: TaskCreate) {
  checkDates(b);
  await groupBelongs(projectId, b.groupId);
  await scopeBelongs(projectId, b.scopeId);
  await phaseBelongs(projectId, b.phaseId);
  const groupId = b.groupId ?? null;
  if (b.parentTaskId) await sql.begin((tx) => checkParent(tx, projectId, null, groupId, b.parentTaskId));
  const both = !!(b.startDate && b.endDate);
  const subtasks = normalizeSubtasks(b.subtasks ?? []);
  const [t] = await sql`
    insert into tasks (project_id, group_id, scope_id, phase_id, parent_task_id, name, assignee, support, progress, start_date, end_date, days, note, getfly_note, subtasks, baseline_start, baseline_end, sort)
    values (${projectId}, ${groupId}, ${b.scopeId ?? null}, ${b.phaseId ?? null}, ${b.parentTaskId ?? null}, ${b.name}, ${b.assignee ?? ''}, ${b.support ?? ''}, ${subtaskProgress(subtasks, b.progress ?? 0)}, ${b.startDate ?? null}, ${b.endDate ?? null}, ${b.days ?? null}, ${b.note ?? ''}, ${b.getflyNote ?? false}, ${sql.json(subtasks)},
      ${both ? b.startDate! : null}, ${both ? b.endDate! : null},
      (select coalesce(max(sort), -1) + 1 from tasks where project_id = ${projectId} and group_id is not distinct from ${groupId}))
    returning *`;
  await touch(projectId);
  return taskView(t);
}

/** Chuyển việc giữa hai dự án trong một transaction, giữ id / lịch sử / task con / liên kết Getfly. */
export async function transferTasks(source: ProjectRow, target: ProjectRow, ids: string[], actorId: string) {
  if (source.id === target.id) throw bad('Dự án nguồn và đích phải khác nhau');
  if (!ids.length || new Set(ids).size !== ids.length) throw bad('Chọn các mã việc khác nhau');
  const moved = await sql.begin(async (tx) => {
    await tx`select id from projects where id in ${tx([source.id, target.id])} order by id for update`;
    const tasks = await tx<TaskRow[]>`select * from tasks where project_id = ${source.id} and id in ${tx(ids)} order by group_id, sort, id for update`;
    if (tasks.length !== ids.length) throw bad('Có việc không còn trong dự án, chưa chuyển việc nào');
    const [freshTarget] = await tx<ProjectRow[]>`select * from projects where id = ${target.id}`;
    const targetParents = { ...(freshTarget.getflyGroups ?? {}) };
    const groupMap = new Map<string, string>(), scopeMap = new Map<string, string>();
    const result: Record<string, unknown>[] = [];
    for (const task of tasks) {
      let groupId: string | null = null, scopeId: string | null = null;
      if (task.groupId) {
        if (!groupMap.has(task.groupId)) {
          const [group] = await tx`select * from task_groups where id = ${task.groupId} and project_id = ${source.id}`;
          if (!group) throw bad('Nhóm nguồn không hợp lệ');
          let [dest] = await tx`select id from task_groups where project_id = ${target.id} and lower(name) = lower(${group.name}) order by sort, id limit 1`;
          if (!dest) [dest] = await tx`insert into task_groups (project_id, name, sort) values (${target.id}, ${group.name}, (select coalesce(max(sort), -1) + 1 from task_groups where project_id = ${target.id})) returning id`;
          groupMap.set(task.groupId, dest.id);
          if (!targetParents[dest.id] && source.getflyGroups?.[task.groupId]) targetParents[dest.id] = source.getflyGroups[task.groupId];
        }
        groupId = groupMap.get(task.groupId)!;
      }
      if (task.scopeId) {
        if (!scopeMap.has(task.scopeId)) {
          const [scope] = await tx<ScopeRow[]>`select * from scopes where id = ${task.scopeId} and project_id = ${source.id}`;
          if (!scope) throw bad('Phạm vi nguồn không hợp lệ');
          let [dest] = await tx`select id from scopes where project_id = ${target.id} and lower(name) = lower(${scope.name}) limit 1`;
          if (!dest) [dest] = await tx`insert into scopes (project_id, name, color, owner, note, sort) values (${target.id}, ${scope.name}, ${scope.color}, ${scope.owner}, ${scope.note}, (select coalesce(max(sort), -1) + 1 from scopes where project_id = ${target.id})) returning id`;
          scopeMap.set(task.scopeId, dest.id);
        }
        scopeId = scopeMap.get(task.scopeId)!;
      }
      const [row] = await tx`update tasks set project_id = ${target.id}, group_id = ${groupId}, scope_id = ${scopeId}, phase_id = null, sort = (select coalesce(max(sort), -1) + 1 from tasks where project_id = ${target.id} and group_id is not distinct from ${groupId}), updated_at = now() where id = ${task.id} and project_id = ${source.id} returning *`;
      await tx`update task_history set project_id = ${target.id} where task_id = ${task.id} and project_id = ${source.id}`;
      await tx`insert into task_history (task_id, project_id, user_id, field, old_value, new_value) values (${task.id}, ${target.id}, ${actorId}, 'project', ${source.name}, ${target.name})`;
      result.push(row);
    }
    // Chuyển các liên kết của việc được chọn và task con cũ; việc nhóm vẫn thuộc dự án nguồn.
    const links = await tx<{ localId: string; parentLocal: string | null }[]>`select local_id, parent_local from getfly_links where project_id = ${source.id}`;
    const moving = new Set(tasks.flatMap((t) => [t.id, ...(t.subtasks ?? []).map((child) => child.id)]));
    for (let added = true; added;) { added = false; for (const link of links) if (link.parentLocal && moving.has(link.parentLocal) && !moving.has(link.localId)) { moving.add(link.localId); added = true; } }
    if (moving.size) await tx`update getfly_links set project_id = ${target.id} where project_id = ${source.id} and local_id in ${tx([...moving])}`;
    await clearBrokenParents(tx, [source.id, target.id]);
    for (const row of result) await tx`update getfly_links set parent_local = ${row.groupId ? `g:${row.groupId}` : null} where project_id = ${target.id} and local_id = ${String(row.id)}`;
    await tx`update projects set getfly_groups = ${tx.json(targetParents)}, updated_at = now() where id = ${target.id}`;
    await tx`update projects set updated_at = now() where id = ${source.id}`;
    return result;
  });
  emitChanged(source.id); emitChanged(target.id);
  return moved.map(taskView);
}

/** Trường được ghi lịch sử khi đổi. */
const TRACKED: (keyof TaskPatch)[] = ['name', 'groupId', 'scopeId', 'phaseId', 'parentTaskId', 'assignee', 'support', 'progress', 'startDate', 'endDate', 'days', 'note', 'getflyNote', 'subtasks'];
const asText = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function updateTask(projectId: string, taskId: string, b: TaskPatch, actorId: string | null = null) {
  if (!Object.keys(b).length) throw bad('Không có gì để sửa');
  if (b.groupId !== undefined) await groupBelongs(projectId, b.groupId);
  if (b.scopeId !== undefined) await scopeBelongs(projectId, b.scopeId);
  if (b.phaseId !== undefined) await phaseBelongs(projectId, b.phaseId);
  const t = await sql.begin(async (tx) => {
    const [cur] = await tx<TaskRow[]>`select * from tasks where id = ${taskId} and project_id = ${projectId} for update`;
    if (!cur) throw notFound();
    const subtasks = normalizeSubtasks(b.subtasks ?? cur.subtasks ?? []);
    // Đổi nhóm mà không chọn việc cha mới -> bỏ việc cha cũ (việc cha phải cùng nhóm).
    const groupChanged = b.groupId !== undefined && (b.groupId ?? null) !== (cur.groupId ?? null);
    if (groupChanged && b.parentTaskId === undefined && cur.parentTaskId) b = { ...b, parentTaskId: null };
    if (b.parentTaskId) await checkParent(tx, projectId, taskId, b.groupId !== undefined ? b.groupId : cur.groupId, b.parentTaskId);
    const update = { ...b, progress: subtaskProgress(subtasks, b.progress ?? cur.progress), ...(b.subtasks !== undefined ? { subtasks } : {}) };
    const next = { ...cur, ...update };
    checkDates(next);
    const changes = TRACKED.filter((k) => k in update && asText((cur as Record<string, unknown>)[k]) !== asText(update[k]));
    const patch: Record<string, unknown> = { ...update, updatedAt: new Date() };
    if (b.subtasks !== undefined) patch.subtasks = tx.json(subtasks);
    if (!cur.baselineStart && !cur.baselineEnd && next.startDate && next.endDate) { patch.baselineStart = next.startDate; patch.baselineEnd = next.endDate; }
    const [row] = await tx`update tasks set ${tx(patch)} where id = ${taskId} returning *`;
    // Việc cha chuyển nhóm: các việc con ở lại nhóm cũ và thôi là việc con.
    if (groupChanged) await clearBrokenParents(tx, [projectId]);
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
    await clearBrokenParents(tx, [projectId]);
  });
  await touch(projectId);
}

/** Sắp xếp việc trong nhóm theo ngày bắt đầu (trống xếp cuối), rồi kết thúc, rồi tên. groupId undefined = mọi nhóm. */
// ---------------------------------------------------------------- dùng chung REST / MCP: dự án, thành viên, nhóm

/** Sửa thông tin dự án (đã kiểm quyền ở nơi gọi). Phát `changed` để giao diện / Google Sheet cập nhật. */
export async function updateProject(p: ProjectRow & { myRole: MemberRole }, patch: Record<string, unknown>) {
  if (!Object.keys(patch).length) return p;
  const [row] = await sql<ProjectRow[]>`update projects set ${sql({ ...patch, updatedAt: new Date() })} where id = ${p.id} returning *`;
  emitChanged(p.id);
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

/** Đổi tên / thu gọn nhóm. */
export async function updateGroup(projectId: string, groupId: string, patch: { name?: string; collapsed?: boolean }, getflyParent?: GetflyGroupParent | null) {
  const g = await sql.begin(async (tx) => {
    const [existing] = await tx`select id, name, sort, collapsed from task_groups where id = ${groupId} and project_id = ${projectId} for update`;
    if (!existing) throw notFound();
    const [g] = Object.keys(patch).length ? await tx`update task_groups set ${tx(patch)} where id = ${groupId} and project_id = ${projectId} returning id, name, sort, collapsed` : [existing];
    if (getflyParent !== undefined) {
      if (getflyParent) await tx`update projects set getfly_groups = coalesce(getfly_groups, '{}'::jsonb) || ${tx.json({ [groupId]: getflyParent })}::jsonb where id = ${projectId}`;
      else await tx`update projects set getfly_groups = coalesce(getfly_groups, '{}'::jsonb) - ${groupId} where id = ${projectId}`;
    }
    return g;
  });
  await touch(projectId);
  return g as { id: string; name: string; sort: number; collapsed: boolean };
}

/** Ai được thấy dự án (chủ + thành viên đã có tài khoản) — để gửi sự kiện cho đúng người. */
export async function projectAudience(projectId: string): Promise<{ name: string; userIds: string[] } | null> {
  const [p] = await sql<{ name: string; ownerId: string }[]>`select name, owner_id from projects where id = ${projectId}`;
  if (!p) return null;
  const ms = await sql<{ userId: string }[]>`select user_id from project_members where project_id = ${projectId} and user_id is not null`;
  return { name: p.name, userIds: [p.ownerId, ...ms.map((m) => m.userId)] };
}

export async function deleteProject(projectId: string) {
  // Lấy người xem trước khi xoá để vẫn báo được cho họ.
  const audience = await projectAudience(projectId);
  await sql`delete from projects where id = ${projectId}`;
  emitChanged(projectId, { deleted: true, audience });
}

// ---------------------------------------------------------------- phạm vi (tag)

export const scopeSchema = z.object({
  name: zText(80).min(1, 'Nhập tên phạm vi'),
  color: zColor.default('#4274bc'),
  owner: zText(200).default(''),
  note: zText(1000).default(''),
});
export async function scopeBelongs(projectId: string, scopeId: string | null | undefined) {
  if (!scopeId) return;
  const [m] = await sql`select 1 from scopes where id = ${scopeId} and project_id = ${projectId}`;
  if (!m) throw bad('Phạm vi không thuộc dự án này');
}
export async function findScope(projectId: string, name: string) {
  const [m] = await sql<ScopeRow[]>`select id, name, color, owner, note, sort from scopes where project_id = ${projectId} and lower(name) = ${name.trim().toLowerCase()}`;
  return m ?? null;
}
/** Bảng màu gợi ý cho phạm vi mới (xoay vòng). */
const SCOPE_COLORS = ['#4274bc', '#2f9e8f', '#c47a1c', '#8a5cc7', '#c2456b', '#4f8a2e', '#3b8fc4', '#b5651d'];
export async function createScope(projectId: string, b: Partial<z.infer<typeof scopeSchema>> & { name: string }) {
  if (await findScope(projectId, b.name)) throw bad(`Đã có phạm vi "${b.name.trim()}"`);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from scopes where project_id = ${projectId}`;
  const [m] = await sql<ScopeRow[]>`
    insert into scopes (project_id, name, color, owner, note, sort)
    values (${projectId}, ${b.name.trim()}, ${b.color ?? SCOPE_COLORS[n % SCOPE_COLORS.length]}, ${b.owner ?? ''}, ${b.note ?? ''}, ${n})
    returning id, name, color, owner, note, sort`;
  await touch(projectId);
  return m;
}
export async function updateScope(projectId: string, scopeId: string, patch: Partial<z.infer<typeof scopeSchema>>) {
  if (!Object.keys(patch).length) throw bad('Không có gì để sửa');
  if (patch.name) { const dup = await findScope(projectId, patch.name); if (dup && dup.id !== scopeId) throw bad(`Đã có phạm vi "${patch.name}"`); }
  const [m] = await sql<ScopeRow[]>`update scopes set ${sql(patch)} where id = ${scopeId} and project_id = ${projectId} returning id, name, color, owner, note, sort`;
  if (!m) throw notFound();
  await touch(projectId);
  return m;
}
/** Xoá phạm vi: việc đang gắn được bỏ tag (không xoá việc). */
export async function deleteScope(projectId: string, scopeId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where scope_id = ${scopeId} and project_id = ${projectId}`;
  const rows = await sql`delete from scopes where id = ${scopeId} and project_id = ${projectId} returning id`;
  if (!rows.length) throw notFound();
  await touch(projectId);
  return { untagged: n };
}
export async function reorderScopes(projectId: string, ids: string[]) {
  await sql.begin(async (tx) => {
    for (const [i, id] of ids.entries()) await tx`update scopes set sort = ${i} where id = ${id} and project_id = ${projectId}`;
  });
  await touch(projectId);
}

// ---------------------------------------------------------------- phase

export const phaseSchema = z.object({
  name: zText(80).min(1, 'Nhập tên phase'),
  startDate: zDate.nullable().optional(),
  endDate: zDate.nullable().optional(),
  note: zText(1000).optional(),
});
const phaseCols = sql`id, name, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, note, sort`;
export async function phaseBelongs(projectId: string, phaseId: string | null | undefined) {
  if (!phaseId) return;
  const [m] = await sql`select 1 from phases where id = ${phaseId} and project_id = ${projectId}`;
  if (!m) throw bad('Phase không thuộc dự án này');
}
export async function findPhase(projectId: string, name: string) {
  const [m] = await sql<PhaseRow[]>`select ${phaseCols} from phases where project_id = ${projectId} and lower(name) = ${name.trim().toLowerCase()}`;
  return m ?? null;
}
export async function createPhase(projectId: string, b: z.infer<typeof phaseSchema>) {
  checkDates(b);
  if (await findPhase(projectId, b.name)) throw bad(`Đã có phase "${b.name.trim()}"`);
  const [m] = await sql<PhaseRow[]>`
    insert into phases (project_id, name, start_date, end_date, note, sort)
    values (${projectId}, ${b.name.trim()}, ${b.startDate ?? null}, ${b.endDate ?? null}, ${b.note ?? ''}, (select coalesce(max(sort), -1) + 1 from phases where project_id = ${projectId}))
    returning ${phaseCols}`;
  await touch(projectId);
  return m;
}
export async function updatePhase(projectId: string, phaseId: string, patch: Partial<z.infer<typeof phaseSchema>>) {
  if (!Object.keys(patch).length) throw bad('Không có gì để sửa');
  if (patch.name) { const dup = await findPhase(projectId, patch.name); if (dup && dup.id !== phaseId) throw bad(`Đã có phase "${patch.name}"`); }
  const [cur] = await sql<PhaseRow[]>`select ${phaseCols} from phases where id = ${phaseId} and project_id = ${projectId}`;
  if (!cur) throw notFound();
  checkDates({ startDate: patch.startDate !== undefined ? patch.startDate : cur.startDate, endDate: patch.endDate !== undefined ? patch.endDate : cur.endDate });
  const [m] = await sql<PhaseRow[]>`update phases set ${sql(patch)} where id = ${phaseId} returning ${phaseCols}`;
  await touch(projectId);
  return m;
}
/** Xoá phase: mặc định việc trong phase thành "chưa có phase"; deleteTasks = xoá luôn việc. */
export async function deletePhase(projectId: string, phaseId: string, deleteTasks = false) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where phase_id = ${phaseId} and project_id = ${projectId}`;
  await sql.begin(async (tx) => {
    if (deleteTasks) await tx`delete from tasks where phase_id = ${phaseId} and project_id = ${projectId}`;
    const rows = await tx`delete from phases where id = ${phaseId} and project_id = ${projectId} returning id`;
    if (!rows.length) throw notFound();
  });
  await touch(projectId);
  return { tasks: n, deletedTasks: deleteTasks ? n : 0 };
}
export async function reorderPhases(projectId: string, ids: string[]) {
  await sql.begin(async (tx) => {
    for (const [i, id] of ids.entries()) await tx`update phases set sort = ${i} where id = ${id} and project_id = ${projectId}`;
  });
  await touch(projectId);
}
/** Gán việc vào một phase (null = bỏ phase): danh sách id, hoặc 'unphased' = mọi việc chưa có phase. */
export async function setTasksPhase(projectId: string, phaseId: string | null, taskIds: string[] | 'unphased') {
  await phaseBelongs(projectId, phaseId);
  const rows = taskIds === 'unphased'
    ? await sql`update tasks set phase_id = ${phaseId} where project_id = ${projectId} and phase_id is null returning id`
    : await sql`update tasks set phase_id = ${phaseId} where project_id = ${projectId} and id = any(${taskIds}::uuid[]) returning id`;
  await touch(projectId);
  return { moved: rows.length };
}

/**
 * Gộp dự án nguồn vào dự án đích thành một phase (hai "dự án" thực ra là hai giai đoạn dùng chung cấu hình).
 * - Việc chưa có phase của dự án đích được gán `targetPhase` (nếu đặt).
 * - Mọi việc của nguồn chuyển sang đích, vào phase `sourcePhase` (tạo nếu chưa có); nhóm / phạm vi ghép theo tên (thiếu thì tạo).
 * - Lịch sử việc đi theo; thành viên của nguồn chưa có ở đích được thêm (giữ vai trò).
 * - Dự án nguồn được lưu trữ (không xoá) và đổi tên "… (đã gộp vào …)"; liên kết Getfly của nguồn bị bỏ.
 */
export async function mergeProjectAsPhase(targetId: string, sourceId: string, sourcePhase: string, targetPhase?: string) {
  if (targetId === sourceId) throw bad('Không gộp dự án vào chính nó');
  const out = await sql.begin(async (tx) => {
    await tx`select id from projects where id in ${tx([targetId, sourceId])} order by id for update`;
    const [target] = await tx<ProjectRow[]>`select * from projects where id = ${targetId}`;
    const [source] = await tx<ProjectRow[]>`select * from projects where id = ${sourceId}`;
    if (!target || !source) throw notFound();
    const phaseOf = async (name: string) => {
      const [f] = await tx<{ id: string }[]>`select id from phases where project_id = ${targetId} and lower(name) = ${name.trim().toLowerCase()}`;
      if (f) return f.id;
      const [r] = await tx<{ id: string }[]>`insert into phases (project_id, name, sort) values (${targetId}, ${name.trim()}, (select coalesce(max(sort), -1) + 1 from phases where project_id = ${targetId})) returning id`;
      return r.id;
    };
    let tagged = 0;
    if (targetPhase?.trim()) {
      const tp = await phaseOf(targetPhase);
      tagged = (await tx`update tasks set phase_id = ${tp} where project_id = ${targetId} and phase_id is null returning id`).length;
    }
    const sp = await phaseOf(sourcePhase);
    const groupMap = new Map<string, string>();
    for (const g of await tx<{ id: string; name: string }[]>`select id, name from task_groups where project_id = ${sourceId} order by sort, created_at`) {
      const [f] = await tx<{ id: string }[]>`select id from task_groups where project_id = ${targetId} and lower(name) = ${g.name.trim().toLowerCase()}`;
      groupMap.set(g.id, f?.id ?? (await tx<{ id: string }[]>`insert into task_groups (project_id, name, sort) values (${targetId}, ${g.name}, (select coalesce(max(sort), -1) + 1 from task_groups where project_id = ${targetId})) returning id`)[0].id);
    }
    const scopeMap = new Map<string, string>();
    for (const s of await tx<{ id: string; name: string; color: string; owner: string; note: string }[]>`select id, name, color, owner, note from scopes where project_id = ${sourceId} order by sort, created_at`) {
      const [f] = await tx<{ id: string }[]>`select id from scopes where project_id = ${targetId} and lower(name) = ${s.name.trim().toLowerCase()}`;
      scopeMap.set(s.id, f?.id ?? (await tx<{ id: string }[]>`insert into scopes (project_id, name, color, owner, note, sort) values (${targetId}, ${s.name}, ${s.color}, ${s.owner}, ${s.note}, (select coalesce(max(sort), -1) + 1 from scopes where project_id = ${targetId})) returning id`)[0].id);
    }
    const tasks = await tx<{ id: string; groupId: string | null; scopeId: string | null; sort: number }[]>`select id, group_id, scope_id, sort from tasks where project_id = ${sourceId} order by sort`;
    const offset = new Map<string | null, number>();
    for (const t of tasks) {
      const gid = t.groupId ? groupMap.get(t.groupId)! : null;
      if (!offset.has(gid)) {
        const [{ m }] = await tx<{ m: number }[]>`select coalesce(max(sort), -1) + 1 as m from tasks where project_id = ${targetId} and group_id is not distinct from ${gid}`;
        offset.set(gid, m);
      }
      const sort = offset.get(gid)!;
      offset.set(gid, sort + 1);
      await tx`update tasks set project_id = ${targetId}, group_id = ${gid}, scope_id = ${t.scopeId ? scopeMap.get(t.scopeId)! : null}, phase_id = ${sp}, sort = ${sort} where id = ${t.id}`;
    }
    await tx`update task_history set project_id = ${targetId} where project_id = ${sourceId}`;
    await tx`
      insert into project_members (project_id, email, user_id, role, invited_by)
      select ${targetId}, m.email, m.user_id, m.role, m.invited_by from project_members m where m.project_id = ${sourceId}
      on conflict (project_id, email) do nothing`;
    await tx`delete from getfly_links where project_id = ${sourceId}`;
    await tx`delete from task_groups where project_id = ${sourceId}`;
    await tx`delete from scopes where project_id = ${sourceId}`;
    await tx`update projects set archived = true, name = ${`${source.name} (đã gộp vào ${target.name})`.slice(0, 160)}, updated_at = now() where id = ${sourceId}`;
    return { moved: tasks.length, tagged, phaseId: sp, groupsMapped: groupMap.size, scopesMapped: scopeMap.size, sourceName: source.name };
  });
  await touch(targetId);
  await touch(sourceId);
  return out;
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
          insert into tasks (project_id, group_id, scope_id, phase_id, name, assignee, support, progress, start_date, end_date, days, note, getfly_note, subtasks, baseline_start, baseline_end, sort)
          values (${projectId}, ${groupId}, ${t.scopeId ?? null}, ${t.phaseId ?? null}, ${t.name}, ${t.assignee ?? ''}, ${t.support ?? ''}, ${subtaskProgress(subtasks, t.progress ?? 0)}, ${t.startDate ?? null}, ${t.endDate ?? null}, ${t.days ?? null}, ${t.note ?? ''}, ${t.getflyNote ?? false}, ${tx.json(subtasks)},
            ${both ? t.startDate! : null}, ${both ? t.endDate! : null},
            (select coalesce(max(sort), -1) + 1 from tasks where project_id = ${projectId} and group_id is not distinct from ${groupId}))`;
        tasks++;
      }
    }
  });
  await touch(projectId);
  return { groups: created, tasks };
}
