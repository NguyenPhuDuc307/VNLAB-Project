// Công cụ cho AI qua MCP (server/mcp.ts). Mỗi công cụ là (user, input) -> JSON và
// dùng chung tầng dữ liệu với REST (server/data.ts) nên AI và giao diện không
// bao giờ lệch nhau. Quyền tính năng (project.*) kiểm như REST; quyền theo dự án
// (chủ / được sửa / chỉ xem) kiểm trong data.ts.
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import * as D from './data.ts';
import { parseDate, today } from './dates.ts';
import { effectivePermissions, rolesOf } from './rbac.ts';
import { syncProject } from './sheets.ts';
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

const taskOut = (t: ReturnType<typeof D.taskView>, p: { satWeight: number; sunWeight: number }, groups: Map<string, string>, t0: string) => ({
  subtasks: t.subtasks,
  id: t.id, name: t.name, group: t.groupId ? groups.get(t.groupId) ?? null : null, groupId: t.groupId,
  assignee: t.assignee, support: t.support, progress: t.progress, startDate: t.startDate, endDate: t.endDate,
  days: D.effortOf(t, p), daysManual: t.days != null, note: t.note,
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
    input: z.object({ ...projectRef, includeDone: z.boolean().optional().describe('Gồm cả việc đã xong (mặc định có)') }),
    run: async (user, a: { projectId?: string; project?: string; includeDone?: boolean }) => {
      const p = await resolveProject(user, a);
      const [bundle, who] = await Promise.all([D.projectBundle(p.id), D.projectMembers(p)]);
      const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
      const t0 = today();
      const tasks = bundle.tasks.map((t) => taskOut(t, p, groups, t0)).filter((t) => a.includeDone !== false || t.status !== 'done');
      return {
        today: t0, id: p.id, name: p.name, code: p.code, customer: p.customer, description: p.description, startDate: p.startDate, archived: p.archived, myRole: p.myRole,
        owner: who.owner.name || who.owner.email, members: who.members.map((m) => ({ email: m.email, name: m.name, role: m.role })),
        groups: bundle.groups.map((g) => ({ id: g.id, name: g.name, taskCount: bundle.tasks.filter((t) => t.groupId === g.id).length })),
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
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: async (user, a: { projectId?: string; project?: string; query?: string; assignee?: string; status?: string; dueBefore?: string; limit?: number }) => {
      const projects = a.projectId || a.project ? [await resolveProject(user, a)] : await D.myProjects(user);
      const t0 = today();
      const due = date(a.dueBefore);
      const q = a.query?.toLowerCase(), who = a.assignee?.toLowerCase();
      const out: unknown[] = [];
      for (const p of projects) {
        if (p.archived && !(a.projectId || a.project)) continue;
        const bundle = await D.projectBundle(p.id);
        const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
        for (const t of bundle.tasks) {
          const v = taskOut(t, p, groups, t0);
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
  create_task: {
    title: 'Tạo việc',
    description: 'Thêm một việc vào dự án. `group` là tên nhóm (chưa có thì tạo); không có thì việc nằm ở "Chưa phân nhóm". Không tự bịa ngày: chỉ đặt ngày khi người dùng nói.',
    input: z.object({ ...projectRef, name: z.string().trim().min(1).max(300), group: z.string().trim().max(160).optional().describe('Tên nhóm việc'), groupId: z.uuid().optional(), ...taskBody }),
    write: true, destructive: false, perm: 'project.task.write',
    run: async (user, a: { projectId?: string; project?: string; name: string; group?: string; groupId?: string } & Record<string, unknown>) => {
      const p = await editableProject(user, a);
      const perms = await effectivePermissions(rolesOf(user));
      const groupId = a.groupId ?? (await groupByName(user, perms, p.id, a.group));
      const t = await D.insertTask(p.id, D.taskCreate.parse({ groupId: groupId ?? null, name: a.name, assignee: a.assignee, support: a.support, progress: a.progress, startDate: date(a.startDate as string), endDate: date(a.endDate as string), days: a.days ?? null, note: a.note, subtasks: a.subtasks }));
      const groups = new Map((await D.projectBundle(p.id)).groups.map((g) => [g.id, g.name]));
      return { project: p.name, task: taskOut(t, p, groups, today()), url: `https://project.vnlab.id.vn/du-an/${p.id}?task=${t.id}` };
    },
  },
  create_tasks: {
    title: 'Tạo nhiều việc',
    description: 'Thêm nhiều việc một lần (VD cả kế hoạch): mỗi việc có thể ghi tên nhóm; nhóm chưa có thì tạo theo thứ tự xuất hiện.',
    input: z.object({
      ...projectRef,
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
        byGroup.get(key)!.tasks.push(D.taskCreate.omit({ groupId: true }).parse({ name: t.name, assignee: t.assignee, support: t.support, progress: t.progress, startDate: date(t.startDate as string), endDate: date(t.endDate as string), days: t.days ?? null, note: t.note, subtasks: t.subtasks }));
      }
      const r = await D.importGroups(p.id, [...byGroup.values()]);
      return { project: p.name, groupsCreated: r.groups, tasksCreated: r.tasks, url: `https://project.vnlab.id.vn/du-an/${p.id}` };
    },
  },
  update_task: {
    title: 'Sửa việc',
    description: 'Đổi tên, tiến độ, người phụ trách/hỗ trợ, ngày, ngày công, ghi chú hoặc chuyển nhóm của một việc (theo taskId từ get_project / find_tasks). Chỉ gửi trường cần đổi.',
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
      if (a.note !== undefined) patch.note = a.note as string;
      if (a.group !== undefined) {
        const perms = await effectivePermissions(rolesOf(user));
        patch.groupId = a.group.trim() ? await groupByName(user, perms, p.id, a.group) : null;
      }
      const t = await D.updateTask(p.id, task.id, D.taskFields.partial().parse(patch), user.id);
      const groups = new Map((await D.projectBundle(p.id)).groups.map((g) => [g.id, g.name]));
      return { project: p.name, task: taskOut(t, p, groups, today()) };
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
  description: 'Sắp xếp lại thứ tự việc trong một nhóm (hoặc mọi nhóm) theo ngày bắt đầu, rồi kết thúc, rồi tên. Chỉ đổi thứ tự hiển thị, không đổi ngày.',
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
export async function runTool(user: D.UserRow, name: string, args: unknown) {
  const t = TOOLS[name];
  if (!t) throw new ToolError(`Không có công cụ ${name}`);
  if (t.perm) {
    const perms = await effectivePermissions(rolesOf(user));
    if (!perms.has(t.perm)) throw new ToolError(`Bạn chưa có quyền "${t.perm}" trong Project — nhờ quản trị viên cấp ở VNLab Account`);
  }
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) throw new ToolError(`Dữ liệu không hợp lệ: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(gốc)'}: ${i.message}`).join('; ')}`);
  try {
    return await t.run(user, parsed.data as never);
  } catch (err) {
    if (err instanceof HTTPException) throw new ToolError(err.message);
    if (err instanceof z.ZodError) throw new ToolError(`Dữ liệu không hợp lệ: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    throw err;
  }
}
