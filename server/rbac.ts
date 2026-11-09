// Phân quyền theo tính năng, quản lý tập trung ở VNLab Account.
//
// - Role là role Logto (`project:user`, `project:admin`); quyền của từng role
//   lưu ở bảng `rbac_roles` và do VNLab Account sửa qua API dịch vụ bên dưới.
// - `project:admin` khoá cứng: luôn đủ mọi quyền, không lưu và không sửa được.
// - Role của người dùng chụp vào `users.app_roles` mỗi lần đăng nhập VNLab ID
//   (kể cả vòng kiểm role lại 12 giờ/lần).
// - Quyền hiệu dụng = hợp quyền của mọi role; bảng role đọc qua cache 30 giây,
//   PUT từ Account thì xoá cache ngay trên tiến trình này.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql } from './db.ts';
import { ALL_PERMISSIONS, isPermissionKey, PERMISSION_GROUPS, ROLE_DEFS, type PermissionKey, type ProjectRole } from './permissions.ts';

export const APP = 'project';
const CACHE_MS = 30_000;
const PROJECT_ROLE_SET = new Set<string>(ROLE_DEFS.map((r) => r.role));
const roleDef = (role: string) => ROLE_DEFS.find((r) => r.role === role);

// ---------------------------------------------------------------- quyền hiệu dụng

type RoleRow = { role: string; permissions: string[]; updatedAt: Date | null };
let cache: { at: number; rows: Map<string, RoleRow> } | null = null;

async function roleRows(): Promise<Map<string, RoleRow>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await sql<RoleRow[]>`select role, permissions, updated_at from rbac_roles`;
  const map = new Map(rows.map((r) => [r.role, { ...r, permissions: r.permissions.filter(isPermissionKey) }]));
  cache = { at: Date.now(), rows: map };
  return map;
}
export const clearRbacCache = () => { cache = null; };

async function permissionsOfRole(role: string): Promise<PermissionKey[]> {
  const def = roleDef(role);
  if (!def) return [];
  if (def.locked) return [...ALL_PERMISSIONS];
  return ((await roleRows()).get(role)?.permissions ?? []) as PermissionKey[];
}

/** Role project của một tài khoản — chụp từ Logto lúc đăng nhập. */
export function rolesOf(u: { appRoles?: string[] | null }): ProjectRole[] {
  return (u.appRoles ?? []).filter((r): r is ProjectRole => PROJECT_ROLE_SET.has(r));
}

export async function effectivePermissions(roles: readonly string[]): Promise<Set<PermissionKey>> {
  const out = new Set<PermissionKey>();
  for (const role of roles) for (const p of await permissionsOfRole(role)) out.add(p);
  return out;
}

type PermEnv = { Variables: { permissions: Set<PermissionKey> } };

/** Chặn route khi người dùng thiếu quyền. Cần middleware `auth` chạy trước để có `permissions`. */
export function requirePermission(key: PermissionKey): MiddlewareHandler<PermEnv> {
  const label = PERMISSION_GROUPS.flatMap((g) => g.permissions as readonly { key: string; label: string }[]).find((p) => p.key === key)!.label;
  return async (c, next) => {
    if (!c.get('permissions')?.has(key)) {
      throw new HTTPException(403, { message: `Bạn chưa có quyền ${label.charAt(0).toLowerCase()}${label.slice(1)} trong Project — nhờ quản trị viên cấp ở VNLab Account` });
    }
    await next();
  };
}

// ---------------------------------------------------------------- API dịch vụ cho VNLab Account

/**
 * `/api/service/rbac` — server của VNLab Account (account.vnlab.id.vn) gọi:
 *
 *   Authorization: Bearer <ACCOUNT_SERVICE_TOKEN>
 *   X-VNLab-Actor: <Logto sub của quản trị viên đang thao tác>   (bắt buộc)
 *   X-VNLab-Actor-Email: <email>                                   (tuỳ chọn)
 *
 * Hợp đồng chung với Stock/Finance/Shop. Lỗi luôn dạng `{ message }`.
 */
const MIN_TOKEN_LENGTH = 32;

function serviceToken(): string | null {
  const t = (process.env.ACCOUNT_SERVICE_TOKEN ?? '').trim();
  return t.length >= MIN_TOKEN_LENGTH ? t : null;
}

/** So sánh hằng thời gian; băm trước để hai vế luôn cùng độ dài. */
function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

type Actor = { sub: string; email: string | null };
type SvcEnv = { Variables: { actor: Actor } };

const fail = (c: Context, status: 400 | 401 | 404 | 409 | 503, message: string) => c.json({ message }, status);

async function roleView(role: (typeof ROLE_DEFS)[number]) {
  const row = role.locked ? undefined : (await roleRows()).get(role.role);
  return {
    role: role.role, label: role.label, description: role.description, locked: role.locked,
    permissions: await permissionsOfRole(role.role),
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export const rbacService = new Hono<SvcEnv>();

rbacService.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
  console.error('[rbac]', err);
  return c.json({ message: 'Lỗi máy chủ' }, 500);
});

rbacService.use('*', async (c, next) => {
  const expected = serviceToken();
  if (!expected) return fail(c, 503, 'Project chưa cấu hình ACCOUNT_SERVICE_TOKEN');
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m || !sameSecret(m[1].trim(), expected)) return fail(c, 401, 'Sai khoá dịch vụ');
  const sub = (c.req.header('x-vnlab-actor') ?? '').trim();
  if (!sub) return fail(c, 401, 'Thiếu X-VNLab-Actor');
  const email = (c.req.header('x-vnlab-actor-email') ?? '').trim().toLowerCase() || null;
  c.set('actor', { sub, email });
  await next();
});

rbacService.get('/catalog', (c) => c.json({
  app: APP,
  groups: PERMISSION_GROUPS.map((g) => ({
    key: g.key, label: g.label,
    permissions: (g.permissions as readonly { key: string; label: string; description?: string; dangerous?: boolean }[]).map((p) => ({
      key: p.key, label: p.label,
      ...(p.description ? { description: p.description } : {}),
      ...(p.dangerous ? { dangerous: true } : {}),
    })),
  })),
}));

rbacService.get('/roles', async (c) => c.json(await Promise.all(ROLE_DEFS.map(roleView))));

rbacService.put('/roles/:role/permissions', async (c) => {
  const def = roleDef(c.req.param('role'));
  if (!def) return fail(c, 404, 'Không có role này trong Project');
  if (def.locked) return fail(c, 409, `${def.role} luôn có mọi quyền, không chỉnh được`);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, 'Dữ liệu gửi lên không phải JSON');
  }
  const parsed = z.object({ permissions: z.array(z.string()).max(500) }).safeParse(raw);
  if (!parsed.success) return fail(c, 400, 'Cần dạng { permissions: string[] }');
  const unknown = parsed.data.permissions.filter((p) => !isPermissionKey(p));
  if (unknown.length) return fail(c, 400, `Quyền không có trong danh mục Project: ${[...new Set(unknown)].join(', ')}`);
  const wanted = new Set(parsed.data.permissions);
  const next = ALL_PERMISSIONS.filter((p) => wanted.has(p));
  const actor = c.get('actor');
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ permissions: string[] }[]>`select permissions from rbac_roles where role = ${def.role} for update`;
    const before = new Set(cur?.permissions ?? []);
    const added = next.filter((p) => !before.has(p));
    const removed = [...before].filter((p) => !wanted.has(p));
    await tx`
      insert into rbac_roles (role, permissions, updated_at) values (${def.role}, ${tx.array(next)}, now())
      on conflict (role) do update set permissions = excluded.permissions, updated_at = excluded.updated_at`;
    await tx`
      insert into rbac_audit (actor_sub, actor_email, role, added, removed)
      values (${actor.sub}, ${actor.email}, ${def.role}, ${tx.array(added)}, ${tx.array(removed)})`;
  });
  clearRbacCache();
  console.log(`[rbac] ${actor.sub} đặt quyền ${def.role}: ${next.length} quyền`);
  return c.json(await roleView(def));
});

rbacService.get('/audit', async (c) => {
  const n = Number(c.req.query('limit'));
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
  const rows = await sql<{ at: Date; actorSub: string; actorEmail: string | null; role: string; added: string[]; removed: string[] }[]>`
    select at, actor_sub, actor_email, role, added, removed from rbac_audit order by at desc, id desc limit ${limit}`;
  return c.json(rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() })));
});

rbacService.all('*', (c) => fail(c, 404, 'Không tìm thấy'));
