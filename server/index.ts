// VNLab Project — API + MCP + SPA trong một tiến trình (Hono trên Node).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { sign, verify } from 'hono/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import * as D from './data.ts';
import { migrate, sql } from './db.ts';
import { today } from './dates.ts';
import { handleMcp } from './mcp.ts';
import { effectivePermissions, rbacService, requirePermission, rolesOf } from './rbac.ts';
import { authorizeUrl, endSessionUrl, exchangeCode, hasProjectRole, LOGTO_APP_ID, noAccessPage, PROJECT_ROLES, randomToken, roleCheckFresh } from './sso.ts';
import { toolList } from './tools.ts';
import { ALL_COLUMNS, buildPlanLayout, isColKey, normalizeColumns } from './plan-layout.ts';
import { parseSheetId, sheetStatus, startAutoSync, syncProject } from './sheets.ts';
import { GoogleError } from './google.ts';
import { findGetflyTask, getflyLinkCount, getflyStatus, getflyUsers, syncGetfly } from './getfly.ts';
import { renderXlsx } from './xlsx.ts';
import type { PermissionKey, ProjectRole } from './permissions.ts';

const PORT = Number(process.env.PORT ?? 3400);
const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.PROJECT_JWT_SECRET ?? (PROD ? '' : 'dev-secret-khong-dung-o-production');
if (PROD && JWT_SECRET.length < 32) {
  console.error('[project] PROJECT_JWT_SECRET phải có ít nhất 32 ký tự');
  process.exit(1);
}
if (PROD && !process.env.PROJECT_LOGTO_APP_ID) console.warn('[project] chưa đặt PROJECT_LOGTO_APP_ID — đăng nhập VNLab ID sẽ lỗi (chạy bootstrap ở repo Account rồi đặt id app "project")');
// Đăng nhập giả cho máy dev (không có Logto): POST /api/auth/dev-login. Không bao giờ bật ở production.
const DEV_LOGIN = !PROD && process.env.PROJECT_DEV_LOGIN === '1';
const COOKIE = 'prj_session';
// Phiên bản chính sách bảo mật người dùng phải đồng ý (đổi khi chính sách đổi).
const POLICY_VERSION = '2026-11-09';
const SESSION_DAYS = 30;

type Env = { Variables: Record<string, never> };
const app = new Hono<Env>();
const { zId, zText, forbidden } = D;
type UserRow = D.UserRow;

// ---------------------------------------------------------------- helpers

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Dữ liệu gửi lên không phải JSON' });
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HTTPException(400, { message: issue ? `${issue.path.join('.') ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'Dữ liệu không hợp lệ' });
  }
  return r.data;
}

function param(c: Context, name = 'id'): string {
  const v = c.req.param(name);
  if (!v || !zId.safeParse(v).success) throw new HTTPException(400, { message: 'Mã không hợp lệ' });
  return v;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = (c: Context) => /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim() ?? '';
const origin = (c: Context) => `${c.req.header('x-forwarded-proto') ?? (PROD ? 'https' : 'http')}://${c.req.header('host')}`;

// ---------------------------------------------------------------- middleware

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof GoogleError) return c.json({ error: err.message }, err.status as 400);
  const code = (err as { code?: string }).code;
  if (code === '23505') return c.json({ error: 'Mục này đã tồn tại' }, 409);
  if (code === '23503') return c.json({ error: 'Dữ liệu liên quan không tồn tại' }, 400);
  if (code === '23514') return c.json({ error: 'Dữ liệu không hợp lệ' }, 400);
  console.error(err);
  return c.json({ error: 'Lỗi máy chủ' }, 500);
});

// Chặn CSRF: cookie SameSite=Lax đã chặn phần lớn, thêm kiểm tra Origin cho mọi lệnh ghi.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const o = c.req.header('origin');
    if (o && new URL(o).host !== c.req.header('host')) return c.json({ error: 'Sai nguồn gửi' }, 403);
  }
  c.header('Cache-Control', 'no-store');
  await next();
});

// rc: lúc vừa kiểm role VNLab ID (giây).
async function startSession(c: Context, userId: string, rc: number) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await sign({ sub: userId, exp, rc }, JWT_SECRET, 'HS256');
  setCookie(c, COOKIE, token, { httpOnly: true, secure: PROD, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}

type AuthEnv = { Variables: { user: UserRow; userId: string; roles: ProjectRole[]; permissions: Set<PermissionKey> } };
const auth = new Hono<AuthEnv>();
auth.use('*', async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) return c.json({ error: 'Chưa đăng nhập' }, 401);
  let user: UserRow | undefined, payload;
  try {
    payload = await verify(token, JWT_SECRET, 'HS256');
    [user] = await sql<UserRow[]>`select * from users where id = ${payload.sub as string}`;
    if (!user) throw new Error('user đã bị xoá');
  } catch {
    deleteCookie(c, COOKIE, { path: '/', secure: PROD });
    return c.json({ error: 'Phiên đăng nhập hết hạn' }, 401);
  }
  // Role project phải được kiểm lại định kỳ: 401 reauth -> app tự đi SSO im lặng.
  if (!roleCheckFresh(payload)) return c.json({ error: 'Cần xác nhận lại quyền VNLab ID', reauth: true }, 401);
  const roles = rolesOf(user);
  c.set('user', user);
  c.set('userId', user.id);
  c.set('roles', roles);
  c.set('permissions', await effectivePermissions(roles));
  await D.actorContext.run({ source: 'web', actor: user.name || user.email, actorId: user.id }, () => next());
});

// ---------------------------------------------------------------- VNLab ID (Logto)

const SSO_COOKIE = 'prj_sso';
const IDT_COOKIE = 'prj_idt';
const NOACCESS_COOKIE = 'prj_noaccess';
const SSO_PATH = '/api/auth/sso';
const safeNext = (n: string | undefined) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

/** Gắn user_id cho các lời mời theo email của người này (mời trước khi họ đăng nhập lần đầu). */
const linkInvites = (userId: string, email: string) =>
  sql`update project_members set user_id = ${userId} where user_id is null and lower(email) = ${email.toLowerCase()}`;

app.get(`${SSO_PATH}/start`, async (c) => {
  const st = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), next: safeNext(c.req.query('next')) };
  const url = await authorizeUrl({ ...st, redirectUri: `${origin(c)}${SSO_PATH}/callback` });
  const token = await sign({ ...st, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET, 'HS256');
  setCookie(c, SSO_COOKIE, token, { httpOnly: true, secure: PROD, sameSite: 'Lax', path: SSO_PATH, maxAge: 600 });
  return c.redirect(url);
});

app.get(`${SSO_PATH}/callback`, async (c) => {
  const fail = (msg: string) => {
    deleteCookie(c, SSO_COOKIE, { path: SSO_PATH, secure: PROD });
    return c.redirect(`/?sso_error=${encodeURIComponent(msg)}`);
  };
  const raw = getCookie(c, SSO_COOKIE);
  if (c.req.query('error')) return fail(c.req.query('error_description') ?? 'Đăng nhập VNLab ID bị huỷ');
  if (!raw) return fail('Phiên đăng nhập đã hết hạn, thử lại');
  let st: { state: string; nonce: string; verifier: string; next: string };
  try {
    st = (await verify(raw, JWT_SECRET, 'HS256')) as unknown as typeof st;
  } catch {
    return fail('Phiên đăng nhập đã hết hạn, thử lại');
  }
  const code = c.req.query('code');
  if (!code || c.req.query('state') !== st.state) return fail('Yêu cầu đăng nhập không hợp lệ');
  let profile;
  try {
    profile = await exchangeCode({ code, redirectUri: `${origin(c)}${SSO_PATH}/callback`, verifier: st.verifier, nonce: st.nonce });
  } catch (err) {
    console.error('[sso]', err);
    return fail('Không xác thực được với VNLab ID');
  }
  // Chốt quyền: thiếu role project:user/project:admin thì không tạo tài khoản, không tạo phiên, huỷ cả phiên cũ.
  if (!hasProjectRole(profile.roles)) {
    console.warn(`[sso] từ chối ${profile.sub}: thiếu role project:user/project:admin`);
    deleteCookie(c, SSO_COOKIE, { path: SSO_PATH, secure: PROD });
    deleteCookie(c, COOKIE, { path: '/', secure: PROD });
    setCookie(c, IDT_COOKIE, profile.idToken, { httpOnly: true, secure: PROD, sameSite: 'Lax', path: '/api/auth', maxAge: 3600 });
    setCookie(c, NOACCESS_COOKIE, profile.email ?? '', { httpOnly: true, secure: PROD, sameSite: 'Lax', path: '/api/auth/no-access', maxAge: 600 });
    return c.redirect('/api/auth/no-access');
  }
  const email = profile.email ?? `${profile.sub}@vnlab.id`;
  const appRoles = profile.roles.filter((r) => (PROJECT_ROLES as readonly string[]).includes(r));
  // Tài khoản theo sub VNLab ID; tên/ảnh/email lấy lại mỗi lần đăng nhập.
  const [user] = await sql<UserRow[]>`
    insert into users (logto_sub, email, name, avatar, app_roles, last_login_at)
    values (${profile.sub}, ${email}, ${profile.name}, ${profile.picture}, ${sql.array(appRoles)}, now())
    on conflict (logto_sub) do update set
      email = excluded.email, avatar = excluded.avatar, app_roles = excluded.app_roles, last_login_at = now(),
      name = case when users.name = '' then excluded.name else users.name end
    returning *`;
  await linkInvites(user.id, email);
  setCookie(c, IDT_COOKIE, profile.idToken, { httpOnly: true, secure: PROD, sameSite: 'Lax', path: '/api/auth', maxAge: SESSION_DAYS * 86400 });
  deleteCookie(c, SSO_COOKIE, { path: SSO_PATH, secure: PROD });
  await startSession(c, user.id, Math.floor(Date.now() / 1000));
  return c.redirect(safeNext(st.next));
});

app.get('/api/auth/no-access', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.html(noAccessPage({ app: 'Project', email: getCookie(c, NOACCESS_COOKIE) || null, logoutUrl: '/api/auth/logout' }), 403);
});

app.get('/api/auth/logout', async (c) => {
  const idt = getCookie(c, IDT_COOKIE);
  deleteCookie(c, COOKIE, { path: '/', secure: PROD });
  deleteCookie(c, IDT_COOKIE, { path: '/api/auth', secure: PROD });
  if (!idt) return c.redirect('/?logged_out=1');
  try {
    return c.redirect(await endSessionUrl(idt, `${origin(c)}/api/auth/logged-out`));
  } catch (err) {
    console.error('[sso] logout', err);
    return c.redirect('/?logged_out=1');
  }
});
app.get('/api/auth/logged-out', (c) => c.redirect('/?logged_out=1'));
app.get('/api/auth/status', (c) => c.json({ devLogin: DEV_LOGIN, policyVersion: POLICY_VERSION, logtoAppId: LOGTO_APP_ID }));

if (DEV_LOGIN) {
  app.post('/api/auth/dev-login', async (c) => {
    const b = await body(c, z.object({ email: z.email().default('dev@vnlab.local'), name: zText(80).default('Dev'), roles: z.array(z.string()).default(['project:admin']) }));
    const email = b.email.toLowerCase();
    const [user] = await sql<UserRow[]>`
      insert into users (logto_sub, email, name, app_roles, last_login_at) values (${`dev:${email}`}, ${email}, ${b.name}, ${sql.array(b.roles)}, now())
      on conflict (logto_sub) do update set app_roles = excluded.app_roles, last_login_at = now() returning *`;
    await linkInvites(user.id, email);
    await startSession(c, user.id, Math.floor(Date.now() / 1000));
    return c.json({ ok: true });
  });
}

// ---------------------------------------------------------------- MCP cho AI bên ngoài

// Token "vpj_…" tạo ở Cài đặt (chỉ lưu băm). Không đi qua Logto nên không bị vòng
// kiểm role 12 giờ; gỡ quyền project.tokens.manage ở VNLab Account thì token thôi
// dùng được ngay. Nằm ngoài /api/* nên không dính kiểm tra Origin (chỉ bearer, không cookie).
app.all('/mcp', async (c) => {
  const deny = (code: number, message: string, status: 401 | 403) => c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);
  const token = bearer(c);
  if (!token.startsWith('vpj_')) return deny(-32001, 'Thiếu hoặc sai token — tạo token MCP ở Cài đặt của VNLab Project', 401);
  const [row] = await sql<{ userId: string }[]>`update api_tokens set last_used_at = now() where token_hash = ${sha256(token)} returning user_id`;
  const [user] = row ? await sql<UserRow[]>`select * from users where id = ${row.userId}` : [];
  if (!user) return deny(-32001, 'Token không còn hiệu lực', 401);
  if (!(await effectivePermissions(rolesOf(user))).has('project.tokens.manage')) return deny(-32002, 'Tài khoản không còn quyền dùng MCP — xem VNLab Account', 403);
  // Ghi qua MCP: touch() đọc ngữ cảnh này để giao diện web báo "AI vừa sửa gì".
  return D.actorContext.run({ source: 'mcp', actor: user.name || user.email, actorId: user.id }, () => handleMcp(c.req.raw, user));
});

// ---------------------------------------------------------------- tài khoản

const publicUser = (u: UserRow) => ({
  id: u.id, email: u.email, name: u.name, avatar: u.avatar,
  consentAt: u.consentAt ? new Date(u.consentAt).toISOString() : null,
  consentRequired: !u.consentAt || u.consentVersion !== POLICY_VERSION,
  policyVersion: POLICY_VERSION,
});

auth.get('/me', (c) => c.json({ ...publicUser(c.get('user')), roles: c.get('roles'), permissions: [...c.get('permissions')] }));

auth.post('/me/consent', async (c) => {
  const b = await body(c, z.object({ version: z.literal(POLICY_VERSION, { error: 'Chính sách vừa được cập nhật, tải lại trang rồi đọc lại' }) }));
  const [u] = await sql<UserRow[]>`update users set consent_at = now(), consent_version = ${b.version} where id = ${c.get('userId')} returning *`;
  return c.json(publicUser(u));
});

auth.patch('/me', requirePermission('project.settings.write'), async (c) => {
  const b = await body(c, z.object({ name: zText(80).min(1) }));
  const [u] = await sql<UserRow[]>`update users set name = ${b.name} where id = ${c.get('userId')} returning *`;
  return c.json(publicUser(u));
});

// Xoá tài khoản: xoá luôn dự án mình là chủ (cùng mọi việc) và rút khỏi dự án được mời.
auth.post('/me/delete', async (c) => {
  const b = await body(c, z.object({ confirm: z.string().default('') }));
  const u = c.get('user');
  if (b.confirm.trim().toLowerCase() !== u.email.toLowerCase()) throw new HTTPException(400, { message: 'Gõ đúng email để xác nhận' });
  await sql`delete from users where id = ${u.id}`;
  deleteCookie(c, COOKIE, { path: '/', secure: PROD });
  return c.json({ ok: true });
});

/** Toàn bộ dữ liệu của tôi (quyền riêng tư): dự án mình là chủ + dự án được mời. */
auth.get('/me/export', requirePermission('project.data.export'), async (c) => {
  const u = c.get('user');
  const projects = await sql`select id from projects where owner_id = ${u.id} order by created_at`;
  const out = [];
  for (const p of projects) out.push(await D.projectBundle(p.id));
  const invited = await sql`select p.id, p.name, m.role from project_members m join projects p on p.id = m.project_id where m.user_id = ${u.id} or lower(m.email) = ${u.email.toLowerCase()}`;
  c.header('Content-Disposition', `attachment; filename="vnlab-project-${today()}.json"`);
  return c.json({ exportedAt: new Date().toISOString(), user: { email: u.email, name: u.name }, projects: out, invitedTo: invited });
});

// ---------------------------------------------------------------- token MCP

auth.get('/mcp/tools', (c) => c.json({ url: `${origin(c)}/mcp`, tools: toolList() }));
auth.get('/tokens', requirePermission('project.tokens.manage'), async (c) =>
  c.json((await sql`select id, name, created_at, last_used_at from api_tokens where user_id = ${c.get('userId')} order by created_at desc`).map((t) => ({
    id: t.id, name: t.name, createdAt: new Date(t.createdAt).toISOString(), lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
  }))));
auth.post('/tokens', requirePermission('project.tokens.manage'), async (c) => {
  const b = await body(c, z.object({ name: zText(80).min(1, 'Đặt tên cho token') }));
  const token = `vpj_${randomBytes(24).toString('base64url')}`;
  const [row] = await sql`insert into api_tokens (user_id, name, token_hash) values (${c.get('userId')}, ${b.name}, ${sha256(token)}) returning id, name, created_at`;
  return c.json({ id: row.id, name: row.name, createdAt: new Date(row.createdAt).toISOString(), token, url: `${origin(c)}/mcp` }, 201);
});
auth.delete('/tokens/:id', requirePermission('project.tokens.manage'), async (c) => {
  await sql`delete from api_tokens where id = ${param(c)} and user_id = ${c.get('userId')}`;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- dự án

auth.get('/projects', async (c) => c.json(await D.myProjects(c.get('user'))));
auth.get('/overview', async (c) => c.json(await D.overview(c.get('user'))));

auth.post('/projects', requirePermission('project.project.create'), async (c) => {
  const b = await body(c, D.projectSchema);
  const p = await D.createProject(c.get('userId'), b);
  return c.json({ ...D.projectView(p), myRole: 'owner' }, 201);
});

/**
 * Luồng sự kiện (Server-Sent Events) của một dự án: mỗi khi dữ liệu đổi (giao diện, MCP, nhập liệu…)
 * gửi event `changed`; client tải lại dự án. Gửi `ping` mỗi 25 giây để Cloudflare / Caddy không cắt kết nối rỗi.
 */
/**
 * Luồng sự kiện của người dùng: mọi thay đổi ở dự án mình được thấy (kể cả dự án vừa bị xoá).
 * Giao diện mở một kết nối ở khung trang: tải lại dữ liệu và báo ở góc màn hình khi AI sửa qua MCP — ở bất kỳ trang nào.
 */
auth.get('/events', async (c) => {
  const me = c.get('userId');
  return streamSSE(c, async (stream) => {
    let n = 0;
    const onChanged = async (projectId: string, actor: D.Actor | null, extra?: { deleted?: boolean; audience?: { name: string; userIds: string[] } | null }) => {
      try {
        const aud = extra?.audience !== undefined ? extra.audience : await D.projectAudience(projectId);
        if (!aud || !aud.userIds.includes(me) || stream.aborted) return;
        await stream.writeSSE({ event: 'changed', id: String(++n), data: JSON.stringify({ at: Date.now(), projectId, projectName: aud.name, deleted: !!extra?.deleted, ...D.actorPublic(actor) }) });
      } catch { /* kết nối đã đóng */ }
    };
    D.projectEvents.on('changed', onChanged);
    stream.onAbort(() => { D.projectEvents.off('changed', onChanged); });
    await stream.writeSSE({ event: 'hello', data: me });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
    }
    D.projectEvents.off('changed', onChanged);
  });
});

auth.get('/projects/:id/events', async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  return streamSSE(c, async (stream) => {
    let n = 0;
    const onChanged = (projectId: string, actor: D.Actor | null) => {
      if (projectId !== p.id) return;
      void stream.writeSSE({ event: 'changed', data: JSON.stringify({ at: Date.now(), ...D.actorPublic(actor) }), id: String(++n) });
    };
    D.projectEvents.on('changed', onChanged);
    stream.onAbort(() => { D.projectEvents.off('changed', onChanged); });
    await stream.writeSSE({ event: 'hello', data: p.id });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
    }
    D.projectEvents.off('changed', onChanged);
  });
});

auth.get('/projects/:id', async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  const [bundle, who] = await Promise.all([D.projectBundle(p.id), D.projectMembers(p)]);
  return c.json({ ...bundle, myRole: p.myRole, owner: who.owner, members: who.members });
});

auth.patch('/projects/:id', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, D.projectSchema.partial().extend({ aiContext: zText(20000).optional(), archived: z.boolean().optional(), exportColumns: z.array(z.enum(ALL_COLUMNS)).max(20).nullable().optional() }));
  if (b.archived !== undefined) D.owned(p);
  if (b.exportColumns) b.exportColumns = normalizeColumns(b.exportColumns) as typeof b.exportColumns;
  if (!Object.keys(b).length) return c.json(D.projectView(p));
  const row = await D.updateProject(p, b);
  return c.json({ ...D.projectView(row), myRole: p.myRole });
});

auth.delete('/projects/:id', requirePermission('project.project.delete'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.owned(p);
  await D.deleteProject(p.id);
  return c.json({ ok: true });
});

// ---- Google Sheets (đồng bộ một chiều app -> sheet)

auth.get('/google/status', (c) => c.json(sheetStatus()));

// ---- Getfly CRM (đồng bộ một chiều app -> Getfly bằng nút bấm)
auth.get('/getfly/status', (c) => c.json(getflyStatus()));
auth.get('/getfly/users', async (c) => c.json(await getflyUsers()));

/** Cấu hình Getfly của dự án: việc cha (dán link / id / mã), tên dự án Getfly, ghép tên người phụ trách -> username Getfly. */
auth.patch('/projects/:id/getfly', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({
    parent: z.string().trim().max(500).optional(),
    creatorId: z.string().trim().max(20).optional(),
    users: z.record(z.string().max(160), z.string().trim().max(120)).optional(),
  }));
  const patch: Record<string, unknown> = {};
  if (b.parent !== undefined) {
    if (!b.parent) Object.assign(patch, { getflyParentCode: '', getflyParentName: '', getflyParentId: null, getflyProjectId: '', getflyProjectName: '' });
    else {
      // Việc cha quyết định luôn dự án Getfly của các việc đẩy sang.
      const t = await findGetflyTask(b.parent);
      Object.assign(patch, { getflyParentCode: t.code, getflyParentName: t.name, getflyParentId: t.id, getflyProjectId: t.projectId, getflyProjectName: t.projectName });
    }
  }
  if (b.creatorId !== undefined) patch.getflyCreatorId = b.creatorId;
  if (b.users !== undefined) patch.getflyUsers = sql.json(Object.fromEntries(Object.entries(b.users).filter(([k, v]) => k.trim() && v)));
  if (!Object.keys(patch).length) throw new HTTPException(400, { message: 'Không có gì để sửa' });
  const row = await D.updateProject(p, patch);
  return c.json({ ...D.projectView(row), myRole: p.myRole, getflyLinks: await getflyLinkCount(p.id) });
});

/** Bấm "Đồng bộ Getfly": tạo / sửa / hoàn thành / xoá việc bên Getfly cho khớp dự án. */
auth.post('/projects/:id/getfly/sync', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  return c.json(await syncGetfly(p.id));
});
auth.get('/projects/:id/getfly', async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  return c.json({ ...getflyStatus(), links: await getflyLinkCount(p.id) });
});

/** Liên kết sheet có sẵn (dán link) / bật tự đồng bộ. Chủ dự án mới được đổi. */
auth.patch('/projects/:id/sheet', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.owned(p);
  const b = await body(c, z.object({ sheetUrl: z.string().trim().max(400).nullable().optional(), sheetAuto: z.boolean().optional() }));
  const patch: Record<string, unknown> = {};
  if (b.sheetUrl !== undefined) {
    if (b.sheetUrl === null || b.sheetUrl === '') Object.assign(patch, { sheetId: null, sheetSyncedAt: null, sheetError: null, sheetAuto: false });
    else {
      const id = parseSheetId(b.sheetUrl);
      if (!id) throw new HTTPException(400, { message: 'Không nhận ra link Google Sheet (dạng https://docs.google.com/spreadsheets/d/…)' });
      // Liên kết mới: bật tự đồng bộ luôn (mọi thay đổi, kể cả qua MCP, ghi sang sheet sau ~30 giây).
      Object.assign(patch, { sheetId: id, sheetError: null, sheetAuto: b.sheetAuto ?? true });
    }
  }
  if (b.sheetAuto !== undefined) patch.sheetAuto = b.sheetAuto;
  if (!Object.keys(patch).length) throw new HTTPException(400, { message: 'Không có gì để sửa' });
  const [row] = await sql<D.ProjectRow[]>`update projects set ${sql(patch)} where id = ${p.id} returning *`;
  return c.json({ ...D.projectView(row), myRole: p.myRole });
});

/** Đồng bộ ngay (ai được sửa dự án đều bấm được). */
auth.post('/projects/:id/sheet/sync', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const r = await syncProject(p.id);
  return c.json({ sheetUrl: r.url, sheetSyncedAt: r.syncedAt });
});

// ---- thành viên

const memberSchema = z.object({ email: z.email('Email không hợp lệ').max(200), role: z.enum(['editor', 'viewer']) });

auth.post('/projects/:id/members', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.owned(p);
  const b = await body(c, memberSchema);
  const r = await D.upsertMember(p, b.email, b.role, c.get('userId'));
  return c.json({ ok: true, ...r }, 201);
});

auth.patch('/projects/:id/members/:email', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.owned(p);
  const b = await body(c, z.object({ role: z.enum(['editor', 'viewer']) }));
  await D.setMemberRole(p, decodeURIComponent(c.req.param('email')), b.role);
  return c.json({ ok: true });
});

// Chủ dự án gỡ thành viên; thành viên tự rút bằng `me`.
auth.delete('/projects/:id/members/:email', async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  const u = c.get('user');
  const raw = decodeURIComponent(c.req.param('email')).toLowerCase();
  const email = raw === 'me' ? u.email.toLowerCase() : raw;
  if (raw !== 'me') {
    if (!c.get('permissions').has('project.project.write')) throw forbidden('Bạn chưa có quyền sửa thành viên dự án');
    D.owned(p);
  } else if (p.myRole === 'owner') throw new HTTPException(400, { message: 'Chủ dự án không rút được — hãy xoá dự án hoặc đổi chủ' });
  await D.removeMember(p, email, raw === 'me' ? u.id : undefined);
  return c.json({ ok: true });
});

// ---- nhóm việc

const groupSchema = z.object({ name: zText(160).min(1, 'Nhập tên nhóm') });

auth.post('/projects/:id/groups', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, groupSchema);
  return c.json(await D.createGroup(p.id, b.name), 201);
});

auth.patch('/projects/:id/groups/:gid', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, groupSchema.partial().extend({ collapsed: z.boolean().optional() }));
  if (!Object.keys(b).length) throw new HTTPException(400, { message: 'Không có gì để sửa' });
  return c.json(await D.updateGroup(p.id, param(c, 'gid'), b));
});

// ?keepTasks=1: giữ lại việc trong nhóm (chuyển thành "chưa phân nhóm"); mặc định xoá cả việc.
auth.delete('/projects/:id/groups/:gid', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  await D.deleteGroup(p.id, param(c, 'gid'), c.req.query('keepTasks') === '1');
  return c.json({ ok: true });
});

// ---- phạm vi (tag): ai sửa được dự án thì quản lý được phạm vi
auth.post('/projects/:id/scopes', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  // Không dùng default của scopeSchema: màu bỏ trống thì createScope tự xoay vòng bảng màu.
  const b = await body(c, z.object({ name: zText(80).min(1, 'Nhập tên phạm vi'), color: D.zColor.optional(), owner: zText(200).optional(), note: zText(1000).optional() }));
  return c.json(await D.createScope(p.id, b), 201);
});
auth.patch('/projects/:id/scopes/:sid', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({ name: zText(80).min(1).optional(), color: D.zColor.optional(), owner: zText(200).optional(), note: zText(1000).optional() }));
  return c.json(await D.updateScope(p.id, param(c, 'sid'), b));
});
auth.delete('/projects/:id/scopes/:sid', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  return c.json(await D.deleteScope(p.id, param(c, 'sid')));
});
auth.put('/projects/:id/scopes/order', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({ ids: z.array(zId).max(200) }));
  await D.reorderScopes(p.id, b.ids);
  return c.json({ ok: true });
});

auth.put('/projects/:id/groups/order', requirePermission('project.project.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({ ids: z.array(zId).max(500) }));
  await D.reorderGroups(p.id, b.ids);
  return c.json({ ok: true });
});

// ---- việc

auth.post('/projects/:id/tasks', requirePermission('project.task.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  return c.json(await D.insertTask(p.id, await body(c, D.taskCreate)), 201);
});

auth.patch('/projects/:id/tasks/:tid', requirePermission('project.task.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  return c.json(await D.updateTask(p.id, param(c, 'tid'), await body(c, D.taskFields.partial()), c.get('userId')));
});

auth.get('/projects/:id/tasks/:tid/history', async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  return c.json(await D.taskHistory(p.id, param(c, 'tid')));
});

auth.post('/projects/:id/tasks/:tid/rebaseline', requirePermission('project.task.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  return c.json(await D.rebaselineTask(p.id, param(c, 'tid'), c.get('userId')));
});

auth.delete('/projects/:id/tasks/:tid', requirePermission('project.task.delete'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  await D.deleteTask(p.id, param(c, 'tid'));
  return c.json({ ok: true });
});

auth.put('/projects/:id/tasks/order', requirePermission('project.task.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({ groupId: zId.nullable(), ids: z.array(zId).max(1000) }));
  await D.reorderTasks(p.id, b.groupId, b.ids);
  return c.json({ ok: true });
});

/** Sắp xếp việc theo ngày: body { groupId } cho một nhóm (null = chưa phân nhóm), bỏ trống = mọi nhóm. */
auth.post('/projects/:id/tasks/sort', requirePermission('project.task.write'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({ groupId: zId.nullable().optional() }));
  if (b.groupId) await D.groupBelongs(p.id, b.groupId);
  return c.json(await D.sortTasksByDate(p.id, b.groupId));
});

/** Nhập hàng loạt (dán từ bảng tính). */
auth.post('/projects/:id/import', requirePermission('project.data.import'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  D.editable(p);
  const b = await body(c, z.object({
    groups: z.array(z.object({ name: zText(160).nullable(), tasks: z.array(D.taskCreate.omit({ groupId: true })).max(2000) })).max(200),
  }));
  return c.json({ ok: true, ...(await D.importGroups(p.id, b.groups)) }, 201);
});

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

auth.get('/projects/:id/export', requirePermission('project.data.export'), async (c) => {
  const p = await D.projectOf(c.get('user'), param(c));
  const bundle = await D.projectBundle(p.id);
  const slug = p.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'du-an';
  if (c.req.query('format') === 'xlsx') {
    const [owner] = await sql<{ name: string; email: string }[]>`select name, email from users where id = ${p.ownerId}`;
    // ?cols=assignee,progress,... ghi đè lựa chọn lưu trong dự án (null = tất cả).
    const q = c.req.query('cols');
    const cols = q !== undefined ? q.split(',').map((x) => x.trim()).filter(isColKey) : p.exportColumns;
    const buf = await renderXlsx(buildPlanLayout(p, owner?.name || owner?.email || '', bundle.groups, bundle.tasks, D.effortOf, cols));
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="${slug}.xlsx"`);
    return c.body(new Uint8Array(buf));
  }
  if (c.req.query('format') === 'csv') {
    const groupName = new Map(bundle.groups.map((g) => [g.id, g.name]));
    const head = ['STT', 'Nhóm', 'Việc', 'Phụ trách', 'Hỗ trợ', 'Tiến độ (%)', 'Bắt đầu', 'Kết thúc', 'Ngày công', 'Ghi chú'];
    const rows = bundle.tasks.map((t, i) => [i + 1, t.groupId ? groupName.get(t.groupId) ?? '' : '', t.name, t.assignee, t.support, t.progress, t.startDate ?? '', t.endDate ?? '', t.days ?? '', t.note]);
    const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${slug}.csv"`);
    return c.body(csv);
  }
  c.header('Content-Disposition', `attachment; filename="${slug}.json"`);
  return c.json({ exportedAt: new Date().toISOString(), ...bundle });
});

// API dịch vụ cho VNLab Account — đăng ký TRƯỚC `auth` để middleware phiên
// người dùng (cookie) không chạy trên các route này.
app.route('/api/service/rbac', rbacService);
app.route('/api', auth);

// ---------------------------------------------------------------- static SPA

app.get('/healthz', (c) => c.text('ok'));
app.use('/assets/*', async (c, next) => {
  await next();
  if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
});
app.use('/*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/assets/') && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-cache');
});
app.use('/*', serveStatic({ root: './dist' }));
app.get('/assets/*', (c) => c.text('Not found', 404));
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Không tìm thấy' }, 404);
  let indexHtml: string;
  try {
    indexHtml = readFileSync('./dist/index.html', 'utf8');
  } catch {
    return c.text('Chưa build giao diện (npm run build)', 503);
  }
  c.header('Cache-Control', 'no-cache');
  return c.html(indexHtml);
});

// ---------------------------------------------------------------- boot

await migrate();
startAutoSync();
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => console.log(`[project] chạy ở :${PORT}`));
