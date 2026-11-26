// Truy vấn gộp (thay N+1 / UPDATE từng dòng): thống kê danh sách dự án, find_tasks nhiều dự án,
// /me/export, sắp xếp lại nhóm / phạm vi / phase / việc, index lower(email) và giới hạn kích thước import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('truy vấn gộp: stats, find_tasks, export, reorder hàng loạt cho kết quả như cũ', async () => {
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1' });
  try {
    const login = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'batch@x.vn', name: 'Gộp' }) });
    const session = cookieOf(login, 'prj_session');
    const raw = (method: string, path: string, body?: unknown) =>
      fetch(`${srv.base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const rest = async (method: string, path: string, body?: unknown) => {
      const r = await raw(method, path, body);
      assert.ok(r.ok, `${method} ${path}: ${await r.clone().text()}`);
      return r.json() as Promise<any>;
    };

    const a = await rest('POST', '/projects', { name: 'Dự án A' });
    const b = await rest('POST', '/projects', { name: 'Dự án B' });
    const empty = await rest('POST', '/projects', { name: 'Dự án trống' });
    const ga = await rest('POST', `/projects/${a.id}/groups`, { name: 'Nhóm A' });
    const gb = await rest('POST', `/projects/${b.id}/groups`, { name: 'Nhóm B' });
    await rest('POST', `/projects/${a.id}/tasks`, { groupId: ga.id, name: 'A xong', assignee: 'Lan', progress: 100, startDate: '2026-01-05', endDate: '2026-01-09' });
    await rest('POST', `/projects/${a.id}/tasks`, { groupId: ga.id, name: 'A quá hạn', assignee: 'Minh', progress: 20, startDate: '2026-01-02', endDate: '2026-01-20' });
    await rest('POST', `/projects/${b.id}/tasks`, { groupId: gb.id, name: 'B đang làm', assignee: 'Lan', progress: 50, startDate: '2099-01-01', endDate: '2099-02-01' });

    // Danh sách dự án: thống kê theo từng dự án (một truy vấn group by), dự án trống ra số 0.
    const list = await rest('GET', '/projects');
    const st = (id: string) => list.find((p: any) => p.id === id).stats;
    assert.deepEqual(st(a.id), { taskCount: 2, doneCount: 1, overdueCount: 1, progress: 60, firstStart: '2026-01-02', lastEnd: '2026-01-20' });
    assert.deepEqual(st(b.id), { taskCount: 1, doneCount: 0, overdueCount: 0, progress: 50, firstStart: '2099-01-01', lastEnd: '2099-02-01' });
    assert.deepEqual(st(empty.id), { taskCount: 0, doneCount: 0, overdueCount: 0, progress: 0, firstStart: null, lastEnd: null });

    // find_tasks qua MCP trên mọi dự án: việc của cả A và B, đúng nhóm / dự án; dự án lưu trữ bị bỏ qua.
    const token = (await rest('POST', '/tokens', { name: 'Batch test' })).token;
    let rpc = 0;
    const call = async (name: string, args: unknown) => {
      const r = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
      const result = (await r.json() as any).result;
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const lan = await call('find_tasks', { assignee: 'lan' });
    assert.deepEqual(lan.tasks.map((t: any) => [t.name, t.project, t.group]).sort(), [['A xong', 'Dự án A', 'Nhóm A'], ['B đang làm', 'Dự án B', 'Nhóm B']]);
    assert.equal((await call('find_tasks', { status: 'overdue' })).tasks[0].name, 'A quá hạn');
    assert.equal((await call('find_tasks', { limit: 1 })).truncated, true);
    await rest('PATCH', `/projects/${b.id}`, { archived: true });
    assert.deepEqual((await call('find_tasks', { assignee: 'lan' })).tasks.map((t: any) => t.name), ['A xong']);
    assert.deepEqual((await call('find_tasks', { projectId: b.id })).tasks.map((t: any) => t.name), ['B đang làm']);

    // Xuất dữ liệu: bundle từng dự án đầy đủ, theo thứ tự tạo, giống GET /projects/:id.
    const exp = await rest('GET', '/me/export');
    assert.deepEqual(exp.projects.map((p: any) => p.name), ['Dự án A', 'Dự án B', 'Dự án trống']);
    const one = await rest('GET', `/projects/${a.id}`);
    const pa = exp.projects[0];
    assert.deepEqual(pa.tasks, one.tasks);
    assert.deepEqual(pa.groups, one.groups);
    assert.deepEqual(exp.projects[2].tasks, []);

    // Sắp xếp lại hàng loạt: nhóm, phạm vi, phase, việc (kể cả chuyển nhóm) bằng một UPDATE.
    const g2 = await rest('POST', `/projects/${a.id}/groups`, { name: 'Nhóm A2' });
    const g3 = await rest('POST', `/projects/${a.id}/groups`, { name: 'Nhóm A3' });
    await rest('PUT', `/projects/${a.id}/groups/order`, { ids: [g3.id, ga.id, g2.id] });
    assert.deepEqual((await rest('GET', `/projects/${a.id}`)).groups.map((g: any) => [g.name, g.sort]), [['Nhóm A3', 0], ['Nhóm A', 1], ['Nhóm A2', 2]]);

    const s1 = await rest('POST', `/projects/${a.id}/scopes`, { name: 'S1' });
    const s2 = await rest('POST', `/projects/${a.id}/scopes`, { name: 'S2' });
    await rest('PUT', `/projects/${a.id}/scopes/order`, { ids: [s2.id, s1.id] });
    assert.deepEqual((await rest('GET', `/projects/${a.id}`)).scopes.map((s: any) => s.name), ['S2', 'S1']);

    const p1 = await rest('POST', `/projects/${a.id}/phases`, { name: 'P1' });
    const p2 = await rest('POST', `/projects/${a.id}/phases`, { name: 'P2' });
    await rest('PUT', `/projects/${a.id}/phases/order`, { ids: [p2.id, p1.id] });
    assert.deepEqual((await rest('GET', `/projects/${a.id}`)).phases.map((s: any) => s.name), ['P2', 'P1']);

    const tasks = (await rest('GET', `/projects/${a.id}`)).tasks;
    const [t1, t2] = tasks.map((t: any) => t.id);
    await rest('PUT', `/projects/${a.id}/tasks/order`, { groupId: g2.id, ids: [t2, t1] });
    const after = (await rest('GET', `/projects/${a.id}`)).tasks;
    assert.deepEqual(after.map((t: any) => [t.id, t.groupId, t.sort]), [[t2, g2.id, 0], [t1, g2.id, 1]]);
    // id của dự án khác không bị đụng tới.
    const bTask = (await rest('GET', `/projects/${b.id}`)).tasks[0];
    await rest('PUT', `/projects/${a.id}/tasks/order`, { groupId: g2.id, ids: [t1, bTask.id, t2] });
    assert.equal((await rest('GET', `/projects/${b.id}`)).tasks[0].groupId, gb.id);

    // Index theo lower(email) có mặt sau migration.
    const idx = await mem.db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'project_members_lower_email'`);
    assert.match(idx.rows[0].indexdef, /lower\(email\)/);

    // Import quá 10 MB bị chặn 413 trước khi parse.
    const big = JSON.stringify({ groups: [{ name: 'x', tasks: [{ name: 'y', note: 'z'.repeat(11 * 1024 * 1024) }] }] });
    const r = await fetch(`${srv.base}/api/projects/${a.id}/import`, { method: 'POST', headers: { cookie: `prj_session=${session}`, 'content-type': 'application/json' }, body: big });
    assert.equal(r.status, 413);
    const ok = await raw('POST', `/projects/${a.id}/import`, { groups: [{ name: 'Nhập', tasks: [{ name: 'Việc nhập' }] }] });
    assert.equal(ok.status, 201);
  } finally {
    await srv.stop();
    await mem.close();
  }
});
