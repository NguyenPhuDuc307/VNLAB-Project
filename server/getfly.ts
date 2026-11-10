// Đồng bộ một chiều VNLab Project -> Getfly CRM (API v6.1): mỗi việc thành một công việc Getfly
// nằm dưới "việc cha" của dự án (cấu hình theo dự án), task con thành việc con của việc tương ứng.
// Bấm nút là tạo việc mới, sửa việc đã đổi, đánh dấu hoàn thành, xoá việc đã xoá bên VNLab.
// Liên kết lưu ở bảng getfly_links (mã Getfly + băm nội dung đã gửi) để không tạo trùng / gửi thừa.
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

async function gf<T = Json>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!getflyStatus().configured) throw new GetflyError(503, { message: 'Chưa cấu hình Getfly trên máy chủ (GETFLY_BASE_URL, GETFLY_API_KEY)' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${base()}/api/v6.1${path}`, {
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
    const d = data as { message?: unknown; error?: unknown; errors?: unknown } | null;
    const msg = typeof d?.message === 'string' ? d.message : typeof d?.error === 'string' ? d.error : d?.errors ? JSON.stringify(d.errors) : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new GetflyError(502, { message: `Getfly từ chối API key (${msg})` });
    throw new GetflyError(res.status === 404 ? 404 : 502, { message: `Getfly: ${msg}` });
  }
  return data as T;
}

/** Tra việc theo id (từ link #/tasks/?…task_id=8689) hoặc mã việc. */
export async function findGetflyTask(input: string): Promise<{ id: number | null; code: string; name: string; projectName: string | null }> {
  const s = input.trim();
  if (!s) throw new GetflyError(400, { message: 'Nhập link hoặc mã việc Getfly' });
  const idMatch = s.match(/task_id=(\d+)/) ?? s.match(/^(\d+)$/);
  const fields = 'id,task_code,task_name,project_name';
  if (idMatch) {
    const r = await gf<{ data?: Json[] }>('GET', `/tasks?fields=${fields}&limit=5&offset=0&filter[id][eq]=${idMatch[1]}`);
    const t = (r.data ?? []).find((x) => String(x.id) === idMatch[1]) ?? null;
    if (!t) throw new GetflyError(404, { message: `Không thấy việc Getfly id ${idMatch[1]} (API key có quyền xem việc này không?)` });
    return { id: Number(t.id), code: String(t.task_code), name: String(t.task_name ?? ''), projectName: (t.project_name as string) ?? null };
  }
  const t = await gf<Json>('GET', `/task?fields=${fields}&task_code=${encodeURIComponent(s)}`);
  const row = (t.data as Json) ?? t;
  if (!row?.task_code) throw new GetflyError(404, { message: `Không thấy việc Getfly mã ${s}` });
  return { id: row.id ? Number(row.id) : null, code: String(row.task_code), name: String(row.task_name ?? ''), projectName: (row.project_name as string) ?? null };
}

type Link = { localId: string; parentLocal: string | null; getflyCode: string; getflyId: number | null; hash: string; completed: boolean };
type Item = { localId: string; parentLocal: string | null; payload: Json; done: boolean; label: string };
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
    const bundle = await D.projectBundle(projectId);
    const users: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.getflyUsers ?? {}) as Record<string, string>)) if (v?.trim()) users[k.trim().toLowerCase()] = v.trim();
    const userOf = (name: string) => {
      for (const n of name.split(',')) { const u = users[n.trim().toLowerCase()]; if (u) return u; }
      return undefined;
    };
    const groups = new Map(bundle.groups.map((g) => [g.id, g.name]));
    const scopes = new Map(bundle.scopes.map((s) => [s.id, s]));
    const items: Item[] = [];
    for (const t of bundle.tasks) {
      const scope = t.scopeId ? scopes.get(t.scopeId) : undefined;
      const meta = [t.groupId ? `Nhóm: ${groups.get(t.groupId)}` : null, scope ? `Phạm vi: ${scope.name}${scope.owner ? ` (phụ trách ${scope.owner})` : ''}` : null, t.support ? `Hỗ trợ: ${t.support}` : null, `Tiến độ: ${t.progress}%`].filter(Boolean).join(' · ');
      const related = t.support.split(',').map((n) => userOf(n)).filter((u): u is string => !!u);
      items.push({
        localId: t.id, parentLocal: null, done: t.progress >= 100, label: t.name,
        payload: {
          task_name: t.name,
          task_start_date: when(t.startDate ?? t.endDate, '08:00:00'),
          task_end_date: when(t.endDate ?? t.startDate, '17:30:00'),
          task_description: `${t.note ? `<p>${esc(t.note).replace(/\n/g, '<br>')}</p>` : ''}<p><i>${esc(meta)} — đồng bộ từ VNLab Project</i></p>`,
          task_receiver_username: userOf(t.assignee),
          related_users: related.length ? related : undefined,
          project_name: p.getflyProjectName || undefined,
          task_parent_code: p.getflyParentCode || undefined,
        },
      });
      for (const s of t.subtasks ?? []) {
        items.push({
          localId: s.id, parentLocal: t.id, done: s.progress >= 100, label: `${t.name} › ${s.name}`,
          payload: {
            task_name: s.name,
            task_start_date: when(t.startDate ?? t.endDate, '08:00:00'),
            task_end_date: when(t.endDate ?? t.startDate, '17:30:00'),
            task_description: `<p><i>Task con của “${esc(t.name)}” · Tiến độ: ${s.progress}% — đồng bộ từ VNLab Project</i></p>`,
            task_receiver_username: userOf(s.assignee),
            project_name: p.getflyProjectName || undefined,
            // task_parent_code điền lúc chạy: mã Getfly của việc cha vừa tạo / đã có.
          },
        });
      }
    }
    const links = new Map((await sql<Link[]>`select local_id, parent_local, getfly_code, getfly_id, hash, completed from getfly_links where project_id = ${projectId}`).map((l) => [l.localId, l]));
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
      try { await gf('DELETE', '/task', { task_code: l.getflyCode }); r.deleted++; }
      catch (err) { if ((err as GetflyError).status !== 404) { r.errors.push(`Xoá ${l.getflyCode}: ${(err as Error).message}`); continue; } r.deleted++; }
      links.delete(l.localId);
      await sql`delete from getfly_links where project_id = ${projectId} and local_id = ${l.localId}`;
    }

    // 2) Tạo / sửa (việc cha trước, task con sau để có mã cha), rồi đánh dấu hoàn thành.
    for (const it of items) {
      try {
        const payload: Json = { ...it.payload };
        if (it.parentLocal) {
          const parent = links.get(it.parentLocal);
          if (!parent) { r.errors.push(`${it.label}: việc cha chưa lên Getfly`); continue; }
          payload.task_parent_code = parent.getflyCode;
        }
        for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
        const hash = hashOf(payload);
        const cur = links.get(it.localId);
        let link: Link;
        if (!cur) {
          const res = await gf<{ data?: { task_id?: number; task_code?: string } }>('POST', '/task', payload);
          const code = res.data?.task_code;
          if (!code) throw new GetflyError(502, { message: 'Getfly không trả mã việc' });
          link = { localId: it.localId, parentLocal: it.parentLocal, getflyCode: code, getflyId: res.data?.task_id ?? null, hash, completed: false };
          r.created++;
        } else if (cur.hash !== hash) {
          const res = await gf<{ data?: { task_id?: number; task_code?: string } }>('PUT', '/task', { current_task_code: cur.getflyCode, ...payload });
          link = { ...cur, parentLocal: it.parentLocal, getflyCode: res.data?.task_code ?? cur.getflyCode, getflyId: res.data?.task_id ?? cur.getflyId, hash };
          r.updated++;
        } else { link = cur; r.unchanged++; }
        if (it.done && !link.completed) {
          await gf('POST', '/task/complete', { task_code: link.getflyCode });
          link = { ...link, completed: true };
          r.completed++;
        } else if (!it.done && link.completed) {
          r.warnings.push(`${it.label}: đã hoàn thành trên Getfly nhưng bên VNLab mở lại — Getfly không có API mở lại, sửa tay trên Getfly`);
        }
        await save(link);
      } catch (err) {
        r.errors.push(`${it.label}: ${(err as Error).message}`);
      }
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
