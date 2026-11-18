// Đăng nhập VNLab ID (Logto) — dùng chung phiên với các app VNLab khác.
//
// Làm ở phía server (Authorization Code + PKCE) như Finance/Stock: đổi mã lấy
// id_token một lần, kiểm chữ ký bằng JWKS của Logto rồi cấp cookie phiên riêng.
// App Logto riêng "VNLab Project" (SPA, client công khai) — id do bootstrap của
// repo Account tạo, đặt vào PROJECT_LOGTO_APP_ID. Chỉ tài khoản có role
// `project:user`/`project:admin` mới được tạo phiên — cấp role ở
// https://account.vnlab.id.vn/admin.
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const LOGTO_ENDPOINT = (process.env.LOGTO_ENDPOINT ?? 'https://auth.vnlab.id.vn').replace(/\/$/, '');
export const LOGTO_APP_ID = process.env.PROJECT_LOGTO_APP_ID ?? 'project';
export const ACCOUNT_URL = 'https://account.vnlab.id.vn';

/** Role Logto cho phép dùng Project. */
export const PROJECT_ROLES = ['project:user', 'project:admin'] as const;
export const hasProjectRole = (roles: readonly string[]) => roles.some((r) => (PROJECT_ROLES as readonly string[]).includes(r));

/**
 * Kiểm lại role sau bao lâu: phiên mang mốc `rc` (lúc kiểm role gần nhất); quá
 * hạn thì API trả 401 `reauth` và trình duyệt đi một vòng SSO im lặng.
 */
export const ROLE_RECHECK_SECONDS = Math.max(60, Number(process.env.PROJECT_ROLE_RECHECK_HOURS ?? 12) * 3600 || 12 * 3600);
export function roleCheckFresh(session: { rc?: unknown; [k: string]: unknown }, nowSec = Math.floor(Date.now() / 1000)) {
  return typeof session.rc === 'number' && nowSec - session.rc < ROLE_RECHECK_SECONDS && session.rc <= nowSec + 60;
}

type Discovery = {
  issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; jwks_uri: string;
  end_session_endpoint: string;
};
let discovery: Promise<Discovery> | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function discover() {
  discovery ??= fetch(`${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration`)
    .then((r) => {
      if (!r.ok) throw new Error(`discovery ${r.status}`);
      return r.json() as Promise<Discovery>;
    })
    .catch((e) => {
      discovery = null; // lần sau thử lại
      throw e;
    });
  return discovery;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = () => b64url(randomBytes(32));
const challenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export async function authorizeUrl(p: { redirectUri: string; state: string; nonce: string; verifier: string; forceLogin?: boolean }) {
  const d = await discover();
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: LOGTO_APP_ID,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    // `roles`: Logto đưa claim `roles` (tên các role của người dùng) vào id_token/userinfo.
    scope: 'openid profile email roles',
    state: p.state,
    nonce: p.nonce,
    code_challenge: challenge(p.verifier),
    code_challenge_method: 'S256',
    ...(p.forceLogin ? { prompt: 'login' } : {}),
  }).toString();
  return u.toString();
}

export type SsoProfile = { sub: string; email: string | null; emailVerified: boolean; name: string; picture: string | null; idToken: string; roles: string[] };

export async function exchangeCode(p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<SsoProfile> {
  const d = await discover();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: LOGTO_APP_ID,
      code_verifier: p.verifier,
    }),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new Error(`đổi mã thất bại: ${res.status} ${tok.error_description ?? ''}`);

  jwks ??= createRemoteJWKSet(new URL(d.jwks_uri));
  const { payload } = await jwtVerify(tok.id_token, jwks, { issuer: d.issuer, audience: LOGTO_APP_ID });
  if (payload.nonce !== p.nonce) throw new Error('nonce không khớp');

  let claims: JWTPayload & Record<string, unknown> = payload;
  // Logto chỉ nhét email vào id_token khi được cấu hình; thiếu thì hỏi userinfo.
  // Role cũng vậy: id_token thiếu claim `roles` thì lấy từ userinfo (cùng scope `roles`).
  if ((!claims.email || !Array.isArray(claims.roles)) && tok.access_token) {
    const ui = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (ui.ok) {
      const info = (await ui.json()) as Record<string, unknown>;
      if (info.sub === payload.sub) claims = { ...payload, ...info };
    }
  }
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  return {
    sub: String(payload.sub),
    email,
    emailVerified: claims.email_verified !== false,
    name: String(claims.name ?? claims.username ?? '').trim(),
    picture: typeof claims.picture === 'string' && /^https:\/\//.test(claims.picture) ? claims.picture : null,
    idToken: tok.id_token,
    // Không đọc được role là coi như không có role nào — không cho vào.
    roles: Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : [],
  };
}

/** Kết thúc phiên Logto — đăng xuất Project là đăng xuất VNLab ID. */
export async function endSessionUrl(idToken: string | undefined, postLogoutRedirectUri: string) {
  const d = await discover();
  const u = new URL(d.end_session_endpoint);
  u.search = new URLSearchParams({
    client_id: LOGTO_APP_ID,
    post_logout_redirect_uri: postLogoutRedirectUri,
    ...(idToken ? { id_token_hint: idToken } : {}),
  }).toString();
  return u.toString();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Trang báo "chưa được cấp quyền" — trả thẳng HTML để không phụ thuộc app React (chưa có phiên). */
export function noAccessPage(p: { app: string; email?: string | null; logoutUrl: string }) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chưa được cấp quyền · VNLab ${esc(p.app)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f7fb;--card:#fff;--ink:#1b2a41;--muted:#5a6a80;--primary:#4274bc;--border:#dfe5ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1726;--card:#182434;--ink:#e8eef6;--muted:#a9b6c7;--primary:#8dbdf5;--border:#2a3a52}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:24px;padding:28px}
.eyebrow{margin:0;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
h1{margin:6px 0 12px;font-size:22px;line-height:1.25}p{margin:0 0 12px;color:var(--muted)}b{color:var(--ink)}
a.btn{display:flex;align-items:center;justify-content:center;height:46px;margin-top:12px;border-radius:14px;font-weight:700;text-decoration:none}
.primary{background:var(--primary);color:#fff}.ghost{border:1px solid var(--border);color:var(--ink)}
</style></head><body><main>
<p class="eyebrow">VNLab ID</p>
<h1>Tài khoản VNLab ID của bạn chưa được cấp quyền dùng ${esc(p.app)}</h1>
<p>${p.email ? `Bạn đang đăng nhập bằng <b>${esc(p.email)}</b>. ` : ''}Nhờ quản trị viên cấp quyền rồi đăng nhập lại.</p>
<a class="btn primary" href="${ACCOUNT_URL}">Mở VNLab Account</a>
<a class="btn ghost" href="${esc(p.logoutUrl)}">Đăng xuất để dùng tài khoản khác</a>
</main></body></html>`;
}
