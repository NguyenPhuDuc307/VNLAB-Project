import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'hono/jwt';
import { addDays, today, weekday, workDays, coveredDays } from './dates.ts';
import { hasProjectRole, roleCheckFresh } from './sso.ts';
import { parseDate } from '../src/lib/dates.ts';
import { parseSheet } from '../src/lib/sheet.ts';
import { APP_ID, cookieOf, fakeLogto, JWT_SECRET, memoryDb, ssoLogin, startServer } from './test-helpers.ts';

test('chỉ role project:user / project:admin mới được vào', () => {
  assert.equal(hasProjectRole(['project:user']), true);
  assert.equal(hasProjectRole(['home:user', 'project:admin']), true);
  assert.equal(hasProjectRole([]), false);
  assert.equal(hasProjectRole(['finance:user', 'vnlab:admin', 'project', 'project:viewer']), false);
});

test('phiên phải kiểm role lại sau 12 giờ; phiên không có mốc rc là quá hạn', () => {
  const now = 1_800_000_000;
  assert.equal(roleCheckFresh({ rc: now - 60 }, now), true);
  assert.equal(roleCheckFresh({ rc: now - 13 * 3600 }, now), false);
  assert.equal(roleCheckFresh({}, now), false);
});

test('ngày công: T2–T6 = 1, T7 nửa ngày, CN nghỉ (mặc định), đổi được trọng số', () => {
  assert.equal(weekday('2026-11-09'), 1); // thứ hai
  assert.equal(workDays('2026-11-02', '2026-11-07'), 5.5);
  assert.equal(workDays('2026-11-12', '2026-11-14'), 2.5);
  assert.equal(workDays('2026-11-09', '2026-11-12'), 4);
  assert.equal(workDays('2026-11-02', '2026-11-08', 1, 1), 7);
  assert.equal(workDays('2026-11-02', '2026-11-08', 0, 0), 5);
  assert.equal(workDays('2026-11-08', '2026-11-02'), 0);
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('coveredDays: việc gối nhau chỉ tính một lần, khoảng rời nhau cộng lại, thiếu ngày bỏ qua', () => {
  // T2 03/11 → T6 07/11 (5) gối với T4 05/11 → T2 10/11; hợp = 03/11 → 10/11 = 5 + 0.5 + 0 + 1 = 6.5
  assert.equal(coveredDays([{ startDate: '2026-11-03', endDate: '2026-11-07' }, { startDate: '2026-11-05', endDate: '2026-11-10' }]), 6.5);
  // Cộng dồn từng việc sẽ ra 5 + 4 = 9, nhiều hơn số ngày thật sự có việc.
  assert.equal(workDays('2026-11-03', '2026-11-07') + workDays('2026-11-05', '2026-11-10'), 9);
  // Hai khoảng rời nhau: 03/11 → 04/11 (2) và 12/11 → 13/11 (2)
  assert.equal(coveredDays([{ startDate: '2026-11-12', endDate: '2026-11-13' }, { startDate: '2026-11-03', endDate: '2026-11-04' }]), 4);
  // Việc chỉ có một ngày tính một ngày; việc không có ngày không tính.
  assert.equal(coveredDays([{ startDate: null, endDate: '2026-11-04' }, { startDate: null, endDate: null }]), 1);
});

test('parseDate hiểu các dạng ngày hay gặp trong bảng tính', () => {
  assert.equal(parseDate('2-Nov-26'), '2026-11-02');
  assert.equal(parseDate('12-thg 11-26'), '2026-11-12');
  assert.equal(parseDate('14/11/2026'), '2026-11-14');
  assert.equal(parseDate('6/10/2026'), '2026-10-06');
  assert.equal(parseDate('2026-11-21'), '2026-11-21');
  assert.equal(parseDate('21 thg 11, 2026'), '2026-11-21');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('abc'), null);
  assert.equal(parseDate(''), null);
});

test('parseSheet: dòng nhóm (tên ở cột STT), dòng việc, dòng tiêu đề, ngày công "5,5"', () => {
  const tsv = [
    'No\tTASK\tASSIGNED TO\tSUPPORT\tPROGRESS\tSTART\tEND\tTask\tDAYS',
    'Thiết kế\t\t\t\t\t\t\t\t3.5',
    '1\tThiết kế màn hình đăng nhập\tAn\t\t100%\t2-Nov-26\t7-Nov-26\t\t5,5',
    '2\tThiết kế trang chủ\tAn\tBình, Chi\t0%\t9-Nov-26\t12-Nov-26\t\t5.5',
    'Lập trình\t\t\t\t\t\t\t\t3.5',
    '5\tDựng API giỏ hàng, thanh toán\tAn\t\t0%\t2-Nov-26\t7-Nov-26\t\t',
    '',
  ].join('\n');
  const r = parseSheet(tsv);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.groups.map((g) => [g.name, g.tasks.length]), [['Thiết kế', 2], ['Lập trình', 1]]);
  const [a, b] = r.groups[0].tasks;
  assert.equal(a.name, 'Thiết kế màn hình đăng nhập');
  assert.equal(a.progress, 100);
  assert.equal(a.startDate, '2026-11-02');
  assert.equal(a.endDate, '2026-11-07');
  assert.equal(a.days, 5.5);
  assert.equal(b.support, 'Bình, Chi');
  assert.equal(b.days, 5.5);
  assert.equal(r.groups[1].tasks[0].days, null);
  // Không có tiêu đề: cột theo thứ tự mặc định; dòng chỉ có tên là nhóm.
  const r2 = parseSheet('Kiểm thử\n7\tKiểm thử luồng thanh toán\t\tBình, Chi\t\t10-Nov-26\t14-Nov-26\t\t5');
  assert.deepEqual(r2.groups.map((g) => [g.name, g.tasks.length]), [['Kiểm thử', 1]]);
  assert.equal(r2.groups[0].tasks[0].startDate, '2026-11-10');
});

test('SSO, dự án, thành viên, nhập/xuất và API dịch vụ phân quyền', { timeout: 90_000 }, async () => {
  const mem = await memoryDb();
  const logto = await fakeLogto();
  const TOKEN = 'khoa-dich-vu-cho-test-project-dai-hon-32-ky-tu';
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, LOGTO_ENDPOINT: logto.url, PROJECT_LOGTO_APP_ID: APP_ID, ACCOUNT_SERVICE_TOKEN: TOKEN });
  const base = srv.base;
  const as = (session: string) => async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const svc = (path: string, method = 'GET', body?: unknown, token = TOKEN) =>
    fetch(`${base}/api/service/rbac${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-vnlab-actor': 'admin-sub', 'x-vnlab-actor-email': 'admin@x.vn', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  try {
    // Thiếu role: không phiên, tới trang báo chưa có quyền.
    const denied = await ssoLogin(base, 'khach', ['home:user', 'finance:user'], 'idtoken');
    assert.equal(denied.location, '/api/auth/no-access');
    assert.equal(denied.session, null);
    const page = await fetch(`${base}/api/auth/no-access`, { headers: { cookie: `prj_noaccess=${cookieOf(denied.res, 'prj_noaccess')}` } });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /chưa được cấp quyền dùng Project[\s\S]*khach@x\.vn/);

    // Chủ dự án đăng nhập (roles trong id_token).
    const duc = await ssoLogin(base, 'an', ['project:user'], 'idtoken');
    assert.equal(duc.location, '/du-an');
    assert.ok(duc.session);
    const D = as(duc.session!);
    const me = await D('GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'an@x.vn');
    assert.deepEqual(me.body.roles, ['project:user']);
    assert.ok(me.body.permissions.includes('project.task.write'));
    assert.equal(me.body.consentRequired, true);
    assert.equal((await D('POST', '/me/consent', { version: 'cu' })).status, 400);
    assert.equal((await D('POST', '/me/consent', { version: me.body.policyVersion })).body.consentRequired, false);

    // Tạo dự án, mời Bình (chưa từng đăng nhập) với quyền sửa, nhập việc.
    const created = await D('POST', '/projects', { name: 'Website bán hàng', customer: 'Công ty ABC', startDate: '2026-11-01' });
    assert.equal(created.status, 201);
    const pid = created.body.id as string;
    assert.equal((await D('POST', `/projects/${pid}/members`, { email: 'Binh@x.vn', role: 'editor' })).status, 201);
    assert.equal((await D('POST', `/projects/${pid}/members`, { email: 'an@x.vn', role: 'editor' })).status, 400);
    const t = today();
    const imp = await D('POST', `/projects/${pid}/import`, { groups: [
      { name: 'Thiết kế', tasks: [{ name: 'A', progress: 100, startDate: '2026-11-02', endDate: '2026-11-07', days: 5.5 }, { name: 'B', support: 'Bình, Chi', startDate: addDays(t, -2), endDate: addDays(t, 1) }] },
      { name: null, tasks: [{ name: 'C' }] },
    ] });
    assert.equal(imp.status, 201);
    assert.deepEqual(imp.body, { ok: true, groups: 1, tasks: 3 });
    const detail = await D('GET', `/projects/${pid}`);
    assert.equal(detail.body.myRole, 'owner');
    assert.equal(detail.body.groups.length, 1);
    assert.equal(detail.body.tasks.length, 3);
    assert.equal(detail.body.tasks[0].days, 5.5);
    assert.equal(detail.body.tasks[1].groupId, detail.body.groups[0].id);
    assert.equal(detail.body.tasks[2].groupId, null);
    assert.equal(detail.body.members[0].email, 'binh@x.vn');
    assert.equal(detail.body.members[0].userId, null);
    assert.equal((await D('POST', `/projects/${pid}/tasks`, { name: 'X', startDate: '2026-11-10', endDate: '2026-11-09' })).status, 400);

    // Task con dùng lịch cha; tiến độ cha do server tổng hợp, không đếm trùng việc/ngày công.
    const parent = await D('POST', `/projects/${pid}/tasks`, {
      name: 'Task cha', startDate: '2026-11-02', endDate: '2026-11-07', progress: 99,
      subtasks: [{ name: 'API', assignee: 'An', progress: 100 }, { name: 'Giao diện', assignee: 'Bình', progress: 20 }],
    });
    assert.equal(parent.status, 201);
    assert.equal(parent.body.progress, 60);
    assert.equal(parent.body.subtasks.length, 2);
    assert.ok(parent.body.subtasks[0].id);
    const childId = parent.body.subtasks[0].id;
    const path = `/projects/${pid}/tasks/${parent.body.id}`;
    const movedParent = await D('PATCH', path, { endDate: '2026-11-09', progress: 1 });
    assert.equal(movedParent.body.progress, 60);
    assert.equal(movedParent.body.endDate, '2026-11-09');
    assert.deepEqual(movedParent.body.subtasks, parent.body.subtasks);
    const completed = await D('PATCH', path, { subtasks: parent.body.subtasks.map((s: Record<string, unknown>) => ({ ...s, progress: 100 })) });
    assert.equal(completed.body.progress, 100);
    assert.equal(completed.body.subtasks[0].id, childId);
    const refreshed = await D('GET', `/projects/${pid}`);
    assert.equal(refreshed.body.tasks.length, 4);
    assert.equal(refreshed.body.tasks.find((t: { id: string }) => t.id === parent.body.id).progress, 100);
    assert.equal((await D('PATCH', path, { subtasks: [{ name: 'Không có lịch riêng', startDate: '2026-11-01' }] })).status, 400);
    assert.equal((await D('PATCH', path, { subtasks: [{ name: 'Sai tiến độ', progress: 101 }] })).status, 400);
    assert.equal((await D('PATCH', path, { subtasks: [parent.body.subtasks[0], parent.body.subtasks[0]] })).status, 400);
    const removedChildren = await D('PATCH', path, { subtasks: [], progress: 35 });
    assert.equal(removedChildren.body.progress, 35);
    assert.deepEqual(removedChildren.body.subtasks, []);
    assert.equal((await D('DELETE', path)).status, 200);

    // Bình đăng nhập (roles chỉ có ở userinfo): lời mời tự gắn, thấy dự án với quyền sửa.
    const binh = await ssoLogin(base, 'binh', ['project:user'], 'userinfo');
    assert.ok(binh.session);
    const L = as(binh.session!);
    const list = await L('GET', '/projects');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].myRole, 'editor');
    assert.equal(list.body[0].stats.taskCount, 3);
    assert.equal(list.body[0].stats.doneCount, 1);
    const tB = detail.body.tasks[1];
    const patched = await L('PATCH', `/projects/${pid}/tasks/${tB.id}`, { progress: 40 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.progress, 40);
    // Kế hoạch gốc chốt lúc nhập; dời ngày kết thúc -> gốc giữ nguyên, lịch sử ghi ai đổi; chốt lại -> gốc = hiện tại.
    assert.equal(patched.body.baselineStart, tB.startDate);
    assert.equal(patched.body.baselineEnd, tB.endDate);
    const moved = await L('PATCH', `/projects/${pid}/tasks/${tB.id}`, { endDate: addDays(t, 3) });
    assert.equal(moved.body.endDate, addDays(t, 3));
    assert.equal(moved.body.baselineEnd, tB.endDate);
    const hist = await L('GET', `/projects/${pid}/tasks/${tB.id}/history`);
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.map((h: { field: string }) => h.field), ['endDate', 'progress']);
    assert.equal(hist.body[0].user, 'Tên binh');
    assert.equal(hist.body[0].oldValue, tB.endDate);
    const rebased = await L('POST', `/projects/${pid}/tasks/${tB.id}/rebaseline`, {});
    assert.equal(rebased.body.baselineEnd, addDays(t, 3));
    assert.equal((await L('GET', `/projects/${pid}/tasks/${tB.id}/history`)).body[0].field, 'baseline');
    assert.equal((await L('DELETE', `/projects/${pid}`)).status, 403);
    assert.equal((await L('POST', `/projects/${pid}/members`, { email: 'x@x.vn', role: 'viewer' })).status, 403);
    assert.equal((await D('GET', `/projects/${pid}`)).body.members[0].userId !== null, true);

    // Hạ Bình xuống chỉ xem: đọc được, không sửa được.
    assert.equal((await D('PATCH', `/projects/${pid}/members/binh%40x.vn`, { role: 'viewer' })).status, 200);
    assert.equal((await L('PATCH', `/projects/${pid}/tasks/${tB.id}`, { progress: 50 })).status, 403);
    assert.equal((await L('GET', `/projects/${pid}`)).status, 200);

    // Người ngoài (kể cả project:admin): không thấy dự án.
    const dai = await ssoLogin(base, 'chi', ['project:admin'], 'idtoken');
    const A = as(dai.session!);
    assert.equal((await A('GET', `/projects/${pid}`)).status, 404);
    assert.equal((await A('GET', '/projects')).body.length, 0);

    // Tổng quan: B chưa xong, hạn ngày mai -> sắp đến hạn.
    const ov = await D('GET', '/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.body.projects.length, 1);
    assert.equal(ov.body.upcoming.length, 1);
    assert.equal(ov.body.overdue.length, 0);

    // Xuất CSV: BOM, tiêu đề, 3 dòng việc, ô có dấu phẩy được bọc ngoặc kép.
    const csv = await fetch(`${base}/api/projects/${pid}/export?format=csv`, { headers: { cookie: `prj_session=${duc.session}` } });
    assert.equal(csv.status, 200);
    // fetch().text() tự bỏ BOM nên kiểm BOM trên byte thô.
    const bytes = new Uint8Array(await csv.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith('STT,'));
    assert.match(text, /"Bình, Chi"/);
    assert.equal(text.trim().split('\r\n').length, 4);

    // API dịch vụ cho VNLab Account.
    assert.equal((await svc('/roles', 'GET', undefined, 'sai-khoa')).status, 401);
    const roles = await (await svc('/roles')).json() as { role: string; locked: boolean }[];
    assert.equal(roles.find((r) => r.role === 'project:admin')!.locked, true);
    assert.equal((await svc('/roles/project:user/permissions', 'PUT', { permissions: ['project.khong.co'] })).status, 400);
    assert.equal((await svc('/roles/project:admin/permissions', 'PUT', { permissions: [] })).status, 409);
    assert.equal((await svc('/roles/project:user/permissions', 'PUT', { permissions: ['project.project.create'] })).status, 200);
    // An (project:user) mất quyền sửa việc ngay; Chi (project:admin, khoá cứng) vẫn tạo dự án được.
    assert.equal((await D('PATCH', `/projects/${pid}/tasks/${tB.id}`, { progress: 60 })).status, 403);
    assert.equal((await A('POST', '/projects', { name: 'Của Chi' })).status, 201);
    const audit = await (await svc('/audit?limit=5')).json() as { removed: string[] }[];
    assert.equal(audit.length, 1);
    assert.ok(audit[0].removed.includes('project.task.write'));

    // Phiên có mốc kiểm role quá 12 giờ -> 401 reauth.
    const now = Math.floor(Date.now() / 1000);
    const stale = await sign({ sub: me.body.id, exp: now + 3600, rc: now - 13 * 3600 }, JWT_SECRET, 'HS256');
    const r = await fetch(`${base}/api/me`, { headers: { cookie: `prj_session=${stale}` } });
    assert.equal(r.status, 401);
    assert.equal((await r.json() as { reauth: boolean }).reauth, true);

    // Xoá tài khoản chủ: dự án mất theo, Bình không còn thấy.
    assert.equal((await D('POST', '/me/delete', { confirm: 'sai' })).status, 400);
    assert.equal((await D('POST', '/me/delete', { confirm: 'an@x.vn' })).status, 200);
    assert.equal((await L('GET', '/projects')).body.length, 0);
  } finally {
    await srv.stop();
    logto.server.close();
    await mem.close();
  }
});
