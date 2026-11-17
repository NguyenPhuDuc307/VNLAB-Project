// Công cụ cho AI qua MCP (server/mcp.ts). Mỗi công cụ là (user, input) -> JSON và
// dùng chung tầng dữ liệu với REST (server/data.ts) nên AI và giao diện không
// bao giờ lệch nhau. Quyền tính năng (project.*) kiểm như REST; quyền theo dự án
// (chủ / được sửa / chỉ xem) kiểm trong data.ts.
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import * as D from './data.ts';
import { parseDate, today } from './dates.ts';
import { effectivePermissions, rolesOf } from './rbac.ts';
import { parseSheetId, syncProject } from './sheets.ts';
import { clearCalendar, parseCalendarId, syncCalendar } from './gcal.ts';
import { sql } from './db.ts';
import { findGetflyTask, getflyJob, getflyUsers, startGetflyJob, waitGetflyJob, withGetflyProjectsLocked } from './getfly.ts';
import { ALL_COLUMNS, normalizeColumns } from './plan-layout.ts';
import type { PermissionKey } from './permissions.ts';

export class ToolError extends Error {}

type Tool = {
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  write?: boolean;
  destructive?: boolean;
  /** Quyền tính năng cần có (ngoài quyền theo dự án). */
  perm?: PermissionKey;
  run: (user: D.UserRow, args: never) => Promise<unknown>;
};

const zAnyDate = z.string().trim().max(40).describe('Ngày: YYYY-MM-DD (cũng hiểu dd/mm/yyyy, 2-Nov-26). Để trống = không đặt.');
const date = (s: string | null | undefined): string | null => {
  if (s == null || s.trim() === '') return null;
  const d = parseDate(s);
  if (!d) throw new ToolError(`Không hiểu ngày "${s}" — dùng dạng YYYY-MM-DD`);
  return d;
};
const projectRef = {
  projectId: z.uuid().optional().describe('Mã dự án (ưu tiên). Lấy từ list_projects.'),
  project: z.string().trim().max(160).optional().describe('Hoặc tên / mã ngắn của dự án; nếu khớp nhiều dự án sẽ báo để chọn.'),
};
const taskBody = {
  subtasks: z.array(D.subtaskFields).max(100).optional().describe('Danh sách đầy đủ task con (id, name, assignee, progress). Không có lịch riêng; tiến độ cha là trung bình task con. Gửi [] để bỏ task con.'),
  assignee: z.string().trim().max(160).optional().describe('Người phụ trách chính'),
  support: z.string().trim().max(300).optional().describe('Người hỗ trợ, nhiều người cách nhau bằng dấu phẩy'),
  progress: z.number().int().min(0).max(100).optional().describe('Tiến độ 0–100 (%)'),
  startDate: zAnyDate.optional(),
  endDate: zAnyDate.optional(),
  days: z.number().min(0).max(9999).optional().describe('Ngày công ước tính; bỏ qua = tự tính từ khoảng ngày (T2–T6 = 1, T7 = ½, CN = 0)'),
  note: z.string().trim().max(4000).optional(),
  getflyNote: z.boolean().optional().describe('true = gửi ghi chú lên mô tả việc trên Getfly CRM khi đồng bộ; mặc định false (ghi chú nội bộ)'),
  scope: z.string().trim().max(80).optional().describe('Tên phạm vi (tag) của việc; chưa có thì tạo; "" = bỏ phạm vi. Xem danh sách phạm vi trong get_project'),
  phase: z.string().trim().max(80).optional().describe('Tên phase của việc (VD "Tháng 11"); chưa có thì tạo; "" = bỏ phase. Xem phases trong get_project'),
};

async function resolveProject(user: D.UserRow, args: { projectId?: string; project?: string }) {
  if (args.projectId) return D.projectOf(user, args.projectId);
  const q = (args.project ?? '').trim().toLowerCase();
  if (!q) throw new ToolError('Cần projectId hoặc tên dự án (project). Gọi list_projects để xem danh sách.');
  const all = await D.myProjects(user);
  const exact = all.filter((p) => p.name.toLowerCase() === q || (p.code && p.code.toLowerCase() === q));
  const hits = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(q));
  if (hits.length === 1) return D.projectOf(user, hits[0].id);
  if (!hits.length) throw new ToolError(`Không có dự án nào khớp "${args.project}". Gọi list_projects để xem danh sách.`);
  throw new ToolError(`Nhiều dự án khớp "${args.project}": ${hits.map((p) => `${p.name} (${p.id})`).join('; ')} — chỉ rõ projectId.`);
}

async function editableProject(user: D.UserRow, args: { projectId?: string; project?: string }) {
  const p = await resolveProject(user, args);
  D.editable(p);
  return p;
}

/** Nhóm theo tên trong dự án; chưa có thì tạo (cần quyền sửa dự án). */
async function groupByName(user: D.UserRow, perms: Set<PermissionKey>, projectId: string, name: string | undefined) {
  if (!name?.trim()) return null;
  const found = await D.findGroup(projectId, name);
  if (found) return found.id;
  if (!perms.has('project.project.write')) throw new ToolError(`Chưa có nhóm "${name}" và bạn không có quyền tạo nhóm — dùng nhóm có sẵn hoặc bỏ group`);
  return (await D.createGroup(projectId, name.trim())).id;
}

/** Phạm vi theo tên; "" = bỏ phạm vi; chưa có thì tạo (cần quyền sửa dự án). undefined = không đổi. */
async function scopeByName(perms: Set<PermissionKey>, projectId: string, name: string | undefined): Promise<string | null | undefined> {
  if (name === undefined) return undefined;
  if (!name.trim()) return null;
  const found = await D.findScope(projectId, name);
  if (found) return found.id;
  if (!perms.has('project.project.write')) throw new ToolError(`Chưa có phạm vi "${name}" và bạn không có quyền tạo — dùng phạm vi có sẵn`);
  return (await D.createScope(projectId, { name: name.trim() })).id;
}
/** Tên phạm vi + phase theo id (id là uuid nên không trùng giữa hai bảng). */
const namesOf = (b: { scopes: D.ScopeRow[]; phases: D.PhaseRow[] }) => new Map([...b.scopes.map((s) => [s.id, s.name] as const), ...b.phases.map((x) => [x.id, x.name] as const)]);
/** Phase theo tên; "" = bỏ phase; chưa có thì tạo (cần quyền sửa dự án). undefined = không đổi. */
async function phaseByName(perms: Set<PermissionKey>, projectId: string, name: string | undefined): Promise<string | null | undefined> {
  if (name === undefined) return undefined;
  if (!name.trim()) return null;
  const found = await D.findPhase(projectId, name);
  if (found) return found.id;
  if (!perms.has('project.project.write')) throw new ToolError(`Chưa có phase "${name}" và bạn không có quyền tạo — dùng phase có sẵn`);
  return (await D.createPhase(projectId, { name: name.trim() })).id;
}

const taskOut = (t: ReturnType<typeof D.taskView>, p: { satWeight: number; sunWeight: number }, groups: Map<string, string>, t0: string, scopes: Map<string, string> = new Map()) => ({
  subtasks: t.subtasks,
  id: t.id, name: t.name, group: t.groupId ? groups.get(t.groupId) ?? null : null, groupId: t.groupId,
  scope: t.scopeId ? scopes.get(t.scopeId) ?? null : null, scopeId: t.scopeId,
  phase: t.phaseId ? scopes.get(t.phaseId) ?? null : null, phaseId: t.phaseId,
  assignee: t.assignee, support: t.support, progress: t.progress, startDate: t.startDate, endDate: t.endDate,
  days: D.effortOf(t, p), daysManual: t.days != null, note: t.note, getflyNote: t.getflyNote,
  status: t.progress >= 100 ? 'done' : t.endDate && t.endDate < t0 ? 'overdue' : 'open',
  baseline: t.baselineStart && t.baselineEnd ? { startDate: t.baselineStart, endDate: t.baselineEnd, shiftDays: D.planShift(t)?.end ?? 0 } : null,
});

export const TOOLS: Record<string, Tool> = {
  list_projects: {
    title: 'Danh sách dự án',
    description: 'Mọi dự án bạn là chủ hoặc được mời, kèm vai trò của bạn (owner/editor/viewer) và thống kê (số việc, xong, quá hạn, tiến độ %, khoảng ngày). Gọi trước khi làm gì với dự án.',
    input: z.object({ includeArchived: z.boolean().optional().describe('Gồm cả dự án đã lưu trữ') }),
    run: async (user, a: { includeArchived?: boolean }) => {
      const all = await D.myProjects(user);
      return { today: today(), projects: all.filter((p) => a.includeArchived || !p.archived).map((p) => ({ id: p.id, name: p.name, code: p.code, customer: p.customer, startDate: p.startDate, archived: p.archived, myRole: p.myRole, owner: p.owner.name || p.owner.email, stats: p.stats })) };
    },
  },
  get_project: {
    title: 'Chi tiết dự án',
    description: 'Nhóm việc, việc (phụ trách, tiến độ, ngày bắt đầu/kết thúc, ngày công, trạng thái open/done/overdue) và thành viên của một dự án.',
    input: z.object({ ...projectRef, includeDone: z.boolean().optional().describe('Gồm cả việc đã xong (mặc định có)'), phase: z.string().trim().max(80).optional().describe('Chỉ việc thuộc phase này (tên)') }),
    run: async (user, a: { projectId?: string; project?: string; includeDone?: boolean; phase?: string }) => {
      const p = await resolveProject(user, a);
      const [bundle, who] = await Promise.all([D.projectBundle(p.id), D.projectMembers(p)]);
      const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
      const t0 = today();
      const scopes = namesOf(bundle);
      const tasks = bundle.tasks.map((t) => taskOut(t, p, groups, t0, scopes)).filter((t) => !a.phase || (t.phase ?? '').toLowerCase() === a.phase.toLowerCase()).filter((t) => a.includeDone !== false || t.status !== 'done');
      return {
        today: t0, id: p.id, name: p.name, code: p.code, customer: p.customer, description: p.description, startDate: p.startDate, archived: p.archived, myRole: p.myRole,
        owner: who.owner.name || who.owner.email, members: who.members.map((m) => ({ email: m.email, name: m.name, role: m.role })),
        groups: bundle.groups.map((g) => ({ id: g.id, name: g.name, taskCount: bundle.tasks.filter((t) => t.groupId === g.id).length })),
        phases: bundle.phases.map((x) => ({ id: x.id, name: x.name, startDate: x.startDate, endDate: x.endDate, note: x.note, taskCount: bundle.tasks.filter((t) => t.phaseId === x.id).length })),
        unphasedTasks: bundle.tasks.filter((t) => !t.phaseId).length,
        scopes: bundle.scopes.map((s) => ({ id: s.id, name: s.name, owner: s.owner, color: s.color, note: s.note, taskCount: bundle.tasks.filter((t) => t.scopeId === s.id).length })),
        aiContext: p.aiContext || null,
        getfly: p.getflyParentCode || p.getflyProjectName ? { parentCode: p.getflyParentCode, parentName: p.getflyParentName, projectName: p.getflyProjectName, users: p.getflyUsers, syncedAt: p.getflySyncedAt } : null,
        tasks,
      };
    },
  },
  get_overview: {
    title: 'Tổng quan',
    description: 'Hôm nay là ngày nào, dự án đang chạy, việc quá hạn và việc đến hạn trong 7 ngày tới trong mọi dự án của bạn.',
    input: z.object({}),
    run: async (user) => {
      const o = await D.overview(user);
      const slim = (t: (typeof o.overdue)[number]) => ({ id: t.id, name: t.name, project: t.projectName, projectId: t.projectId, assignee: t.assignee, progress: t.progress, endDate: t.endDate });
      return { today: o.today, projects: o.projects.map((p) => ({ id: p.id, name: p.name, progress: p.stats.progress, taskCount: p.stats.taskCount, overdueCount: p.stats.overdueCount })), overdue: o.overdue.map(slim), upcoming: o.upcoming.map(slim) };
    },
  },
  find_tasks: {
    title: 'Tìm việc',
    description: 'Tìm việc trong các dự án của bạn theo từ khoá tên/ghi chú, người phụ trách, trạng thái, hạn. Trả về id để update_task / delete_task.',
    input: z.object({
      ...projectRef,
      query: z.string().trim().max(200).optional().describe('Từ khoá trong tên hoặc ghi chú'),
      assignee: z.string().trim().max(160).optional().describe('Khớp một phần tên người phụ trách hoặc hỗ trợ'),
      status: z.enum(['open', 'done', 'overdue', 'all']).optional().describe('Mặc định all'),
      dueBefore: zAnyDate.optional().describe('Chỉ việc có hạn trước hoặc bằng ngày này'),
      scope: z.string().trim().max(80).optional().describe('Chỉ việc thuộc phạm vi này (tên)'),
      phase: z.string().trim().max(80).optional().describe('Chỉ việc thuộc phase này (tên)'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: async (user, a: { projectId?: string; project?: string; query?: string; assignee?: string; status?: string; dueBefore?: string; scope?: string; phase?: string; limit?: number }) => {
      const projects = a.projectId || a.project ? [await resolveProject(user, a)] : await D.myProjects(user);
      const t0 = today();
      const due = date(a.dueBefore);
      const q = a.query?.toLowerCase(), who = a.assignee?.toLowerCase();
      const out: unknown[] = [];
      for (const p of projects) {
        if (p.archived && !(a.projectId || a.project)) continue;
        const bundle = await D.projectBundle(p.id);
        const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
        const scopes = namesOf(bundle);
        for (const t of bundle.tasks) {
          const v = taskOut(t, p, groups, t0, scopes);
          if (a.scope && (v.scope ?? '').toLowerCase() !== a.scope.toLowerCase()) continue;
          if (a.phase && (v.phase ?? '').toLowerCase() !== a.phase.toLowerCase()) continue;
          if (q && !`${t.name} ${t.note}`.toLowerCase().includes(q)) continue;
          if (who && !`${t.assignee} ${t.support}`.toLowerCase().includes(who)) continue;
          if (a.status && a.status !== 'all' && v.status !== a.status) continue;
          if (due && (!t.endDate || t.endDate > due)) continue;
          out.push({ ...v, project: p.name, projectId: p.id });
          if (out.length >= (a.limit ?? 50)) return { today: t0, tasks: out, truncated: true };
        }
      }
      return { today: t0, tasks: out };
    },
  },
  create_project: {
    title: 'Tạo dự án',
    description: 'Tạo dự án mới (bạn là chủ). Sau đó dùng create_group / create_task / create_tasks để thêm việc.',
    input: z.object({
      name: z.string().trim().min(1).max(160),
      customer: z.string().trim().max(160).optional().describe('Khách hàng, VD "Công ty ABC"'),
      code: z.string().trim().max(40).optional().describe('Mã ngắn, VD "WEB01"'),
      description: z.string().trim().max(2000).optional(),
      startDate: zAnyDate.optional(),
    }),
    write: true, destructive: false, perm: 'project.project.create',
    run: async (user, a: { name: string; customer?: string; code?: string; description?: string; startDate?: string }) => {
      const b = D.projectSchema.parse({ name: a.name, customer: a.customer ?? '', code: a.code ?? '', description: a.description ?? '', startDate: date(a.startDate) });
      const p = await D.createProject(user.id, b);
      return { id: p.id, name: p.name, url: `https://project.vnlab.id.vn/du-an/${p.id}` };
    },
  },
  create_group: {
    title: 'Tạo nhóm việc',
    description: 'Thêm một nhóm việc (giai đoạn / phân hệ) vào dự án. Nhóm trùng tên thì trả nhóm có sẵn.',
    input: z.object({ ...projectRef, name: z.string().trim().min(1).max(160) }),
    write: true, destructive: false, perm: 'project.project.write',
    run: async (user, a: { projectId?: string; project?: string; name: string }) => {
      const p = await editableProject(user, a);
      const found = await D.findGroup(p.id, a.name);
      if (found) return { id: found.id, name: found.name, existed: true };
      const g = await D.createGroup(p.id, a.name);
      return { id: g.id, name: g.name, existed: false };
    },
  },
  delete_group: {
    title: 'Xoá nhóm việc',
    description: 'Xoá một nhóm việc (theo `group` là tên hoặc `groupId`). Nhóm còn việc thì mặc định TỪ CHỐI; `keepTasks: true` chuyển các việc sang "Chưa phân nhóm" rồi xoá nhóm, `deleteTasks: true` xoá luôn cả việc. Chỉ xoá khi người dùng nói rõ.',
    input: z.object({
      ...projectRef,
      group: z.string().trim().max(160).optional().describe('Tên nhóm'),
      groupId: z.uuid().optional(),
      keepTasks: z.boolean().optional().describe('Giữ việc, chuyển sang Chưa phân nhóm'),
      deleteTasks: z.boolean().optional().describe('Xoá cả các việc trong nhóm'),
    }),
    write: true, destructive: true, perm: 'project.project.write',
    run: async (user, a: { projectId?: string; project?: string; group?: string; groupId?: string; keepTasks?: boolean; deleteTasks?: boolean }) => {
      const p = await editableProject(user, a);
      if (a.keepTasks && a.deleteTasks) throw new ToolError('Chọn một trong keepTasks hoặc deleteTasks');
      const bundle = await D.projectBundle(p.id);
      const g = a.groupId ? bundle.groups.find((x) => x.id === a.groupId) : a.group?.trim() ? await D.findGroup(p.id, a.group) : null;
      if (!g) throw new ToolError(a.groupId || a.group ? `Không có nhóm "${a.group ?? a.groupId}" trong ${p.name}` : 'Cần `group` (tên) hoặc `groupId`');
      const count = bundle.tasks.filter((t) => t.groupId === g.id).length;
      if (count && !a.keepTasks && !a.deleteTasks) throw new ToolError(`Nhóm "${g.name}" còn ${count} việc — truyền keepTasks: true (chuyển sang Chưa phân nhóm) hoặc deleteTasks: true (xoá cả việc) nếu người dùng đồng ý`);
      await D.deleteGroup(p.id, g.id, !!a.keepTasks);
      return { project: p.name, deleted: g.name, tasksMoved: a.keepTasks ? count : 0, tasksDeleted: a.deleteTasks ? count : 0 };
    },
  },
  create_task: {
    title: 'Tạo việc',
    description: 'Thêm một việc vào dự án. `group` là tên nhóm (chưa có thì tạo); không có thì việc nằm ở "Chưa phân nhóm". Không tự bịa ngày: chỉ đặt ngày khi người dùng nói.',
    input: z.object({ ...projectRef, name: z.string().trim().min(1).max(300), group: z.string().trim().max(160).optional().describe('Tên nhóm việc'), groupId: z.uuid().optional(), ...taskBody }),
    write: true, destructive: false, perm: 'project.task.write',
    run: async (user, a: { projectId?: string; project?: string; name: string; group?: string; groupId?: string } & Record<string, unknown>) => {
      const p = await editableProject(user, a);
      const perms = await effectivePermissions(rolesOf(user));
      const groupId = a.groupId ?? (await groupByName(user, perms, p.id, a.group));
      const scopeId = await scopeByName(perms, p.id, a.scope as string | undefined);
      const phaseId = await phaseByName(perms, p.id, a.phase as string | undefined);
      const t = await D.insertTask(p.id, D.taskCreate.parse({ groupId: groupId ?? null, scopeId: scopeId ?? null, phaseId: phaseId ?? null, name: a.name, assignee: a.assignee, support: a.support, progress: a.progress, startDate: date(a.startDate as string), endDate: date(a.endDate as string), days: a.days ?? null, note: a.note, getflyNote: a.getflyNote, subtasks: a.subtasks }));
      const bundle = await D.projectBundle(p.id);
      const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
      return { project: p.name, task: taskOut(t, p, groups, today(), namesOf(bundle)), url: `https://project.vnlab.id.vn/du-an/${p.id}?task=${t.id}` };
    },
  },
  create_tasks: {
    title: 'Tạo nhiều việc',
    description: 'Thêm nhiều việc một lần (VD cả kế hoạch): mỗi việc có thể ghi tên nhóm; nhóm chưa có thì tạo theo thứ tự xuất hiện.',
    input: z.object({
      ...projectRef,
      phase: z.string().trim().max(80).optional().describe('Phase cho cả lô (từng việc vẫn đặt riêng được)'),
      tasks: z.array(z.object({ name: z.string().trim().min(1).max(300), group: z.string().trim().max(160).optional(), ...taskBody })).min(1).max(500),
    }),
    write: true, destructive: false, perm: 'project.task.write',
    run: async (user, a: { projectId?: string; project?: string; tasks: ({ name: string; group?: string } & Record<string, unknown>)[] }) => {
      const p = await editableProject(user, a);
      const perms = await effectivePermissions(rolesOf(user));
      const byGroup = new Map<string | null, D.ImportGroup>();
      for (const t of a.tasks) {
        const key = t.group?.trim() || null;
        if (key && !(await D.findGroup(p.id, key)) && !perms.has('project.project.write')) throw new ToolError(`Chưa có nhóm "${key}" và bạn không có quyền tạo nhóm`);
        if (!byGroup.has(key)) byGroup.set(key, { name: key, tasks: [] });
        const scopeId = await scopeByName(perms, p.id, t.scope as string | undefined);
        const phaseId = await phaseByName(perms, p.id, (t.phase as string | undefined) ?? (a as { phase?: string }).phase);
        byGroup.get(key)!.tasks.push(D.taskCreate.omit({ groupId: true }).parse({ scopeId: scopeId ?? null, phaseId: phaseId ?? null, name: t.name, assignee: t.assignee, support: t.support, progress: t.progress, startDate: date(t.startDate as string), endDate: date(t.endDate as string), days: t.days ?? null, note: t.note, getflyNote: t.getflyNote, subtasks: t.subtasks }));
      }
      const r = await D.importGroups(p.id, [...byGroup.values()]);
      return { project: p.name, groupsCreated: r.groups, tasksCreated: r.tasks, url: `https://project.vnlab.id.vn/du-an/${p.id}` };
    },
  },
  update_task: {
    title: 'Sửa việc',
    description: 'Đổi tên, tiến độ, người phụ trách/hỗ trợ, ngày, ngày công, ghi chú, phạm vi (scope) hoặc chuyển nhóm của một việc (theo taskId từ get_project / find_tasks). Chỉ gửi trường cần đổi.',
    input: z.object({
      taskId: z.uuid(),
      name: z.string().trim().min(1).max(300).optional(),
      group: z.string().trim().max(160).optional().describe('Tên nhóm mới (chưa có thì tạo); chuỗi rỗng = bỏ nhóm'),
      ...taskBody,
    }),
    write: true, destructive: false, perm: 'project.task.write',
    run: async (user, a: { taskId: string; name?: string; group?: string } & Record<string, unknown>) => {
      const { task, project: p } = await D.taskOf(user, a.taskId);
      D.editable(p);
      const patch: D.TaskPatch = {};
      if (a.subtasks !== undefined) patch.subtasks = a.subtasks as D.TaskPatch['subtasks'];
      if (a.name !== undefined) patch.name = a.name;
      if (a.assignee !== undefined) patch.assignee = a.assignee as string;
      if (a.support !== undefined) patch.support = a.support as string;
      if (a.progress !== undefined) patch.progress = a.progress as number;
      if (a.startDate !== undefined) patch.startDate = date(a.startDate as string);
      if (a.endDate !== undefined) patch.endDate = date(a.endDate as string);
      if (a.days !== undefined) patch.days = a.days as number;
      if (a.getflyNote !== undefined) patch.getflyNote = a.getflyNote as boolean;
      if (a.note !== undefined) patch.note = a.note as string;
      if (a.group !== undefined || a.scope !== undefined || a.phase !== undefined) {
        const perms = await effectivePermissions(rolesOf(user));
        if (a.phase !== undefined) patch.phaseId = await phaseByName(perms, p.id, a.phase as string);
        if (a.group !== undefined) patch.groupId = a.group.trim() ? await groupByName(user, perms, p.id, a.group) : null;
        if (a.scope !== undefined) patch.scopeId = await scopeByName(perms, p.id, a.scope as string);
      }
      const t = await D.updateTask(p.id, task.id, D.taskFields.partial().parse(patch), user.id);
      const bundle = await D.projectBundle(p.id);
      const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
      return { project: p.name, task: taskOut(t, p, groups, today(), namesOf(bundle)) };
    },
  },
  delete_task: {
    title: 'Xoá việc',
    description: 'Xoá hẳn một việc. Chỉ làm khi người dùng nói rõ muốn xoá; không hoàn tác được.',
    input: z.object({ taskId: z.uuid() }),
    write: true, destructive: true, perm: 'project.task.delete',
    run: async (user, a: { taskId: string }) => {
      const { task, project: p } = await D.taskOf(user, a.taskId);
      D.editable(p);
      await D.deleteTask(p.id, task.id);
      return { ok: true, deleted: task.name, project: p.name };
    },
  },
};

TOOLS.sort_tasks = {
  title: 'Sắp xếp việc theo ngày',
  description: 'Sắp xếp theo ngày: có `group` thì chỉ xếp việc trong nhóm đó; bỏ trống thì xếp việc trong mọi nhóm VÀ xếp các nhóm theo ngày bắt đầu sớm nhất. Xếp theo ngày bắt đầu, rồi kết thúc, rồi tên. Chỉ đổi thứ tự hiển thị, không đổi ngày. Muốn đặt thứ tự tuỳ ý thì dùng move_task / reorder_groups.',
  input: z.object({ ...projectRef, group: z.string().trim().max(160).optional().describe('Tên nhóm; bỏ trống = mọi nhóm') }),
  write: true, destructive: false, perm: 'project.task.write',
  run: async (user, a: { projectId?: string; project?: string; group?: string }) => {
    const p = await editableProject(user, a);
    let groupId: string | null | undefined;
    if (a.group?.trim()) {
      const g = await D.findGroup(p.id, a.group);
      if (!g) throw new ToolError(`Không có nhóm "${a.group}" trong ${p.name}`);
      groupId = g.id;
    }
    const r = await D.sortTasksByDate(p.id, groupId);
    return { project: p.name, groupsSorted: r.groups, tasksMoved: r.moved };
  },
};

/** Tìm nhóm theo id hoặc tên trong dự án. */
async function groupRef(p: { id: string; name: string }, a: { group?: string; groupId?: string }) {
  if (a.groupId) {
    const g = (await D.projectBundle(p.id)).groups.find((x) => x.id === a.groupId);
    if (g) return g;
  } else if (a.group?.trim()) {
    const g = await D.findGroup(p.id, a.group);
    if (g) return g;
  }
  throw new ToolError(a.group || a.groupId ? `Không có nhóm "${a.group ?? a.groupId}" trong ${p.name}` : 'Cần `group` (tên) hoặc `groupId`');
}
const groupArgs = { group: z.string().trim().max(160).optional().describe('Tên nhóm'), groupId: z.uuid().optional() };

TOOLS.update_project = {
  title: 'Sửa thông tin dự án',
  description: 'Sửa tên, mã, khách hàng, mô tả, ngày bắt đầu, màu, trọng số ngày công T7/CN, lưu trữ (chỉ chủ dự án) và cột mặc định khi xuất / đồng bộ. Chỉ gửi trường cần đổi.',
  input: z.object({
    ...projectRef,
    name: z.string().trim().min(1).max(160).optional(), code: z.string().trim().max(40).optional(), customer: z.string().trim().max(160).optional(),
    description: z.string().trim().max(2000).optional(), startDate: zAnyDate.nullable().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Màu #RRGGBB'),
    satWeight: z.number().min(0).max(1).optional().describe('Ngày công thứ 7 (0, 0.5, 1)'), sunWeight: z.number().min(0).max(1).optional().describe('Ngày công chủ nhật'),
    archived: z.boolean().optional().describe('Lưu trữ / bỏ lưu trữ (chỉ chủ dự án)'),
    exportColumns: z.array(z.enum(ALL_COLUMNS)).max(20).nullable().optional().describe(`Cột khi xuất Excel / đồng bộ Sheet: ${ALL_COLUMNS.join(', ')}; null = tất cả`),
    aiContext: z.string().max(20000).optional().describe('Hướng dẫn / ngữ cảnh cho AI của dự án (thay toàn bộ). Muốn thêm thì đọc get_ai_context rồi gửi bản đầy đủ'),
  }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: Record<string, unknown> & { projectId?: string; project?: string }) => {
    const p = await editableProject(user, a);
    const { projectId: _i, project: _n, ...rest } = a;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    if ('startDate' in patch) patch.startDate = date(patch.startDate as string | null);
    if (patch.archived !== undefined) D.owned(p);
    if (Array.isArray(patch.exportColumns)) patch.exportColumns = normalizeColumns(patch.exportColumns as string[]);
    if (!Object.keys(patch).length) throw new ToolError('Không có gì để sửa');
    const row = await D.updateProject(p, patch);
    return { project: D.projectView(row), changed: Object.keys(patch) };
  },
};

/** Phạm vi theo id hoặc tên. */
async function scopeRef(p: { id: string; name: string }, a: { scope?: string; scopeId?: string }) {
  const all = (await D.projectBundle(p.id)).scopes;
  const s = a.scopeId ? all.find((x) => x.id === a.scopeId) : a.scope?.trim() ? all.find((x) => x.name.toLowerCase() === a.scope!.trim().toLowerCase()) : undefined;
  if (!s) throw new ToolError(a.scope || a.scopeId ? `Không có phạm vi "${a.scope ?? a.scopeId}" trong ${p.name}` : 'Cần `scope` (tên) hoặc `scopeId`');
  return s;
}
const scopeArgs = { scope: z.string().trim().max(80).optional().describe('Tên phạm vi'), scopeId: z.uuid().optional() };

TOOLS.create_scope = {
  title: 'Tạo phạm vi',
  description: 'Tạo phạm vi (tag) cho dự án, kèm người phụ trách phạm vi (ghi tên tay), màu #RRGGBB và ghi chú. Mỗi việc gắn một phạm vi qua `scope` ở create_task / update_task.',
  input: z.object({ ...projectRef, name: z.string().trim().min(1).max(80), owner: z.string().trim().max(200).optional().describe('Người phụ trách phạm vi'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), note: z.string().trim().max(1000).optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; name: string; owner?: string; color?: string; note?: string }) => {
    const p = await editableProject(user, a);
    return { project: p.name, scope: await D.createScope(p.id, { name: a.name, owner: a.owner, color: a.color, note: a.note }) };
  },
};

TOOLS.update_scope = {
  title: 'Sửa phạm vi',
  description: 'Đổi tên (`newName`), người phụ trách (`owner`), màu hoặc ghi chú của một phạm vi.',
  input: z.object({ ...projectRef, ...scopeArgs, newName: z.string().trim().min(1).max(80).optional(), owner: z.string().trim().max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), note: z.string().trim().max(1000).optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; scope?: string; scopeId?: string; newName?: string; owner?: string; color?: string; note?: string }) => {
    const p = await editableProject(user, a);
    const s = await scopeRef(p, a);
    const patch: Record<string, string> = {};
    if (a.newName) patch.name = a.newName;
    if (a.owner !== undefined) patch.owner = a.owner;
    if (a.color) patch.color = a.color;
    if (a.note !== undefined) patch.note = a.note;
    if (!Object.keys(patch).length) throw new ToolError('Cần newName, owner, color hoặc note');
    return { project: p.name, scope: await D.updateScope(p.id, s.id, patch) };
  },
};

TOOLS.delete_scope = {
  title: 'Xoá phạm vi',
  description: 'Xoá một phạm vi; các việc đang gắn chỉ bị bỏ tag, không bị xoá. Chỉ gọi khi người dùng nói rõ.',
  input: z.object({ ...projectRef, ...scopeArgs }),
  write: true, destructive: true, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; scope?: string; scopeId?: string }) => {
    const p = await editableProject(user, a);
    const s = await scopeRef(p, a);
    const r = await D.deleteScope(p.id, s.id);
    return { project: p.name, deleted: s.name, tasksUntagged: r.untagged };
  },
};

TOOLS.reorder_scopes = {
  title: 'Sắp xếp thứ tự phạm vi',
  description: '`order` là danh sách tên (hoặc id) phạm vi theo thứ tự mong muốn; phạm vi không nêu xếp sau.',
  input: z.object({ ...projectRef, order: z.array(z.string().trim().min(1).max(80)).min(1).max(200) }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; order: string[] }) => {
    const p = await editableProject(user, a);
    const all = (await D.projectBundle(p.id)).scopes;
    const picked: string[] = [];
    for (const key of a.order) {
      const s = all.find((x) => x.id === key) ?? all.find((x) => x.name.toLowerCase() === key.toLowerCase());
      if (!s) throw new ToolError(`Không có phạm vi "${key}" trong ${p.name}`);
      if (!picked.includes(s.id)) picked.push(s.id);
    }
    const ids = [...picked, ...all.map((s) => s.id).filter((id) => !picked.includes(id))];
    await D.reorderScopes(p.id, ids);
    return { project: p.name, scopes: ids.map((id) => all.find((s) => s.id === id)!.name) };
  },
};

TOOLS.get_ai_context = {
  title: 'Hướng dẫn cho AI của dự án',
  description: 'Đọc phần hướng dẫn / ngữ cảnh người dùng lưu cho AI ở dự án này (quy ước đặt tên, cách chia phạm vi, ai phụ trách gì…). Đọc trước khi tạo hay sửa việc và làm theo.',
  input: z.object({ ...projectRef }),
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await resolveProject(user, a);
    return { project: p.name, aiContext: p.aiContext || '' };
  },
};

TOOLS.set_ai_context = {
  title: 'Lưu hướng dẫn cho AI',
  description: 'Ghi phần hướng dẫn / ngữ cảnh cho AI của dự án. mode "replace" (mặc định) thay toàn bộ, "append" thêm vào cuối. Chỉ ghi khi người dùng muốn lưu lại quy ước.',
  input: z.object({ ...projectRef, text: z.string().max(20000), mode: z.enum(['replace', 'append']).optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; text: string; mode?: 'replace' | 'append' }) => {
    const p = await editableProject(user, a);
    const next = a.mode === 'append' && p.aiContext ? `${p.aiContext.trimEnd()}\n\n${a.text.trim()}` : a.text.trim();
    if (next.length > 20000) throw new ToolError('Hướng dẫn dài quá 20.000 ký tự');
    await D.updateProject(p, { aiContext: next });
    return { project: p.name, length: next.length };
  },
};

/** Phase theo id hoặc tên. */
async function phaseRef(p: { id: string; name: string }, a: { phase?: string; phaseId?: string }) {
  const all = (await D.projectBundle(p.id)).phases;
  const x = a.phaseId ? all.find((y) => y.id === a.phaseId) : a.phase?.trim() ? all.find((y) => y.name.toLowerCase() === a.phase!.trim().toLowerCase()) : undefined;
  if (!x) throw new ToolError(a.phase || a.phaseId ? `Không có phase "${a.phase ?? a.phaseId}" trong ${p.name}` : 'Cần `phase` (tên) hoặc `phaseId`');
  return x;
}
const phaseArgs = { phase: z.string().trim().max(80).optional().describe('Tên phase'), phaseId: z.uuid().optional() };

TOOLS.create_phase = {
  title: 'Tạo phase',
  description: 'Thêm một phase (giai đoạn, VD "Tháng 11") vào dự án. Các phase dùng chung cấu hình dự án (thành viên, phạm vi, nhóm, hướng dẫn AI, Getfly…). Gắn việc vào phase qua `phase` ở create_task / update_task hoặc set_tasks_phase.',
  input: z.object({ ...projectRef, name: z.string().trim().min(1).max(80), startDate: zAnyDate.optional(), endDate: zAnyDate.optional(), note: z.string().trim().max(1000).optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; name: string; startDate?: string; endDate?: string; note?: string }) => {
    const p = await editableProject(user, a);
    return { project: p.name, phase: await D.createPhase(p.id, { name: a.name, startDate: date(a.startDate), endDate: date(a.endDate), note: a.note }) };
  },
};

TOOLS.update_phase = {
  title: 'Sửa phase',
  description: 'Đổi tên (`newName`), ngày bắt đầu / kết thúc hoặc ghi chú của một phase.',
  input: z.object({ ...projectRef, ...phaseArgs, newName: z.string().trim().min(1).max(80).optional(), startDate: zAnyDate.nullable().optional(), endDate: zAnyDate.nullable().optional(), note: z.string().trim().max(1000).optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; phase?: string; phaseId?: string; newName?: string; startDate?: string | null; endDate?: string | null; note?: string }) => {
    const p = await editableProject(user, a);
    const x = await phaseRef(p, a);
    const patch: Record<string, unknown> = {};
    if (a.newName) patch.name = a.newName;
    if (a.startDate !== undefined) patch.startDate = date(a.startDate);
    if (a.endDate !== undefined) patch.endDate = date(a.endDate);
    if (a.note !== undefined) patch.note = a.note;
    if (!Object.keys(patch).length) throw new ToolError('Cần newName, startDate, endDate hoặc note');
    return { project: p.name, phase: await D.updatePhase(p.id, x.id, patch) };
  },
};

TOOLS.delete_phase = {
  title: 'Xoá phase',
  description: 'Xoá một phase. Mặc định việc trong phase chuyển thành "chưa có phase"; `deleteTasks: true` xoá luôn các việc. Chỉ gọi khi người dùng nói rõ.',
  input: z.object({ ...projectRef, ...phaseArgs, deleteTasks: z.boolean().optional() }),
  write: true, destructive: true, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; phase?: string; phaseId?: string; deleteTasks?: boolean }) => {
    const p = await editableProject(user, a);
    const x = await phaseRef(p, a);
    return { project: p.name, deleted: x.name, ...(await D.deletePhase(p.id, x.id, !!a.deleteTasks)) };
  },
};

TOOLS.set_tasks_phase = {
  title: 'Gán việc vào phase',
  description: 'Chuyển nhiều việc vào một phase: `taskIds` cụ thể, hoặc `unphased: true` = mọi việc chưa có phase. `phase: ""` = bỏ phase.',
  input: z.object({ ...projectRef, phase: z.string().trim().max(80).describe('Tên phase đích; "" = bỏ phase'), taskIds: z.array(z.uuid()).max(500).optional(), unphased: z.boolean().optional() }),
  write: true, destructive: false, perm: 'project.task.write',
  run: async (user, a: { projectId?: string; project?: string; phase: string; taskIds?: string[]; unphased?: boolean }) => {
    const p = await editableProject(user, a);
    if (!a.taskIds?.length && !a.unphased) throw new ToolError('Cần taskIds hoặc unphased: true');
    const perms = await effectivePermissions(rolesOf(user));
    const phaseId = (await phaseByName(perms, p.id, a.phase)) ?? null;
    return { project: p.name, phase: a.phase || null, ...(await D.setTasksPhase(p.id, phaseId, a.unphased ? 'unphased' : a.taskIds!)) };
  },
};

TOOLS.merge_project_into_phase = {
  title: 'Gộp dự án khác vào làm phase',
  description: 'Gộp `sourceProject` vào dự án đích thành phase `sourcePhase` (VD gộp "AMMS tháng 11" vào "AMMS" thành phase "Tháng 11"). `targetPhase` (tuỳ chọn) gán cho các việc hiện chưa có phase của dự án đích. Nhóm / phạm vi ghép theo tên, thành viên được thêm; dự án nguồn bị lưu trữ (không xoá). Phải là chủ cả hai dự án. Chỉ gọi khi người dùng nói rõ.',
  input: z.object({ ...projectRef, sourceProject: z.string().trim().min(1).max(160).describe('Tên hoặc id dự án nguồn'), sourcePhase: z.string().trim().min(1).max(80), targetPhase: z.string().trim().max(80).optional() }),
  write: true, destructive: true, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; sourceProject: string; sourcePhase: string; targetPhase?: string }) => {
    const target = await resolveProject(user, a);
    D.owned(target);
    const isId = /^[0-9a-f-]{36}$/i.test(a.sourceProject);
    const source = await resolveProject(user, isId ? { projectId: a.sourceProject } : { project: a.sourceProject });
    D.owned(source);
    return { project: target.name, ...(await D.mergeProjectAsPhase(target.id, source.id, a.sourcePhase, a.targetPhase)) };
  },
};

TOOLS.delete_project = {
  title: 'Xoá dự án',
  description: 'Xoá hẳn một dự án cùng mọi nhóm, việc và lịch sử (không hoàn tác). Chỉ chủ dự án. Phải gửi `confirmName` đúng tên dự án; chỉ gọi khi người dùng nói rõ muốn xoá.',
  input: z.object({ ...projectRef, confirmName: z.string().trim().min(1).max(160).describe('Gõ lại đúng tên dự án để xác nhận') }),
  write: true, destructive: true, perm: 'project.project.delete',
  run: async (user, a: { projectId?: string; project?: string; confirmName: string }) => {
    const p = await resolveProject(user, a);
    D.owned(p);
    if (a.confirmName.trim().toLowerCase() !== p.name.trim().toLowerCase()) throw new ToolError(`confirmName phải đúng tên dự án "${p.name}"`);
    await D.deleteProject(p.id);
    return { deleted: p.name };
  },
};

TOOLS.set_member = {
  title: 'Mời / đổi quyền thành viên',
  description: 'Mời người vào dự án theo email VNLab ID, hoặc đổi vai trò nếu đã là thành viên: editor (được sửa) hoặc viewer (chỉ xem). Chỉ chủ dự án.',
  input: z.object({ ...projectRef, email: z.email().max(200), role: z.enum(['editor', 'viewer']) }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; email: string; role: 'editor' | 'viewer' }) => {
    const p = await resolveProject(user, a);
    D.owned(p);
    return { project: p.name, ...(await D.upsertMember(p, a.email, a.role, user.id)) };
  },
};

TOOLS.remove_member = {
  title: 'Gỡ thành viên',
  description: 'Gỡ một thành viên khỏi dự án theo email (chỉ chủ dự án). Chỉ gọi khi người dùng nói rõ.',
  input: z.object({ ...projectRef, email: z.email().max(200) }),
  write: true, destructive: true, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; email: string }) => {
    const p = await resolveProject(user, a);
    D.owned(p);
    await D.removeMember(p, a.email);
    return { project: p.name, removed: a.email.toLowerCase() };
  },
};

TOOLS.update_group = {
  title: 'Sửa nhóm việc',
  description: 'Đổi tên nhóm (`newName`) và/hoặc thu gọn / mở nhóm trên Gantt (`collapsed`).',
  input: z.object({ ...projectRef, ...groupArgs, newName: z.string().trim().min(1).max(160).optional(), collapsed: z.boolean().optional() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; group?: string; groupId?: string; newName?: string; collapsed?: boolean }) => {
    const p = await editableProject(user, a);
    const g = await groupRef(p, a);
    const patch: { name?: string; collapsed?: boolean } = {};
    if (a.newName) patch.name = a.newName;
    if (a.collapsed !== undefined) patch.collapsed = a.collapsed;
    if (!Object.keys(patch).length) throw new ToolError('Cần newName hoặc collapsed');
    return { project: p.name, group: await D.updateGroup(p.id, g.id, patch) };
  },
};

TOOLS.reorder_groups = {
  title: 'Sắp xếp thứ tự nhóm',
  description: 'Đặt thứ tự nhóm việc như kéo thả trên Gantt. `order` là danh sách tên (hoặc id) nhóm theo thứ tự mong muốn; nhóm không nêu giữ thứ tự cũ và xếp sau.',
  input: z.object({ ...projectRef, order: z.array(z.string().trim().min(1).max(160)).min(1).max(500) }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; order: string[] }) => {
    const p = await editableProject(user, a);
    const groups = (await D.projectBundle(p.id)).groups;
    const picked: string[] = [];
    for (const key of a.order) {
      const k = key.toLowerCase();
      const g = groups.find((x) => x.id === key) ?? groups.find((x) => x.name.trim().toLowerCase() === k);
      if (!g) throw new ToolError(`Không có nhóm "${key}" trong ${p.name}`);
      if (!picked.includes(g.id)) picked.push(g.id);
    }
    const ids = [...picked, ...groups.map((g) => g.id).filter((id) => !picked.includes(id))];
    await D.reorderGroups(p.id, ids);
    return { project: p.name, groups: ids.map((id) => groups.find((g) => g.id === id)!.name) };
  },
};

TOOLS.transfer_tasks = {
  title: 'Chuyển việc sang dự án khác',
  description: 'Chuyển các việc được chọn từ dự án nguồn sang dự án đích. Đọc get_project của cả hai trước khi gọi, chỉ dùng taskIds người dùng đã chọn. Giữ id, task con, phụ trách, hỗ trợ, tiến độ, ngày, ghi chú, kế hoạch gốc, lịch sử và liên kết Getfly. Giữ nhóm/phạm vi theo tên (tạo ở đích nếu thiếu); không ghi đè cấu hình nhóm đã có. Cần quyền sửa cả hai dự án. Không xoá dự án/nhóm nguồn và không tự gọi Getfly.',
  input: z.object({ ...projectRef, targetProjectId: z.uuid().optional(), targetProject: z.string().trim().max(160).optional().describe('Tên hoặc mã dự án đích'), taskIds: z.array(z.uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, 'Mã việc bị lặp') }),
  write: true, destructive: false, perm: 'project.task.write',
  run: async (user, a: { projectId?: string; project?: string; targetProjectId?: string; targetProject?: string; taskIds: string[] }) => {
    const source = await editableProject(user, a);
    const target = await editableProject(user, { projectId: a.targetProjectId, project: a.targetProject });
    const perms = await effectivePermissions(rolesOf(user));
    if (!perms.has('project.project.write')) throw new ToolError('Cần quyền sửa cấu trúc dự án để chuyển nhóm và phạm vi đi cùng việc');
    if (getflyJob(source.id)?.status === 'running' || getflyJob(target.id)?.status === 'running') throw new ToolError('Đợi đồng bộ Getfly xong trước khi chuyển việc');
    const tasks = await withGetflyProjectsLocked([source.id, target.id], () => D.transferTasks(source, target, a.taskIds, user.id));
    return { sourceProject: { id: source.id, name: source.name }, targetProject: { id: target.id, name: target.name }, moved: tasks.length, tasks, note: 'Đã chuyển việc; Google Sheet tự cập nhật nếu bật tự đồng bộ. Getfly chỉ cập nhật khi bạn bấm đồng bộ ở dự án đích.' };
  },
};

TOOLS.move_task = {
  title: 'Chuyển / đổi thứ tự việc',
  description: 'Đổi vị trí một việc như kéo thả: đặt trước `beforeTaskId`, sau `afterTaskId`, hoặc ở `position` (1 = đầu nhóm). Có `group`/`groupId` thì chuyển sang nhóm đó (group: "" = Chưa phân nhóm). Không nêu vị trí thì đặt cuối nhóm.',
  input: z.object({
    taskId: z.uuid(), group: z.string().trim().max(160).optional().describe('Nhóm đích (tên); "" = Chưa phân nhóm'), groupId: z.uuid().optional(),
    beforeTaskId: z.uuid().optional(), afterTaskId: z.uuid().optional(), position: z.number().int().min(1).optional(),
  }),
  write: true, destructive: false, perm: 'project.task.write',
  run: async (user, a: { taskId: string; group?: string; groupId?: string; beforeTaskId?: string; afterTaskId?: string; position?: number }) => {
    const { task, project: p } = await D.taskOf(user, a.taskId);
    D.editable(p);
    const bundle = await D.projectBundle(p.id);
    const anchorId = a.beforeTaskId ?? a.afterTaskId;
    const anchor = anchorId ? bundle.tasks.find((t) => t.id === anchorId) : undefined;
    if (anchorId && !anchor) throw new ToolError('Không thấy việc mốc (beforeTaskId / afterTaskId) trong cùng dự án');
    let groupId: string | null = task.groupId ?? null;
    if (a.groupId || a.group !== undefined) groupId = a.group === '' && !a.groupId ? null : (await groupRef(p, a)).id;
    else if (anchor) groupId = anchor.groupId ?? null;
    if (anchor && (anchor.groupId ?? null) !== groupId) throw new ToolError('Việc mốc nằm ở nhóm khác nhóm đích');
    const ids = bundle.tasks.filter((t) => (t.groupId ?? null) === groupId && t.id !== task.id).map((t) => t.id);
    let at = ids.length;
    if (anchor) at = ids.indexOf(anchor.id) + (a.afterTaskId ? 1 : 0);
    else if (a.position) at = Math.min(ids.length, a.position - 1);
    ids.splice(at, 0, task.id);
    await D.reorderTasks(p.id, groupId, ids);
    const groupName = groupId ? bundle.groups.find((g) => g.id === groupId)?.name ?? null : null;
    return { project: p.name, task: task.name, group: groupName ?? 'Chưa phân nhóm', position: at + 1, of: ids.length };
  },
};

TOOLS.rebaseline_task = {
  title: 'Chốt kế hoạch gốc',
  description: 'Lấy ngày bắt đầu / kết thúc hiện tại của việc làm kế hoạch gốc mới (xoá dấu "+N ngày" dời / gia hạn). Chỉ gọi khi người dùng muốn chốt lại kế hoạch.',
  input: z.object({ taskId: z.uuid() }),
  write: true, destructive: false, perm: 'project.task.write',
  run: async (user, a: { taskId: string }) => {
    const { task, project: p } = await D.taskOf(user, a.taskId);
    D.editable(p);
    await D.rebaselineTask(p.id, task.id, user.id);
    return { project: p.name, task: task.name, baseline: { start: task.startDate, end: task.endDate } };
  },
};

TOOLS.get_task_history = {
  title: 'Lịch sử thay đổi của việc',
  description: 'Các lần đổi tên, ngày, tiến độ, phụ trách… của một việc: ai đổi, lúc nào, giá trị cũ → mới.',
  input: z.object({ taskId: z.uuid(), limit: z.number().int().min(1).max(100).optional() }),
  run: async (user, a: { taskId: string; limit?: number }) => {
    const { task, project: p } = await D.taskOf(user, a.taskId);
    return { project: p.name, task: task.name, history: await D.taskHistory(p.id, task.id, a.limit ?? 50) };
  },
};

TOOLS.set_google_sheet = {
  title: 'Liên kết Google Sheet',
  description: 'Liên kết dự án với một Google Sheet (link hoặc id; sheet phải chia sẻ quyền Người chỉnh sửa cho email service account trong Cài đặt), bật/tắt tự đồng bộ, chọn thu gọn task con, hoặc gỡ liên kết (sheetUrl: null). Chỉ chủ dự án.',
  input: z.object({ ...projectRef, sheetUrl: z.string().trim().max(400).nullable().optional(), auto: z.boolean().optional().describe('Tự đồng bộ sau mỗi thay đổi'), collapseSubtasks: z.boolean().optional().describe('Thu gọn task con khi đồng bộ; mặc định bật') }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; sheetUrl?: string | null; auto?: boolean; collapseSubtasks?: boolean }) => {
    const p = await resolveProject(user, a);
    D.owned(p);
    const patch: Record<string, unknown> = {};
    if (a.sheetUrl !== undefined) {
      if (!a.sheetUrl) Object.assign(patch, { sheetId: null, sheetSyncedAt: null, sheetError: null, sheetAuto: false });
      else {
        const id = parseSheetId(a.sheetUrl);
        if (!id) throw new ToolError('Không nhận ra link Google Sheet (dạng https://docs.google.com/spreadsheets/d/…)');
        Object.assign(patch, { sheetId: id, sheetError: null, sheetAuto: a.auto ?? true });
      }
    }
    if (a.auto !== undefined) patch.sheetAuto = a.auto;
    if (a.collapseSubtasks !== undefined) patch.sheetCollapseSubtasks = a.collapseSubtasks;
    if (!Object.keys(patch).length) throw new ToolError('Cần sheetUrl, auto hoặc collapseSubtasks');
    const row = await D.updateProject(p, patch);
    const v = D.projectView(row);
    return { project: p.name, sheetUrl: v.sheetUrl, auto: v.sheetAuto, collapseSubtasks: v.sheetCollapseSubtasks, note: v.sheetUrl ? 'Gọi sync_google_sheet để ghi ngay lần đầu' : 'Đã gỡ liên kết' };
  },
};

TOOLS.set_google_calendar = {
  title: 'Liên kết Google Calendar',
  description: 'Liên kết dự án với một Google Calendar (Mã lịch dạng …@group.calendar.google.com / email, hoặc link có src= / cid=). Lịch phải chia sẻ quyền "Thay đổi sự kiện" cho email service account (Cài đặt). Mỗi việc có ngày thành một sự kiện cả ngày, tự đồng bộ sau mỗi thay đổi. calendar: null = bỏ liên kết (xoá các sự kiện app đã tạo). Chỉ chủ dự án.',
  input: z.object({ ...projectRef, calendar: z.string().trim().max(600).nullable() }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; calendar: string | null }) => {
    const p = await resolveProject(user, a);
    D.owned(p);
    let patch: Record<string, unknown>;
    if (!a.calendar) {
      if (p.gcalId) await clearCalendar(p.id, p.gcalId).catch(() => undefined);
      patch = { gcalId: null, gcalSyncedAt: null, gcalError: null };
    } else {
      const id = parseCalendarId(a.calendar);
      if (!id) throw new ToolError('Không nhận ra lịch — cần Mã lịch (…@group.calendar.google.com hoặc email) trong Cài đặt lịch của Google Calendar');
      if (p.gcalId && p.gcalId !== id) await clearCalendar(p.id, p.gcalId).catch(() => undefined);
      patch = { gcalId: id, gcalError: null, ...(p.gcalId !== id ? { gcalSyncedAt: null } : {}) };
    }
    const [row] = await sql<D.ProjectRow[]>`update projects set ${sql(patch)} where id = ${p.id} returning *`;
    const v = D.projectView(row);
    return { project: p.name, calendarId: v.gcalId, calendarUrl: v.gcalUrl, note: v.gcalId ? 'Gọi sync_google_calendar để ghi ngay lần đầu' : 'Đã gỡ liên kết và xoá sự kiện app đã tạo' };
  },
};

TOOLS.sync_google_calendar = {
  title: 'Đồng bộ Google Calendar',
  description: 'Ghi ngay các việc có ngày của dự án thành sự kiện cả ngày trên Google Calendar đã liên kết (tạo / sửa / xoá cho khớp). Trả về số sự kiện tạo, sửa, xoá.',
  input: z.object({ ...projectRef }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await editableProject(user, a);
    if (!p.gcalId) throw new ToolError(`Dự án "${p.name}" chưa liên kết Google Calendar — chủ dự án liên kết trong Cài đặt dự án (hoặc set_google_calendar) trước`);
    const r = await syncCalendar(p.id);
    return { project: p.name, calendarId: p.gcalId, ...r };
  },
};

TOOLS.get_export_link = {
  title: 'Link xuất Excel / CSV',
  description: 'Trả link tải file kế hoạch (Excel theo mẫu Gantt, CSV hoặc JSON) để người dùng mở trên trình duyệt đã đăng nhập.',
  input: z.object({ ...projectRef, format: z.enum(['xlsx', 'csv', 'json']).optional(), columns: z.array(z.enum(ALL_COLUMNS)).max(20).optional() }),
  run: async (user, a: { projectId?: string; project?: string; format?: 'xlsx' | 'csv' | 'json'; columns?: string[] }) => {
    const p = await resolveProject(user, a);
    const q = new URLSearchParams({ format: a.format ?? 'xlsx' });
    if (a.columns?.length) q.set('cols', normalizeColumns(a.columns).join(','));
    return { project: p.name, url: `https://project.vnlab.id.vn/api/projects/${p.id}/export?${q}` };
  },
};

TOOLS.set_getfly = {
  title: 'Cấu hình đồng bộ Getfly',
  description: 'Đặt việc cha trên Getfly CRM (dán link #/tasks/?…task_id=…, id hoặc mã việc). Cây trên Getfly: việc cha -> mỗi nhóm việc một việc (tự tạo, hoặc gắn việc có sẵn qua `groups`) -> việc -> task con; tên dự án Getfly; ghép tên người phụ trách -> username Getfly (users: {"Đức": "ducnp"}).',
  input: z.object({ ...projectRef, parent: z.string().trim().max(500).optional().describe('Link / id / mã việc cha trên Getfly; "" = bỏ. Dự án Getfly lấy theo việc cha'), creatorId: z.string().trim().max(20).optional().describe('Id người dùng Getfly đứng tên người tạo việc (bắt buộc để đồng bộ)'), users: z.record(z.string().max(160), z.string().trim().max(120)).optional().describe('Tên người phụ trách -> id người dùng Getfly (gửi đầy đủ). Xem get_getfly_users'), groups: z.record(z.string().max(160), z.string().trim().max(500)).optional().describe('Tên nhóm việc -> link / id / mã việc có sẵn trên Getfly làm việc cha của nhóm (chung mọi phase); "" = bỏ gắn'), phaseGroups: z.record(z.string().max(80), z.record(z.string().max(160), z.string().trim().max(500))).optional().describe('Việc cha riêng theo phase: { "Tháng 11": { "Giao hàng": link/id/mã } } — ưu tiên hơn việc cha chung của nhóm; "" = bỏ') }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string; parent?: string; creatorId?: string; users?: Record<string, string>; groups?: Record<string, string>; phaseGroups?: Record<string, Record<string, string>> }) => {
    const p = await editableProject(user, a);
    const patch: Record<string, unknown> = {};
    if (a.parent !== undefined) {
      if (!a.parent) Object.assign(patch, { getflyParentCode: '', getflyParentName: '', getflyParentId: null, getflyProjectId: '', getflyProjectName: '' });
      else {
        const t = await findGetflyTask(a.parent);
        Object.assign(patch, { getflyParentCode: t.code, getflyParentName: t.name, getflyParentId: t.id, getflyProjectId: t.projectId, getflyProjectName: t.projectName });
      }
    }
    if (a.creatorId !== undefined) patch.getflyCreatorId = a.creatorId;
    if (a.users !== undefined) patch.getflyUsers = a.users;
    if (a.groups !== undefined) {
      const next = { ...(p.getflyGroups ?? {}) };
      for (const [gname, ref] of Object.entries(a.groups)) {
        const g = await D.findGroup(p.id, gname);
        if (!g) throw new ToolError(`Không có nhóm "${gname}" trong ${p.name}`);
        if (!ref) { delete next[g.id]; continue; }
        const t = await findGetflyTask(ref);
        next[g.id] = { id: t.id, code: t.code, name: t.name };
      }
      patch.getflyGroups = next;
    }
    if (a.phaseGroups !== undefined) {
      const next = { ...((patch.getflyGroups as typeof p.getflyGroups | undefined) ?? p.getflyGroups ?? {}) };
      for (const [pname, byGroup] of Object.entries(a.phaseGroups)) {
        const ph = await D.findPhase(p.id, pname);
        if (!ph) throw new ToolError(`Không có phase "${pname}" trong ${p.name}`);
        for (const [gname, ref] of Object.entries(byGroup)) {
          const g = await D.findGroup(p.id, gname);
          if (!g) throw new ToolError(`Không có nhóm "${gname}" trong ${p.name}`);
          const key = `${ph.id}:${g.id}`;
          if (!ref) { delete next[key]; continue; }
          const t = await findGetflyTask(ref);
          next[key] = { id: t.id, code: t.code, name: t.name };
        }
      }
      patch.getflyGroups = next;
    }
    if (!Object.keys(patch).length) throw new ToolError('Cần parent, creatorId, users, groups hoặc phaseGroups');
    const row = await D.updateProject(p, patch);
    return { project: p.name, getfly: { parentCode: row.getflyParentCode, parentName: row.getflyParentName, projectName: row.getflyProjectName, creatorId: row.getflyCreatorId, users: row.getflyUsers } };
  },
};

TOOLS.get_getfly_users = {
  title: 'Người dùng Getfly',
  description: 'Danh sách người dùng Getfly (id, tên, email, phòng ban) để ghép người phụ trách hoặc chọn người tạo trong set_getfly.',
  input: z.object({}),
  run: async () => ({ users: await getflyUsers() }),
};

TOOLS.get_getfly_job = {
  title: 'Tiến độ đồng bộ Getfly',
  description: 'Job đồng bộ / gỡ Getfly gần nhất của dự án: running / done / error, đã xử lý bao nhiêu trên tổng, kết quả.',
  input: z.object({ ...projectRef }),
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await resolveProject(user, a);
    return { project: p.name, job: getflyJob(p.id) };
  },
};

TOOLS.unsync_getfly = {
  title: 'Gỡ dự án khỏi Getfly',
  description: 'Xoá mọi việc app đã tạo trên Getfly cho dự án (không đụng việc cha hay việc có sẵn đã gắn cho nhóm). Chỉ gọi khi người dùng nói rõ.',
  input: z.object({ ...projectRef }),
  write: true, destructive: true, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await editableProject(user, a);
    const job = await waitGetflyJob(startGetflyJob(p.id, 'unsync'), 20_000);
    return { project: p.name, job, note: job.status === 'running' ? 'Đang chạy nền — gọi get_getfly_job để xem tiến độ' : undefined };
  },
};

TOOLS.sync_getfly = {
  title: 'Đồng bộ sang Getfly',
  description: 'Đẩy việc của dự án sang Getfly CRM: tạo việc mới, sửa việc đã đổi, xoá việc đã xoá. Không đồng bộ tiến độ hay trạng thái hoàn thành (API Getfly không cho). Task con thành việc con dưới việc tương ứng. Như bấm nút "Đồng bộ Getfly".',
  input: z.object({ ...projectRef }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await editableProject(user, a);
    const job = await waitGetflyJob(startGetflyJob(p.id, 'sync'), 20_000);
    return { project: p.name, job, note: job.status === 'running' ? 'Đang chạy nền — gọi get_getfly_job để xem tiến độ' : undefined };
  },
};

TOOLS.sync_google_sheet = {
  title: 'Đồng bộ Google Sheet',
  description: 'Ghi kế hoạch của dự án (bảng việc + lưới Gantt) sang Google Sheet đã liên kết trong Cài đặt dự án. Trả về link sheet.',
  input: z.object({ ...projectRef }),
  write: true, destructive: false, perm: 'project.project.write',
  run: async (user, a: { projectId?: string; project?: string }) => {
    const p = await editableProject(user, a);
    if (!p.sheetId) throw new ToolError(`Dự án "${p.name}" chưa liên kết Google Sheet — chủ dự án liên kết trong Cài đặt dự án trước`);
    const r = await syncProject(p.id);
    return { project: p.name, sheetUrl: r.url, syncedAt: r.syncedAt };
  },
};

export const toolList = () => Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, write: !!t.write }));

/** Chạy một công cụ: kiểm quyền tính năng, validate input, đổi lỗi HTTP thành ToolError. */
const FIELD_VI: Record<string, string> = { name: 'tên', assignee: 'phụ trách', support: 'hỗ trợ', progress: 'tiến độ', startDate: 'bắt đầu', endDate: 'kết thúc', days: 'ngày công', note: 'ghi chú', group: 'nhóm', subtasks: 'task con' };
/** Mô tả ngắn (tiếng Việt) cho thông báo trên giao diện: "Thêm việc “X”", "Sửa việc (tiến độ)". */
function describeTool(name: string, a: Record<string, unknown> | null): string {
  const q = (v: unknown) => (typeof v === 'string' && v.trim() ? `“${v.trim().slice(0, 60)}”` : '');
  switch (name) {
    case 'create_project': return `Tạo dự án ${q(a?.name)}`.trim();
    case 'create_group': return `Thêm nhóm ${q(a?.name)}`.trim();
    case 'create_task': return `Thêm việc ${q(a?.name)}`.trim();
    case 'create_tasks': return `Thêm ${Array.isArray(a?.tasks) ? a.tasks.length : 'nhiều'} việc`;
    case 'update_task': {
      const fields = Object.keys(a ?? {}).filter((k) => !['taskId', 'projectId', 'project'].includes(k)).map((k) => FIELD_VI[k] ?? k);
      return `Sửa việc${fields.length ? ` (${fields.join(', ')})` : ''}`;
    }
    case 'delete_task': return 'Xoá việc';
    case 'delete_group': return `Xoá nhóm ${q(a?.group)}`.trim();
    case 'update_project': return 'Sửa thông tin dự án';
    case 'create_scope': return `Tạo phạm vi ${q(a?.name)}`.trim();
    case 'update_scope': return `Sửa phạm vi ${q(a?.scope)}`.trim();
    case 'delete_scope': return `Xoá phạm vi ${q(a?.scope)}`.trim();
    case 'reorder_scopes': return 'Sắp xếp thứ tự phạm vi';
    case 'set_ai_context': return 'Lưu hướng dẫn cho AI';
    case 'create_phase': return `Tạo phase ${q(a?.name)}`.trim();
    case 'update_phase': return `Sửa phase ${q(a?.phase)}`.trim();
    case 'delete_phase': return `Xoá phase ${q(a?.phase)}`.trim();
    case 'set_tasks_phase': return `Gán việc vào phase ${q(a?.phase)}`.trim();
    case 'merge_project_into_phase': return `Gộp ${q(a?.sourceProject)} thành phase ${q(a?.sourcePhase)}`;
    case 'set_getfly': return 'Cấu hình Getfly';
    case 'sync_getfly': return 'Đồng bộ Getfly';
    case 'unsync_getfly': return 'Gỡ dự án khỏi Getfly';
    case 'delete_project': return 'Xoá dự án';
    case 'set_member': return `Mời / đổi quyền ${typeof a?.email === 'string' ? a.email : ''}`.trim();
    case 'remove_member': return `Gỡ thành viên ${typeof a?.email === 'string' ? a.email : ''}`.trim();
    case 'update_group': return `Sửa nhóm ${q(a?.group)}`.trim();
    case 'reorder_groups': return 'Sắp xếp thứ tự nhóm';
    case 'move_task': return 'Chuyển / đổi thứ tự việc';
    case 'transfer_tasks': return `Chuyển ${Array.isArray(a?.taskIds) ? a.taskIds.length : ''} việc sang dự án khác`;
    case 'rebaseline_task': return 'Chốt kế hoạch gốc';
    case 'set_google_sheet': return 'Liên kết Google Sheet';
    case 'sort_tasks': return 'Sắp xếp việc theo ngày';
    case 'sync_google_sheet': return 'Đồng bộ Google Sheet';
    case 'set_google_calendar': return 'Liên kết Google Calendar';
    case 'sync_google_calendar': return 'Đồng bộ Google Calendar';
    default: return TOOLS[name]?.title ?? name;
  }
}

export async function runTool(user: D.UserRow, name: string, args: unknown) {
  const t = TOOLS[name];
  if (!t) throw new ToolError(`Không có công cụ ${name}`);
  const ctx = D.actorContext.getStore();
  if (ctx) {
    ctx.action = describeTool(name, args && typeof args === 'object' ? (args as Record<string, unknown>) : null);
    ctx.seen = new Set();
    ctx.emitted = new Set();
  }
  if (t.perm) {
    const perms = await effectivePermissions(rolesOf(user));
    if (!perms.has(t.perm)) throw new ToolError(`Bạn chưa có quyền "${t.perm}" trong Project — nhờ quản trị viên cấp ở VNLab Account`);
  }
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) throw new ToolError(`Dữ liệu không hợp lệ: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(gốc)'}: ${i.message}`).join('; ')}`);
  try {
    const out = await t.run(user, parsed.data as never);
    // Bảo đảm 100% lệnh ghi qua MCP đều báo lên giao diện: dự án nào lệnh đã chạm tới mà chưa phát `changed`
    // (vd. sắp xếp khi thứ tự đã đúng, đồng bộ Sheet) thì phát bù một lần.
    if (t.write && ctx) for (const pid of ctx.seen ?? []) if (!ctx.emitted?.has(pid)) D.emitChanged(pid);
    return out;
  } catch (err) {
    if (err instanceof HTTPException) throw new ToolError(err.message);
    if (err instanceof z.ZodError) throw new ToolError(`Dữ liệu không hợp lệ: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    throw err;
  }
}
