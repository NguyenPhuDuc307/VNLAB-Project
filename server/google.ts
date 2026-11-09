// Google API bằng service account (không OAuth từng người): ký JWT RS256 bằng
// khoá trong GOOGLE_SERVICE_ACCOUNT_FILE (hoặc GOOGLE_SERVICE_ACCOUNT_JSON), đổi
// lấy access token (cache tới khi còn 60 giây), rồi gọi Sheets / Drive API.
// Người dùng chỉ cần Share sheet cho email của service account (quyền Editor).
// Các URL đổi được bằng biến môi trường để test với máy chủ giả.
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

export class GoogleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Sa = { client_email: string; private_key: string };
let sa: Sa | null | undefined;
let warned = false;

function loadSa(): Sa | null {
  if (sa !== undefined) return sa;
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (process.env.GOOGLE_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8') : '');
    const j = raw ? (JSON.parse(raw) as Partial<Sa>) : null;
    sa = j?.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
  } catch (err) {
    sa = null;
    if (!warned) { warned = true; console.warn('[google] không đọc được service account:', (err as Error).message); }
  }
  return sa;
}
/** Cho test: nạp lại cấu hình. */
export const resetGoogle = () => { sa = undefined; token = null; };

export const googleConfigured = () => !!loadSa();
export const serviceAccountEmail = () => loadSa()?.client_email ?? null;

const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
export const SHEETS_API = () => (process.env.GOOGLE_SHEETS_API ?? 'https://sheets.googleapis.com/v4').replace(/\/$/, '');
export const DRIVE_API = () => (process.env.GOOGLE_DRIVE_API ?? 'https://www.googleapis.com/drive/v3').replace(/\/$/, '');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];

let token: { value: string; exp: number } | null = null;

export async function googleToken(): Promise<string> {
  const cfg = loadSa();
  if (!cfg) throw new GoogleError(503, 'Chưa cấu hình Google service account (GOOGLE_SERVICE_ACCOUNT_FILE)');
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const key = await importPKCS8(cfg.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPES.join(' ') })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(cfg.client_email).setSubject(cfg.client_email).setAudience(TOKEN_URL())
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new GoogleError(502, `Không lấy được token Google: ${res.status} ${body.error_description ?? body.error ?? ''}`.trim());
  token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

/** Gọi Google API: thêm Bearer, đọc JSON, đổi lỗi Google thành thông báo tiếng Việt dễ hiểu. */
export async function gfetch<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const t = await googleToken();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal, headers: { authorization: `Bearer ${t}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  } catch (err) {
    throw new GoogleError(504, `Không kết nối được Google: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } } | null)?.error?.message ?? `Google trả ${res.status}`;
    if (/not supported for this document|Office|\.xlsx/i.test(msg)) throw new GoogleError(400, 'File này là Excel (.xlsx) mở trong Google Sheets, không phải Google Sheet gốc. Trong Google Sheets chọn Tệp → Lưu dưới dạng Google Trang tính, rồi dán link bản mới.');
    if (res.status === 403) throw new GoogleError(403, `Google từ chối (${msg}). Sheet đã Share quyền Người chỉnh sửa cho ${serviceAccountEmail() ?? 'service account'} chưa? (Service account không tự tạo file được — sheet phải do bạn tạo.)`);
    if (res.status === 404) throw new GoogleError(404, 'Không tìm thấy Google Sheet — kiểm tra lại đường dẫn, hoặc sheet chưa Share cho service account');
    throw new GoogleError(502, `Google lỗi ${res.status}: ${msg}`);
  }
  return data as T;
}
