import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';
import { GETFLY_DONE_PATH, getflyBookmarklet, getflyBookmarkletScript } from '../src/lib/getfly-bookmarklet.ts';

test('Bookmarklet Hoàn thành Getfly: URL javascript:, chứa trang popup và là JS hợp lệ', () => {
  // Dấu trang chỉ là bộ nạp /bm/getfly.js (luôn bản mới nhất); mã thật do server phục vụ.
  const url = getflyBookmarklet('https://project.vnlab.id.vn', 'https://acs.getflycrm.com');
  assert.ok(url.startsWith('javascript:'));
  const loader = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(loader.includes('"https://project.vnlab.id.vn/bm/getfly.js"'));
  assert.doesNotThrow(() => new Function(loader));
  const src = getflyBookmarkletScript('https://project.vnlab.id.vn', 'https://acs.getflycrm.com');
  assert.ok(src.includes(JSON.stringify(GETFLY_DONE_PATH)));
  assert.ok(src.includes('"https://project.vnlab.id.vn"'));
  assert.ok(src.includes('"https://acs.getflycrm.com"'));
  assert.ok(!/__(PROJECT|GETFLY|PATH)__/.test(src));
  assert.ok(!/\balert\(|\bconfirm\(/.test(src)); // không dùng hộp thoại chặn
  assert.doesNotThrow(() => new Function(src)); // cú pháp hợp lệ
  // Chỉ nhận hộp việc mới mở sau khi đổi hash (Getfly có việc trùng tên), đối chiếu id / mã, hash trùng thì về #/tasks trước.
  for (const s of ['MutationObserver', 'before.indexOf(m) < 0', 'verifyTask', "'task_id=' + it.getflyId", 'closeAll()', "location.hash === target", "location.hash = '#/tasks'"]) assert.ok(src.includes(s), s);
});

test('Popup Getfly: báo sẵn sàng, chỉ nhận Bắt đầu từ đúng popup và không chạy hai lần', () => {
  const P = 'https://project.vnlab.id.vn', G = 'https://acs.getflycrm.com';
  const handlers = new Set<(e: any) => void>();
  const sent: any[] = [];
  const popup = { postMessage: (data: any, origin: string) => sent.push({ data, origin }), closed: false };
  const element = () => ({ style: {}, appendChild() {}, remove() {}, innerHTML: '', textContent: '' });
  const box = element();
  const window = {
    open: () => popup, focus() {},
    addEventListener: (_: string, fn: (e: any) => void) => handlers.add(fn),
    removeEventListener: (_: string, fn: (e: any) => void) => handlers.delete(fn),
  };
  runInNewContext(getflyBookmarkletScript(P, G), {
    window, location: { origin: G }, screen: { availWidth: 1440, availHeight: 900 },
    document: { getElementById: () => box, createElement: element, body: element(), querySelectorAll: () => [] },
    setTimeout: () => 1, clearTimeout() {},
  });
  const message = (type: string, origin = P, source: unknown = popup, extra = {}) => {
    for (const fn of [...handlers]) fn({ origin, source, data: { type, ...extra } });
  };
  message('vnlab-getfly-done-start'); // chưa có danh sách
  assert.equal(sent.length, 0);
  message('vnlab-getfly-done-list', P, popup, { items: [{ getflyId: 9130, name: 'Review lần 2' }] });
  assert.equal(sent[0].data.type, 'vnlab-getfly-done-ready');
  message('vnlab-getfly-done-start', G);
  message('vnlab-getfly-done-start', P, {});
  assert.equal(sent.length, 1);
  message('vnlab-getfly-done-start');
  message('vnlab-getfly-done-start');
  assert.deepEqual(sent.map((x) => x.data.type), ['vnlab-getfly-done-ready', 'vnlab-getfly-done-started']);
  assert.ok(sent.every((x) => x.origin === P));
});

/** Getfly giả: chỉ danh sách việc (mới -> cũ) với task_status đổi được; '6' = hoàn thành, '11' = đang tiến hành. */
async function fakeGetfly(status: Record<number, string>) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://x');
    const json = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== 'khoa') return json({ message: 'Unauthorized' }, 401);
    if (url.pathname !== '/api/v3/tasks') return json({ message: 'no route' }, 404);
    const all = Object.keys(status).map(Number).sort((a, b) => b - a).map((id) => ({ task_id: String(id), task_code: `CVI/2026-11/00${id}`, task_name: `Việc ${id}`, project_id: '1', project_name: 'X', task_status: status[id] }));
    const limit = Number(url.searchParams.get('limit') ?? 10), page = Number(url.searchParams.get('page') ?? 1);
    json({ data: all.slice((page - 1) * limit, page * limit), total_page: Math.ceil(all.length / limit), current_page: page });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test('Getfly pending-done / mark-done: theo quyền sửa, chỉ tin trạng thái thật trên Getfly; tụt tiến độ thì xoá dấu', { timeout: 60_000 }, async () => {
  const status: Record<number, string> = { 9100: '11', 9180: '11', 9181: '11', 9182: '6', 9207: '11', 9300: '6', 9500: '11' };
  const gf = await fakeGetfly(status);
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', GETFLY_BASE_URL: `${gf.base}/`, GETFLY_API_KEY: 'khoa' });
  try {
    const login = async (email: string) => {
      const r = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email }) });
      const session = cookieOf(r, 'prj_session');
      return async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${srv.base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) as any };
      };
    };
    const owner = await login('owner@x.vn');
    const editor = await login('editor@x.vn');
    const viewer = await login('viewer@x.vn');
    const stranger = await login('stranger@x.vn');

    assert.equal((await owner('GET', '/getfly/status')).body.webOrigin, gf.base);

    const p = (await owner('POST', '/projects', { name: 'AMMS' })).body;
    const other = (await stranger('POST', '/projects', { name: 'Của người khác' })).body;
    assert.equal((await owner('POST', `/projects/${p.id}/members`, { email: 'editor@x.vn', role: 'editor' })).status, 201);
    assert.equal((await owner('POST', `/projects/${p.id}/members`, { email: 'viewer@x.vn', role: 'viewer' })).status, 201);
    const g = (await owner('POST', `/projects/${p.id}/groups`, { name: 'Kho' })).body;
    const mk = async (R: typeof owner, pid: string, name: string, progress: number) => (await R('POST', `/projects/${pid}/tasks`, { groupId: pid === p.id ? g.id : undefined, name, progress })).body;
    const done = await mk(owner, p.id, 'Xong rồi', 100);
    const half = await mk(owner, p.id, 'Mới một nửa', 50);
    await mk(owner, p.id, 'Xong nhưng chưa lên Getfly', 100);
    const noId = await mk(owner, p.id, 'Xong, liên kết chưa có id', 100);
    const marked = await mk(owner, p.id, 'Đã đánh dấu trước', 100);
    const wrong = await mk(owner, p.id, 'Bị báo nhầm là xong', 100);
    const auto = await mk(owner, p.id, 'Đã hoàn thành tay trên Getfly', 100);
    const foreign = await mk(stranger, other.id, 'Việc của người khác', 100);
    const link = (pid: string, localId: string, id: number | null, completed = false) =>
      mem.db.query(`insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash, completed_at) values ($1, $2, $3, $4, $5, '', ${completed ? 'now()' : 'null'})`, [pid, localId, `g:${g.id}`, `CVI/${id ?? 'x'}`, id]);
    await link(p.id, done.id, 9180);
    await link(p.id, half.id, 9181);
    await link(p.id, noId.id, null);
    await link(p.id, marked.id, 9182, true);
    await link(p.id, wrong.id, 9207, true); // bookmarklet cũ báo nhầm: completed_at có mà Getfly vẫn '11'
    await link(p.id, auto.id, 9300);
    await link(p.id, `g:${g.id}`, 9100); // liên kết nhóm, không phải việc
    await link(other.id, foreign.id, 9500);
    const at = async (id: number) => (await mem.db.query<any>(`select completed_at from getfly_links where getfly_id = $1`, [id])).rows[0].completed_at;

    // Chỉ việc 100% có id Getfly mà trên Getfly chưa hoàn thành, ở dự án tôi được sửa.
    const pend = (await owner('GET', '/getfly/pending-done')).body;
    assert.deepEqual(pend.map((x: any) => x.getflyId), [9180, 9207]);
    assert.deepEqual(pend[0], { projectId: p.id, projectName: 'AMMS', taskId: done.id, name: 'Xong rồi', getflyId: 9180, getflyCode: 'CVI/9180' });
    assert.equal(await at(9207), null); // tự sửa dấu sai
    assert.ok(await at(9300)); // Getfly đã hoàn thành -> ghi nhận luôn
    assert.deepEqual((await editor('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9180, 9207]);
    assert.deepEqual((await viewer('GET', '/getfly/pending-done')).body, []); // chỉ xem -> không có
    assert.deepEqual((await stranger('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9500]);

    // Ghi nhận: chỉ khi Getfly thật sự '6'; từ chối id dự án khác, việc chưa 100%, id không có.
    assert.equal((await owner('POST', '/getfly/mark-done', { getflyIds: ['9180'] })).status, 400);
    assert.deepEqual((await viewer('POST', '/getfly/mark-done', { getflyIds: [9180] })).body.marked, []);
    const before = await at(9182);
    const r = (await editor('POST', '/getfly/mark-done', { getflyIds: [9180, 9181, 9500, 9182, 123456] })).body;
    assert.deepEqual([r.marked, [...r.rejected].sort()], [[9182], [123456, 9180, 9181, 9500]]);
    assert.equal(r.reasons[9180], 'Getfly chưa hoàn thành');
    assert.match(r.reasons[9500], /không thuộc dự án|chưa xong/i);
    assert.equal(await at(9180), null);
    assert.equal(await at(9500), null);
    assert.equal(String(await at(9182)), String(before));
    status[9180] = '6'; // bookmarklet bấm xong trên Getfly
    assert.deepEqual((await editor('POST', '/getfly/mark-done', { getflyIds: [9180] })).body.marked, [9180]);
    assert.ok(await at(9180));
    assert.deepEqual((await owner('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9207]);

    // Tiến độ tụt dưới 100% -> xoá dấu; lên lại 100% mà Getfly vẫn hoàn thành -> tự ghi nhận lại.
    assert.equal((await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { note: 'sửa ghi chú' })).status, 200);
    assert.ok(await at(9180)); // sửa khác không đụng tới
    assert.equal((await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { progress: 80 })).status, 200);
    assert.equal(await at(9180), null);
    await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { progress: 100 });
    assert.deepEqual((await owner('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9207]);
    assert.ok(await at(9180));
  } finally {
    await srv.stop();
    await mem.close();
    gf.close();
  }
});
