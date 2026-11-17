import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { eventFor, eventIdOf, parseCalendarId } from './gcal.ts';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('parseCalendarId: mã lịch, email, link src= / cid= / ical', () => {
  const id = 'abc123def@group.calendar.google.com';
  assert.equal(parseCalendarId(id), id);
  assert.equal(parseCalendarId(' an@gmail.com '), 'an@gmail.com');
  assert.equal(parseCalendarId(`https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id)}&ctz=Asia%2FHo_Chi_Minh`), id);
  assert.equal(parseCalendarId(`https://calendar.google.com/calendar/u/0?cid=${Buffer.from(id).toString('base64').replace(/=+$/, '')}`), id);
  assert.equal(parseCalendarId(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`), id);
  assert.equal(parseCalendarId('https://evil.example.com/?src=a@b.c'), null);
  assert.equal(parseCalendarId('khong-phai-lich'), null);
  assert.equal(parseCalendarId(''), null);
});

test('eventFor: sự kiện cả ngày, kết thúc là ngày sau, việc xong có ✓, thiếu ngày thì bỏ', () => {
  const p = { id: 'p1', name: 'Web', code: 'WEB', groups: [{ id: 'g1', name: 'Thiết kế', sort: 0, collapsed: false }], scopes: [], phases: [] };
  const base = { id: '0b8c2f5e-1111-4222-8333-444455556666', projectId: 'p1', groupId: 'g1', name: 'Màn đăng nhập', scopeId: null, phaseId: null, subtasks: [], assignee: 'An', support: '', progress: 40, startDate: '2026-11-02', endDate: '2026-11-07', days: null, note: '', getflyNote: false, sort: 0, baselineStart: null, baselineEnd: null };
  const ev = eventFor(p, base)!;
  assert.equal(ev.id, 'vpj0b8c2f5e111142228333444455556666');
  assert.match(ev.id, /^[a-v0-9]{5,1024}$/);
  assert.deepEqual([ev.start.date, ev.end.date], ['2026-11-02', '2026-11-08']);
  assert.equal(ev.summary, '[WEB] Màn đăng nhập (40%)');
  assert.match(ev.description, /Nhóm: Thiết kế/);
  assert.match(ev.description, /Phụ trách: An/);
  assert.equal(eventFor(p, { ...base, progress: 100 })!.summary, '✓ [WEB] Màn đăng nhập');
  assert.deepEqual([eventFor(p, { ...base, startDate: null })!.start.date, eventFor(p, { ...base, startDate: null })!.end.date], ['2026-11-07', '2026-11-08']);
  assert.equal(eventFor(p, { ...base, startDate: null, endDate: null }), null);
  assert.notEqual(eventFor(p, { ...base, name: 'Khác' })!.extendedProperties.private.vnlabHash, ev.extendedProperties.private.vnlabHash);
  assert.equal(eventIdOf(base.id), ev.id);
});

/** Google Calendar giả: token + events (list theo privateExtendedProperty, insert có 409 khi trùng id, put, delete). */
async function fakeCalendar() {
  const calls: { method: string; path: string }[] = [];
  const state = { throttle: 0 };
  // id lịch -> (id sự kiện -> sự kiện). Sự kiện xoá giữ lại với status cancelled như Google.
  const cals = new Map<string, Map<string, any>>([['team@group.calendar.google.com', new Map()], ['khac@group.calendar.google.com', new Map()]]);
  cals.get('team@group.calendar.google.com')!.set('ngoai', { id: 'ngoai', summary: 'Họp tuần (không phải của app)', status: 'confirmed' });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname });
    const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/token') return json({ access_token: 'fake-token', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer fake-token') return json({ error: { message: 'no auth' } }, 401);
    const m = url.pathname.match(/^\/cal\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m) return json({ error: { message: 'Not Found' } }, 404);
    const calId = decodeURIComponent(m[1]);
    if (calId.startsWith('noshare')) return json({ error: { message: 'Forbidden' } }, 403);
    const cal = cals.get(calId);
    if (!cal) return json({ error: { message: 'Not Found' } }, 404);
    const evId = m[2];
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'GET' && !evId) {
      const [k, v] = (url.searchParams.get('privateExtendedProperty') ?? '').split('=');
      const items = [...cal.values()].filter((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.[k] === v);
      return json({ items });
    }
    if (req.method === 'POST' && !evId) {
      if (state.throttle > 0) { state.throttle--; return json({ error: { message: 'Rate Limit Exceeded' } }, 403); }
      if (cal.has(body.id)) return json({ error: { message: 'The requested identifier already exists.' } }, 409);
      cal.set(body.id, { ...body, status: 'confirmed' });
      return json(cal.get(body.id));
    }
    if (req.method === 'PUT' && evId) {
      if (!cal.has(evId)) return json({ error: { message: 'Not Found' } }, 404);
      cal.set(evId, { ...body, id: evId });
      return json(cal.get(evId));
    }
    if (req.method === 'DELETE' && evId) {
      const e = cal.get(evId);
      if (!e || e.status === 'cancelled') return json({ error: { message: 'Resource has been deleted' } }, 410);
      e.status = 'cancelled';
      res.writeHead(204); return res.end();
    }
    json({ error: { message: `không có ${req.method} ${url.pathname}` } }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const live = (calId: string) => [...cals.get(calId)!.values()].filter((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.vnlabProject);
  return { server, base, calls, cals, live, state };
}

test('đồng bộ Google Calendar: liên kết, tạo / sửa / xoá sự kiện cho khớp, bỏ qua sự kiện không đổi, tự đồng bộ, đổi lịch, bỏ liên kết, lỗi quyền', { timeout: 90_000 }, async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const dir = mkdtempSync(join(tmpdir(), 'vnlab-sa-'));
  const saFile = join(dir, 'sa.json');
  writeFileSync(saFile, JSON.stringify({ client_email: 'vnlab-project-sheets@test.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) }));
  const mem = await memoryDb();
  const g = await fakeCalendar();
  const srv = await startServer({
    PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', GOOGLE_SERVICE_ACCOUNT_FILE: saFile,
    GOOGLE_TOKEN_URL: `${g.base}/token`, GOOGLE_CALENDAR_API: `${g.base}/cal`, PROJECT_SHEET_AUTO_DELAY_MS: '300', PROJECT_GCAL_RETRY_MS: '10',
  });
  try {
    const login = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'an@x.vn', name: 'Trần Văn An', roles: ['project:user'] }) });
    const cookie = `prj_session=${cookieOf(login, 'prj_session')}`;
    const j = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${srv.base}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    const p = (await j('POST', '/projects', { name: 'Website', code: 'WEB' })).body;
    await j('POST', `/projects/${p.id}/import`, { groups: [{ name: 'Thiết kế', tasks: [
      { name: 'Đăng nhập', assignee: 'An', progress: 100, startDate: '2026-11-02', endDate: '2026-11-07' },
      { name: 'Giỏ hàng', assignee: 'Bình', startDate: '2026-11-09', endDate: '2026-11-13' },
      { name: 'Chưa có ngày' },
    ] }] });
    const TEAM = 'team@group.calendar.google.com';

    // Chưa liên kết -> 400; lịch không nhận ra -> 400.
    assert.equal((await j('POST', `/projects/${p.id}/gcal/sync`, {})).status, 400);
    assert.equal((await j('PATCH', `/projects/${p.id}/gcal`, { calendar: 'linh tinh' })).status, 400);

    const linked = await j('PATCH', `/projects/${p.id}/gcal`, { calendar: `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(TEAM)}` });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.gcalId, TEAM);
    const s1 = await j('POST', `/projects/${p.id}/gcal/sync`, {});
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.deepEqual([s1.body.created, s1.body.updated, s1.body.deleted], [2, 0, 0]);
    assert.deepEqual(g.live(TEAM).map((e) => e.summary).sort(), ['[WEB] Giỏ hàng', '✓ [WEB] Đăng nhập']);
    const cart = g.live(TEAM).find((e) => e.summary.includes('Giỏ hàng'));
    assert.deepEqual([cart.start.date, cart.end.date], ['2026-11-09', '2026-11-14']);
    assert.equal(g.cals.get(TEAM)!.get('ngoai').status, 'confirmed', 'không đụng sự kiện ngoài app');

    // Đồng bộ lại không đổi gì -> không ghi.
    g.calls.length = 0;
    const s2 = (await j('POST', `/projects/${p.id}/gcal/sync`, {})).body;
    assert.deepEqual([s2.created, s2.updated, s2.deleted, s2.unchanged], [0, 0, 0, 2]);
    assert.ok(g.calls.every((c) => c.method === 'GET' || c.path === '/token'));

    // Sửa / xoá / thêm ngày cho việc -> tự đồng bộ (sau ~300ms).
    const detail = (await j('GET', `/projects/${p.id}`)).body;
    const byName = (n: string) => detail.tasks.find((t: any) => t.name === n);
    await j('PATCH', `/projects/${p.id}/tasks/${byName('Giỏ hàng').id}`, { progress: 50, endDate: '2026-11-20' });
    await j('DELETE', `/projects/${p.id}/tasks/${byName('Đăng nhập').id}`);
    await j('PATCH', `/projects/${p.id}/tasks/${byName('Chưa có ngày').id}`, { startDate: '2026-11-16', endDate: '2026-11-16' });
    for (let i = 0; i < 50 && !g.live(TEAM).some((e) => e.summary.includes('Chưa có ngày')); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(g.live(TEAM).map((e) => e.summary).sort(), ['[WEB] Chưa có ngày', '[WEB] Giỏ hàng (50%)']);
    assert.equal(g.live(TEAM).find((e) => e.summary.includes('Giỏ hàng')).end.date, '2026-11-21');
    assert.ok((await j('GET', `/projects/${p.id}`)).body.gcalSyncedAt);

    // Thêm việc mới bằng tay -> đồng bộ tay tạo thêm sự kiện.
    const back = (await j('POST', `/projects/${p.id}/tasks`, { name: 'Đăng nhập', startDate: '2026-11-03', endDate: '2026-11-03' })).body;
    assert.ok(back.id);
    const s3 = (await j('POST', `/projects/${p.id}/gcal/sync`, {})).body;
    assert.equal(s3.created, 1);

    // Google giới hạn tốc độ (403 Rate Limit Exceeded) -> chờ rồi thử lại, không báo nhầm là thiếu quyền.
    g.state.throttle = 2;
    await j('POST', `/projects/${p.id}/tasks`, { name: 'Bị giới hạn', startDate: '2026-11-18', endDate: '2026-11-18' });
    const s4 = await j('POST', `/projects/${p.id}/gcal/sync`, {});
    assert.equal(s4.status, 200, JSON.stringify(s4.body));
    assert.equal(s4.body.created, 1);
    assert.equal(g.state.throttle, 0);

    // Đổi sang lịch khác: lịch cũ được dọn, lịch mới có đủ sự kiện.
    const OTHER = 'khac@group.calendar.google.com';
    assert.equal((await j('PATCH', `/projects/${p.id}/gcal`, { calendar: OTHER })).status, 200);
    assert.equal(g.live(TEAM).length, 0);
    assert.equal((await j('POST', `/projects/${p.id}/gcal/sync`, {})).body.created, 4);
    assert.equal(g.live(OTHER).length, 4);

    // Bỏ liên kết: xoá sự kiện app đã tạo, sự kiện ngoài app còn nguyên.
    const off = await j('PATCH', `/projects/${p.id}/gcal`, { calendar: null });
    assert.equal(off.body.gcalId, null);
    assert.equal(g.live(OTHER).length, 0);
    assert.equal(g.cals.get(TEAM)!.get('ngoai').status, 'confirmed');

    // Lịch chưa chia sẻ: báo lỗi rõ, lưu gcalError.
    await j('PATCH', `/projects/${p.id}/gcal`, { calendar: 'noshare@group.calendar.google.com' });
    const denied = await j('POST', `/projects/${p.id}/gcal/sync`, {});
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Thay đổi sự kiện/);
    assert.match((await j('GET', `/projects/${p.id}`)).body.gcalError, /vnlab-project-sheets@test/);
  } finally {
    await srv.stop();
    g.server.close();
    await mem.close();
  }
});
