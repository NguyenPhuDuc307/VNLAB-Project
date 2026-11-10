import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

/** Getfly giả (API v6.1): lưu việc trong bộ nhớ, ghi lại mọi request. */
async function fakeGetfly() {
  const calls: { method: string; path: string; body: any }[] = [];
  const tasks = new Map<string, any>();
  tasks.set('CHA.0001', { id: 8689, task_code: 'CHA.0001', task_name: 'Giao hàng — phát triển', project_name: 'AMMS', status: 'open' });
  let next = 100;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname, body });
    const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== 'khoa-getfly') return json({ message: 'Unauthorized' }, 401);
    if (req.method === 'GET' && url.pathname === '/api/v6.1/tasks') {
      const id = url.searchParams.get('filter[id][eq]');
      return json({ data: [...tasks.values()].filter((t) => String(t.id) === id), has_more: false, offset: 0, limited: 5 });
    }
    if (url.pathname === '/api/v6.1/task') {
      if (req.method === 'POST') {
        if (!body.task_name) return json({ message: 'task_name required' }, 422);
        if (body.task_parent_code && !tasks.has(body.task_parent_code)) return json({ message: 'parent not found' }, 422);
        const code = `Task.${String(++next).padStart(4, '0')}`;
        tasks.set(code, { id: next, ...body, task_code: code, status: 'open' });
        return json({ message: 'Successfully added', data: { task_id: next, task_code: code } });
      }
      if (req.method === 'PUT') {
        const t = tasks.get(body.current_task_code);
        if (!t) return json({ message: 'not found' }, 404);
        Object.assign(t, body);
        return json({ message: 'Successfully updated', data: { task_id: t.id, task_code: t.task_code } });
      }
      if (req.method === 'DELETE') {
        if (!tasks.delete(body.task_code)) return json({ message: 'not found' }, 404);
        return json({ message: 'Deleted' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/v6.1/task/complete') {
      const t = tasks.get(body.task_code);
      if (!t) return json({ message: 'not found' }, 404);
      t.status = 'done';
      return json({ message: 'Task completed successfully', data: { task_code: t.task_code } });
    }
    return json({ message: 'no route' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, calls, tasks, close: () => server.close() };
}

test('đồng bộ Getfly: việc cha từ link, tạo / sửa / hoàn thành / xoá, task con nằm dưới việc tương ứng, ghép username', { timeout: 90_000 }, async () => {
  const gf = await fakeGetfly();
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', GETFLY_BASE_URL: `${gf.base}/`, GETFLY_API_KEY: 'khoa-getfly' });
  try {
    const login = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gf@vnlab.local', name: 'GF' }) });
    const session = cookieOf(login, 'prj_session');
    const R = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${srv.base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    assert.deepEqual((await R('GET', '/getfly/status')).body.configured, true);
    const p = (await R('POST', '/projects', { name: 'Đồng bộ thử' })).body;
    // Việc cha: dán link Getfly -> tra ra mã + tên dự án Getfly.
    const cfg = await R('PATCH', `/projects/${p.id}/getfly`, { parent: 'https://acs.getflycrm.com/#/tasks/?project_id=1;view_type=list;task_id=8689', users: { 'Đức': 'ducnp' } });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    assert.deepEqual([cfg.body.getflyParentCode, cfg.body.getflyProjectName], ['CHA.0001', 'AMMS']);
    assert.equal((await R('PATCH', `/projects/${p.id}/getfly`, { parent: '99999' })).status, 404);

    const t1 = (await R('POST', `/projects/${p.id}/tasks`, { name: 'Màn hình giao hàng', assignee: 'Đức', startDate: '2026-11-10', endDate: '2026-11-12', subtasks: [{ name: 'Danh sách chuyến', assignee: 'Đức', progress: 0 }] })).body;
    const t2 = (await R('POST', `/projects/${p.id}/tasks`, { name: 'Việc không có ngày', assignee: 'Người lạ' })).body;
    const s1 = await R('POST', `/projects/${p.id}/getfly/sync`);
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.deepEqual([s1.body.created, s1.body.updated, s1.body.errors], [3, 0, []]);
    const created = gf.calls.filter((c) => c.method === 'POST' && c.path === '/api/v6.1/task').map((c) => c.body);
    const parent = created.find((b) => b.task_name === 'Màn hình giao hàng');
    assert.equal(parent.task_parent_code, 'CHA.0001');
    assert.equal(parent.project_name, 'AMMS');
    assert.equal(parent.task_receiver_username, 'ducnp');
    assert.equal(parent.task_start_date, '2026-11-10 08:00:00');
    const parentCode = [...gf.tasks.values()].find((t) => t.task_name === 'Màn hình giao hàng').task_code;
    assert.equal(created.find((b) => b.task_name === 'Danh sách chuyến').task_parent_code, parentCode); // task con dưới đúng việc cha
    assert.equal(created.find((b) => b.task_name === 'Việc không có ngày').task_receiver_username, undefined);

    // Bấm lại không đổi gì -> không gọi thừa.
    const before = gf.calls.length;
    const s2 = (await R('POST', `/projects/${p.id}/getfly/sync`)).body;
    assert.deepEqual([s2.created, s2.updated, s2.unchanged], [0, 0, 3]);
    assert.equal(gf.calls.length, before);

    // Sửa tên + xong 100% -> PUT + complete; xoá việc -> DELETE.
    await R('PATCH', `/projects/${p.id}/tasks/${t1.id}`, { name: 'Màn hình giao hàng (bản 2)', subtasks: [{ ...t1.subtasks[0], progress: 100 }] });
    await R('DELETE', `/projects/${p.id}/tasks/${t2.id}`);
    const s3 = (await R('POST', `/projects/${p.id}/getfly/sync`)).body;
    assert.deepEqual([s3.updated, s3.completed, s3.deleted, s3.errors], [2, 2, 1, []]); // việc cha đổi tên + tiến độ, task con 100% -> cả hai xong
    assert.equal(gf.tasks.get(parentCode).task_name, 'Màn hình giao hàng (bản 2)');
    assert.equal(gf.tasks.get(parentCode).status, 'done');
    assert.ok(![...gf.tasks.values()].some((t) => t.task_name === 'Việc không có ngày'));
    assert.ok((await R('GET', `/projects/${p.id}`)).body.getflySyncedAt);
  } finally {
    await srv.stop();
    await mem.close();
    gf.close();
  }
});
