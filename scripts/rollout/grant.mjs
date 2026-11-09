// Chạy TRONG container Account: cấp role project:admin cho mọi tài khoản đang giữ vnlab:admin
// (chỉ thêm; chạy lại không lặp). Người khác cấp ở https://account.vnlab.id.vn/admin.
import { managementFromEnv } from './server/logto.ts';

const mgmt = managementFromEnv();
const roles = await mgmt.listRoles();
const admin = roles.find((r) => r.name === 'vnlab:admin');
const target = roles.find((r) => r.name === 'project:admin');
if (!admin || !target) throw new Error('Thiếu role vnlab:admin hoặc project:admin — chạy bootstrap trước');
const { users } = await mgmt.searchUsers({ roleId: admin.id, page: 1, pageSize: 100 });
for (const u of users) {
  const have = (await mgmt.userRoles(u.id)).some((r) => r.name === target.name);
  if (have) { console.log(`✓ ${u.primaryEmail ?? u.id} đã có project:admin`); continue; }
  await mgmt.assignRoles(u.id, [target.id]);
  console.log(`+ project:admin → ${u.primaryEmail ?? u.id}`);
}
console.log(`Xong: ${users.length} tài khoản vnlab:admin.`);
