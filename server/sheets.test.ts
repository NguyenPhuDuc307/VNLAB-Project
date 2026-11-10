import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { formulaFor, parseSheetId, phaseTabTitle } from './sheets.ts';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('formulaFor: locale dấu phẩy thập phân đổi , -> ;', () => {
  const f = 'AND($G8<>"",K$5>=$G8,WEEKDAY(K$5)<>1)';
  assert.equal(formulaFor('en_US', f), f);
  assert.equal(formulaFor(undefined, f), f);
  assert.equal(formulaFor('vi_VN', f), 'AND($G8<>"";K$5>=$G8;WEEKDAY(K$5)<>1)');
  assert.equal(formulaFor('de_DE', f), 'AND($G8<>"";K$5>=$G8;WEEKDAY(K$5)<>1)');
});

test('phaseTabTitle: tab PLAN riêng cho phase, bỏ ký tự cấm', () => {
  assert.equal(phaseTabTitle('Tháng 11'), 'PLAN Tháng 11');
  assert.equal(phaseTabTitle("Q4/2026: [đợt 1]*"), 'PLAN Q4 2026 đợt 1');
});

test('parseSheetId: link hoặc id', () => {
  assert.equal(parseSheetId('https://docs.google.com/spreadsheets/d/1aJdANK4k1NuaiI_BjunXVbtFYlIyHonn/edit?usp=sharing'), '1aJdANK4k1NuaiI_BjunXVbtFYlIyHonn');
  assert.equal(parseSheetId('1aJdANK4k1NuaiI_BjunXVbtFYlIyHonn'), '1aJdANK4k1NuaiI_BjunXVbtFYlIyHonn');
  assert.equal(parseSheetId('https://example.com/x'), null);
  assert.equal(parseSheetId(''), null);
});

/** Google giả: token, Sheets API (get / batchUpdate / create), Drive permissions. Ghi lại mọi request để soát. */
async function fakeGoogle() {
  const calls: { method: string; path: string; body: any }[] = [];
  const sheets = new Map<string, { title: string; tabs: { sheetId: number; title: string; cf: number; rowGroups?: any[] }[] }>();
  sheets.set('EXISTING00000000000000000000', { title: 'Có sẵn', tabs: [{ sheetId: 0, title: 'Trang tính1', cf: 0 }] });
  let nextId = 1000;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname, body });
    const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/token') return json({ access_token: 'fake-token', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer fake-token') return json({ error: { message: 'no auth' } }, 401);
    if (req.method === 'POST' && url.pathname === '/sheets/spreadsheets') {
      const id = `NEW${String(nextId++).padStart(25, '0')}`;
      sheets.set(id, { title: body.properties.title, tabs: body.sheets.map((s: any, i: number) => ({ sheetId: i, title: s.properties.title, cf: 0 })) });
      return json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` });
    }
    const m = url.pathname.match(/^\/sheets\/spreadsheets\/([^/:]+)(:batchUpdate)?$/);
    if (m) {
      const ss = sheets.get(m[1]);
      if (!ss) return json({ error: { message: 'Requested entity was not found.' } }, 404);
      if (m[1].startsWith('FORBIDDEN')) return json({ error: { message: 'The caller does not have permission' } }, 403);
      if (!m[2]) return json({ spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${m[1]}/edit`, properties: { locale: 'vi_VN' }, sheets: ss.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title }, conditionalFormats: Array(t.cf).fill({}), rowGroups: t.rowGroups ?? [] })) });
      const replies = (body.requests as any[]).map((r) => {
        if (r.addSheet) { const t = { sheetId: nextId++, title: r.addSheet.properties.title, cf: 0 }; ss.tabs.push(t); return { addSheet: { properties: { sheetId: t.sheetId, title: t.title } } }; }
        if (r.addDimensionGroup) {
          const t = ss.tabs.find((x) => x.sheetId === r.addDimensionGroup.range.sheetId)!;
          (t.rowGroups ??= []).push({ range: r.addDimensionGroup.range, depth: 1, collapsed: false });
        }
        if (r.deleteDimensionGroup) {
          const t = ss.tabs.find((x) => x.sheetId === r.deleteDimensionGroup.range.sheetId)!;
          const index = (t.rowGroups ?? []).findIndex((g: any) => g.range.startIndex === r.deleteDimensionGroup.range.startIndex && g.range.endIndex === r.deleteDimensionGroup.range.endIndex);
          assert.ok(index >= 0, 'xoá nhóm không tồn tại');
          t.rowGroups!.splice(index, 1);
        }
        if (r.updateDimensionGroup) {
          const group = r.updateDimensionGroup.dimensionGroup;
          const t = ss.tabs.find((x) => x.sheetId === group.range.sheetId)!;
          const current = (t.rowGroups ?? []).find((g: any) => g.range.startIndex === group.range.startIndex && g.range.endIndex === group.range.endIndex && g.depth === group.depth);
          assert.ok(current, 'cập nhật nhóm không tồn tại / sai depth');
          current.collapsed = group.collapsed;
        }
        if (r.addConditionalFormatRule) { const t = ss.tabs.find((x) => x.sheetId === r.addConditionalFormatRule.rule.ranges[0].sheetId); if (t) t.cf++; }
        if (r.deleteConditionalFormatRule) { const t = ss.tabs.find((x) => x.sheetId === r.deleteConditionalFormatRule.sheetId); if (t) t.cf--; }
        return {};
      });
      return json({ replies });
    }
    if (req.method === 'POST' && /^\/drive\/files\/[^/]+\/permissions$/.test(url.pathname)) return json({ id: 'perm' });
    json({ error: { message: `không có ${req.method} ${url.pathname}` } }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, base, calls, sheets };
}

test('đồng bộ Google Sheets: tạo sheet mới + chia sẻ, ghi PLAN/Dữ liệu bằng batchUpdate có conditional formatting, liên kết sheet có sẵn, lỗi quyền, tự đồng bộ', { timeout: 90_000 }, async () => {
  // Khoá RSA giả (extractable để xuất PKCS8) làm service account cho server.
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const dir = mkdtempSync(join(tmpdir(), 'vnlab-sa-'));
  const saFile = join(dir, 'sa.json');
  writeFileSync(saFile, JSON.stringify({ client_email: 'vnlab-project-sheets@test.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) }));
  const mem = await memoryDb();
  const g = await fakeGoogle();
  const srv = await startServer({
    PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1', GOOGLE_SERVICE_ACCOUNT_FILE: saFile,
    GOOGLE_TOKEN_URL: `${g.base}/token`, GOOGLE_SHEETS_API: `${g.base}/sheets`, GOOGLE_DRIVE_API: `${g.base}/drive`, PROJECT_SHEET_AUTO_DELAY_MS: '300',
  });
  const base = srv.base;
  try {
    const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'an@x.vn', name: 'Trần Văn An', roles: ['project:user'] }) });
    const cookie = `prj_session=${cookieOf(login, 'prj_session')}`;
    const j = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    assert.deepEqual((await j('GET', '/google/status')).body, { configured: true, email: 'vnlab-project-sheets@test.iam.gserviceaccount.com' });

    const p = (await j('POST', '/projects', { name: 'Website bán hàng', customer: 'Công ty ABC', startDate: '2026-11-01' })).body;
    await j('POST', `/projects/${p.id}/members`, { email: 'binh@x.vn', role: 'editor' });
    await j('POST', `/projects/${p.id}/members`, { email: 'chi@x.vn', role: 'viewer' });
    await j('POST', `/projects/${p.id}/import`, { groups: [{ name: 'Thiết kế', tasks: [{ name: 'Thiết kế màn hình đăng nhập', assignee: 'An', progress: 100, startDate: '2026-11-02', endDate: '2026-11-07', days: 5.5 }] }] });

    // Chưa liên kết -> đồng bộ báo 400.
    assert.equal((await j('POST', `/projects/${p.id}/sheet/sync`, {})).status, 400);

    // (Google không cho service account tạo file — chỉ ghi vào sheet người dùng Share.)
    // Liên kết sheet có sẵn bằng link: tab PLAN / Dữ liệu thiếu thì được thêm, tab cũ giữ nguyên.
    g.calls.length = 0;
    assert.equal((await j('PATCH', `/projects/${p.id}/sheet`, { sheetUrl: 'https://not-a-sheet' })).status, 400);
    const linked = await j('PATCH', `/projects/${p.id}/sheet`, { sheetUrl: 'https://docs.google.com/spreadsheets/d/EXISTING00000000000000000000/edit#gid=0' });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.sheetId, 'EXISTING00000000000000000000');
    assert.equal(linked.body.sheetCollapseSubtasks, true);
    const synced = await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.deepEqual(g.sheets.get('EXISTING00000000000000000000')!.tabs.map((t) => t.title), ['Trang tính1', 'PLAN', 'Dữ liệu']);
    // batchUpdate ghi PLAN: merge, updateCells, đóng băng 10 cột, 2 luật conditional formatting (thanh + hôm nay), tab Dữ liệu có header + 1 dòng.
    const reqs = g.calls.filter((c) => c.path.endsWith(':batchUpdate')).flatMap((c) => c.body.requests as any[]);
    const cf = reqs.filter((r) => r.addConditionalFormatRule);
    assert.equal(cf.length, 2);
    const formulas = cf.map((r) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue as string);
    assert.match(formulas.join(' '), /WEEKDAY/);
    assert.ok(formulas.every((f) => !f.includes(',')), `sheet vi_VN không được có dấu phẩy: ${formulas.join(' | ')}`);
    assert.ok(formulas.some((f) => /WEEKDAY\(K\$5\)<>1\)$/.test(f) && f.includes(';')), 'công thức thanh phải dùng ;');
    assert.ok(reqs.some((r) => r.mergeCells));
    assert.ok(reqs.some((r) => r.updateSheetProperties?.properties?.gridProperties?.frozenColumnCount === 10));
    const cells = reqs.filter((r) => r.updateCells?.rows).flatMap((r) => r.updateCells.rows[0].values as any[]);
    assert.ok(cells.some((v) => v.userEnteredValue?.stringValue === 'TASK' && v.userEnteredFormat.backgroundColor));
    assert.ok(cells.some((v) => v.userEnteredValue?.stringValue === 'Thiết kế màn hình đăng nhập'));
    assert.ok(cells.some((v) => v.userEnteredValue?.numberValue === 5.5 && v.userEnteredFormat.backgroundColor?.red === 1 && v.userEnteredFormat.backgroundColor?.blue === 0));
    const dataTab = g.sheets.get('EXISTING00000000000000000000')!.tabs.find((t) => t.title === 'Dữ liệu')!;
    assert.ok(reqs.some((r) => r.updateCells?.range?.sheetId === dataTab.sheetId && r.updateCells.rows?.length === 2));
    const detail = (await j('GET', `/projects/${p.id}`)).body;
    assert.equal(detail.sheetId, 'EXISTING00000000000000000000');
    assert.ok(detail.sheetSyncedAt);
    assert.equal(detail.sheetError, null);
    // Đồng bộ task con thành hàng riêng trong PLAN và tab Dữ liệu.
    const parent = detail.tasks[0];
    const changed = await j('PATCH', `/projects/${p.id}/tasks/${parent.id}`, { subtasks: [
      { name: 'API đăng nhập', assignee: 'An', progress: 100 },
      { name: 'Giao diện đăng nhập', assignee: 'Bình', progress: 0 },
    ] });
    assert.equal(changed.body.progress, 50);
    g.calls.length = 0;
    assert.equal((await j('POST', `/projects/${p.id}/sheet/sync`, {})).status, 200);
    const childReqs = g.calls.filter((c) => c.path.endsWith(':batchUpdate')).flatMap((c) => c.body.requests as any[]);
    const planId = g.sheets.get('EXISTING00000000000000000000')!.tabs.find((t) => t.title === 'PLAN')!.sheetId;
    const groupRow = childReqs.find((r) => r.updateCells?.range?.sheetId === planId && r.updateCells.range.startRowIndex === 7).updateCells.rows[0].values;
    assert.equal(groupRow[0].userEnteredValue.stringValue, 'Thiết kế (1)');
    assert.equal(groupRow[0].userEnteredFormat.textFormat.bold, true);
    assert.equal(groupRow[4].userEnteredValue.numberValue, 0.5);
    assert.ok(groupRow[5].userEnteredValue.numberValue > 0);
    assert.ok(groupRow[6].userEnteredValue.numberValue >= groupRow[5].userEnteredValue.numberValue);
    assert.equal(groupRow[8].userEnteredValue.numberValue, 5.5);
    const childRow = childReqs.find((r) => r.updateCells?.range?.sheetId === planId && r.updateCells.range.startRowIndex === 9).updateCells.rows[0].values;
    assert.equal(childRow[0].userEnteredValue.stringValue, '1.1');
    assert.equal(childRow[1].userEnteredValue.stringValue, 'API đăng nhập'); // tên task con để nguyên, không ↳, không khoảng trắng đệm
    assert.equal(childRow[1].userEnteredFormat.textFormat.bold, false);
    const parentRow = childReqs.find((r) => r.updateCells?.range?.sheetId === planId && r.updateCells.range.startRowIndex === 8).updateCells.rows[0].values;
    assert.equal(parentRow[1].userEnteredFormat.textFormat.bold, false);
    assert.equal(childRow[2].userEnteredValue.stringValue, 'An');
    assert.equal(childRow[4].userEnteredValue.numberValue, 1);
    for (const index of [5, 6, 8]) assert.equal(childRow[index].userEnteredValue, undefined);
    const rawRows = childReqs.find((r) => r.updateCells?.range?.sheetId === dataTab.sheetId && r.updateCells.rows?.length === 4).updateCells.rows;
    assert.equal(rawRows[2].values[0].userEnteredValue.stringValue, '1.1');
    assert.equal(rawRows[2].values[10].userEnteredValue.stringValue, parent.name);
    assert.equal(rawRows[2].values[6].userEnteredValue, undefined);
    const planTab = g.sheets.get('EXISTING00000000000000000000')!.tabs.find((t) => t.sheetId === planId)!;
    assert.deepEqual(planTab.rowGroups, [{ range: { sheetId: planId, dimension: 'ROWS', startIndex: 9, endIndex: 11 }, depth: 1, collapsed: true }]);
    assert.ok(childReqs.some((r) => r.updateSheetProperties?.properties?.gridProperties?.rowGroupControlAfter === false));
    assert.ok(childReqs.some((r) => r.updateDimensionProperties?.properties?.hiddenByUser === false));


    // Đồng bộ lần hai: luật CF cũ bị xoá trước khi thêm lại (không chồng luật).
    await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(g.sheets.get('EXISTING00000000000000000000')!.tabs.find((t) => t.title === 'PLAN')!.cf, 2);
    assert.equal(planTab.rowGroups!.length, 1, 'đồng bộ lại không được tạo nhóm lồng nhau');
    // Tùy chọn lưu ở dự án, và luồng đồng bộ thật phải dùng lựa chọn đó.
    const expanded = await j('PATCH', `/projects/${p.id}/sheet`, { sheetCollapseSubtasks: false });
    assert.equal(expanded.status, 200);
    assert.equal(expanded.body.sheetCollapseSubtasks, false);
    assert.equal((await j('GET', `/projects/${p.id}`)).body.sheetCollapseSubtasks, false);
    await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(planTab.rowGroups!.length, 1);
    assert.equal(planTab.rowGroups![0].collapsed, false);
    await j('PATCH', `/projects/${p.id}/sheet`, { sheetCollapseSubtasks: true });
    await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(planTab.rowGroups![0].collapsed, true);
    // Thêm/bớt task con: dựng lại đúng vùng, không để việc cha bị ẩn bởi vùng nhóm cũ.
    await j('PATCH', `/projects/${p.id}/tasks/${parent.id}`, { subtasks: [changed.body.subtasks[0]] });
    await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(planTab.rowGroups!.length, 1);
    assert.deepEqual(planTab.rowGroups![0].range, { sheetId: planId, dimension: 'ROWS', startIndex: 9, endIndex: 10 });
    await j('PATCH', `/projects/${p.id}/tasks/${parent.id}`, { subtasks: [] });
    g.calls.length = 0;
    await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.deepEqual(planTab.rowGroups, []);
    const cleared = g.calls.filter((c) => c.path.endsWith(':batchUpdate')).flatMap((c) => c.body.requests as any[]);
    assert.ok(cleared.some((r) => r.deleteDimensionGroup));
    assert.ok(cleared.some((r) => r.updateDimensionProperties?.properties?.hiddenByUser === false));


    // Sheet chưa Share cho service account -> 403 với lời nhắc, lỗi lưu vào dự án.
    g.sheets.set('FORBIDDEN0000000000000000000', { title: 'x', tabs: [{ sheetId: 0, title: 'PLAN', cf: 0 }] });
    await j('PATCH', `/projects/${p.id}/sheet`, { sheetUrl: 'FORBIDDEN0000000000000000000' });
    const denied = await j('POST', `/projects/${p.id}/sheet/sync`, {});
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Share/);
    assert.match((await j('GET', `/projects/${p.id}`)).body.sheetError, /Share/);

    // Tự đồng bộ: bật rồi sửa việc -> sau ~300ms có batchUpdate mới.
    await j('PATCH', `/projects/${p.id}/sheet`, { sheetUrl: 'EXISTING00000000000000000000', sheetAuto: true });
    g.calls.length = 0;
    const t = detail.tasks[0];
    await j('PATCH', `/projects/${p.id}/tasks/${t.id}`, { subtasks: changed.body.subtasks.map((s: any) => ({ ...s, progress: 100 })) });
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(g.calls.some((c) => c.path.endsWith(':batchUpdate')), 'tự đồng bộ chưa chạy');

    // Bỏ liên kết.
    const un = await j('PATCH', `/projects/${p.id}/sheet`, { sheetUrl: null });
    assert.equal(un.body.sheetId, null);
    assert.equal(un.body.sheetAuto, false);
  } finally {
    await srv.stop();
    g.server.close();
    await mem.close();
  }
});
