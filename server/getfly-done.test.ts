import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';
import { GETFLY_DONE_PATH, getflyBookmarklet } from '../src/lib/getfly-bookmarklet.ts';

test('Bookmarklet Hoàn thành Getfly: URL javascript:, chứa trang popup và là JS hợp lệ', () => {
  const url = getflyBookmarklet('https://project.vnlab.id.vn', 'https://acs.getflycrm.com');
  assert.ok(url.startsWith('javascript:'));
  const src = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(src.includes(JSON.stringify(GETFLY_DONE_PATH)));
  assert.ok(src.includes('"https://project.vnlab.id.vn"'));
  assert.ok(src.includes('"https://acs.getflycrm.com"'));
  assert.ok(!/__(PROJECT|GETFLY|PATH)__/.test(src));
  assert.ok(!/\balert\(|\bconfirm\(/.test(src)); // không dùng hộp thoại chặn
  assert.doesNotThrow(() => new Function(src)); // cú pháp hợp lệ
});

test('Getfly pending-done / mark-done: chỉ việc 100% có liên kết, theo quyền sửa; tụt tiến độ thì xoá dấu', { timeout: 60_000 }, async () => {
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', GETFLY_BASE_URL: 'https://acs.example.vn/' });
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

    assert.equal((await owner('GET', '/getfly/status')).body.webOrigin, 'https://acs.example.vn');

    const p = (await owner('POST', '/projects', { name: 'AMMS' })).body;
    const other = (await stranger('POST', '/projects', { name: 'Của người khác' })).body;
    assert.equal((await owner('POST', `/projects/${p.id}/members`, { email: 'editor@x.vn', role: 'editor' })).status, 201);
    assert.equal((await owner('POST', `/projects/${p.id}/members`, { email: 'viewer@x.vn', role: 'viewer' })).status, 201);
    const g = (await owner('POST', `/projects/${p.id}/groups`, { name: 'Kho' })).body;
    const mk = async (R: typeof owner, pid: string, name: string, progress: number) => (await R('POST', `/projects/${pid}/tasks`, { groupId: pid === p.id ? g.id : undefined, name, progress })).body;
    const done = await mk(owner, p.id, 'Xong rồi', 100);
    const half = await mk(owner, p.id, 'Mới một nửa', 50);
    const noLink = await mk(owner, p.id, 'Xong nhưng chưa lên Getfly', 100);
    const noId = await mk(owner, p.id, 'Xong, liên kết chưa có id', 100);
    const marked = await mk(owner, p.id, 'Đã đánh dấu trước', 100);
    const foreign = await mk(stranger, other.id, 'Việc của người khác', 100);
    const link = (pid: string, localId: string, id: number | null, extra = '') =>
      mem.db.query(`insert into getfly_links (project_id, local_id, parent_local, getfly_code, getfly_id, hash${extra ? ', completed_at' : ''}) values ($1, $2, $3, $4, $5, ''${extra ? ', now()' : ''})`, [pid, localId, `g:${g.id}`, `CVI/${id ?? 'x'}`, id]);
    await link(p.id, done.id, 9180);
    await link(p.id, half.id, 9181);
    await link(p.id, noId.id, null);
    await link(p.id, marked.id, 9182, 'done');
    await link(p.id, `g:${g.id}`, 9100); // liên kết nhóm, không phải việc
    await link(other.id, foreign.id, 9500);
    void noLink;

    // Chỉ việc 100% có id Getfly, chưa đánh dấu, ở dự án tôi được sửa.
    const pend = (await owner('GET', '/getfly/pending-done')).body;
    assert.deepEqual(pend.map((x: any) => x.getflyId), [9180]);
    assert.deepEqual(pend[0], { projectId: p.id, projectName: 'AMMS', taskId: done.id, name: 'Xong rồi', getflyId: 9180, getflyCode: 'CVI/9180' });
    assert.deepEqual((await editor('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9180]);
    assert.deepEqual((await viewer('GET', '/getfly/pending-done')).body, []); // chỉ xem -> không có
    assert.deepEqual((await stranger('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9500]);

    // Ghi nhận: từ chối id của dự án khác, việc chưa 100%, id không có; việc đã đánh dấu thì giữ nguyên.
    assert.equal((await owner('POST', '/getfly/mark-done', { getflyIds: ['9180'] })).status, 400);
    assert.deepEqual((await viewer('POST', '/getfly/mark-done', { getflyIds: [9180] })).body, { marked: [], rejected: [9180] });
    const before = (await mem.db.query<any>(`select completed_at from getfly_links where getfly_id = 9182`)).rows[0].completed_at;
    const r = (await editor('POST', '/getfly/mark-done', { getflyIds: [9180, 9181, 9500, 9182, 123456] })).body;
    assert.deepEqual([r.marked.sort(), r.rejected.sort()], [[9180, 9182], [123456, 9181, 9500].sort()]);
    const at = async (id: number) => (await mem.db.query<any>(`select completed_at from getfly_links where getfly_id = $1`, [id])).rows[0].completed_at;
    assert.ok(await at(9180));
    assert.equal(await at(9181), null);
    assert.equal(await at(9500), null);
    assert.equal(String(await at(9182)), String(before));
    assert.deepEqual((await owner('GET', '/getfly/pending-done')).body, []);

    // Tiến độ tụt dưới 100% -> xoá dấu; lên lại 100% -> chờ đánh dấu lại.
    assert.equal((await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { note: 'sửa ghi chú' })).status, 200);
    assert.ok(await at(9180)); // sửa khác không đụng tới
    assert.equal((await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { progress: 80 })).status, 200);
    assert.equal(await at(9180), null);
    assert.deepEqual((await owner('GET', '/getfly/pending-done')).body, []);
    await owner('PATCH', `/projects/${p.id}/tasks/${done.id}`, { progress: 100 });
    assert.deepEqual((await owner('GET', '/getfly/pending-done')).body.map((x: any) => x.getflyId), [9180]);
  } finally {
    await srv.stop();
    await mem.close();
  }
});
