// Chạy TRONG container Account (cwd /app, có LOGTO_M2M_APP_ID/SECRET trong env):
//   docker compose exec -T [-e APPLY=1] app node --input-type=module < bootstrap.mjs
// In kế hoạch bootstrap theo shared/catalog.ts; APPLY=1 thì ghi lên Logto (chỉ thêm, idempotent).
import { managementFromEnv } from './server/logto.ts';
import { applyPlan, buildPlan, describe } from './scripts/bootstrap-plan.ts';

const apply = process.env.APPLY === '1';
const mgmt = managementFromEnv();
const plan = await buildPlan(mgmt, {});
for (const n of plan.notes) console.log(`! ${n}`);
if (!plan.steps.length) console.log('✓ Logto đã đúng như catalog — không có gì để làm.');
else {
  console.log(`Kế hoạch (${plan.steps.length} bước)${apply ? ' — ĐANG GHI' : ' — dry-run'}:`);
  for (const s of plan.steps) console.log(`  ${describe(s)}`);
}
for (const [k, id] of Object.entries(plan.existingApps)) console.log(`EXISTING ${k} id=${id}`);
if (apply && plan.steps.length) {
  const { created } = await applyPlan(mgmt, plan);
  console.log(`✓ Đã ghi ${mgmt.writes.length} lệnh lên Logto.`);
  for (const a of created) console.log(`CREATED ${a.key} ${a.type} id=${a.id}`);
}
