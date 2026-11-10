// Đồng bộ một chiều VNLab Project -> Getfly CRM bằng nút bấm.
// Getfly của ACS (acs.getflycrm.com) chạy API v3 — đã kiểm chứng trên hệ thống thật (11/2026):
//   - Danh sách việc: GET /api/v3/tasks?limit=100&page=N (bỏ qua mọi tham số lọc), người dùng: GET /api/v3/users.
//   - Tạo: POST /api/v3/tasks { task_info: { task_name, task_start_date "Y-m-d H:i", task_end_date, task_description,
//          project_id, task_parent (id việc cha), task_type, task_weight, task_creator (bắt buộc), task_receiver } } -> { task_id }.
//   - Sửa: PUT /api/v3/tasks { task_code, task_info: {...} }. Xoá: DELETE /api/v3/tasks { task_code }.
//   - KHÔNG có cách đánh dấu hoàn thành qua API (task_progress / task_status đều bị từ chối): việc 100% chỉ ghi chú
//     trong mô tả và báo người dùng đánh dấu tay.
// Mỗi việc -> một việc Getfly dưới "việc cha" của dự án; task con -> việc con dưới việc tương ứng (task_parent = id Getfly).
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
type GTask = { task_id: string; task_code: string; task_name: string; project_id: string; project_name: string; task_status: string };

async function gf<T = Json>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!getflyStatus().configured) throw new GetflyError(503, { message: 'Chưa cấu hình Getfly trên máy chủ (GETFLY_BASE_URL, GETFLY_API_KEY)' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(`${base()}/api/v3${path}`, {
      method, signal: ctl.signal,
      headers: { 'X-API-KEY': apiKey(), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GetflyError(504, { message: `Không kết nối được Getfly: ${(err as Error).message}` });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const d = data as { message?: unknown } | null;
    const msg = typeof d?.message === 'string' ? d.message : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new GetflyError(502, { message: `Getfly từ chối API key (${msg})` });
    throw new GetflyError(res.status === 404 ? 404 : 502, { message: `Getfly: ${msg}` });
  }
  return data as T;
}

/** Lật danh sách việc (mới -> cũ, 100 việc / trang) tới khi `found` trả true hoặc hết số trang cho phép. */
async function scanTasks(found: (t: GTask) => boolean, maxPages = 90) {
  for (let page = 1; page <= maxPages; page++) {
    const r = await gf<{ data?: GTask[]; total_page?: number }>('GET', `/tasks?limit=100&page=${page}`);
    const rows = r.data ?? [];
    for (const t of rows) if (found(t)) return;
    if (!rows.length || (r.total_page && page >= Number(r.total_page))) return;
  }
}

/** Tra việc theo link (#/tasks/?…task_id=8689), id hoặc mã việc (CVI/2026-11/008676). */
export async function findGetflyTask(input: string) {
  const s = input.trim();
  if (!s) throw new GetflyError(400, { message: 'Nhập link, id hoặc mã việc Getfly' });
  const id = (s.match(/task_id=(\d+)/) ?? s.match(/^(\d+)$/))?.[1];
  let hit: GTask | null = null;
  await scanTasks((t) => { if (id ? String(t.task_id) === id : t.task_code === s) { hit = t; return true; } return false; });
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
type Item = { localId: string; parentLocal: string | null; info: Json; done: boolean; label: string };
export type GetflyResult = { created: number; updated: number; completed: number; deleted: number; unchanged: number; errors: string[]; warnings: string[]; syncedAt: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const when = (d: string | null, time: string) => (d ? `${d} ${time}` : undefined);
const hashOf = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex');
const running = new Set<string>();

/** Đẩy toàn bộ dự án sang Getfly. Lỗi từng việc không dừng cả lượt; trả số liệu + danh sách lỗi. */
export async function syncGetfly(projectId: string): Promise<GetflyResult> {
  if (running.has(projectId)) throw new GetflyError(409, { message: 'Đang đồng bộ Getfly cho dự án này, đợi chút' });
  running.add(projectId);
  try {
    const [p] = await sql<D.ProjectRow[]>`select * from projects where id = ${projectId}`;
    if (!p) throw new GetflyError(404, { message: 'Không thấy dự án' });
    if (!p.getflyParentId) throw new GetflyError(400, { message: 'Chưa đặt việc cha trên Getfly (Cài đặt dự án → Getfly CRM)' });
    if (!p.getflyCreatorId) throw new GetflyError(400, { message: 'Chưa chọn người tạo việc trên Getfly (Cài đặt dự án → Getfly CRM)' });
    const bundle = await D.projectBundle(projectId);
    const users: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.getflyUsers ?? {}) as Record<string, string>)) if (String(v ?? '').trim()) users[k.trim().toLowerCase()] = String(v).trim();
    const userOf = (name: string) => {
      for (const n of name.split(',')) { const u = users[n.trim().toLowerCase()]; if (u) return u; }
      return undefined;
    };
    const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
    const scopes = new Map(bundle.scopes.map((s) => [s.id, s]));
    const common = { project_id: p.getflyProjectId || undefined, task_type: '1', task_weight: 1 };
    const doneNote = '<p><b>✔ Đã xong 100% bên VNLab Project</b> — đánh dấu hoàn thành trên Getfly.</p>';
    const items: Item[] = [];
    for (const t of bundle.tasks) {
      const scope = t.scopeId ? scopes.get(t.scopeId) : undefined;
      const done = t.progress >= 100;
      const meta = [t.groupId ? `Nhóm: ${groups.get(t.groupId)}` : null, scope ? `Phạm vi: ${scope.name}${scope.owner ? ` (phụ trách ${scope.owner})` : ''}` : null, t.support ? `Hỗ trợ: ${t.support}` : null, `Tiến độ: ${t.progress}%`].filter(Boolean).join(' · ');
      items.push({
        localId: t.id, parentLocal: null, done, label: t.name,
        info: {
          ...common,
          task_name: t.name,
          task_start_date: when(t.startDate ?? t.endDate, '08:00'),
          task_end_date: when(t.endDate ?? t.startDate, '17:30'),
          task_description: `${done ? doneNote : ''}${t.note ? `<p>${esc(t.note).replace(/\n/g, '<br>')}</p>` : ''}<p><i>${esc(meta)} — đồng bộ từ VNLab Project</i></p>`,
          task_receiver: userOf(t.assignee),
          task_parent: String(p.getflyParentId),
        },
      });
      for (const s of t.subtasks ?? []) {
        const sDone = s.progress >= 100;
        items.push({
          localId: s.id, parentLocal: t.id, done: sDone, label: `${t.name} › ${s.name}`,
          info: {
            ...common,
            task_name: s.name,
            task_start_date: when(t.startDate ?? t.endDate, '08:00'),
            task_end_date: when(t.endDate ?? t.startDate, '17:30'),
            task_description: `${sDone ? doneNote : ''}<p><i>Task con của “${esc(t.name)}” · Tiến độ: ${s.progress}% — đồng bộ từ VNLab Project</i></p>`,
            task_receiver: userOf(s.assignee),
            // task_parent điền lúc chạy: id Getfly của việc cha vừa tạo / đã có.
          },
        });
      }
    }
    const links = new Map((await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, completed from getfly_links where project_id = ${projectId}`).map((l) => [l.localId, { ...l, getflyId: l.getflyId == null ? null : Number(l.getflyId) }]));
    const r: GetflyResult = { created: 0, updated: 0, completed: 0, deleted: 0, unchanged: 0, errors: [], warnings: [], syncedAt: '' };
    const save = async (l: Link) => {
      links.set(l.localId, l);
      await sql`
        insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash, completed, synced_at)
        values (${projectId}, ${l.localId}, ${l.parentLocal}, ${l.getflyCode}, ${l.getflyId}, ${l.hash}, ${l.completed}, now())
        on conflict (project_id, local_id) do update set parent_local = excluded.parent_local, getfly_code = excluded.getfly_code, getfly_id = excluded.getfly_id,
          hash = excluded.hash, completed = excluded.completed, synced_at = now()`;
    };

    // 1) Xoá bên Getfly những việc đã xoá bên VNLab (task con trước, việc cha sau).
    const alive = new Set(items.map((i) => i.localId));
    const gone = [...links.values()].filter((l) => !alive.has(l.localId)).sort((a, b) => Number(!a.parentLocal) - Number(!b.parentLocal));
    for (const l of gone) {
      if (l.getflyCode) {
        try { await gf('DELETE', '/tasks', { task_code: l.getflyCode }); }
        catch (err) { if (!/không tồn tại/i.test((err as Error).message)) { r.errors.push(`Xoá ${l.getflyCode}: ${(err as Error).message}`); continue; } }
      }
      r.deleted++;
      links.delete(l.localId);
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${l.localId}`;
    }

    // 2) Tạo / sửa (việc cha trước, task con sau để có id cha).
    const pendingCode = new Map<number, Link>(); // việc vừa tạo: API chỉ trả id, tra mã sau
    for (const it of items) {
      try {
        const info: Json = { ...it.info };
        if (it.parentLocal) {
          const parent = links.get(it.parentLocal);
          if (!parent?.getflyId) { r.errors.push(`${it.label}: việc cha chưa lên Getfly`); continue; }
          info.task_parent = String(parent.getflyId);
        }
        for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
        const hash = hashOf(info);
        const cur = links.get(it.localId);
        let link: Link;
        if (!cur) {
          const res = await gf<{ task_id?: number | string }>('POST', '/tasks', { task_info: { ...info, task_creator: p.getflyCreatorId } });
          const id = Number(res.task_id);
          if (!id) throw new GetflyError(502, { message: 'Getfly không trả id việc' });
          link = { localId: it.localId, parentLocal: it.parentLocal, getflyCode: '', getflyId: id, hash, completed: false };
          pendingCode.set(id, link);
          r.created++;
        } else if (cur.hash !== hash) {
          if (!cur.getflyCode) throw new GetflyError(502, { message: 'Chưa biết mã việc trên Getfly — bấm đồng bộ lại sau' });
          await gf('PUT', '/tasks', { task_code: cur.getflyCode, task_info: info });
          link = { ...cur, parentLocal: it.parentLocal, hash };
          r.updated++;
        } else { link = cur; r.unchanged++; }
        if (it.done && !link.completed) { r.completed++; link = { ...link, completed: true }; }
        if (!it.done && link.completed) link = { ...link, completed: false };
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
    if (r.completed) r.warnings.push(`${r.completed} việc đã xong 100%: API Getfly không cho đánh dấu hoàn thành — đã ghi chú trong mô tả, anh đánh dấu tay trên Getfly`);
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
