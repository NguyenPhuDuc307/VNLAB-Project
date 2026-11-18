// Danh mục quyền của Project — nguồn duy nhất cho cả server lẫn giao diện.
//
// Quyền ở đây là quyền DÙNG TÍNH NĂNG của role project:*; còn ai thấy được dự
// án nào do chủ dự án quyết định (mời thành viên với quyền sửa/xem). Xem dự án
// mình là chủ hay được mời là phần lõi, không có key.
//
// Chỉ THÊM key khi có chỗ trong code kiểm tra nó (requirePermission ở server,
// useCan ở giao diện). File này không được import gì có tác dụng phụ — giao
// diện (Vite) import thẳng nó.

export type Permission = { key: string; label: string; description?: string; dangerous?: boolean };
export type PermissionGroup = { key: string; label: string; permissions: Permission[] };

export const PERMISSION_GROUPS = [
  {
    key: 'project',
    label: 'Dự án',
    permissions: [
      { key: 'project.project.create', label: 'Tạo dự án mới' },
      { key: 'project.project.write', label: 'Sửa dự án, nhóm việc, thành viên', description: 'Với dự án mình là chủ, hoặc được mời với quyền sửa' },
      { key: 'project.project.delete', label: 'Xoá dự án', description: 'Xoá luôn mọi nhóm và việc bên trong; chỉ chủ dự án', dangerous: true },
    ],
  },
  {
    key: 'task',
    label: 'Việc',
    permissions: [
      { key: 'project.task.write', label: 'Thêm, sửa, kéo việc trên Gantt' },
      { key: 'project.task.delete', label: 'Xoá việc' },
    ],
  },
  {
    key: 'data',
    label: 'Dữ liệu',
    permissions: [
      { key: 'project.data.import', label: 'Nhập việc từ bảng tính', description: 'Dán từ Excel / Google Sheets' },
      { key: 'project.data.export', label: 'Xuất dự án ra JSON, CSV', description: 'Mang kế hoạch ra khỏi app', dangerous: true },
    ],
  },
  {
    key: 'mcp',
    label: 'AI bên ngoài (MCP)',
    permissions: [
      { key: 'project.tokens.manage', label: 'Tạo token MCP cho AI bên ngoài', description: 'Cho Claude, Codex… sửa dự án qua token. Gỡ quyền thì token ngừng chạy.', dangerous: true },
    ],
  },
  {
    key: 'settings',
    label: 'Cài đặt',
    permissions: [
      { key: 'project.settings.write', label: 'Đổi tên hiển thị' },
    ],
  },
] as const satisfies readonly PermissionGroup[];

export type PermissionKey = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
const KNOWN = new Set<string>(ALL_PERMISSIONS);
export const isPermissionKey = (k: string): k is PermissionKey => KNOWN.has(k);

/** Role Logto của Project. `project:admin` khoá cứng = luôn đủ mọi quyền. */
export const ROLE_DEFS = [
  { role: 'project:user', label: 'Người dùng Project', description: 'Lập kế hoạch dự án của mình và dự án được mời', locked: false },
  { role: 'project:admin', label: 'Quản trị Project', description: 'Luôn có mọi quyền trong Project — không chỉnh được', locked: true },
] as const;
export type ProjectRole = (typeof ROLE_DEFS)[number]['role'];
