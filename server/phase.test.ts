import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOf, memoryDb, startServer } from './test-helpers.ts';

test('phase: tạo / gán việc / lọc, MCP phase, gộp dự án khác thành phase (nhóm, phạm vi ghép theo tên)', { timeout: 90_000 }, async () => {
  const mem = await memoryDb();
  const srv = await startServer({ PROJECT_DATABASE_URL: mem.url, PROJECT_DEV_LOGIN: '1' });
  try {
    const login = await fetch(`${srv.base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ph@vnlab.local', name: 'PH' }) });
    const session = cookieOf(login, 'prj_session');
    const R = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${srv.base}/api${path}`, { method, headers: { cookie: `prj_session=${session}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    // Hai "dự án" thực ra là hai tháng của một dự án.
    const a = (await R('POST', '/projects', { name: 'AMMS tháng 10' })).body;
    const b = (await R('POST', '/projects', { name: 'AMMS tháng 11' })).body;
    const ga = (await R('POST', `/projects/${a.id}/groups`, { name: 'Giao hàng' })).body;
    const sa = (await R('POST', `/projects/${a.id}/scopes`, { name: 'Kho', owner: 'Lương' })).body;
    await R('POST', `/projects/${a.id}/tasks`, { groupId: ga.id, scopeId: sa.id, name: 'Việc tháng 10' });
    const gb = (await R('POST', `/projects/${b.id}/groups`, { name: 'giao hàng' })).body; // trùng tên khác hoa thường
    const gb2 = (await R('POST', `/projects/${b.id}/groups`, { name: 'Chứng từ' })).body;
    const sb = (await R('POST', `/projects/${b.id}/scopes`, { name: 'Vận hành', owner: 'Đại' })).body;
    const tb = (await R('POST', `/projects/${b.id}/tasks`, { groupId: gb.id, scopeId: sb.id, name: 'Việc tháng 11' })).body;
    await R('POST', `/projects/${b.id}/tasks`, { groupId: gb2.id, name: 'Chứng từ tháng 11' });
    await R('PATCH', `/projects/${b.id}/tasks/${tb.id}`, { progress: 50 }); // có lịch sử

    const m = await R('POST', `/projects/${a.id}/merge`, { sourceId: b.id, sourcePhase: 'Tháng 11', targetPhase: 'Tháng 10' });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.deepEqual([m.body.moved, m.body.tagged], [2, 1]);
    const pa = (await R('GET', `/projects/${a.id}`)).body;
    assert.deepEqual(pa.phases.map((x: { name: string }) => x.name), ['Tháng 10', 'Tháng 11']);
    assert.deepEqual(pa.groups.map((g: { name: string }) => g.name), ['Giao hàng', 'Chứng từ']); // ghép theo tên
    assert.deepEqual(pa.scopes.map((s: { name: string }) => s.name).sort(), ['Kho', 'Vận hành']);
    const t11 = pa.tasks.find((t: { name: string }) => t.name === 'Việc tháng 11');
    assert.equal(t11.groupId, ga.id);
    assert.equal(t11.phaseId, pa.phases[1].id);
    assert.equal(pa.tasks.find((t: { name: string }) => t.name === 'Việc tháng 10').phaseId, pa.phases[0].id);
    assert.ok((await R('GET', `/projects/${a.id}/tasks/${tb.id}/history`)).body.length >= 1); // lịch sử đi theo
    const pb = (await R('GET', `/projects/${b.id}`)).body;
    assert.equal(pb.archived, true);
    assert.equal(pb.tasks.length, 0);
    assert.equal((await R('POST', `/projects/${a.id}/merge`, { sourceId: a.id, sourcePhase: 'x' })).body.error, 'Không gộp dự án vào chính nó');

    // REST phase: tạo, sửa ngày, gán việc, xoá (việc thành chưa có phase).
    const p12 = (await R('POST', `/projects/${a.id}/phases`, { name: 'Tháng 12', startDate: '2026-12-01', endDate: '2026-12-31' })).body;
    assert.equal(p12.startDate, '2026-12-01');
    assert.equal((await R('POST', `/projects/${a.id}/phases`, { name: 'tháng 12' })).status, 400);
    const t12 = (await R('POST', `/projects/${a.id}/tasks`, { name: 'Việc tháng 12', phaseId: p12.id })).body;
    assert.equal(t12.phaseId, p12.id);
    assert.equal((await R('POST', `/projects/${a.id}/tasks/phase`, { phaseId: p12.id, taskIds: [t11.id] })).body.moved, 1);
    // Xuất Excel / CSV theo phase.
    const csvAll = await (await fetch(`${srv.base}/api/projects/${a.id}/export?format=csv`, { headers: { cookie: `prj_session=${session}` } })).text();
    const csv12 = await (await fetch(`${srv.base}/api/projects/${a.id}/export?format=csv&phase=${p12.id}`, { headers: { cookie: `prj_session=${session}` } })).text();
    assert.ok(csvAll.includes('Việc tháng 10') && csv12.includes('Việc tháng 12') && !csv12.includes('Việc tháng 10'));
    const xl = await fetch(`${srv.base}/api/projects/${a.id}/export?format=xlsx&phase=${p12.id}`, { headers: { cookie: `prj_session=${session}` } });
    assert.equal(xl.status, 200);
    assert.match(xl.headers.get('content-disposition') ?? '', /thang-12/);
    assert.equal((await fetch(`${srv.base}/api/projects/${a.id}/export?format=csv&phase=00000000-0000-4000-8000-000000000000`, { headers: { cookie: `prj_session=${session}` } })).status, 404);
    // Xuất theo nhóm việc: chỉ việc của nhóm đó, tên file kèm tên nhóm.
    const gPlan = (await R('POST', `/projects/${a.id}/groups`, { name: 'Lập kế hoạch' })).body;
    const tPlan = (await R('POST', `/projects/${a.id}/tasks`, { name: 'Việc của nhóm', groupId: gPlan.id })).body;
    const csvG = await (await fetch(`${srv.base}/api/projects/${a.id}/export?format=csv&group=${gPlan.id}`, { headers: { cookie: `prj_session=${session}` } })).text();
    assert.ok(csvG.includes('Việc của nhóm') && !csvG.includes('Việc tháng 10') && !csvG.includes('Việc tháng 12'));
    const xlG = await fetch(`${srv.base}/api/projects/${a.id}/export?format=xlsx&group=${gPlan.id}`, { headers: { cookie: `prj_session=${session}` } });
    assert.equal(xlG.status, 200);
    assert.match(xlG.headers.get('content-disposition') ?? '', /lap-ke-hoach\.xlsx/);
    assert.equal((await fetch(`${srv.base}/api/projects/${a.id}/export?format=xlsx&group=00000000-0000-4000-8000-000000000000`, { headers: { cookie: `prj_session=${session}` } })).status, 404);
    await R('DELETE', `/projects/${a.id}/tasks/${tPlan.id}`);
    await R('DELETE', `/projects/${a.id}/groups/${gPlan.id}`);
    assert.equal((await R('DELETE', `/projects/${a.id}/phases/${p12.id}`)).body.tasks, 2);
    assert.equal((await R('GET', `/projects/${a.id}`)).body.tasks.filter((t: { phaseId: string | null }) => !t.phaseId).length, 2);
  } finally {
    await srv.stop();
    await mem.close();
  }
});
