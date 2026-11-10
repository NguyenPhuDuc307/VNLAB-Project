import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('MCP transfer_tasks: chuyển đúng việc, giữ lịch sử / task con / liên kết và rollback khi sai phạm vi', async () => {
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1' });
  try {
    const login = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'transfer@x.vn', name: 'Người chuyển' }) });
    const session = cookieOf(login, 'prj_session');
    const rest = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${srv.base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(r.ok, await r.clone().text());
      return r.json() as Promise<any>;
    };
    const token = (await rest('POST', '/tokens', { name: 'Transfer test' })).token;
    let id = 0;
    const call = async (args: unknown, error = false) => {
      const r = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'transfer_tasks', arguments: args } }) });
      const result = (await r.json() as any).result;
      assert.equal(!!result.isError, error, JSON.stringify(result));
      return error ? result.content[0].text : JSON.parse(result.content[0].text);
    };
    const source = await rest('POST', '/projects', { name: 'AMMS tháng 10' });
    const target = await rest('POST', '/projects', { name: 'AMMS tháng 11' });
    const group = await rest('POST', `/projects/${source.id}/groups`, { name: 'Kho' });
    const scope = await rest('POST', `/projects/${source.id}/scopes`, { name: 'Dock', color: '#123456', owner: 'Đức', note: 'Phạm vi gốc' });
    const task = await rest('POST', `/projects/${source.id}/tasks`, { groupId: group.id, scopeId: scope.id, name: 'Cần chuyển', assignee: 'Đức', support: 'Lương', startDate: '2026-11-10', endDate: '2026-11-13', days: 3, note: 'Ban đầu', subtasks: [{ name: 'Task con', assignee: 'Đức', progress: 50 }] });
    await rest('PATCH', `/projects/${source.id}/tasks/${task.id}`, { note: 'Giữ ghi chú này' });
    const untouched = await rest('POST', `/projects/${source.id}/tasks`, { groupId: group.id, name: 'Giữ ở nguồn' });
    await mem.db.query(`update projects set getfly_groups = $1::jsonb where id = $2`, [JSON.stringify({ [group.id]: { id: 8689, code: 'PARENT', name: 'Cha', projectId: '1' } }), source.id]);
    await mem.db.query(`insert into getfly_links (project_id, local_id, parent_local, getfly_id, getfly_code, hash) values ($1, $2, $3, 9001, 'REMOTE/TASK', 'hash'), ($1, $4, $2, 9002, 'REMOTE/CHILD', 'hash')`, [source.id, task.id, `g:${group.id}`, task.subtasks[0].id]);

    // Cả lô thất bại nếu có id không thuộc nguồn, không được chuyển dở dang.
    await call({ projectId: source.id, targetProjectId: target.id, taskIds: [task.id, crypto.randomUUID()] }, true);
    assert.equal((await rest('GET', `/projects/${source.id}`)).tasks.length, 2);
    assert.equal((await rest('GET', `/projects/${target.id}`)).tasks.length, 0);
    await call({ projectId: source.id, targetProjectId: source.id, taskIds: [task.id] }, true);
    await call({ projectId: source.id, targetProjectId: target.id, taskIds: [task.id, task.id] }, true);

    const moved = await call({ project: source.name, targetProject: target.name, taskIds: [task.id] });
    assert.equal(moved.moved, 1);
    const src = await rest('GET', `/projects/${source.id}`), dst = await rest('GET', `/projects/${target.id}`);
    assert.deepEqual(src.tasks.map((t: any) => t.id), [untouched.id]);
    assert.equal(src.groups[0].id, group.id);
    assert.equal(dst.tasks.length, 1);
    const t = dst.tasks[0];
    assert.equal(t.id, task.id);
    assert.deepEqual(t.subtasks, task.subtasks);
    assert.deepEqual([t.assignee, t.support, t.progress, t.startDate, t.endDate, t.days, t.note, t.baselineStart, t.baselineEnd], ['Đức', 'Lương', 50, '2026-11-10', '2026-11-13', 3, 'Giữ ghi chú này', task.baselineStart, task.baselineEnd]);
    assert.equal(dst.groups[0].name, 'Kho');
    assert.notEqual(t.groupId, group.id);
    assert.equal(t.scopeId, dst.scopes[0].id);
    assert.deepEqual([dst.scopes[0].name, dst.scopes[0].color, dst.scopes[0].owner, dst.scopes[0].note], ['Dock', '#123456', 'Đức', 'Phạm vi gốc']);
    assert.equal(dst.getflyGroups[t.groupId].id, 8689);
    const history = await rest('GET', `/projects/${target.id}/tasks/${task.id}/history`);
    assert.ok(history.some((h: any) => h.field === 'note' && h.newValue === 'Giữ ghi chú này'));
    assert.ok(history.some((h: any) => h.field === 'project' && h.oldValue === source.name && h.newValue === target.name));
    const links = await mem.db.query<any>(`select project_id, local_id, parent_local, getfly_code from getfly_links order by getfly_code`);
    assert.ok(links.rows.every((l: any) => l.project_id === target.id));
    assert.equal(links.rows.find((l: any) => l.local_id === task.id).parent_local, `g:${t.groupId}`);
    assert.equal(links.rows.find((l: any) => l.local_id === task.subtasks[0].id).parent_local, task.id);
    // Chuyển lần hai dùng lại nhóm/tag đã có và nối cuối, không nhân bản cấu trúc.
    await call({ projectId: source.id, targetProjectId: target.id, taskIds: [untouched.id] });
    const second = await rest('GET', `/projects/${target.id}`);
    assert.equal(second.groups.length, 1);
    assert.equal(second.tasks.length, 2);
    assert.equal(second.tasks[1].id, untouched.id);
    // Có quyền nguồn nhưng chỉ xem đích thì không được chuyển.
    const restricted = await rest('POST', '/projects', { name: 'Nguồn khác' });
    const restrictedTask = await rest('POST', `/projects/${restricted.id}/tasks`, { name: 'Chưa chuyển' });
    const viewerLogin = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@x.vn', name: 'Chủ khác' }) });
    const other = cookieOf(viewerLogin, 'prj_session');
    const response = await fetch(`${srv.base}/api/projects`, { method: 'POST', headers: { cookie: `prj_session=${other}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Đích chỉ xem' }) });
    const privateTarget = await response.json() as any;
    await fetch(`${srv.base}/api/projects/${privateTarget.id}/members`, { method: 'POST', headers: { cookie: `prj_session=${other}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'transfer@x.vn', role: 'viewer' }) });
    await call({ projectId: restricted.id, targetProjectId: privateTarget.id, taskIds: [restrictedTask.id] }, true);
    assert.equal((await rest('GET', `/projects/${restricted.id}`)).tasks.length, 1);
  } finally { await srv.stop(); await mem.close(); }
});
