// Đồng bộ một chiều VNLab Project -> Getfly CRM bằng nút bấm.
// Getfly của ACS (acs.getflycrm.com) chạy API v3 — đã kiểm chứng trên hệ thống thật (11/2026):
//   - Danh sách việc: GET /api/v3/tasks?limit=100&page=N (bỏ qua mọi tham số lọc), người dùng: GET /api/v3/users.
//   - Tạo: POST /api/v3/tasks { task_info: { task_name, task_start_date "Y-m-d H:i", task_end_date, task_description,
//          project_id, task_parent (id việc cha), task_type, task_weight, task_creator (bắt buộc), task_receiver } } -> { task_id }.
//   - Sửa: PUT /api/v3/tasks { task_code, task_info: {...} }. Xoá: DELETE /api/v3/tasks { task_code }.
//   - KHÔNG có cách đánh dấu hoàn thành qua API (task_progress / task_status đều bị từ chối): việc 100% chỉ được
//     báo để người dùng đánh dấu tay. Không gửi mô tả / ghi chú (người dùng yêu cầu).
// Cây trên Getfly: việc cha của dự án -> mỗi nhóm việc (danh mục) một việc -> các việc trong nhóm -> task con.
// Nhóm có thể gắn với một việc có sẵn trên Getfly (getfly_groups) thì dùng luôn việc đó, app không sửa / xoá nó.
// Việc chưa phân nhóm nằm thẳng dưới việc cha của dự án.
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
    const common = { project_id: p.getflyProjectId || undefined, task_type: '1', task_weight: 1 };
    const items: Item[] = [];
    const mapped = (p.getflyGroups ?? {}) as Record<string, { id: number; code: string; name: string }>;
    const gKey = (id: string) => `g:${id}`;
    // Tầng nhóm: nhóm có việc mà chưa gắn việc Getfly có sẵn thì tạo một việc cho nhóm.
    for (const g of bundle.groups) {
      const gt = bundle.tasks.filter((t) => t.groupId === g.id);
      if (!gt.length || mapped[g.id]?.id) continue;
      const starts = gt.map((t) => t.startDate ?? t.endDate).filter((d): d is string => !!d).sort();
      const ends = gt.map((t) => t.endDate ?? t.startDate).filter((d): d is string => !!d).sort();
      items.push({
        localId: gKey(g.id), parentLocal: null, done: false, label: `Nhóm ${g.name}`,
        info: {
          ...common,
          task_name: g.name,
          task_start_date: when(starts[0] ?? null, '08:00'),
          task_end_date: when(ends[ends.length - 1] ?? null, '17:30'),
          task_parent: String(p.getflyParentId),
        },
      });
    }
    for (const t of bundle.tasks) {
      const done = t.progress >= 100;
      items.push({
        localId: t.id, parentLocal: t.groupId ? gKey(t.groupId) : null, done, label: t.name,
        info: {
          ...common,
          task_name: t.name,
          task_start_date: when(t.startDate ?? t.endDate, '08:00'),
          task_end_date: when(t.endDate ?? t.startDate, '17:30'),
          // Không gửi mô tả / ghi chú: mô tả bên Getfly do người dùng tự quản.
          task_receiver: userOf(t.assignee),
          // Nhóm gắn việc có sẵn -> dùng id đó; nhóm tự tạo -> điền lúc chạy; chưa phân nhóm -> việc cha của dự án.
          task_parent: t.groupId && mapped[t.groupId]?.id ? String(mapped[t.groupId].id) : t.groupId ? undefined : String(p.getflyParentId),
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

    // 1) Xoá bên Getfly những việc đã xoá bên VNLab: task con trước, rồi việc, rồi việc của nhóm.
    const alive = new Set(items.map((i) => i.localId));
    const depth = (l: { localId: string; parentLocal: string | null }) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    const gone = [...links.values()].filter((l) => !alive.has(l.localId)).sort((a, b) => depth(b) - depth(a));
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
        if (it.parentLocal && info.task_parent === undefined) {
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
    if (r.completed) r.warnings.push(`${r.completed} việc đã xong 100%: API Getfly không cho đánh dấu hoàn thành — anh đánh dấu tay trên Getfly`);
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
export async function unsyncGetfly(projectId: string) {
  if (running.has(projectId)) throw new GetflyError(409, { message: 'Đang đồng bộ Getfly cho dự án này, đợi chút' });
  running.add(projectId);
  try {
    const links = (await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, completed from getfly_links where project_id = ${projectId}`)
      .map((l) => ({ ...l, getflyId: l.getflyId == null ? null : Number(l.getflyId) }));
    // Việc vừa tạo mà chưa tra được mã: tra theo id.
    const noCode = new Map(links.filter((l) => !l.getflyCode && l.getflyId).map((l) => [l.getflyId!, l]));
    if (noCode.size) await scanTasks((t) => { const l = noCode.get(Number(t.task_id)); if (l) { l.getflyCode = t.task_code; noCode.delete(Number(t.task_id)); } return noCode.size === 0; }, 20);
    const depth = (l: Link) => (l.localId.startsWith('g:') ? 0 : !l.parentLocal || l.parentLocal.startsWith('g:') ? 1 : 2);
    let deleted = 0;
    const errors: string[] = [];
    for (const l of links.sort((a, b) => depth(b) - depth(a))) {
      try {
        if (l.getflyCode) await gf('DELETE', '/tasks', { task_code: l.getflyCode });
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
