// Đồng bộ một chiều app -> Google Calendar: mỗi việc có ngày là một sự kiện cả ngày
// (bắt đầu -> kết thúc) trên lịch mà người dùng chia sẻ cho service account
// (quyền "Thay đổi sự kiện"). Không cần bảng ánh xạ: id sự kiện suy ra từ id việc,
// mọi sự kiện mang extendedProperties.private.vnlabProject để biết sự kiện nào do app quản lý
// (sự kiện khác trên cùng lịch không bị đụng tới). Hash nội dung giúp bỏ qua sự kiện không đổi.
import { createHash } from 'node:crypto';
import { sql } from './db.ts';
import * as D from './data.ts';
import { addDays } from './dates.ts';
import { CALENDAR_API, GoogleError, gfetch, serviceAccountEmail } from './google.ts';

const PUBLIC_URL = () => (process.env.PROJECT_PUBLIC_URL ?? 'https://project.vnlab.id.vn').replace(/\/$/, '');

/** Nhận id lịch (abc@group.calendar.google.com, ten@gmail.com) hoặc link Google Calendar có src= / cid= / …/ical/<id>/… */
export function parseCalendarId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let id = s;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (!/(^|\.)google\.com$/i.test(u.hostname)) return null;
    const src = u.searchParams.get('src');
    const cid = u.searchParams.get('cid');
    const ical = u.pathname.match(/\/calendar\/ical\/([^/]+)\//);
    if (src) id = src;
    else if (ical) id = decodeURIComponent(ical[1]);
    else if (cid) {
      // cid là id lịch mã hoá base64 (không đệm =).
      try { id = Buffer.from(cid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
    } else return null;
  }
  id = id.trim();
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(id) && id.length <= 300 ? id : null;
}

export const calendarUrl = (id: string) => `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(id)}`;

/** Id sự kiện: base32hex (a–v, 0–9), 5–1024 ký tự. uuid bỏ gạch toàn 0–9a–f nên hợp lệ. */
export const eventIdOf = (taskId: string) => `vpj${taskId.replace(/-/g, '').toLowerCase()}`;

type Bundle = Awaited<ReturnType<typeof D.projectBundle>>;
type Task = Bundle['tasks'][number];
export type GcalEvent = {
  id: string;
  summary: string;
  description: string;
  start: { date: string };
  end: { date: string };
  transparency: 'transparent';
  source: { title: string; url: string };
  extendedProperties: { private: Record<string, string> };
};

/** Sự kiện muốn có cho một việc; việc chưa có ngày nào thì không có sự kiện. */
type Named = { id: string; name: string };
export function eventFor(p: { id: string; name: string; code: string; groups: readonly Named[]; scopes: readonly Named[]; phases: readonly Named[] }, t: Task): GcalEvent | null {
  const a = t.startDate ?? t.endDate;
  const b = t.endDate ?? t.startDate;
  if (!a || !b) return null;
  const [start, end] = a <= b ? [a, b] : [b, a];
  const done = t.progress >= 100;
  const url = `${PUBLIC_URL()}/du-an/${p.id}?task=${t.id}`;
  const group = p.groups.find((g) => g.id === t.groupId)?.name;
  const scope = p.scopes.find((s) => s.id === t.scopeId)?.name;
  const phase = p.phases.find((x) => x.id === t.phaseId)?.name;
  const lines = [
    `Dự án: ${p.name}${p.code ? ` (${p.code})` : ''}`,
    group && `Nhóm: ${group}`,
    phase && `Phase: ${phase}`,
    scope && `Phạm vi: ${scope}`,
    t.assignee && `Phụ trách: ${t.assignee}`,
    t.support && `Hỗ trợ: ${t.support}`,
    `Tiến độ: ${t.progress}%`,
    ...(t.subtasks.length ? ['', 'Task con:', ...t.subtasks.map((s) => `${s.progress >= 100 ? '✓' : '•'} ${s.name}${s.assignee ? ` — ${s.assignee}` : ''}${s.progress > 0 && s.progress < 100 ? ` (${s.progress}%)` : ''}`)] : []),
    ...(t.note.trim() ? ['', t.note.trim()] : []),
    '',
    `Mở trong VNLab Project: ${url}`,
  ].filter((x): x is string => typeof x === 'string');
  const body = {
    id: eventIdOf(t.id),
    summary: `${done ? '✓ ' : ''}${p.code ? `[${p.code}] ` : ''}${t.name}${!done && t.progress > 0 ? ` (${t.progress}%)` : ''}`,
    description: lines.join('\n').slice(0, 8000),
    start: { date: start },
    end: { date: addDays(end, 1) }, // Google: ngày kết thúc của sự kiện cả ngày là ngày SAU (không tính).
    transparency: 'transparent' as const, // không chiếm "bận" trong lịch
    source: { title: 'VNLab Project', url },
  };
  const hash = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { ...body, extendedProperties: { private: { vnlabProject: p.id, vnlabTask: t.id, vnlabHash: hash } } };
}

type Existing = { id: string; status?: string; extendedProperties?: { private?: Record<string, string> } };

const errs = () => ({
  forbidden: `Chưa có quyền. Hãy chia sẻ lịch cho ${serviceAccountEmail() ?? 'service account'}, quyền "Thay đổi sự kiện".`,
  notFound: `Không tìm thấy lịch — kiểm tra Mã lịch và quyền chia sẻ`,
});

/** Gọi Google Calendar; bị giới hạn tốc độ thì chờ tăng dần (1, 2, 4, 8, 16 giây) rồi thử lại. */
const RETRY_BASE_MS = Number(process.env.PROJECT_GCAL_RETRY_MS ?? 1000);
async function call<T>(url: string, init: Parameters<typeof gfetch>[1] = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await gfetch<T>(url, { ...errs(), ...init });
    } catch (err) {
      if (!(err instanceof GoogleError) || err.status !== 429 || i >= 5) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** i + Math.random() * 250));
    }
  }
}

async function listManaged(calendarId: string, projectId: string): Promise<Existing[]> {
  const out: Existing[] = [];
  let page: string | undefined;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ privateExtendedProperty: `vnlabProject=${projectId}`, maxResults: '2500', showDeleted: 'false', fields: 'items(id,status,extendedProperties),nextPageToken' });
    if (page) q.set('pageToken', page);
    const r = await call<{ items?: Existing[]; nextPageToken?: string }>(`${CALENDAR_API()}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
    out.push(...(r.items ?? []));
    page = r.nextPageToken;
    if (!page) break;
  }
  return out.filter((e) => e.status !== 'cancelled');
}

/** Chạy tối đa `n` việc song song (đủ nhanh mà không chạm hạn mức Google). */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export type GcalResult = { created: number; updated: number; deleted: number; unchanged: number };

/** Đưa lịch về đúng danh sách `want` (sự kiện app quản lý của dự án này). */
async function reconcile(calendarId: string, projectId: string, want: GcalEvent[]): Promise<GcalResult> {
  const base = `${CALENDAR_API()}/calendars/${encodeURIComponent(calendarId)}/events`;
  const have = new Map((await listManaged(calendarId, projectId)).map((e) => [e.id, e]));
  const r: GcalResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  await pool(want, 2, async (ev) => {
    const cur = have.get(ev.id);
    have.delete(ev.id);
    if (cur?.extendedProperties?.private?.vnlabHash === ev.extendedProperties.private.vnlabHash) { r.unchanged++; return; }
    if (!cur) {
      const made = await call<unknown>(base, { method: 'POST', body: JSON.stringify(ev), allow: [409] });
      if (made) { r.created++; return; }
      // 409: id đã từng dùng (sự kiện đã xoá vẫn nằm trong thùng rác) -> ghi đè và bật lại.
    }
    await call(`${base}/${ev.id}`, { method: 'PUT', body: JSON.stringify({ ...ev, status: 'confirmed' }) });
    if (cur) r.updated++; else r.created++;
  });
  await pool([...have.keys()], 2, async (id) => {
    await call(`${base}/${id}`, { method: 'DELETE', allow: [404, 410] });
    r.deleted++;
  });
  return r;
}

// Mọi lượt đồng bộ lịch chạy lần lượt trên cả server: nhiều dự án thường chung một lịch, và Google
// tính hạn mức theo lịch / service account — chạy song song là dễ bị "Rate Limit Exceeded".
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(_projectId: string, fn: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(fn);
  queue = next.catch(() => undefined);
  return next;
}

/** Đồng bộ một dự án đã liên kết lịch. Ghi kết quả / lỗi vào bảng projects. */
export function syncCalendar(projectId: string): Promise<GcalResult & { syncedAt: string }> {
  return serial(projectId, async () => {
    const [row] = await sql<D.ProjectRow[]>`select * from projects where id = ${projectId}`;
    if (!row) throw new GoogleError(404, 'Không tìm thấy dự án');
    if (!row.gcalId) throw new GoogleError(400, 'Dự án chưa liên kết Google Calendar');
    const bundle = await D.projectBundle(projectId);
    const want = bundle.tasks.map((t) => eventFor(bundle, t)).filter((e): e is GcalEvent => !!e);
    try {
      const r = await reconcile(row.gcalId, projectId, want);
      const [u] = await sql<{ gcalSyncedAt: Date }[]>`update projects set gcal_synced_at = now(), gcal_error = null where id = ${projectId} returning gcal_synced_at`;
      return { ...r, syncedAt: new Date(u.gcalSyncedAt).toISOString() };
    } catch (err) {
      const msg = err instanceof GoogleError ? err.message : `Lỗi đồng bộ lịch: ${(err as Error).message}`;
      await sql`update projects set gcal_error = ${msg} where id = ${projectId}`;
      throw err instanceof GoogleError ? err : new GoogleError(502, msg);
    }
  });
}

/** Bỏ liên kết: xoá các sự kiện app đã tạo trên lịch cũ (lỗi thì bỏ qua — lịch có thể đã mất quyền). */
export function clearCalendar(projectId: string, calendarId: string) {
  return serial(projectId, () => reconcile(calendarId, projectId, []));
}

// Tự đồng bộ: mọi lệnh ghi phát 'changed'; gộp trong khoảng trễ như Google Sheets.
const AUTO_DELAY_MS = Number(process.env.PROJECT_GCAL_AUTO_DELAY_MS ?? process.env.PROJECT_SHEET_AUTO_DELAY_MS ?? 30_000);
const RETRY_LATER_MS = Number(process.env.PROJECT_GCAL_RETRY_LATER_MS ?? 120_000);
const timers = new Map<string, NodeJS.Timeout>();
function schedule(projectId: string, delay: number, attempt = 0) {
  if (timers.has(projectId)) return;
  timers.set(projectId, setTimeout(async () => {
    timers.delete(projectId);
    try {
      const [p] = await sql<{ gcalId: string | null }[]>`select gcal_id from projects where id = ${projectId}`;
      if (p?.gcalId) await syncCalendar(projectId);
    } catch (err) {
      console.warn(`[gcal] tự đồng bộ ${projectId} lỗi:`, (err as Error).message);
      if (err instanceof GoogleError && err.status === 429 && attempt < 5) schedule(projectId, RETRY_LATER_MS, attempt + 1);
    }
  }, delay));
}
export function startCalendarAutoSync() {
  D.projectEvents.on('changed', (projectId: string) => schedule(projectId, AUTO_DELAY_MS));
}
