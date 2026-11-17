import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('xuất Excel theo mẫu Gantt: sheet PLAN có tiêu đề, bảng, nhóm, DAYS, lưới ngày và conditional formatting; chỉ sheet PLAN, thanh tô sẵn', { timeout: 90_000 }, async () => {
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1' });
  const base = srv.base;
  try {
    const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'an@x.vn', name: 'Trần Văn An', roles: ['project:user'] }) });
    const cookie = `prj_session=${cookieOf(login, 'prj_session')}`;
    const j = (method: string, path: string, body?: unknown) => fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<any>);
    const p = await j('POST', '/projects', { name: 'Website bán hàng', customer: 'Công ty ABC', code: 'WEB01', startDate: '2026-11-01' });
    await j('POST', `/projects/${p.id}/import`, { groups: [
      { name: 'Thiết kế', tasks: [{ name: 'Thiết kế màn hình đăng nhập', assignee: 'An', progress: 100, startDate: '2026-11-02', endDate: '2026-11-07', days: 5.5 }, { name: 'Thiết kế trang chủ', assignee: 'An', support: 'Bình, Chi', startDate: '2026-11-09', endDate: '2026-11-12' }] },
      { name: 'Lập trình', tasks: [{ name: 'Dựng API giỏ hàng', startDate: '2026-11-12', endDate: '2026-11-14', days: 2.5, note: 'phụ thuộc thiết kế' }] },
    ] });
    const res = await fetch(`${base}/api/projects/${p.id}/export?format=xlsx`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.match(res.headers.get('content-disposition') ?? '', /website-ban-hang\.xlsx/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 5000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.getWorksheet('PLAN')!;
    assert.ok(ws, 'thiếu sheet PLAN');
    assert.equal(ws.getCell('C1').value, 'Website bán hàng');
    assert.equal(ws.getCell('C2').value, 'Khách hàng: Công ty ABC');
    assert.equal(ws.getCell('C3').value, 'PM: Trần Văn An');
    assert.equal(ws.getCell('F3').value, 'Project Start:');
    assert.deepEqual(['B6', 'C6', 'D6', 'E6', 'F6', 'G6', 'H6', 'I6', 'J6'].map((a) => ws.getCell(a).value), ['No', 'TASK', 'ASSIGNED TO', 'SUPPORT', 'PROGRESS', 'START', 'END', 'NOTE', 'DAYS']);
    // Lưới ngày bắt đầu thứ Hai 2/11 ở cột K, hàng 5 là ngày thật, hàng 6 là T/C.
    const k5 = ws.getCell('K5').value as Date;
    assert.equal(k5.toISOString().slice(0, 10), '2026-11-02');
    assert.equal(ws.getCell('K6').value, 'T');
    assert.equal(ws.getCell('Q6').value, 'C'); // Chủ nhật 8/11
    // Hàng nhóm rồi các việc: nhóm ở B8 (merge B:C), DAYS tổng = 5.5 + 4 (tự tính 9–12/11).
    assert.equal(ws.getCell('B8').value, 'Thiết kế (2)');
    assert.equal(ws.getCell('J8').value, 9.5);
    assert.equal(ws.getCell('B9').value, 1);
    assert.equal(ws.getCell('C9').value, 'Thiết kế màn hình đăng nhập');
    assert.equal(ws.getCell('F9').value, 1);
    assert.equal((ws.getCell('G9').value as Date).toISOString().slice(0, 10), '2026-11-02');
    assert.equal(ws.getCell('J9').value, 5.5);
    assert.equal(ws.getCell('E10').value, 'Bình, Chi');
    assert.equal(ws.getCell('J10').value, 4);
    assert.equal(ws.getCell('B11').value, 'Lập trình (1)');
    assert.equal(ws.getCell('I12').value, 'phụ thuộc thiết kế');
    assert.equal(ws.getCell('J12').value, 2.5);
    // DAYS tô vàng, nhóm tô xám, tiêu đề nền sẫm chữ trắng.
    assert.equal((ws.getCell('J9').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFFFF00');
    assert.equal((ws.getCell('B8').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFD9D9D9');
    assert.equal((ws.getCell('C6').fill as ExcelJS.FillPattern).fgColor?.argb, 'FF595959');
    // Conditional formatting vẽ thanh: có luật expression tham chiếu START/END và WEEKDAY.
    const cf = (ws as unknown as { conditionalFormattings: { ref: string; rules: { type: string; formulae?: string[] }[] }[] }).conditionalFormattings;
    assert.ok(cf.length >= 1);
    const rules = cf.flatMap((x) => x.rules);
    assert.ok(rules.some((r) => r.type === 'expression' && /WEEKDAY/.test(r.formulae?.[0] ?? '')), JSON.stringify(rules));
    assert.ok(cf.some((x) => /^K8:/.test(x.ref)), cf.map((x) => x.ref).join(','));
    // File tải về chỉ có sheet PLAN; thanh được tô sẵn cho app không chạy conditional formatting.
    assert.deepEqual(wb.worksheets.map((x) => x.name), ['PLAN']);
    let painted = 0;
    ws.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => { if ((cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb === 'FF4F81BD') painted++; }));
    assert.ok(painted > 0);

    // Task con xuất thành hàng riêng ngay dưới cha; không có lịch / ngày công riêng.
    const detail = await j('GET', `/projects/${p.id}`);
    await j('PATCH', `/projects/${p.id}/tasks/${detail.tasks[0].id}`, { subtasks: [
      { name: 'Xây API', assignee: 'An', progress: 100 },
      { name: 'Làm giao diện', assignee: 'Bình', progress: 0 },
    ] });
    const withChildren = await fetch(`${base}/api/projects/${p.id}/export?format=xlsx`, { headers: { cookie } });
    const childrenBook = new ExcelJS.Workbook();
    await childrenBook.xlsx.load(Buffer.from(await withChildren.arrayBuffer()) as never);
    const plan = childrenBook.getWorksheet('PLAN')!;
    assert.equal(plan.getCell('F9').value, 0.5);
    assert.equal(plan.getCell('B10').value, '1.1');
    assert.equal(plan.getCell('C10').value, 'Xây API');
    assert.equal(plan.getCell('C10').alignment.indent, 2); // task con thụt lề, không có ↳
    assert.equal(plan.getCell('D10').value, 'An');
    assert.equal(plan.getCell('F10').value, 1);
    assert.equal(plan.getCell('B11').value, '1.2');
    assert.equal(plan.getCell('C11').value, 'Làm giao diện');
    assert.equal(plan.getCell('D11').value, 'Bình');
    assert.equal(plan.getCell('F11').value, 0);
    for (const row of [10, 11]) for (const col of ['G', 'H', 'J']) assert.equal(plan.getCell(`${col}${row}`).value, null);
    assert.equal(plan.getCell('B12').value, 2);
    assert.equal(plan.getCell('J8').value, 9.5);
    assert.equal(plan.getCell('F8').value, 0.25);
    assert.equal((plan.getCell('G8').value as Date).toISOString().slice(0, 10), '2026-11-02');
    assert.equal((plan.getCell('H8').value as Date).toISOString().slice(0, 10), '2026-11-12');
    assert.equal(plan.getCell('B8').value, 'Thiết kế (2)');
    assert.equal(plan.getCell('J9').value, 5.5);
    // Chọn ít cột / không xuất lưới vẫn giữ các hàng con, đúng thứ tự cột.
    const narrow = await fetch(`${base}/api/projects/${p.id}/export?format=xlsx&cols=assignee,progress`, { headers: { cookie } });
    const narrowBook = new ExcelJS.Workbook();
    await narrowBook.xlsx.load(Buffer.from(await narrow.arrayBuffer()) as never);
    assert.equal(narrowBook.getWorksheet('PLAN')!.getCell('E10').value, 1);
    assert.equal(narrowBook.getWorksheet('PLAN')!.getCell('C11').value, 'Làm giao diện');

  } finally {
    await srv.stop();
    await mem.close();
  }
});
