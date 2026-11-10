// Đồng bộ một chiều VNLab Project -> Getfly CRM bằng nút bấm.
// Getfly của ACS (acs.getflycrm.com) chạy API v3 — đã kiểm chứng trên hệ thống thật (11/2026):
//   - Danh sách việc: GET /api/v3/tasks?limit=100&page=N (bỏ qua mọi tham số lọc), người dùng: GET /api/v3/users.
//   - Tạo: POST /api/v3/tasks { task_info: { task_name, task_start_date "Y-m-d H:i", task_end_date, task_description,
//          project_id, task_parent (id việc cha), task_type, task_weight, task_creator (bắt buộc), task_receiver } } -> { task_id }.
//   - Sửa: PUT /api/v3/tasks { task_code, task_info: {...} }. Xoá: DELETE /api/v3/tasks { task_code }.
//   - Người liên quan: people_involved: [id người dùng] nằm ngoài task_info, nhận cả khi tạo lẫn khi sửa.
//   - KHÔNG có cách đánh dấu hoàn thành qua API (task_progress / task_status đều bị từ chối): việc 100% chỉ được
//     báo để người dùng đánh dấu tay. Mô tả chỉ bổ sung danh sách task con, không gửi ghi chú nội bộ.
// Mỗi nhóm gắn một việc cha có sẵn trên Getfly -> việc chính; không đồng bộ task con.
// Chỉ đồng bộ nhóm đã gắn cha; giữ nguyên các liên kết của mục bị bỏ qua.
// Liên kết lưu ở getfly_links (id + mã Getfly + băm nội dung đã gửi) để không tạo trùng / gửi thừa.
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { sql } from './db.ts';
import * as D from './data.ts';

const base = () => (process.env.GETFLY_BASE_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = () => (process.env.GETFLY_API_KEY ?? '').trim();
export const getflyStatus = () => {
  const b = base();
  let host: string | null = null;
  try { host = b ? new URL(b).host : null; } catch { host = null; }
  return { configured: !!(host && apiKey()), host };
};

export class GetflyError extends HTTPException {}
type Json = Record<string, unknown>;
type GTask = { task_id: string; task_code: string; task_name: string; project_id: string; project_name: string; task_status: string; task_description?: string | null };

// Giới hạn dùng chung cho mọi dự án và các lần tra cha/người dùng.
let nextRequestAt = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function requestTurn() {
  while (Date.now() < nextRequestAt) await pause(nextRequestAt - Date.now());
  nextRequestAt = Date.now() + 600;
}

async function gf<T = Json>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!getflyStatus().configured) throw new GetflyError(503, { message: 'Chưa cấu hình Getfly trên máy chủ (GETFLY_BASE_URL, GETFLY_API_KEY)' });
  for (let attempt = 0; ; attempt++) {
    await requestTurn();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    let res: Response;
    let data: unknown;
    try {
      res = await fetch(`${base()}/api/v3${path}`, {
        method, signal: ctl.signal,
        headers: { 'X-API-KEY': apiKey(), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    } catch (err) {
      // Không thử lại lỗi mạng: request tạo có thể đã được Getfly nhận.
      throw new GetflyError(504, { message: `Không kết nối được Getfly: ${(err as Error).message}` });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const d = data as { message?: unknown } | null;
      const msg = typeof d?.message === 'string' ? d.message : `HTTP ${res.status}`;
      if (res.status === 429 || /too many requests/i.test(msg)) {
        const retry = res.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
        nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.max(Number.isFinite(retryMs) ? retryMs : 0, 2000 * 2 ** attempt));
        if (attempt < 3) continue;
        throw new GetflyError(429, { message: 'Getfly đang giới hạn số yêu cầu. Đợi một lát rồi thử lại.' });
      }
      if (res.status === 401 || res.status === 403) throw new GetflyError(502, { message: `Getfly từ chối API key (${msg})` });
      throw new GetflyError(res.status === 404 ? 404 : 502, { message: `Getfly: ${msg}` });
    }
    return data as T;
  }
}

const taskCache = new Map<string, { task: GTask; until: number }>();

/** Lật danh sách việc (mới -> cũ, 100 việc / trang) tới khi `found` trả true hoặc hết số trang cho phép. */
async function scanTasks(found: (t: GTask) => boolean, maxPages = 90) {
  for (let page = 1; page <= maxPages; page++) {
    const r = await gf<{ data?: GTask[]; total_page?: number }>('GET', `/tasks?limit=100&page=${page}`);
    const rows = r.data ?? [];
    for (const t of rows) {
      const cached = { task: t, until: Date.now() + 60_000 };
      taskCache.set(String(t.task_id), cached);
      taskCache.set(t.task_code, cached);
    }
    for (const t of rows) if (found(t)) return;
    if (!rows.length || (r.total_page && page >= Number(r.total_page))) return;
  }
}

/** Tra việc theo link (#/tasks/?…task_id=8689), id hoặc mã việc (CVI/2026-11/008676). */
export async function findGetflyTask(input: string) {
  const s = input.trim();
  if (!s) throw new GetflyError(400, { message: 'Nhập link, id hoặc mã việc Getfly' });
  const id = (s.match(/task_id=(\d+)/) ?? s.match(/^(\d+)$/))?.[1];
  const cached = taskCache.get(id ?? s);
  let hit: GTask | null = cached && cached.until > Date.now() ? cached.task : null;
  if (!hit) await scanTasks((t) => { if (id ? String(t.task_id) === id : t.task_code === s) { hit = t; return true; } return false; });
  if (!hit) throw new GetflyError(404, { message: `Không thấy việc Getfly ${id ? `id ${id}` : s}` });
  const t = hit as GTask;
  return { id: Number(t.task_id), code: t.task_code, name: t.task_name, projectId: String(t.project_id ?? ''), projectName: t.project_name ?? '' };
}

let usersCache: { at: number; rows: { id: string; name: string; email: string; dept: string }[] } | null = null;
/** Người dùng Getfly (để ghép người phụ trách / chọn người tạo). Lưu đệm 10 phút. */
export async function getflyUsers() {
  if (usersCache && Date.now() - usersCache.at < 600_000) return usersCache.rows;
  const r = await gf<{ data?: Json[] } | Json[]>('GET', '/users');
  const list = (Array.isArray(r) ? r : r.data ?? []) as Json[];
  const rows = list.map((u) => ({ id: String(u.id), name: String(u.name ?? ''), email: String(u.email ?? ''), dept: String(u.dept_name ?? '') }));
  usersCache = { at: Date.now(), rows };
  return rows;
}

type Link = { localId: string; parentLocal: string | null; getflyCode: string; getflyId: number | null; hash: string; completed: boolean };
export type GetflyScope = { groupId?: string; taskId?: string };
const inScope = (t: Pick<D.TaskRow, 'id' | 'groupId'>, scope: GetflyScope) => scope.taskId ? t.id === scope.taskId : scope.groupId ? t.groupId === scope.groupId : true;

async function protectedTasks(links: Link[] = []) {
  const rows = await sql<Pick<D.ProjectRow, 'getflyParentId' | 'getflyParentCode' | 'getflyGroups'>[]>`select getfly_parent_id, getfly_parent_code, getfly_groups from projects`;
  const ids = new Set<number>(), codes = new Set<string>();
  for (const p of rows) {
    if (p.getflyParentId) ids.add(Number(p.getflyParentId));
    if (p.getflyParentCode) codes.add(p.getflyParentCode);
    for (const parent of Object.values(p.getflyGroups ?? {})) { if (parent.id) ids.add(Number(parent.id)); if (parent.code) codes.add(parent.code); }
  }
  const configured = (l: Link) => (!!l.getflyId && ids.has(l.getflyId)) || (!!l.getflyCode && codes.has(l.getflyCode));
  const byId = new Map(links.map((l) => [l.localId, l]));
  const protectedLocal = new Set<string>();
  for (const link of links.filter(configured)) {
    let current: Link | undefined = link;
    const seen = new Set<string>();
    while (current && !seen.has(current.localId)) {
      seen.add(current.localId); protectedLocal.add(current.localId);
      current = current.parentLocal ? byId.get(current.parentLocal) : undefined;
    }
  }
  return (l: Link) => configured(l) || protectedLocal.has(l.localId);
}

async function resolveLinkCodes(projectId: string, links: Link[]) {
  const missing = new Map(links.filter((l) => !l.getflyCode && l.getflyId).map((l) => [l.getflyId!, l]));
  if (!missing.size) return;
  const resolved: Link[] = [];
  await scanTasks((task) => { const l = missing.get(Number(task.task_id)); if (l) { l.getflyCode = task.task_code; missing.delete(Number(task.task_id)); resolved.push(l); } return missing.size === 0; }, 20);
  for (const l of resolved) await sql`update getfly_links set getfly_code = ${l.getflyCode} where project_id = ${projectId} and local_id = ${l.localId} and getfly_id = ${l.getflyId}`;
}

type Item = { localId: string; parentLocal: string | null; info: Json; done: boolean; label: string; people: string[] };
export type GetflyResult = { created: number; updated: number; completed: number; deleted: number; unchanged: number; errors: string[]; warnings: string[]; syncedAt: string };

const when = (d: string | null, time: string) => (d ? `${d} ${time}` : undefined);
const hashOf = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex');
const subtasksStart = '<!-- vnlab-project:subtasks:start -->';
const subtasksEnd = '<!-- vnlab-project:subtasks:end -->';
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function subtasksDescription(subtasks: D.Subtask[]) {
  if (!subtasks.length) return '';
  const rows = subtasks.map((s) => `<li>${escapeHtml(s.name)}</li>`).join('');
  return `${subtasksStart}<ol>${rows}</ol>${subtasksEnd}`;
}
function mergeSubtasksDescription(current: string, block: string) {
  const pattern = /<!-- vnlab-project:subtasks:start -->[\s\S]*?<!-- vnlab-project:subtasks:end -->/g;
  if (pattern.test(current)) {
    let inserted = false;
    return current.replace(pattern, () => { if (inserted) return ''; inserted = true; return block; });
  }
  return current + block;
}

const running = new Set<string>();
export async function withGetflyProjectsLocked<T>(projectIds: string[], action: () => Promise<T>): Promise<T> {
  const ids = [...new Set(projectIds)];
  if (ids.some((id) => running.has(id))) throw new GetflyError(409, { message: 'Đợi thao tác Getfly hoặc chuyển việc đang chạy hoàn tất' });
  ids.forEach((id) => running.add(id));
  try { return await action(); } finally { ids.forEach((id) => running.delete(id)); }
}
type Progress = (done: number, total: number) => void;

// ---------------------------------------------------------------- job chạy nền
// Đồng bộ / gỡ có thể mất vài phút (mỗi việc một request, tra mã phải lật danh sách) nên chạy nền:
// API trả job ngay, giao diện hỏi tiến độ qua GET …/getfly/job. Mỗi dự án giữ job gần nhất (trong bộ nhớ).
export type GetflyJob = {
  id: string; kind: 'sync' | 'unsync'; scope?: GetflyScope; status: 'running' | 'done' | 'error';
  done: number; total: number; startedAt: string; finishedAt: string | null;
  result: GetflyResult | { deleted: number; errors: string[] } | null; error: string | null;
};
const jobs = new Map<string, GetflyJob>();
export const getflyJob = (projectId: string) => jobs.get(projectId) ?? null;
export function startGetflyJob(projectId: string, kind: 'sync' | 'unsync', scope: GetflyScope = {}): GetflyJob {
  const cur = jobs.get(projectId);
  if (cur?.status === 'running') return cur;
  const job: GetflyJob = { id: crypto.randomUUID(), kind, scope, status: 'running', done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  jobs.set(projectId, job);
  const progress: Progress = (done, total) => { job.done = done; job.total = total; };
  (kind === 'sync' ? syncGetfly(projectId, progress, scope) : unsyncGetfly(projectId, progress, scope))
    .then((r) => { job.result = r; job.status = 'done'; })
    .catch((err: Error) => { job.error = err.message; job.status = 'error'; })
    // Không phát `changed`: dữ liệu dự án không đổi (tránh kích hoạt tự đồng bộ Google Sheet). Giao diện tự hỏi job.
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}
/** Chờ job xong tối đa `ms` (cho MCP: lệnh ngắn trả kết quả luôn, lệnh dài trả tiến độ). */
export async function waitGetflyJob(job: GetflyJob, ms: number) {
  const until = Date.now() + ms;
  while (job.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  return job;
}

/** Đẩy toàn bộ dự án sang Getfly. Lỗi từng việc không dừng cả lượt; trả số liệu + danh sách lỗi. */
export async function syncGetfly(projectId: string, onProgress: Progress = () => {}, scope: GetflyScope = {}): Promise<GetflyResult> {
  if (running.has(projectId)) throw new GetflyError(409, { message: 'Đang đồng bộ Getfly cho dự án này, đợi chút' });
  running.add(projectId);
  try {
    const [p] = await sql<D.ProjectRow[]>`select * from projects where id = ${projectId}`;
    if (!p) throw new GetflyError(404, { message: 'Không thấy dự án' });
    if (!p.getflyCreatorId) throw new GetflyError(400, { message: 'Chưa chọn người tạo việc trên Getfly (Cài đặt dự án → Getfly CRM)' });
    const bundle = await D.projectBundle(projectId);
    const selected = bundle.tasks.filter((t) => inScope(t, scope));
    const users: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.getflyUsers ?? {}) as Record<string, string>)) if (String(v ?? '').trim()) users[k.trim().toLowerCase()] = String(v).trim();
    const userOf = (name: string) => {
      for (const n of name.split(',')) { const u = users[n.trim().toLowerCase()]; if (u) return u; }
      return undefined;
    };
    /** "Người liên quan" trên Getfly: mọi người (phụ trách + hỗ trợ) đã ghép được, không trùng. */
    const peopleOf = (...names: string[]) => [...new Set(names.flatMap((s) => s.split(',')).map((n) => users[n.trim().toLowerCase()]).filter((u): u is string => !!u))].sort();
    const common = { task_type: '1', task_weight: 1 };
    const items: Item[] = [];
    const mapped = (p.getflyGroups ?? {}) as D.ProjectRow['getflyGroups'];
    const warnings: string[] = [];
    const unavailable = new Set<string>();
    // Cấu hình cũ chưa lưu dự án theo từng cha: tra và bổ sung trước khi gửi việc.
    for (const g of bundle.groups) {
      if ((scope.groupId && scope.groupId !== g.id) || (scope.taskId && !selected.some((t) => t.groupId === g.id))) continue;
      const parent = mapped[g.id];
      if (!parent?.id) { warnings.push(`Bỏ qua nhóm ${g.name}: chưa gắn việc cha Getfly.`); continue; }
      if (parent.projectId === undefined) {
        try {
          const resolved = await findGetflyTask(String(parent.id));
          mapped[g.id] = resolved;
          await sql`update projects set getfly_groups = coalesce(getfly_groups, '{}'::jsonb) || ${sql.json({ [g.id]: resolved })}::jsonb where id = ${projectId}`;
        } catch (err) { unavailable.add(g.id); warnings.push(`Bỏ qua nhóm ${g.name}: ${(err as Error).message}`); }
      }
    }
    const gKey = (id: string) => `g:${id}`;
    for (const t of selected) {
      if (!t.groupId) { warnings.push(`Bỏ qua việc ${t.name}: chưa phân nhóm.`); continue; }
      const parent = mapped[t.groupId];
      if (!parent?.id || unavailable.has(t.groupId)) continue;
      const projectInfo = { project_id: parent.projectId || undefined };
      const done = t.progress >= 100;
      items.push({
        localId: t.id, parentLocal: t.groupId ? gKey(t.groupId) : null, done, label: t.name,
        people: peopleOf(t.assignee, t.support),
        info: {
          ...common,
          ...projectInfo,
          task_name: t.name,
          task_start_date: when(t.startDate ?? t.endDate, '08:00'),
          task_end_date: when(t.endDate ?? t.startDate, '17:30'),
          // Chỉ quản lý khối task con trong mô tả; giữ nguyên nội dung nhập tay.
          task_description: subtasksDescription(t.subtasks ?? []),
          task_receiver: userOf(t.assignee),
          // Việc nằm thẳng dưới cha riêng của nhóm.
          task_parent: String(parent.id),
        },
      });
    }
    const links = new Map((await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, completed from getfly_links where project_id = ${projectId}`).map((l) => [l.localId, { ...l, getflyId: l.getflyId == null ? null : Number(l.getflyId) }]));
    const isProtected = await protectedTasks([...links.values()]);
    await resolveLinkCodes(projectId, [...links.values()].filter((l) => selected.some((t) => t.id === l.localId)));
    const r: GetflyResult = { created: 0, updated: 0, completed: 0, deleted: 0, unchanged: 0, errors: [], warnings, syncedAt: '' };
    const save = async (l: Link) => {
      links.set(l.localId, l);
      await sql`
        insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash, completed, synced_at)
        values (${projectId}, ${l.localId}, ${l.parentLocal}, ${l.getflyCode}, ${l.getflyId}, ${l.hash}, ${l.completed}, now())
        on conflict (project_id, local_id) do update set parent_local = excluded.parent_local, getfly_code = excluded.getfly_code, getfly_id = excluded.getfly_id,
          hash = excluded.hash, completed = excluded.completed, synced_at = now()`;
    };

    // 1) Chỉ xoá các việc chính đã xoá bên VNLab, thuộc nhóm đang được đồng bộ.
    // Mục chưa gắn cha được bỏ qua, không được xem là đã xoá.
    // Giữ các việc nhóm app từng tạo theo cấu trúc cũ.
    const alive = new Set(bundle.tasks.flatMap((t) => [t.id, ...(t.subtasks ?? []).map((s) => s.id)]));
    const mayDelete = (l: Link): boolean => {
      if (isProtected(l) || (scope.taskId && l.localId !== scope.taskId)) return false;
      if (scope.groupId && l.parentLocal !== `g:${scope.groupId}`) return false;
      if (!l.parentLocal || l.localId.startsWith('g:')) return false;
      if (l.parentLocal.startsWith('g:')) {
        const gid = l.parentLocal.slice(2);
        return !!mapped[gid]?.id && !unavailable.has(gid);
      }
      // Liên kết task con cũ được giữ nguyên khi ngừng đồng bộ task con.
      return false;
    };
    const depth = (l: { localId: string; parentLocal: string | null }) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    const gone = [...links.values()].filter((l) => !alive.has(l.localId) && mayDelete(l)).sort((a, b) => depth(b) - depth(a));
    const total = gone.length + items.length;
    let step = 0;
    onProgress(0, total);
    for (const l of gone) {
      onProgress(++step, total);
      if (l.getflyCode) {
        try { await gf('DELETE', '/tasks', { task_code: l.getflyCode }); }
        catch (err) { if (!/không tồn tại/i.test((err as Error).message)) { r.errors.push(`Xoá ${l.getflyCode}: ${(err as Error).message}`); continue; } }
      }
      r.deleted++;
      links.delete(l.localId);
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${l.localId}`;
    }

    // Chỉ đọc mô tả khi cần sửa; tra chung một lượt cho các việc đã có liên kết.
    let descriptionsPromise: Promise<Map<string, GTask>> | undefined;
    const currentDescription = async (code: string) => {
      descriptionsPromise ??= (async () => {
        const found = new Map<string, GTask>();
        const wanted = new Set(items.map((it) => links.get(it.localId)?.getflyCode).filter((c): c is string => !!c));
        await scanTasks((task) => {
          if (wanted.has(task.task_code)) { found.set(task.task_code, task); wanted.delete(task.task_code); }
          return wanted.size === 0;
        });
        return found;
      })();
      const task = (await descriptionsPromise).get(code);
      if (!task || task.task_description === undefined || (task.task_description !== null && typeof task.task_description !== 'string')) {
        throw new GetflyError(502, { message: 'Chưa đọc được mô tả hiện tại trên Getfly — giữ nguyên để tránh ghi đè nội dung' });
      }
      return task.task_description ?? '';
    };

    // 2) Tạo / sửa các việc chính; task con chỉ nằm trong mô tả.
    const pendingCode = new Map<number, Link>(); // việc vừa tạo: API chỉ trả id, tra mã sau
    for (const it of items) {
      onProgress(++step, total);
      try {
        const info: Json = { ...it.info };
        if (it.parentLocal && info.task_parent === undefined) {
          const parent = links.get(it.parentLocal);
          if (!parent?.getflyId) { r.errors.push(`${it.label}: việc cha chưa lên Getfly`); continue; }
          info.task_parent = String(parent.getflyId);
        }
        for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
        // people_involved nằm ngoài task_info (như giao diện Getfly gửi); đổi người liên quan cũng tính là đổi.
        const people = it.people.length ? { people_involved: it.people } : {};
        const hash = hashOf({ ...info, ...people });
        const cur = links.get(it.localId);
        if (cur && isProtected(cur)) { r.errors.push(`${it.label}: giữ nguyên vì là việc cha hoặc chứa việc cha được bảo vệ`); continue; }
        let link: Link;
        if (!cur) {
          if (!info.task_description) delete info.task_description;
          const res = await gf<{ task_id?: number | string }>('POST', '/tasks', { ...people, task_info: { ...info, task_creator: p.getflyCreatorId } });
          const id = Number(res.task_id);
          if (!id) throw new GetflyError(502, { message: 'Getfly không trả id việc' });
          link = { localId: it.localId, parentLocal: it.parentLocal, getflyCode: '', getflyId: id, hash, completed: false };
          pendingCode.set(id, link);
          r.created++;
        } else if (cur.hash !== hash) {
          if (!cur.getflyCode) throw new GetflyError(502, { message: 'Chưa biết mã việc trên Getfly — bấm đồng bộ lại sau' });
          const current = await currentDescription(cur.getflyCode);
          const description = mergeSubtasksDescription(current, String(info.task_description ?? ''));
          if (description === current) delete info.task_description;
          else info.task_description = description;
          await gf('PUT', '/tasks', { task_code: cur.getflyCode, ...people, task_info: info });
          link = { ...cur, parentLocal: it.parentLocal, hash };
          r.updated++;
        } else { link = cur; r.unchanged++; }
        // API v3 chưa cập nhật được trạng thái: không ghi nhận thành công giả.
        if (link.completed) link = { ...link, completed: false };
        await save(link);
      } catch (err) {
        r.errors.push(`${it.label}: ${(err as Error).message}`);
      }
    }
    // 3) Tra mã cho việc vừa tạo (cần cho sửa / xoá lần sau).
    if (pendingCode.size) {
      await scanTasks((t) => {
        const l = pendingCode.get(Number(t.task_id));
        if (l) { l.getflyCode = t.task_code; pendingCode.delete(Number(t.task_id)); }
        return pendingCode.size === 0;
      }, 10);
      for (const l of links.values()) if (l.getflyCode && l.getflyId) await save(l);
      if (pendingCode.size) r.warnings.push(`${pendingCode.size} việc vừa tạo chưa tra được mã trên Getfly — lần đồng bộ sau sẽ thử lại`);
    }
    const pendingCompletion = items.filter((it) => it.done);
    if (pendingCompletion.length) r.warnings.push(`Chưa cập nhật trạng thái hoàn thành trên Getfly cho ${pendingCompletion.length} việc: ${pendingCompletion.map((it) => it.label).join('; ')}. API hiện tại chưa hỗ trợ — cần đánh dấu tay trên Getfly.`);
    const [row] = await sql<{ getflySyncedAt: Date }[]>`
      update projects set getfly_synced_at = now(), getfly_error = ${r.errors.length ? r.errors.slice(0, 5).join('\n') : null}
      where id = ${projectId} returning getfly_synced_at`;
    r.syncedAt = new Date(row.getflySyncedAt).toISOString();
    return r;
  } finally {
    running.delete(projectId);
  }
}

/** Số việc đã có bản trên Getfly (hiện ở giao diện). */
export async function getflyLinkCount(projectId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from getfly_links where project_id = ${projectId}`;
  return n;
}

/** Gỡ khỏi Getfly: xoá mọi việc app đã tạo cho dự án (task con trước, việc, rồi việc của nhóm) và quên liên kết.
 *  Không đụng việc cha của dự án hay việc có sẵn đã gắn cho nhóm. */
export async function unsyncGetfly(projectId: string, onProgress: Progress = () => {}, scope: GetflyScope = {}) {
  if (running.has(projectId)) throw new GetflyError(409, { message: 'Đang đồng bộ Getfly cho dự án này, đợi chút' });
  running.add(projectId);
  try {
    const allLinks = (await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, completed from getfly_links where project_id = ${projectId}`)
      .map((l) => ({ ...l, getflyId: l.getflyId == null ? null : Number(l.getflyId) }));
    const bundle = await D.projectBundle(projectId);
    const selectedIds = new Set(bundle.tasks.filter((t) => inScope(t, scope)).map((t) => t.id));
    const byId = new Map(allLinks.map((l) => [l.localId, l]));
    const matches = (l: Link) => {
      if (!scope.taskId && !scope.groupId) return true;
      const seen = new Set<string>();
      let current: Link | undefined = l;
      while (current && !seen.has(current.localId)) {
        seen.add(current.localId);
        if (selectedIds.has(current.localId) || current.localId === scope.taskId || (scope.groupId && (current.localId === `g:${scope.groupId}` || current.parentLocal === `g:${scope.groupId}`))) return true;
        current = current.parentLocal ? byId.get(current.parentLocal) : undefined;
      }
      return false;
    };
    const links = allLinks.filter(matches);
    await resolveLinkCodes(projectId, links);
    const isProtected = await protectedTasks(allLinks);
    const depth = (l: Link) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    let deleted = 0;
    const errors: string[] = [];
    let step = 0;
    onProgress(0, links.length);
    for (const l of links.sort((a, b) => depth(b) - depth(a))) {
      onProgress(++step, links.length);
      try {
        if (isProtected(l)) { errors.push(`${l.getflyCode || l.getflyId}: giữ nguyên vì đang được gắn làm việc cha`); continue; }
        if (!l.getflyCode) { errors.push(`${l.getflyId ?? l.localId}: chưa tra được mã, giữ nguyên liên kết`); continue; }
        await gf('DELETE', '/tasks', { task_code: l.getflyCode });
        deleted++;
      } catch (err) {
        if (!/không tồn tại/i.test((err as Error).message)) { errors.push(`${l.getflyCode || l.getflyId}: ${(err as Error).message}`); continue; }
        deleted++;
      }
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${l.localId}`;
    }
    await sql`update projects set getfly_synced_at = null, getfly_error = ${errors.length ? errors.slice(0, 5).join('\n') : null} where id = ${projectId}`;
    return { deleted, errors };
  } finally {
    running.delete(projectId);
  }
}
