import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, LogoTile, Splash } from '../components/ui';
import { api, type User } from '../lib/api';

export const PRIVACY_URL = 'https://vnlab.id.vn/chinh-sach-bao-mat';
export const TERMS_URL = 'https://vnlab.id.vn/dieu-khoan';

const linkCls = 'font-medium text-ink-2 underline underline-offset-2 hover:text-ink';
export const PolicyLinks = () => (
  <>
    <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>Chính sách bảo mật</a> và{' '}
    <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>Điều khoản sử dụng</a>
  </>
);

const FEATURES: [string, string][] = [
  ['Gantt theo ngày', '#4274BC'],
  ['Nhóm việc', '#A5D8FF'],
  ['Tiến độ', '#6E9EDC'],
  ['Chia sẻ dự án', '#1B2A41'],
];

/** Khung màn đăng nhập theo poster VNLab Ecosystem: nhãn VNLAB / ECOSYSTEM, chữ "Project" cỡ lớn, vệt màu tròn ở góc. */
function Shell({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] md:px-12 md:pb-10 md:pt-10">
      <span aria-hidden className="pointer-events-none absolute -right-44 -top-52 -z-0 h-[400px] w-[400px] rounded-full md:-right-24 md:-top-64 md:h-[820px] md:w-[820px]" style={{ background: 'var(--blob-1)' }} />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
        <span className="eyebrow text-ink">VNLab / Ecosystem</span>
        <span className="text-[13px] font-semibold tracking-[0.06em] text-primary">project.vnlab.id.vn</span>
      </header>

      <main className="relative mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-7 py-7 md:grid-cols-[1.15fr_1fr] md:gap-16 md:py-12">
        <section className={compact ? 'flex items-center gap-4 md:block' : ''}>
          <LogoTile className={compact ? 'h-14 w-14 rounded-full md:hidden' : 'mb-6 h-[72px] w-[72px] rounded-full md:hidden'} logoClassName={compact ? 'h-10 w-10' : 'h-12 w-12'} />
          <div>
            <p className={compact ? 'display text-[34px] md:text-[104px]' : 'display text-[60px] md:text-[104px]'}>Project</p>
            <p className={compact ? 'mt-1 text-[15px] font-medium text-ink-2 md:mt-5 md:text-[26px]' : 'mt-3 text-[19px] font-medium leading-snug text-ink-2 md:mt-5 md:text-[26px]'}>
              Lên kế hoạch. Về đích đúng hẹn.
            </p>
          </div>
          <ul className={compact ? 'mt-10 hidden flex-wrap gap-x-6 gap-y-2 md:flex' : 'mt-6 flex flex-wrap gap-x-4 gap-y-2 md:mt-12 md:gap-x-7'}>
            {FEATURES.map(([label, color]) => (
              <li key={label} className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2 md:text-[15px]">
                <span className="h-2.5 w-2.5 rounded-full md:h-3 md:w-3" style={{ background: color === '#1B2A41' ? 'var(--ink)' : color }} />
                {label}
              </li>
            ))}
          </ul>
        </section>

        <section className="liquid-glass relative w-full rounded-[30px] p-6 sm:p-8 md:max-w-[440px] md:justify-self-end md:p-9">
          <LogoTile className="mb-7 hidden h-20 w-20 rounded-full md:flex" logoClassName="h-14 w-14" />
          {children}
        </section>
      </main>

      <footer className="relative mx-auto flex w-full max-w-6xl items-end justify-between gap-6">
        <p className="max-w-xl text-[12px] leading-relaxed text-muted">Khi dùng VNLab Project, bạn đồng ý với <PolicyLinks />.</p>
        <p className="hidden shrink-0 text-[15px] font-bold text-ink md:block">VNLab / Project</p>
      </footer>
    </div>
  );
}

const alertCls = 'mb-4 rounded-[20px] border border-danger/25 bg-danger-soft px-4 py-3 text-sm font-medium text-danger';
const ssoUrl = () => `/api/auth/sso/start?next=${encodeURIComponent(location.pathname + location.search)}`;

export function Login() {
  const qc = useQueryClient();
  const [ssoError] = useState(() => new URLSearchParams(location.search).get('sso_error'));
  const [loggedOut] = useState(() => new URLSearchParams(location.search).has('logged_out'));
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ devLogin: boolean }>('/auth/status'), staleTime: Infinity });
  // Phiên Logto dùng chung hệ sinh thái: đã đăng nhập app khác thì chuyển thẳng
  // qua Logto (nó trả về ngay). Không tự chuyển khi vừa đăng xuất / vừa lỗi /
  // máy dev không có Logto, kẻo bị đá vòng lặp.
  const auto = !ssoError && !loggedOut && status.data?.devLogin === false;
  const [err, setErr] = useState<string | undefined>(ssoError ?? undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auto) location.replace(ssoUrl());
    if (ssoError || loggedOut) history.replaceState(null, '', location.pathname);
  }, [auto, ssoError, loggedOut]);

  const devLogin = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api('/auth/dev-login', { method: 'POST', body: {} });
      qc.setQueryData(['me'], await api<User>('/me'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (status.isPending || auto) return <Splash />;

  return (
    <Shell>
      <p className="eyebrow text-primary">Đăng nhập</p>
      <h1 className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight">Kế hoạch dự án</h1>
      <p className="mb-6 mt-1.5 text-[15px] leading-relaxed text-muted">Lên kế hoạch, giao việc và theo dõi tiến độ cùng cả nhóm.</p>

      {loggedOut && !err && <p className="mb-4 rounded-[20px] border border-line bg-card px-4 py-3 text-sm text-ink-2">Đã đăng xuất.</p>}
      {err && <p role="alert" className={alertCls}>{err}</p>}

      <Button block size="lg" onClick={() => location.assign(ssoUrl())}>Đăng nhập bằng VNLab ID</Button>
      <p className="mt-2.5 text-center text-[13px] text-muted">Dùng chung tài khoản với các ứng dụng VNLab khác.</p>
      {status.data?.devLogin && (
        <Button block variant="secondary" className="mt-5" onClick={devLogin} disabled={busy}>{busy ? 'Đang vào…' : 'Vào bằng tài khoản dev (máy này)'}</Button>
      )}
    </Shell>
  );
}

/** Hỏi đồng ý một lần: lần vào đầu tiên và mỗi khi chính sách đổi phiên bản. */
export function Consent({ user }: { user: User }) {
  const qc = useQueryClient();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      qc.setQueryData(['me'], { ...user, ...(await api<User>('/me/consent', { method: 'POST', body: { version: user.policyVersion } })) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell compact>
      <form onSubmit={submit}>
        <p className="eyebrow text-primary">Quyền riêng tư</p>
        <h1 className="mt-2 text-[24px] font-extrabold leading-tight tracking-tight">{user.consentAt ? 'Chính sách đã được cập nhật' : 'Trước khi bắt đầu'}</h1>
        <div className="mb-5 mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
          <p>VNLab lưu những gì bạn nhập (dự án, việc, người được mời) cùng email, tên và ảnh từ VNLab ID.</p>
          <p>Dữ liệu chỉ dùng để chạy ứng dụng, không quảng cáo, không bán cho ai.</p>
          <p>Bạn có thể tải dữ liệu hoặc xoá tài khoản trong Cài đặt.</p>
        </div>
        <label className="mb-4 flex items-start gap-2.5 text-[13px] leading-snug text-ink-2">
          <input type="checkbox" required checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
          <span>Tôi đã đọc và đồng ý với <PolicyLinks />, gồm việc VNLab lưu dự án, việc và người được mời để vận hành ứng dụng.</span>
        </label>
        {err && <p role="alert" className={alertCls}>{err}</p>}
        <Button type="submit" block size="lg" disabled={!agree || busy}>{busy ? 'Đang lưu…' : 'Đồng ý và tiếp tục'}</Button>
        <a href="/api/auth/logout" className="mt-4 block text-center text-sm font-semibold text-ink-2 hover:text-ink">Không đồng ý, đăng xuất</a>
      </form>
    </Shell>
  );
}
