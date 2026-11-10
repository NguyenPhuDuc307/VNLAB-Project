import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, parseDate, today } from './dates.ts';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('MCP: token vpj_ ở Cài đặt, công cụ dùng chung tầng dữ liệu với REST, quyền và thu hồi', { timeout: 90_000 }, async () => {
  const mem = await memoryDb();
  const TOKEN = 'khoa-dich-vu-cho-test-project-dai-hon-32-ky-tu';
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', ACCOUNT_SERVICE_TOKEN: TOKEN });
  const base = srv.base;
  const rest = (session: string) => async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  let id = 0;
  const rpc = async (token: string, method: string, params: unknown) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const call = async (token: string, name: string, args: unknown, expectError = false) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = r.body.result;
    assert.equal(!!res.isError, expectError, JSON.stringify(res));
    return expectError ? res.content[0].text as string : JSON.parse(res.content[0].text);
  };

  try {
    // Đăng nhập dev (project:user) -> tạo token ở Cài đặt.
    const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'an@x.vn', name: 'An', roles: ['project:user'] }) });
    const session = cookieOf(login, 'prj_session')!;
    const R = rest(session);
    const made = await R('POST', '/tokens', { name: 'Claude Desktop' });
    assert.equal(made.status, 201);
    assert.match(made.body.token, /^vpj_[A-Za-z0-9_-]{32}$/);
    assert.equal(made.body.url, `${base}/mcp`);
    const token = made.body.token as string;
    assert.equal((await R('GET', '/tokens')).body.length, 1);
    assert.ok((await R('GET', '/mcp/tools')).body.tools.length >= 9);

    // Sai token / không token.
    assert.equal((await rpc('vpj_sai', 'tools/list', {})).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);

    // Danh sách công cụ + annotation.
    const listed = (await rpc(token, 'tools/list', {})).body.result;
    const byName = Object.fromEntries(listed.tools.map((t: { name: string }) => [t.name, t]));
    for (const n of ['list_projects', 'get_project', 'get_overview', 'find_tasks', 'create_project', 'create_group', 'create_task', 'create_tasks', 'update_task', 'delete_task', 'sort_tasks', 'delete_group']) assert.ok(byName[n], n);
    assert.equal(byName.list_projects.annotations.readOnlyHint, true);
    assert.equal(byName.create_task.annotations.destructiveHint, false);
    assert.equal(byName.delete_task.annotations.destructiveHint, true);

    // Tạo dự án qua MCP, thêm việc với ngày dạng dd/mm/yyyy và nhóm tự tạo.
    const t0 = today();
    assert.deepEqual((await call(token, 'list_projects', {})).projects, []);
    const created = await call(token, 'create_project', { name: 'Website bán hàng', customer: 'Công ty ABC', code: 'WEB01', startDate: '1/11/2026' });
    assert.ok(created.id);
    const d1 = addDays(t0, 1), d5 = addDays(t0, 5);
    const made1 = await call(token, 'create_task', { project: 'web01', name: 'Thiết kế trang chủ', group: 'Thiết kế', assignee: 'An', support: 'Bình, Chi', progress: 20, startDate: d1.split('-').reverse().join('/'), endDate: d5, days: 5.5 });
    assert.equal(made1.task.group, 'Thiết kế');
    assert.equal(made1.task.startDate, d1);
    assert.equal(made1.task.days, 5.5);
    assert.equal(made1.task.status, 'open');
    // Không hiểu ngày -> lỗi rõ ràng, không ghi.
    assert.match(await call(token, 'create_task', { projectId: created.id, name: 'X', startDate: 'thứ ba tuần sau' }, true), /Không hiểu ngày/);
    // Nhiều việc một lần: nhóm có sẵn được dùng lại, nhóm mới được tạo.
    const bulk = await call(token, 'create_tasks', { projectId: created.id, tasks: [
      { name: 'Thiết kế trang sản phẩm', group: 'thiết kế', startDate: d5, endDate: addDays(t0, 7), subtasks: [{ name: 'Bố cục', assignee: 'An', progress: 40 }] },
      { name: 'Dựng API giỏ hàng', group: 'Lập trình', assignee: 'An', progress: 100, startDate: addDays(t0, -6), endDate: addDays(t0, -2) },
      { name: 'Việc quá hạn', group: 'Lập trình', endDate: addDays(t0, -1) },
    ] });
    assert.deepEqual([bulk.groupsCreated, bulk.tasksCreated], [1, 3]);
    const proj = await call(token, 'get_project', { projectId: created.id });
    assert.deepEqual(proj.groups.map((g: { name: string; taskCount: number }) => [g.name, g.taskCount]), [['Thiết kế', 2], ['Lập trình', 2]]);
    assert.equal(proj.tasks.find((t: { name: string }) => t.name === 'Việc quá hạn').status, 'overdue');
    assert.equal(proj.tasks.find((t: { name: string }) => t.name === 'Dựng API giỏ hàng').status, 'done');
    // Tự tính ngày công khi không nhập: 5 ngày T2–T6 trong tuần, T7 nửa ngày.
    const auto = proj.tasks.find((t: { name: string }) => t.name === 'Thiết kế trang sản phẩm');
    assert.equal(auto.subtasks[0].name, "Bố cục");
    assert.equal(auto.progress, 40);
    assert.equal(auto.daysManual, false);
    assert.ok(auto.days > 0);
    // Tìm, tổng quan, sửa, xoá.
    const found = await call(token, 'find_tasks', { query: 'giỏ hàng' });
    assert.equal(found.tasks.length, 1);
    const ov = await call(token, 'get_overview', {});
    assert.equal(ov.overdue.length, 1);
    assert.ok(ov.upcoming.length >= 1);
    const upd = await call(token, 'update_task', { taskId: made1.task.id, progress: 60, group: 'Lập trình', note: 'đang test' });
    assert.equal(upd.task.progress, 60);
    assert.equal(upd.task.group, 'Lập trình');
    const withChildren = await call(token, 'update_task', { taskId: made1.task.id, subtasks: [{ name: 'API', assignee: 'An', progress: 100 }, { name: 'UI', progress: 0 }] });
    assert.equal(withChildren.task.progress, 50);
    assert.equal(withChildren.task.subtasks.length, 2);
    assert.match(await call(token, 'update_task', { taskId: made1.task.id, startDate: addDays(t0, 9), endDate: addDays(t0, 8) }, true), /kết thúc/);
    // REST thấy đúng dữ liệu MCP ghi.
    const viaRest = await R('GET', `/projects/${created.id}`);
    assert.equal(viaRest.body.tasks.length, 4);
    assert.equal(viaRest.body.tasks.find((t: { id: string }) => t.id === made1.task.id).note, 'đang test');
    assert.deepEqual((await call(token, 'delete_task', { taskId: made1.task.id })).ok, true);
    assert.equal((await R('GET', `/projects/${created.id}`)).body.tasks.length, 3);
    // Real-time: mở luồng SSE của dự án, MCP tạo việc -> nhận event `changed` (giao diện web dùng để tải lại).
    const es = await fetch(`${base}/api/projects/${created.id}/events`, { headers: { cookie: `prj_session=${session}`, accept: 'text/event-stream' } });
    assert.equal(es.status, 200);
    assert.match(es.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = es.body!.getReader();
    const readUntil = async (needle: string) => {
      let buf = '';
      const deadline = Date.now() + 5000;
      while (!buf.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
      }
      return buf;
    };
    assert.match(await readUntil('event: hello'), /event: hello/);
    const live = await call(token, 'create_task', { projectId: created.id, name: 'Việc tạo qua MCP phải hiện ngay' });
    assert.ok(live.task.id);
    const evt = await readUntil('"source":"mcp"');
    assert.match(evt, /event: changed/);
    assert.match(evt, /Thêm việc “Việc tạo qua MCP phải hiện ngay”/); // mô tả để giao diện báo ở góc màn hình
    await reader.cancel();
    // Sắp xếp theo ngày: đảo thứ tự bằng REST rồi gọi sort_tasks -> việc có ngày bắt đầu lên trước, việc trống ngày xếp cuối.
    const after = (await R('GET', `/projects/${created.id}`)).body;
    const lap = after.groups.find((g: { name: string }) => g.name === 'Lập trình');
    const inLap = after.tasks.filter((t: { groupId: string | null }) => t.groupId === lap.id);
    assert.equal(inLap.length, 2);
    assert.equal((await R('PUT', `/projects/${created.id}/tasks/order`, { groupId: lap.id, ids: [...inLap].reverse().map((t: { id: string }) => t.id) })).status, 200);
    const sorted = await call(token, 'sort_tasks', { projectId: created.id, group: 'Lập trình' });
    assert.deepEqual([sorted.groupsSorted, sorted.tasksMoved], [1, 2]);
    const namesInLap = (await R('GET', `/projects/${created.id}`)).body.tasks.filter((t: { groupId: string | null }) => t.groupId === lap.id).map((t: { name: string }) => t.name);
    assert.deepEqual(namesInLap, ['Dựng API giỏ hàng', 'Việc quá hạn']);
    assert.match(await call(token, 'sort_tasks', { projectId: created.id, group: 'Không tồn tại' }, true), /Không có nhóm/);
    // REST: sắp xếp tất cả -> việc trong nhóm đã đúng thứ tự, chỉ hai nhóm đổi chỗ (Lập trình bắt đầu sớm hơn Thiết kế).
    assert.deepEqual((await R('POST', `/projects/${created.id}/tasks/sort`, {})).body.moved, 2);
    assert.equal((await R('GET', `/projects/${created.id}`)).body.tasks.length, 4); // 3 + việc tạo trong bước real-time
    // Nhóm: kéo thả đổi thứ tự, rồi "sắp xếp tất cả" xếp nhóm theo ngày bắt đầu sớm nhất (Lập trình có việc từ t0-6 nên lên trước Thiết kế).
    const gs0 = (await R('GET', `/projects/${created.id}`)).body.groups.map((g: { id: string; name: string }) => g);
    assert.equal((await R('PUT', `/projects/${created.id}/groups/order`, { ids: [...gs0].reverse().map((g: { id: string }) => g.id) })).status, 200);
    assert.deepEqual((await R('GET', `/projects/${created.id}`)).body.groups.map((g: { name: string }) => g.name), [...gs0].reverse().map((g: { name: string }) => g.name));
    await R('PUT', `/projects/${created.id}/groups/order`, { ids: gs0.map((g: { id: string }) => g.id) });
    await R('POST', `/projects/${created.id}/tasks/sort`, {});
    assert.deepEqual((await R('GET', `/projects/${created.id}`)).body.groups.map((g: { name: string }) => g.name), ['Lập trình', 'Thiết kế']);
    // delete_group: nhóm rỗng xoá thẳng; nhóm còn việc thì từ chối nếu không nói rõ giữ hay xoá việc.
    await call(token, 'create_group', { projectId: created.id, name: 'Nhóm rỗng' });
    assert.equal((await call(token, 'delete_group', { projectId: created.id, group: 'nhóm rỗng' })).deleted, 'Nhóm rỗng');
    assert.match(await call(token, 'delete_group', { projectId: created.id, group: 'Thiết kế' }, true), /còn 1 việc/);
    const kept = await call(token, 'delete_group', { projectId: created.id, group: 'Thiết kế', keepTasks: true });
    assert.equal(kept.tasksMoved, 1);
    const after2 = (await R('GET', `/projects/${created.id}`)).body;
    assert.deepEqual(after2.groups.map((g: { name: string }) => g.name), ['Lập trình']);
    assert.equal(after2.tasks.length, 4);

    // Thành viên chỉ xem: đọc được, không ghi được qua MCP.
    assert.equal((await R('POST', `/projects/${created.id}/members`, { email: 'xem@x.vn', role: 'viewer' })).status, 201);
    const l2 = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'xem@x.vn', name: 'Xem', roles: ['project:user'] }) });
    const tok2 = (await rest(cookieOf(l2, 'prj_session')!)('POST', '/tokens', { name: 't' })).body.token as string;
    assert.equal((await call(tok2, 'list_projects', {})).projects[0].myRole, 'viewer');
    assert.match(await call(tok2, 'create_task', { projectId: created.id, name: 'lén' }, true), /chỉ được xem/);

    // Gỡ quyền token ở VNLab Account -> MCP 403 ngay; thu hồi token -> 401.
    const svc = (path: string, method = 'GET', b?: unknown) => fetch(`${base}/api/service/rbac${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'x-vnlab-actor': 'admin', ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const roles = await (await svc('/roles')).json() as { role: string; permissions: string[] }[];
    const userPerms = roles.find((r) => r.role === 'project:user')!.permissions;
    assert.ok(userPerms.includes('project.tokens.manage'));
    assert.equal((await svc('/roles/project:user/permissions', 'PUT', { permissions: userPerms.filter((p) => p !== 'project.tokens.manage') })).status, 200);
    assert.equal((await rpc(token, 'tools/list', {})).status, 403);
    assert.equal((await svc('/roles/project:user/permissions', 'PUT', { permissions: userPerms })).status, 200);
    assert.equal((await rpc(token, 'tools/list', {})).status, 200);
    assert.equal((await R('DELETE', `/tokens/${made.body.id}`)).status, 200);
    assert.equal((await rpc(token, 'tools/list', {})).status, 401);
  } finally {
    await srv.stop();
    await mem.close();
  }
});

test('parseDate ở server hiểu ngày AI gửi', () => {
  assert.equal(parseDate('14/11/2026'), '2026-11-14');
  assert.equal(parseDate('2026-11-14'), '2026-11-14');
  assert.equal(parseDate('14-Nov-26'), '2026-11-14');
  assert.equal(parseDate('mai'), null);
});
