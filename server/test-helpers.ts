// Dụng cụ chung cho test tích hợp: Logto giả, Postgres trong bộ nhớ (PGlite) và
// chạy server thật bằng `node server/index.ts`. Không phải file test.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const APP_ID = 'test-project-app';
export const JWT_SECRET = 'secret-cho-test-sso-roles-project-dai-hon-32-ky-tu';

/** Logto giả: discovery, JWKS, token (roles trong id_token hoặc chỉ trong userinfo), userinfo. */
export async function fakeLogto() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const tokens = new Map<string, { sub: string; roles: string[] }>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url!, base);
    if (url.pathname === '/oidc/.well-known/openid-configuration') {
      return json({ issuer: `${base}/oidc`, authorization_endpoint: `${base}/oidc/auth`, token_endpoint: `${base}/oidc/token`, userinfo_endpoint: `${base}/oidc/me`, jwks_uri: `${base}/oidc/jwks`, end_session_endpoint: `${base}/oidc/session/end` });
    }
    if (url.pathname === '/oidc/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/oidc/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      // Mã đăng nhập giả mang kịch bản: "<sub>|<roles,...>|<idtoken|userinfo>|<nonce>".
      const [sub, roleList, where, nonce] = (form.get('code') ?? '').split('|');
      const roles = roleList ? roleList.split(',') : [];
      const at = `at-${sub}-${Math.random()}`;
      tokens.set(at, { sub, roles });
      const idToken = await new SignJWT({ nonce, email: `${sub}@x.vn`, name: `Tên ${sub}`, ...(where === 'idtoken' ? { roles } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`${base}/oidc`).setAudience(form.get('client_id')!).setSubject(sub)
        .setIssuedAt().setExpirationTime('1h').sign(privateKey);
      return json({ id_token: idToken, access_token: at });
    }
    if (url.pathname === '/oidc/me') {
      const t = tokens.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
      return t ? json({ sub: t.sub, email: `${t.sub}@x.vn`, roles: t.roles }) : json({ error: 'invalid_token' }, 401);
    }
    json({ error: 'not found' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

export async function freePort() {
  const r = createNetServer();
  r.listen(0, '127.0.0.1');
  await once(r, 'listening');
  const port = (r.address() as { port: number }).port;
  await new Promise<void>((resolve) => r.close(() => resolve()));
  return port;
}

export const cookieOf = (res: Response, name: string) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (pair.slice(0, i) === name) return pair.slice(i + 1);
  }
  return undefined;
};

/** Postgres trong bộ nhớ, nói giao thức Postgres qua socket để server thật nối vào. */
export async function memoryDb() {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await socket.start();
  return {
    db, url: `postgres://postgres:postgres@${socket.getServerConn()}/postgres`,
    async close() { await socket.stop(); await db.close(); },
  };
}

/** Chạy `node server/index.ts` tới khi in dòng "chạy ở". */
export async function startServer(env: Record<string, string>) {
  const port = await freePort();
  const proc: ChildProcess = spawn(process.execPath, ['server/index.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), PROJECT_DB_POOL: '1', PROJECT_JWT_SECRET: JWT_SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stderr!.on('data', (chunk) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (chunk) => { output += chunk; if (output.includes('[project] chạy ở')) resolve(); });
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    async stop() {
      proc.kill();
      await once(proc, 'exit').catch(() => undefined);
    },
  };
}

/** Đăng nhập VNLab ID qua Logto giả; trả nơi chuyển tới và cookie phiên (nếu có). */
export async function ssoLogin(base: string, sub: string, roles: string[], where: 'idtoken' | 'userinfo') {
  const start = await fetch(`${base}/api/auth/sso/start?next=/du-an`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.searchParams.get('client_id'), APP_ID);
  assert.match(authorize.searchParams.get('scope')!, /\broles\b/);
  const code = [sub, roles.join(','), where, authorize.searchParams.get('nonce')].join('|');
  const cb = await fetch(`${base}/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie: `prj_sso=${cookieOf(start, 'prj_sso')}` },
  });
  assert.equal(cb.status, 302);
  return { location: cb.headers.get('location'), session: cookieOf(cb, 'prj_session') || null, res: cb };
}
