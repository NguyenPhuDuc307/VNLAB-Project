// Đồng bộ một chiều VNLab Project -> Getfly CRM bằng nút bấm.
// Getfly của ACS (acs.getflycrm.com) chạy API v3 — đã kiểm chứng trên hệ thống thật (11/2026):
//   - Danh sách việc: GET /api/v3/tasks?limit=100&page=N (bỏ qua mọi tham số lọc), người dùng: GET /api/v3/users.
//   - Tạo: POST /api/v3/tasks { task_info: { task_name, task_start_date "Y-m-d H:i", task_end_date, task_description,
//          project_id, task_parent (id việc cha), task_type, task_weight, task_creator (bắt buộc), task_receiver } } -> { task_id }.
//   - Sửa: PUT /api/v3/tasks { task_code, task_info: {...} }. Xoá: DELETE /api/v3/tasks { task_code }.
//   - Người liên quan: people_involved: [id người dùng] nằm ngoài task_info, nhận cả khi tạo lẫn khi sửa.
//   - Không đồng bộ tiến độ / trạng thái hoàn thành: API v3 từ chối task_progress / task_status, không có lệnh
//     hoàn thành, còn /task/process của web chỉ nhận token đăng nhập (đã thử 13/11/2026). Đã bỏ hẳn phần này.
//     Mô tả chỉ bổ sung danh sách task con, không gửi ghi chú nội bộ.
// Mỗi nhóm gắn một việc cha có sẵn trên Getfly -> việc chính (-> việc con nếu việc có "việc cha" cùng nhóm);
// không đồng bộ task con. Chỉ đồng bộ nhóm đã gắn cha; giữ nguyên các liên kết của mục bị bỏ qua.
// Quy định xoá (chủ dự án, 25/11/2026): app chỉ được xoá trên Getfly việc LÁ do chính app tạo. KHÔNG BAO GIỜ xoá
//   (a) việc nhận có sẵn (getfly_links.adopted — người dùng tự tạo trên Getfly), (b) việc cha: cha dự án / cha nhóm
//   và việc đang có việc con, (c) việc được bảo vệ khác. Các việc này chỉ bị quên liên kết, giữ nguyên trên Getfly.
// parent_local của liên kết: "g:<nhóm>" / "g:<phase>:<nhóm>" = dưới việc cha của nhóm; "t:<việc>" = dưới việc cha;
//   id việc trần = task con kiểu cũ (giữ nguyên, không sửa / xoá).
// Liên kết lưu ở getfly_links (id + mã Getfly + băm nội dung đã gửi) để không tạo trùng / gửi thừa.
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { sql } from './db.ts';
import * as D from './data.ts';

const base = () => (process.env.GETFLY_BASE_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = () => (process.env.GETFLY_API_KEY ?? '').trim();
/** Origin trang web Getfly (nơi chạy bookmarklet "Hoàn thành Getfly") — lấy từ GETFLY_BASE_URL, mặc định ACS. */
export const getflyWebOrigin = () => {
  try { return new URL(base()).origin; } catch { return 'https://acs.getflycrm.com'; }
};
export const getflyStatus = () => {
  const b = base();
  let host: string | null = null;
  try { host = b ? new URL(b).host : null; } catch { host = null; }
  return { configured: !!(host && apiKey()), host, webOrigin: getflyWebOrigin() };
};

export class GetflyError extends HTTPException {}
type Json = Record<string, unknown>;
type GTask = {
  task_id: string; task_code: string; task_name: string; project_id: string; project_name: string; task_status: string; task_description?: string | null;
  task_receiver?: string | number | null; task_start_date?: string | null; task_end_date?: string | null;
};

// Giới hạn dùng chung cho mọi dự án và các lần tra cha/người dùng.
let nextRequestAt = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function requestTurn() {
  while (Date.now() < nextRequestAt) await pause(nextRequestAt - Date.now());
  nextRequestAt = Date.now() + 600;
}

// DELETE chỉ dùng cho việc lá app tự tạo — xem mayDeleteOnGetfly / quy định đầu file (25/11/2026).
async function gf<T = Json>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!getflyStatus().configured) throw new GetflyError(503, { message: 'Máy chủ chưa kết nối Getfly' });
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
        throw new GetflyError(429, { message: 'Getfly đang bận, thử lại sau ít phút' });
      }
      if (res.status === 401 || res.status === 403) throw new GetflyError(502, { message: `Getfly từ chối API key (${msg})` });
      throw new GetflyError(res.status === 404 ? 404 : 502, { message: `Getfly: ${msg}` });
    }
    return data as T;
  }
}

const taskCache = new Map<string, { task: GTask; until: number }>();

/** Lật danh sách việc (mới -> cũ, 100 việc / trang) tới khi `found` trả true, `pageDone` trả true sau một trang
 *  hoặc hết số trang cho phép. */
async function scanTasks(found: (t: GTask) => boolean, maxPages = 90, pageDone?: (rows: GTask[]) => boolean) {
  for (let page = 1; page <= maxPages; page++) {
    const r = await gf<{ data?: GTask[]; total_page?: number }>('GET', `/tasks?limit=100&page=${page}`);
    const rows = r.data ?? [];
    for (const t of rows) {
      const cached = { task: t, until: Date.now() + 60_000 };
      taskCache.set(String(t.task_id), cached);
      taskCache.set(t.task_code, cached);
    }
    for (const t of rows) if (found(t)) return;
    if (pageDone?.(rows)) return;
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

type Link = { localId: string; parentLocal: string | null; getflyCode: string; getflyId: number | null; hash: string; adopted?: boolean };
/** parent_local "t:<việc>" -> id việc cha; các dạng khác giữ nguyên. */
const parentLocalId = (pl: string | null) => (pl?.startsWith('t:') ? pl.slice(2) : pl);
const loadLinks = async (projectId: string): Promise<Link[]> => (await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, adopted from getfly_links where project_id = ${projectId}`)
  .map((l) => ({ ...l, getflyId: l.getflyId == null ? null : Number(l.getflyId), adopted: l.adopted === true }));
/** Việc được giữ trên Getfly (chỉ quên liên kết, không xoá): được bảo vệ, nhận có sẵn, hoặc là việc cha của việc khác. */
async function keepOnGetfly(links: Link[], tasks: Pick<D.TaskRow, 'parentTaskId'>[]) {
  const isProtected = await protectedTasks(links);
  const parents = new Set<string>();
  for (const t of tasks) if (t.parentTaskId) parents.add(t.parentTaskId);
  for (const l of links) { const pid = parentLocalId(l.parentLocal); if (pid && !pid.startsWith('g:')) parents.add(pid); }
  return (l: Link): string | null => isProtected(l) ? 'việc cha được gắn' : l.adopted ? 'việc có sẵn trên Getfly' : parents.has(l.localId) ? 'đang là việc cha' : null;
}
export type GetflyScope = { groupId?: string; taskId?: string };
/** parentLocal "g:<groupId>" hoặc "g:<phaseId>:<groupId>" (việc cha gắn riêng theo phase) có thuộc nhóm này không. */
const inGroup = (parentLocal: string | null, groupId: string) => !!parentLocal && (parentLocal === `g:${groupId}` || parentLocal.endsWith(`:${groupId}`));
const inScope = (t: Pick<D.TaskRow, 'id' | 'groupId'>, scope: GetflyScope) => scope.taskId ? t.id === scope.taskId : scope.groupId ? t.groupId === scope.groupId : true;

/** Id / mã các việc cha đã gắn (cha dự án + cha của nhóm) ở mọi dự án. */
async function protectedParents() {
  const rows = await sql<Pick<D.ProjectRow, 'getflyParentId' | 'getflyParentCode' | 'getflyGroups'>[]>`select getfly_parent_id, getfly_parent_code, getfly_groups from projects`;
  const ids = new Set<number>(), codes = new Set<string>();
  for (const p of rows) {
    if (p.getflyParentId) ids.add(Number(p.getflyParentId));
    if (p.getflyParentCode) codes.add(p.getflyParentCode);
    for (const parent of Object.values(p.getflyGroups ?? {})) { if (parent.id) ids.add(Number(parent.id)); if (parent.code) codes.add(parent.code); }
  }
  return { ids, codes };
}

async function protectedTasks(links: Link[] = []) {
  const { ids, codes } = await protectedParents();
  const configured = (l: Link) => (!!l.getflyId && ids.has(l.getflyId)) || (!!l.getflyCode && codes.has(l.getflyCode));
  const byId = new Map(links.map((l) => [l.localId, l]));
  const protectedLocal = new Set<string>();
  for (const link of links.filter(configured)) {
    let current: Link | undefined = link;
    const seen = new Set<string>();
    while (current && !seen.has(current.localId)) {
      seen.add(current.localId); protectedLocal.add(current.localId);
      current = current.parentLocal ? byId.get(parentLocalId(current.parentLocal)!) : undefined;
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

type TaskPos = Pick<D.TaskRow, 'id' | 'groupId' | 'parentTaskId'> & { phaseId?: string | null };
type GroupParents = D.ProjectRow['getflyGroups'];
/** Khoá việc cha của nhóm: "phaseId:groupId" (gắn riêng cho phase) ưu tiên, không có thì "groupId" (chung mọi phase). */
function groupKeyOf(t: { groupId: string | null; phaseId?: string | null }, mapped: GroupParents) {
  if (!t.groupId) return null;
  const own = t.phaseId ? `${t.phaseId}:${t.groupId}` : null;
  return own && mapped[own]?.id ? own : t.groupId;
}
/** parent_local của liên kết như lúc đồng bộ: "t:<việc cha>" khi việc cha cùng nhóm và là việc gốc, không thì
 *  "g:<khoá nhóm>". null = việc chưa phân nhóm. Dùng chung cho đồng bộ và gắn tay. */
function parentLocalOf(t: TaskPos, byTask: Map<string, TaskPos>, mapped: GroupParents) {
  const key = groupKeyOf(t, mapped);
  if (!key) return null;
  const up = t.parentTaskId ? byTask.get(t.parentTaskId) : undefined;
  return up && up.groupId === t.groupId && !up.parentTaskId ? `t:${up.id}` : `g:${key}`;
}

type Item = { localId: string; parentLocal: string | null; info: Json; label: string; people: string[] };
export type GetflyResult = { created: number; adopted: number; updated: number; deleted: number; unlinked: number; unchanged: number; errors: string[]; warnings: string[]; syncedAt: string };

// ---------------------------------------------------------------- nhận việc có sẵn
// Việc người dùng tự tạo trên Getfly không có trong getfly_links: trước khi tạo mới, tìm việc cùng tên để gắn
// thay vì tạo trùng. API không trả việc cha nên chỉ ghép khi chắc chắn (tên + người nhận + dự án + ngày),
// còn lại báo để gắn tay. Ghép sai = lần đồng bộ sau ghi đè lên việc không liên quan.
const ADOPT_WINDOW_DAYS = 45;
const DAY_MS = 86_400_000;
/** Tên để so: bỏ khoảng trắng thừa, chữ thường, bỏ số thứ tự đầu ("03. ", "3 - ", "03)"). */
export const matchName = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi').replace(/^\d+\s*[.)\-–:]\s*/, '').trim();
/** "2026-11-02 08:00:00" / "2026-11-02" -> mốc ngày (ms), không đọc được thì null. */
const dayOf = (v: unknown) => {
  const m = typeof v === 'string' ? v.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  const t = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? t : null;
};
type Adoption = { adopt: Map<string, GTask>; ambiguous: Map<string, string[]> };
/** Ghép một-một các mục sắp tạo với việc có sẵn trên Getfly. `taken`: id/mã không được nhận (đã liên kết, việc cha). */
function matchExisting(items: Item[], tasks: GTask[], taken: { ids: Set<number>; codes: Set<string> }): Adoption {
  const byName = new Map<string, GTask[]>();
  for (const t of tasks) {
    if (taken.ids.has(Number(t.task_id)) || taken.codes.has(t.task_code)) continue;
    const k = matchName(String(t.task_name ?? ''));
    if (k) byName.set(k, [...(byName.get(k) ?? []), t]);
  }
  const best = new Map<string, GTask>(), ambiguous = new Map<string, string[]>();
  for (const it of items) {
    const ls = dayOf(it.info.task_start_date), le = dayOf(it.info.task_end_date) ?? ls;
    if (ls === null || le === null) continue;
    const receiver = it.info.task_receiver ? String(it.info.task_receiver) : '';
    const project = it.info.project_id ? String(it.info.project_id) : '';
    const parent = String(it.info.task_parent ?? '');
    const candidates = (byName.get(matchName(String(it.info.task_name ?? ''))) ?? []).filter((t) => {
      if (String(t.task_id) === parent) return false;
      if (receiver && t.task_receiver && String(t.task_receiver) !== receiver) return false;
      if (project && t.project_id && String(t.project_id) !== project) return false;
      const gs = dayOf(t.task_start_date) ?? dayOf(t.task_end_date), ge = dayOf(t.task_end_date) ?? gs;
      if (gs === null || ge === null) return false; // việc không có ngày: không đủ căn cứ
      return Math.abs(gs - ls) <= ADOPT_WINDOW_DAYS * DAY_MS && Math.abs(ge - le) <= ADOPT_WINDOW_DAYS * DAY_MS;
    });
    if (!candidates.length) continue;
    const range = (t: GTask) => { const gs = (dayOf(t.task_start_date) ?? dayOf(t.task_end_date))!; return [gs, dayOf(t.task_end_date) ?? gs]; };
    const exact = candidates.filter((t) => { const [gs, ge] = range(t); return gs === ls && ge === le; });
    const overlap = candidates.filter((t) => { const [gs, ge] = range(t); return gs <= le && ge >= ls; });
    const pick = candidates.length === 1 ? candidates : exact.length ? exact : overlap;
    if (pick.length === 1) best.set(it.localId, pick[0]);
    else ambiguous.set(it.localId, candidates.map((t) => t.task_code));
  }
  // Một việc Getfly là lựa chọn tốt nhất của nhiều mục -> không biết thuộc mục nào: bỏ cả.
  const uses = new Map<string, string[]>();
  for (const [localId, t] of best) uses.set(t.task_code, [...(uses.get(t.task_code) ?? []), localId]);
  const adopt = new Map<string, GTask>();
  for (const [localId, t] of best) {
    if (uses.get(t.task_code)!.length > 1) ambiguous.set(localId, [t.task_code]);
    else adopt.set(localId, t);
  }
  return { adopt, ambiguous };
}

const when = (d: string | null, time: string) => (d ? `${d} ${time}` : undefined);
const hashOf = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex');
const subtasksStart = '<!-- vnlab-project:subtasks:start -->';
const subtasksEnd = '<!-- vnlab-project:subtasks:end -->';
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Khối mô tả do app quản lý: ghi chú (chỉ khi việc được tích gửi) + danh sách task con. */
function managedDescription(t: { note?: string; getflyNote?: boolean; subtasks?: D.Subtask[] }) {
  const note = t.getflyNote ? (t.note ?? '').trim() : '';
  const subtasks = t.subtasks ?? [];
  if (!note && !subtasks.length) return '';
  const notePart = note ? `<p>${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>` : '';
  const listPart = subtasks.length ? `<ol>${subtasks.map((s) => `<li>${escapeHtml(s.name)}</li>`).join('')}</ol>` : '';
  return `${subtasksStart}${notePart}${listPart}${subtasksEnd}`;
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
export type GetflyUnsyncResult = { deleted: number; unlinked: number; errors: string[]; warnings: string[] };
export type GetflyJob = {
  id: string; kind: 'sync' | 'unsync'; scope?: GetflyScope; status: 'running' | 'done' | 'error';
  done: number; total: number; startedAt: string; finishedAt: string | null;
  result: GetflyResult | GetflyUnsyncResult | null; error: string | null;
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
    // Việc cha theo phase: khoá "phaseId:groupId" (gắn riêng cho phase) ưu tiên, không có thì dùng khoá "groupId" (chung mọi phase).
    const phaseName = new Map(bundle.phases.map((x) => [x.id, x.name]));
    const groupName = new Map(bundle.groups.map((g) => [g.id, g.name]));
    const keyOf = (t: { groupId: string | null; phaseId?: string | null }) => groupKeyOf(t, mapped);
    const labelOf = (key: string) => {
      const [a, b] = key.includes(':') ? key.split(':') : [null, key];
      return `nhóm ${groupName.get(b!) ?? b}${a ? ` (${phaseName.get(a) ?? 'phase'})` : ''}`;
    };
    // Cấu hình cũ chưa lưu dự án theo từng cha: tra và bổ sung trước khi gửi việc.
    const usedKeys = [...new Set(selected.map(keyOf).filter((k): k is string => !!k))];
    for (const key of usedKeys) {
      const parent = mapped[key];
      if (!parent?.id) {
        const t = selected.find((x) => keyOf(x) === key);
        warnings.push(`Bỏ qua ${t?.phaseId ? labelOf(`${t.phaseId}:${t.groupId}`) : labelOf(key)}: chưa gắn việc cha Getfly.`);
        continue;
      }
      if (parent.projectId === undefined) {
        try {
          const resolved = await findGetflyTask(String(parent.id));
          mapped[key] = resolved;
          await sql`update projects set getfly_groups = coalesce(getfly_groups, '{}'::jsonb) || ${sql.json({ [key]: resolved })}::jsonb where id = ${projectId}`;
        } catch (err) { unavailable.add(key); warnings.push(`Bỏ qua ${labelOf(key)}: ${(err as Error).message}`); }
      }
    }
    const byTask = new Map(bundle.tasks.map((t) => [t.id, t]));
    for (const t of selected) {
      if (!t.groupId) { warnings.push(`Bỏ qua việc ${t.name}: chưa phân nhóm.`); continue; }
      const key = keyOf(t)!;
      const parent = mapped[key];
      if (!parent?.id || unavailable.has(key)) continue;
      // Getfly bắt buộc thời gian bắt đầu/kết thúc: gửi đi chỉ để nhận lỗi khó hiểu
      // ("Thời gian bắt đầu công việc…"). Báo thẳng cách sửa; liên kết cũ vẫn giữ.
      if (!t.startDate && !t.endDate) { warnings.push(`Bỏ qua ${t.name}: chưa có ngày bắt đầu, kết thúc.`); continue; }
      const projectInfo = { project_id: parent.projectId || undefined };
      // Việc có việc cha cùng nhóm: nằm dưới việc cha trên Getfly (task_parent tra từ liên kết của việc cha ở bước 2).
      const parentLocal = parentLocalOf(t, byTask, mapped)!;
      const underTask = parentLocal.startsWith('t:');
      items.push({
        localId: t.id, parentLocal, label: t.name,
        people: peopleOf(t.assignee, t.support),
        info: {
          ...common,
          ...projectInfo,
          task_name: t.name,
          task_start_date: when(t.startDate ?? t.endDate, '08:00'),
          task_end_date: when(t.endDate ?? t.startDate, '17:30'),
          // Chỉ quản lý khối ghi chú (việc được tích) + task con trong mô tả; giữ nguyên nội dung nhập tay.
          task_description: managedDescription(t),
          task_receiver: userOf(t.assignee),
          // Việc gốc nằm thẳng dưới cha riêng của nhóm; việc con để trống, tra ở bước 2.
          task_parent: underTask ? undefined : String(parent.id),
        },
      });
    }
    // Việc cha trước, việc con sau (việc cha phải có trên Getfly trước).
    items.sort((a, b) => Number(!!a.parentLocal?.startsWith('t:')) - Number(!!b.parentLocal?.startsWith('t:')));
    const links = new Map((await loadLinks(projectId)).map((l) => [l.localId, l]));
    const isProtected = await protectedTasks([...links.values()]);
    const keepReason = await keepOnGetfly([...links.values()], bundle.tasks);
    await resolveLinkCodes(projectId, [...links.values()].filter((l) => selected.some((t) => t.id === l.localId)));
    const r: GetflyResult = { created: 0, adopted: 0, updated: 0, deleted: 0, unlinked: 0, unchanged: 0, errors: [], warnings, syncedAt: '' };
    const save = async (l: Link) => {
      links.set(l.localId, l);
      await sql`
        insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash, adopted, synced_at)
        values (${projectId}, ${l.localId}, ${l.parentLocal}, ${l.getflyCode}, ${l.getflyId}, ${l.hash}, ${!!l.adopted}, now())
        on conflict (project_id, local_id) do update set parent_local = excluded.parent_local, getfly_code = excluded.getfly_code, getfly_id = excluded.getfly_id,
          hash = excluded.hash, adopted = getfly_links.adopted or excluded.adopted, synced_at = now()`;
    };

    // 0) Mục chưa có liên kết: nhận việc cùng tên đã có trên Getfly thay vì tạo trùng (một lượt quét cho cả job).
    const adoptedIds = new Set<string>(), skipped = new Set<string>();
    const fresh = items.filter((it) => !links.has(it.localId));
    if (fresh.length) {
      const taken = await protectedParents();
      for (const l of await sql<{ getflyId: string | null; getflyCode: string }[]>`select getfly_id, getfly_code from getfly_links`) {
        if (l.getflyId != null) taken.ids.add(Number(l.getflyId));
        if (l.getflyCode) taken.codes.add(l.getflyCode);
      }
      for (const it of fresh) if (it.info.task_parent) taken.ids.add(Number(it.info.task_parent));
      const starts = fresh.map((it) => dayOf(it.info.task_start_date)).filter((d): d is number => d !== null);
      const cutoff = Math.min(...starts) - ADOPT_WINDOW_DAYS * DAY_MS;
      const seen = new Map<string, GTask>();
      // Danh sách đi từ mới -> cũ: dừng khi cả trang đều đã kết thúc trước mốc cần xét.
      await scanTasks((t) => { seen.set(String(t.task_id), t); return false; }, 30, (rows) => rows.length > 0 && rows.every((t) => {
        const end = dayOf(t.task_end_date) ?? dayOf(t.task_start_date);
        return end !== null && end < cutoff;
      }));
      // Việc con: loại việc Getfly của việc cha (nếu đã liên kết) khỏi ứng viên.
      const forMatch = fresh.map((it) => it.info.task_parent !== undefined ? it
        : { ...it, info: { ...it.info, task_parent: links.get(parentLocalId(it.parentLocal)!)?.getflyId ?? undefined } });
      const { adopt, ambiguous } = matchExisting(forMatch, [...seen.values()], taken);
      for (const it of fresh) {
        const t = adopt.get(it.localId);
        if (t) {
          // hash rỗng: bước 2 sẽ PUT giá trị của VNLab (tên, ngày, cha, người nhận, mô tả) lên việc vừa nhận.
          await save({ localId: it.localId, parentLocal: it.parentLocal, getflyCode: t.task_code, getflyId: Number(t.task_id), hash: '', adopted: true });
          adoptedIds.add(it.localId);
          r.adopted++;
          warnings.push(`Nhận việc có sẵn trên Getfly: ${t.task_code} "${t.task_name}" ↔ ${it.label}`);
        } else if (ambiguous.has(it.localId)) {
          skipped.add(it.localId);
          warnings.push(`Bỏ qua ${it.label}: trùng tên với nhiều việc trên Getfly (${ambiguous.get(it.localId)!.join(', ')}) — gắn tay`);
        }
      }
    }

    // 1) Việc đã xoá bên VNLab, thuộc nhóm đang được đồng bộ: việc lá app tự tạo thì xoá trên Getfly;
    //    việc nhận có sẵn / việc cha / được bảo vệ chỉ quên liên kết, giữ nguyên trên Getfly.
    // Mục chưa gắn cha được bỏ qua, không được xem là đã xoá.
    // Giữ các việc nhóm app từng tạo theo cấu trúc cũ.
    const alive = new Set(bundle.tasks.flatMap((t) => [t.id, ...(t.subtasks ?? []).map((s) => s.id)]));
    const mayUnlink = (l: Link, viaChild = false): boolean => {
      if (!viaChild && (isProtected(l) || (scope.taskId && l.localId !== scope.taskId))) return false;
      if (!l.parentLocal || l.localId.startsWith('g:')) return false;
      // Việc con: xét theo nhóm của việc cha.
      if (l.parentLocal.startsWith('t:')) { const up = links.get(l.parentLocal.slice(2)); return !!up && !!up.parentLocal?.startsWith('g:') && mayUnlink(up, true); }
      if (scope.groupId && !inGroup(l.parentLocal, scope.groupId)) return false;
      if (l.parentLocal.startsWith('g:')) {
        const gid = l.parentLocal.slice(2);
        return !!mapped[gid]?.id && !unavailable.has(gid);
      }
      // Liên kết task con cũ được giữ nguyên khi ngừng đồng bộ task con.
      return false;
    };
    const depth = (l: { localId: string; parentLocal: string | null }) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    const gone = [...links.values()].filter((l) => !alive.has(l.localId) && mayUnlink(l)).sort((a, b) => depth(b) - depth(a));
    const total = gone.length + items.length;
    let step = 0;
    onProgress(0, total);
    for (const l of gone) {
      onProgress(++step, total);
      const keep = keepReason(l);
      if (keep) {
        // Không gọi Getfly: chỉ quên liên kết.
        r.unlinked++;
        warnings.push(`${l.getflyCode || l.getflyId || l.localId}: việc đã xoá bên Project, giữ nguyên trên Getfly (${keep})`);
      } else {
        if (l.getflyCode) {
          try { await gf('DELETE', '/tasks', { task_code: l.getflyCode }); }
          catch (err) { if (!/không tồn tại/i.test((err as Error).message)) { r.errors.push(`Xoá ${l.getflyCode}: ${(err as Error).message}`); continue; } }
        }
        r.deleted++;
      }
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
        throw new GetflyError(502, { message: 'Chưa đọc được mô tả trên Getfly, tạm chưa ghi' });
      }
      return task.task_description ?? '';
    };

    // 2) Tạo / sửa các việc chính; task con chỉ nằm trong mô tả.
    const pendingCode = new Map<number, Link>(); // việc vừa tạo: API chỉ trả id, tra mã sau
    for (const it of items) {
      onProgress(++step, total);
      if (skipped.has(it.localId)) continue;
      try {
        const info: Json = { ...it.info };
        if (it.parentLocal && info.task_parent === undefined) {
          const parent = links.get(parentLocalId(it.parentLocal)!);
          if (!parent?.getflyId) { warnings.push(`Bỏ qua ${it.label}: việc cha chưa có trên Getfly, đồng bộ việc cha trước`); continue; }
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
          link = { localId: it.localId, parentLocal: it.parentLocal, getflyCode: '', getflyId: id, hash };
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
          if (!adoptedIds.has(it.localId)) r.updated++; // việc vừa nhận đã tính ở `adopted`
        } else { link = cur.parentLocal === it.parentLocal ? cur : { ...cur, parentLocal: it.parentLocal }; r.unchanged++; }
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
      if (pendingCode.size) r.warnings.push(`${pendingCode.size} việc chưa lấy được mã, sẽ thử lại lần sau`);
    }
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

// ---------------------------------------------------------------- gắn tay
// Khi đồng bộ không tự nhận được (trùng tên ở nhiều nhóm — API v3 không trả việc cha), người dùng dán link / id / mã
// việc Getfly cho từng việc. Liên kết gắn tay luôn tính là "việc có sẵn" (adopted): không bao giờ bị xoá trên Getfly.
// hash rỗng: lần đồng bộ sau PUT giá trị của Project (tên, ngày, cha, người nhận, mô tả) lên việc đó.
// Bỏ gắn / đổi sang việc khác chỉ quên liên kết cũ, không gọi DELETE.
export type GetflyTaskLink = { code: string; id: number | null; adopted: boolean };

export async function linkGetflyTask(projectId: string, taskId: string, ref: string): Promise<{ getfly: GetflyTaskLink | null; unlinked?: GetflyTaskLink }> {
  return withGetflyProjectsLocked([projectId], async () => {
    const [task] = await sql<Pick<D.TaskRow, 'id' | 'name' | 'groupId' | 'phaseId' | 'parentTaskId'>[]>`
      select id, name, group_id, phase_id, parent_task_id from tasks where id = ${taskId} and project_id = ${projectId}`;
    if (!task) throw new GetflyError(404, { message: 'Không thấy việc trong dự án' });
    const [old] = await sql<{ getflyCode: string; getflyId: string | null; adopted: boolean }[]>`
      select getfly_code, getfly_id, adopted from getfly_links where project_id = ${projectId} and local_id = ${taskId}`;
    const oldLink = old ? { code: old.getflyCode, id: old.getflyId == null ? null : Number(old.getflyId), adopted: old.adopted === true } : undefined;
    if (!ref.trim()) {
      // Chỉ quên liên kết; việc trên Getfly giữ nguyên.
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${taskId}`;
      return { getfly: null, unlinked: oldLink };
    }
    if (!task.groupId) throw new GetflyError(400, { message: 'Việc chưa phân nhóm — chọn nhóm trước khi gắn Getfly' });
    const g = await findGetflyTask(ref);
    const { ids, codes } = await protectedParents();
    if (ids.has(g.id) || codes.has(g.code)) throw new GetflyError(400, { message: `${g.code} "${g.name}" là việc cha của dự án / nhóm trên Getfly — không gắn vào một việc được` });
    const [taken] = await sql<{ projectId: string; localId: string; projectName: string | null; taskName: string | null }[]>`
      select l.project_id, l.local_id, p.name as project_name, t.name as task_name
      from getfly_links l
      left join projects p on p.id = l.project_id
      left join tasks t on t.project_id = l.project_id and t.id::text = l.local_id
      where (l.getfly_id = ${g.id} or l.getfly_code = ${g.code}) and not (l.project_id = ${projectId} and l.local_id = ${taskId})
      limit 1`;
    if (taken) {
      throw new GetflyError(409, { message: `${g.code} "${g.name}" đã gắn với việc "${taken.taskName ?? taken.localId}" (dự án ${taken.projectName ?? taken.projectId}) — bỏ gắn ở đó trước` });
    }
    // parent_local tính đúng như lúc đồng bộ (việc cha cùng nhóm / việc cha của nhóm theo phase).
    const [p] = await sql<Pick<D.ProjectRow, 'getflyGroups'>[]>`select getfly_groups from projects where id = ${projectId}`;
    const up = task.parentTaskId
      ? (await sql<Pick<D.TaskRow, 'id' | 'groupId' | 'parentTaskId'>[]>`select id, group_id, parent_task_id from tasks where id = ${task.parentTaskId} and project_id = ${projectId}`)[0]
      : undefined;
    const parentLocal = parentLocalOf(task, new Map(up ? [[up.id, up]] : []), (p?.getflyGroups ?? {}) as GroupParents);
    await sql`
      insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash, adopted, completed_at, synced_at)
      values (${projectId}, ${taskId}, ${parentLocal}, ${g.code}, ${g.id}, '', true, null, now())
      on conflict (project_id, local_id) do update set parent_local = excluded.parent_local, getfly_code = excluded.getfly_code,
        getfly_id = excluded.getfly_id, hash = '', adopted = true, completed_at = null, synced_at = now()`;
    const replaced = oldLink && oldLink.id !== g.id && oldLink.code !== g.code ? oldLink : undefined;
    return { getfly: { code: g.code, id: g.id, adopted: true }, ...(replaced ? { unlinked: replaced } : {}) };
  });
}

/** Gỡ khỏi Getfly trong phạm vi: xoá việc lá app đã tạo (việc con trước); việc nhận có sẵn / việc cha /
 *  việc được bảo vệ chỉ quên liên kết, giữ nguyên trên Getfly. */
export async function unsyncGetfly(projectId: string, onProgress: Progress = () => {}, scope: GetflyScope = {}): Promise<GetflyUnsyncResult> {
  if (running.has(projectId)) throw new GetflyError(409, { message: 'Đang đồng bộ Getfly cho dự án này, đợi chút' });
  running.add(projectId);
  try {
    const allLinks = await loadLinks(projectId);
    const bundle = await D.projectBundle(projectId);
    const selectedIds = new Set(bundle.tasks.filter((t) => inScope(t, scope)).map((t) => t.id));
    const byId = new Map(allLinks.map((l) => [l.localId, l]));
    const matches = (l: Link) => {
      if (!scope.taskId && !scope.groupId) return true;
      const seen = new Set<string>();
      let current: Link | undefined = l;
      while (current && !seen.has(current.localId)) {
        seen.add(current.localId);
        if (selectedIds.has(current.localId) || current.localId === scope.taskId || (scope.groupId && (current.localId === `g:${scope.groupId}` || inGroup(current.parentLocal, scope.groupId)))) return true;
        current = current.parentLocal ? byId.get(parentLocalId(current.parentLocal)!) : undefined;
      }
      return false;
    };
    const links = allLinks.filter(matches);
    await resolveLinkCodes(projectId, links);
    const keepReason = await keepOnGetfly(allLinks, bundle.tasks);
    const depth = (l: Link) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    let deleted = 0, unlinked = 0;
    const errors: string[] = [], warnings: string[] = [];
    let step = 0;
    onProgress(0, links.length);
    for (const l of links.sort((a, b) => depth(b) - depth(a))) {
      onProgress(++step, links.length);
      const keep = keepReason(l);
      if (keep) {
        // Không gọi Getfly: việc trên Getfly giữ nguyên, chỉ quên liên kết.
        warnings.push(`${l.getflyCode || l.getflyId}: giữ nguyên trên Getfly (${keep}), chỉ gỡ liên kết`);
        unlinked++;
      } else {
        if (!l.getflyCode) { errors.push(`${l.getflyId ?? l.localId}: chưa tra được mã, giữ nguyên liên kết`); continue; }
        try { await gf('DELETE', '/tasks', { task_code: l.getflyCode }); }
        catch (err) { if (!/không tồn tại/i.test((err as Error).message)) { errors.push(`${l.getflyCode}: ${(err as Error).message}`); continue; } }
        deleted++;
      }
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${l.localId}`;
    }
    await sql`update projects set getfly_synced_at = null, getfly_error = ${errors.length ? errors.slice(0, 5).join('\n') : null} where id = ${projectId}`;
    return { deleted, unlinked, errors, warnings };
  } finally {
    running.delete(projectId);
  }
}

// ---------------------------------------------------------------- đánh dấu hoàn thành trên Getfly (bookmarklet)
// API v3 không cho đổi trạng thái việc, nên bookmarklet chạy trên tab Getfly đã đăng nhập tự bấm "Hoàn thành" + 5 sao
// (src/lib/getfly-bookmarklet.ts). Server chỉ đưa danh sách việc cần đánh dấu và ghi nhận việc đã xong (completed_at).

export type PendingDone = { projectId: string; projectName: string; taskId: string; name: string; getflyId: number; getflyCode: string };

/** Điều kiện chung: liên kết của việc (không phải nhóm / task con) đạt 100%, có id Getfly, ở dự án tôi được sửa. */
const editableBy = (user: Pick<D.UserRow, 'id' | 'email'>) => sql`(
  p.owner_id = ${user.id} or exists (
    select 1 from project_members m where m.project_id = p.id and m.role = 'editor'
      and (m.user_id = ${user.id} or lower(m.email) = ${user.email.toLowerCase()})
  ))`;

/** task_status của việc Getfly đã hoàn thành (API v3; đang tiến hành = '11'). */
export const GETFLY_DONE_STATUS = '6';

/** Trạng thái các việc Getfly theo id: lật danh sách (mới -> cũ) tới khi thấy đủ hoặc đã qua id nhỏ nhất, tối đa 30 trang.
 *  fresh = false thì dùng cache ~60 giây của scanTasks; id không thấy thì không có trong Map. */
async function getflyTaskStatuses(ids: number[], fresh: boolean): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const want = new Set(ids);
  if (!fresh) {
    for (const id of ids) {
      const c = taskCache.get(String(id));
      if (c && c.until > Date.now()) { out.set(id, String(c.task.task_status)); want.delete(id); }
    }
  }
  if (!want.size) return out;
  const min = Math.min(...want);
  await scanTasks((t) => {
    const id = Number(t.task_id);
    if (want.has(id)) { out.set(id, String(t.task_status)); want.delete(id); }
    return want.size === 0;
  }, 30, (rows) => rows.length > 0 && rows.every((t) => Number(t.task_id) < min));
  return out;
}

/**
 * Việc xong 100% bên Project, có bản trên Getfly mà trên Getfly CHƯA "Hoàn thành" — ở mọi dự án tôi được sửa.
 * Lấy trạng thái thật từ Getfly (một lượt quét, cache ~60 giây): đã hoàn thành thì ghi nhận completed_at và bỏ khỏi danh sách;
 * completed_at có mà Getfly chưa hoàn thành (bookmarklet báo nhầm) thì xoá completed_at và đưa lại vào danh sách.
 * Không tra được Getfly (chưa cấu hình / lỗi / không thấy việc) thì dựa vào completed_at.
 */
export async function pendingDone(user: Pick<D.UserRow, 'id' | 'email'>): Promise<PendingDone[]> {
  const rows = await sql<{ projectId: string; projectName: string; taskId: string; name: string; getflyId: string; getflyCode: string; completedAt: Date | null }[]>`
    select p.id as project_id, p.name as project_name, t.id as task_id, t.name, l.getfly_id, l.getfly_code, l.completed_at
    from getfly_links l
    join tasks t on t.project_id = l.project_id and t.id::text = l.local_id
    join projects p on p.id = l.project_id
    where l.getfly_id is not null and t.progress >= 100 and ${editableBy(user)}
    order by p.name, t.sort, t.name`;
  let statuses: Map<number, string> | null = null;
  if (rows.length && getflyStatus().configured) {
    try { statuses = await getflyTaskStatuses(rows.map((r) => Number(r.getflyId)), false); } catch (err) {
      console.warn('[getfly] không tra được trạng thái việc:', (err as Error).message);
    }
  }
  const out: PendingDone[] = [];
  for (const r of rows) {
    const status = statuses?.get(Number(r.getflyId));
    if (status === GETFLY_DONE_STATUS) {
      if (!r.completedAt) await sql`update getfly_links set completed_at = now() where project_id = ${r.projectId} and local_id = ${r.taskId}`;
      continue;
    }
    if (status === undefined && r.completedAt) continue;
    if (r.completedAt) await sql`update getfly_links set completed_at = null where project_id = ${r.projectId} and local_id = ${r.taskId}`;
    out.push({ projectId: r.projectId, projectName: r.projectName, taskId: r.taskId, name: r.name, getflyId: Number(r.getflyId), getflyCode: r.getflyCode });
  }
  return out;
}

/** Ghi nhận việc bookmarklet báo đã xong trên Getfly — chỉ tin Getfly: tra lại trạng thái thật (không dùng cache) và chỉ ghi
 *  completed_at khi task_status = '6'. Id không thuộc dự án tôi được sửa, việc chưa 100%, hay Getfly chưa hoàn thành thì
 *  nằm trong `rejected` kèm lý do. Đánh dấu lại việc đã ghi nhận thì giữ thời điểm cũ. */
export async function markDone(user: Pick<D.UserRow, 'id' | 'email'>, getflyIds: number[]) {
  const ids = [...new Set(getflyIds)];
  const reasons: Record<number, string> = {};
  if (!ids.length) return { marked: [] as number[], rejected: [] as number[], reasons };
  const eligible = new Set((await sql<{ getflyId: string }[]>`
    select l.getfly_id from getfly_links l
    join tasks t on t.project_id = l.project_id and t.id::text = l.local_id
    join projects p on p.id = l.project_id
    where l.getfly_id in ${sql(ids)} and t.progress >= 100 and ${editableBy(user)}`).map((r) => Number(r.getflyId)));
  for (const id of ids) if (!eligible.has(id)) reasons[id] = 'Không thuộc dự án bạn được sửa hoặc việc chưa xong 100%';
  let done: number[] = [];
  if (eligible.size) {
    if (!getflyStatus().configured) for (const id of eligible) reasons[id] = 'Máy chủ chưa kết nối Getfly';
    else {
      try {
        const statuses = await getflyTaskStatuses([...eligible], true);
        for (const id of eligible) {
          const st = statuses.get(id);
          if (st === GETFLY_DONE_STATUS) done.push(id);
          else reasons[id] = st === undefined ? 'Không thấy việc trên Getfly' : 'Getfly chưa hoàn thành';
        }
      } catch (err) { for (const id of eligible) reasons[id] = `Không tra được Getfly: ${(err as Error).message}`; }
    }
  }
  if (done.length) {
    const rows = await sql<{ getflyId: string }[]>`
      update getfly_links l set completed_at = coalesce(l.completed_at, now())
      from tasks t, projects p
      where t.project_id = l.project_id and t.id::text = l.local_id and p.id = l.project_id
        and l.getfly_id in ${sql(done)} and t.progress >= 100 and ${editableBy(user)}
      returning l.getfly_id`;
    done = [...new Set(rows.map((r) => Number(r.getflyId)))];
  }
  return { marked: done, rejected: ids.filter((id) => !done.includes(id)), reasons };
}
