import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

/** Getfly giả theo hành vi API v3 đã kiểm chứng trên acs.getflycrm.com: task_info, task_creator bắt buộc, ngày Y-m-d H:i,
 *  sửa / xoá theo task_code, danh sách bỏ qua bộ lọc, không có trường tiến độ / trạng thái. */
async function fakeGetfly() {
  const calls: { method: string; path: string; body: any }[] = [];
  const tasks = new Map<number, any>();
  tasks.set(8689, { task_id: '8689', task_code: 'CVI/2026-11/008676', task_name: 'Xây dựng Module Giao Hàng', project_id: '1', project_name: '12. R&D_ Nghiên cứu', task_status: '11' });
  for (let i = 1; i <= 150; i++) tasks.set(9000 + i, { task_id: String(9000 + i), task_code: `CVI/X/${i}`, task_name: `Việc khác ${i}`, project_id: '2', project_name: 'Khác', task_status: '11' });
  let next = 9800;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname, body });
    const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== 'khoa-getfly') return json({ message: 'Unauthorized' }, 401);
    if (url.pathname === '/api/v3/users') return json([{ id: '25', name: 'Nguyễn Phú Đức', email: 'ducnp@acs.vn', dept_name: 'R&D' }, { id: '4', name: 'Nguyễn Công Quyết', email: 'q@acs.vn', dept_name: 'R&D' }]);
    if (url.pathname === '/api/v3/tasks' && req.method === 'GET') {
      const all = [...tasks.values()].sort((a, b) => Number(b.task_id) - Number(a.task_id));
      const limit = Number(url.searchParams.get('limit') ?? 10), page = Number(url.searchParams.get('page') ?? 1);
      return json({ data: all.slice((page - 1) * limit, page * limit), total_record: all.length, total_page: Math.ceil(all.length / limit), current_page: page });
    }
    if (url.pathname === '/api/v3/tasks') {
      const info = body?.task_info;
      if (req.method === 'POST') {
        if (!info || typeof info !== 'object') return json({ message: 'task_info phải là một plain object.' }, 400);
        const bad = Object.keys(info).filter((k) => !['task_name', 'task_start_date', 'task_end_date', 'task_description', 'project_id', 'task_parent', 'task_type', 'task_weight', 'task_creator', 'task_receiver'].includes(k));
        if (bad.length) return json({ message: `task_info thuộc tính ${bad.join(',')} không hợp lệ` }, 400);
        if (!info.task_creator) return json({ message: 'Người tạo việc không được để trống' }, 400);
        if (info.task_start_date && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(info.task_start_date)) return json({ message: 'Thời gian bắt đầu công việc không đúng định dạng (Y-m-d H:i)' }, 400);
        if (info.task_parent && !tasks.has(Number(info.task_parent))) return json({ message: 'Công việc cha không tồn tại' }, 400);
        const id = ++next;
        tasks.set(id, { task_id: String(id), task_code: `CVI/2026-11/${id}`, task_status: '11', ...info });
        return json({ message: 'Thêm mới công việc thành công', task_id: id });
      }
      const t = [...tasks.values()].find((x) => x.task_code === body?.task_code);
      if (req.method === 'PUT') {
        if (!t) return json({ message: 'Công việc không tồn tại' }, 400);
        if ('task_progress' in info || 'task_status' in info) return json({ message: 'task_info thuộc tính không hợp lệ' }, 400);
        Object.assign(t, info);
        return json({ message: 'Cập nhật công việc thành công', task_id: t.task_id });
      }
      if (req.method === 'DELETE') {
        if (!t) return json({ message: 'Công việc không tồn tại' }, 400);
        tasks.delete(Number(t.task_id));
        return json({ message: 'Xóa công việc thành công' });
      }
    }
    return json({ message: 'no route' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, calls, tasks, close: () => server.close() };
}

test('đồng bộ Getfly (API v3): việc cha từ link, tạo / sửa / xoá, task con dưới việc tương ứng, ghép id người dùng, việc xong chỉ ghi chú', { timeout: 90_000 }, async () => {
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
    assert.equal((await R('GET', '/getfly/users')).body.length, 2);
    const p = (await R('POST', '/projects', { name: 'Đồng bộ thử' })).body;
    assert.equal((await R('POST', `/projects/${p.id}/getfly/sync`)).status, 400); // chưa đặt việc cha
    // Việc cha: dán link Getfly -> lật danh sách tìm id 8689 -> mã + dự án Getfly.
    const cfg = await R('PATCH', `/projects/${p.id}/getfly`, { parent: 'https://acs.getflycrm.com/#/tasks/?project_id=1;view_type=list;task_id=8689', creatorId: '25', users: { 'Đức': '25', 'Quyết': '4' } });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    assert.deepEqual([cfg.body.getflyParentCode, cfg.body.getflyParentId, cfg.body.getflyProjectId, cfg.body.getflyProjectName], ['CVI/2026-11/008676', 8689, '1', '12. R&D_ Nghiên cứu']);
    assert.equal((await R('PATCH', `/projects/${p.id}/getfly`, { parent: '1' })).status, 404);

    const grp = (await R('POST', `/projects/${p.id}/groups`, { name: 'Giao hàng – Luồng chính' })).body;
    const grp2 = (await R('POST', `/projects/${p.id}/groups`, { name: 'Kho' })).body;
    // Nhóm "Kho" gắn với việc có sẵn trên Getfly (id 9001) -> không tạo việc cho nhóm này.
    assert.equal((await R('PATCH', `/projects/${p.id}/getfly`, { groups: { [grp2.id]: '9001' } })).body.getflyGroups[grp2.id].code, 'CVI/X/1');
    await R('POST', `/projects/${p.id}/tasks`, { groupId: grp2.id, name: 'Nhập kho', note: 'Ghi chú kho' });
    const t1 = (await R('POST', `/projects/${p.id}/tasks`, { groupId: grp.id, name: 'Màn hình giao hàng', assignee: 'Đức', startDate: '2026-11-10', endDate: '2026-11-12', subtasks: [{ name: 'Danh sách chuyến', assignee: 'Quyết', progress: 0 }] })).body;
    const t2 = (await R('POST', `/projects/${p.id}/tasks`, { name: 'Việc không có ngày', assignee: 'Người lạ' })).body;
    const s1 = await R('POST', `/projects/${p.id}/getfly/sync`);
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.deepEqual([s1.body.created, s1.body.updated, s1.body.errors], [5, 0, []]); // 1 việc nhóm + 3 việc + 1 task con
    const made = [...gf.tasks.values()];
    const parent = made.find((t) => t.task_name === 'Màn hình giao hàng');
    const groupTask = made.find((t) => t.task_name === 'Giao hàng – Luồng chính');
    assert.equal(groupTask.task_parent, '8689'); // nhóm -> dưới việc cha của dự án
    assert.ok(!made.some((t) => t.task_name === 'Kho')); // nhóm gắn sẵn không tạo việc
    assert.equal(made.find((t) => t.task_name === 'Nhập kho').task_parent, '9001');
    assert.equal(made.find((t) => t.task_name === 'Nhập kho').task_description, undefined); // không gửi ghi chú / mô tả
    assert.equal(made.find((t) => t.task_name === 'Việc không có ngày').task_parent, '8689'); // chưa phân nhóm
    assert.deepEqual([parent.task_parent, parent.project_id, parent.task_receiver, parent.task_creator, parent.task_start_date], [groupTask.task_id, '1', '25', '25', '2026-11-10 08:00']);
    assert.equal(made.find((t) => t.task_name === 'Danh sách chuyến').task_parent, parent.task_id); // task con dưới đúng việc cha
    assert.equal(made.find((t) => t.task_name === 'Danh sách chuyến').task_receiver, '4');
    assert.equal(made.find((t) => t.task_name === 'Việc không có ngày').task_receiver, undefined);

    // Bấm lại không đổi gì -> không gửi lệnh ghi nào.
    const writes = () => gf.calls.filter((c) => c.method !== 'GET').length;
    const before = writes();
    const s2 = (await R('POST', `/projects/${p.id}/getfly/sync`)).body;
    assert.deepEqual([s2.created, s2.updated, s2.unchanged], [0, 0, 5]);
    assert.equal(writes(), before);

    // Sửa tên + task con xong 100% -> PUT theo task_code, ghi chú "đã xong"; xoá việc -> DELETE.
    await R('PATCH', `/projects/${p.id}/tasks/${t1.id}`, { name: 'Màn hình giao hàng (bản 2)', subtasks: [{ ...t1.subtasks[0], progress: 100 }] });
    await R('DELETE', `/projects/${p.id}/tasks/${t2.id}`);
    const s3 = (await R('POST', `/projects/${p.id}/getfly/sync`)).body;
    assert.deepEqual([s3.updated, s3.completed, s3.deleted, s3.errors], [1, 2, 1, []]); // chỉ việc cha đổi tên; task con xong 100% không gửi gì (không có mô tả)
    assert.equal(gf.tasks.get(Number(parent.task_id)).task_name, 'Màn hình giao hàng (bản 2)');
    assert.ok(s3.warnings.some((w: string) => /đánh dấu tay/.test(w)));
    assert.ok(![...gf.tasks.values()].some((t) => t.task_name === 'Việc không có ngày'));
    assert.ok((await R('GET', `/projects/${p.id}`)).body.getflySyncedAt);
    // Gỡ khỏi Getfly: xoá đúng các việc app đã tạo, giữ việc cha 8689 và việc có sẵn 9001.
    const un = (await R('POST', `/projects/${p.id}/getfly/unsync`)).body;
    assert.deepEqual([un.deleted, un.errors], [4, []]);
    assert.ok(gf.tasks.has(8689) && gf.tasks.has(9001));
    assert.ok(![...gf.tasks.values()].some((x) => ['Màn hình giao hàng (bản 2)', 'Danh sách chuyến', 'Nhập kho', 'Giao hàng – Luồng chính'].includes(x.task_name)));
  } finally {
    await srv.stop();
    await mem.close();
    gf.close();
  }
});
