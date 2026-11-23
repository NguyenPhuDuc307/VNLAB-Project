import { ArrowSquareOut, CaretRight, Copy, DownloadSimple, Palette, Plug, Robot, ShieldCheck, SignOut, Trash, UserCircle, type Icon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { Button, Chip, Field, Input, PageHeader, Segmented, Sheet, applyTheme, cx, readTheme, useFeedback, type Theme } from '../components/ui';
import { api, useAction, useCan, useMe, type ApiToken, type McpTool, type User } from '../lib/api';
import { PolicyLinks } from './Login';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const ACCOUNT_URL = 'https://account.vnlab.id.vn';
const THEME_LABEL: Record<Theme, string> = { system: 'Theo máy', light: 'Sáng', dark: 'Tối' };

export function Settings() {
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const u = me.data!;
  const [name, setName] = useState(u.name);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [del, setDel] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const saveName = useAction((n: string) => api<User>('/me', { method: 'PATCH', body: { name: n } }), { onSuccess: (r) => { qc.setQueryData(['me'], { ...u, ...r }); toast('Đã lưu tên'); } });
  const remove = useAction(() => api('/me/delete', { method: 'POST', body: { confirm: confirmText } }), { onSuccess: () => { location.assign('/api/auth/logout'); } });

  return (
    <div className="mx-auto max-w-2xl space-y-5 pb-4">
      <PageHeader title="Cài đặt" sub="Tài khoản, giao diện và kết nối AI" />

      {/* Danh sách gọn theo nhóm, mỗi mục mặc định đóng: bấm mục nào mở mục đó. */}
      <SettingsGroup label="Tài khoản">
        <SettingsSection title="Hồ sơ" hint={u.email} icon={UserCircle} tone="primary">
          <form onSubmit={(e) => { e.preventDefault(); saveName.mutate(name.trim()); }}>
            <Field label="Tên hiển thị" hint={can('project.settings.write') ? 'Tên này hiện ở dự án và gợi ý ô Phụ trách' : 'Bạn chưa có quyền đổi tên'}>
              <div className="flex gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!can('project.settings.write')} />
                <Button type="submit" variant="secondary" disabled={!can('project.settings.write') || saveName.isPending || name.trim() === u.name || !name.trim()} className="h-11 shrink-0">Lưu</Button>
              </div>
            </Field>
          </form>
          <p className="text-[13px] text-muted">Email <b className="break-all text-ink">{u.email}</b>. Đổi email, mật khẩu ở VNLab Account.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{u.roles.map((r) => <Chip key={r} tone="primary">{r}</Chip>)}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => window.open(ACCOUNT_URL, '_blank', 'noopener')}><ArrowSquareOut size={16} /> Mở VNLab Account</Button>
          </div>
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup label="Ứng dụng">
        <SettingsSection title="Giao diện" hint={`Chủ đề: ${THEME_LABEL[theme]}`} icon={Palette} tone="violet">
          <Field label="Chủ đề" group>
            <Segmented value={theme} onChange={(t) => { setTheme(t); applyTheme(t); }} options={[{ value: 'system', label: 'Theo máy' }, { value: 'light', label: 'Sáng' }, { value: 'dark', label: 'Tối' }]} />
          </Field>
        </SettingsSection>
        {can('project.tokens.manage') && (
          <SettingsSection title="AI bên ngoài (MCP)" hint="Token cho Claude, Codex… sửa dự án" icon={Robot} tone="ok">
            <McpCard />
          </SettingsSection>
        )}
      </SettingsGroup>

      <SettingsGroup label="Dữ liệu">
        <SettingsSection title="Quyền riêng tư" hint="Tải dữ liệu, xoá tài khoản" icon={ShieldCheck} tone="slate">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Dữ liệu của bạn chỉ dùng để chạy VNLab Project. Bạn đã đồng ý <PolicyLinks /> {u.consentAt ? `lúc ${new Date(u.consentAt).toLocaleString('vi-VN')}` : ''} (bản {u.policyVersion}).
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {can('project.data.export') && <Button variant="secondary" onClick={() => location.assign('/api/me/export')}><DownloadSimple size={16} /> Tải toàn bộ dữ liệu (JSON)</Button>}
            <Button variant="danger" onClick={() => setDel(true)}><Trash size={16} /> Xoá tài khoản Project</Button>
          </div>
        </SettingsSection>
      </SettingsGroup>

      {/* Đăng xuất kết thúc phiên: đứng riêng ở cuối trang để không bấm nhầm. */}
      <Button variant="secondary" block className="h-11" onClick={() => location.assign('/api/auth/logout')}><SignOut size={16} /> Đăng xuất</Button>

      <Sheet
        open={del}
        onClose={() => setDel(false)}
        title="Xoá tài khoản Project?"
        footer={<div className="flex gap-2"><Button variant="secondary" block onClick={() => setDel(false)}>Huỷ</Button><Button variant="danger" block disabled={confirmText.trim().toLowerCase() !== u.email.toLowerCase() || remove.isPending} onClick={() => remove.mutate(undefined)}>Xoá vĩnh viễn</Button></div>}
      >
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>Mọi dự án bạn tạo sẽ bị xoá, bạn rời các dự án được mời. Tài khoản VNLab ID vẫn còn.</p>
          <p>Gõ email <b className="text-ink">{u.email}</b> để xác nhận.</p>
        </div>
        <Input className="mt-3" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={u.email} autoCapitalize="none" />
      </Sheet>
    </div>
  );
}

/* Màu ô biểu tượng: nền pha ~12% của màu nhấn. Dùng token của app (primary, ok,
   warning, danger) để tự đổi theo chủ đề sáng/tối; violet là màu tầm trung đọc
   được trên cả hai nền. */
const TONES = {
  primary: 'bg-primary/12 text-primary',
  ok: 'bg-ok/12 text-ok',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  violet: 'bg-violet-500/12 text-violet-500',
  slate: 'bg-fill-2 text-ink-2',
} as const;

/** Một nhóm mục cài đặt: nhãn nhỏ phía trên, các dòng chung một khung, ngăn bằng đường kẻ. */
function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="overflow-hidden rounded-xl border border-line bg-card shadow-[var(--shadow)] [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
    </div>
  );
}

/**
 * Một dòng cài đặt thu gọn được, MẶC ĐỊNH ĐÓNG: trang mở ra chỉ là danh sách
 * tiêu đề, cần mục nào thì bấm mục đó để mở nội dung ngay bên dưới.
 */
function SettingsSection({ title, hint, icon: Ico, tone = 'primary', children }: {
  title: string;
  hint?: string;
  icon: Icon;
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-fill"
      >
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-[10px]', TONES[tone])}><Ico size={19} weight="duotone" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-tight">{title}</span>
          {hint && <span className="mt-0.5 block truncate text-xs text-muted">{hint}</span>}
        </span>
        <CaretRight size={16} weight="bold" className={cx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="min-w-0 border-t border-line bg-fill/50 p-4">{children}</div>}
    </section>
  );
}

const timeAgo = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 48 * 60) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
};

/** Token MCP cho AI bên ngoài (Claude Code, Codex, Claude Desktop…): tạo, thu hồi, hướng dẫn cấu hình. */
function McpCard() {
  const { toast, confirm } = useFeedback();
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ token: string; url: string; name: string } | null>(null);
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<ApiToken[]>('/tokens') });
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: () => api<{ url: string; tools: McpTool[] }>('/mcp/tools'), staleTime: Infinity });
  const create = useAction((n: string) => api<{ token: string; url: string; name: string }>('/tokens', { method: 'POST', body: { name: n } }), { onSuccess: (r) => { setFresh(r); setName(''); } });
  const revoke = useAction((id: string) => api(`/tokens/${id}`, { method: 'DELETE' }), { onSuccess: () => toast('Đã thu hồi token') });
  const del = async (t: ApiToken) => {
    if (await confirm({ title: 'Thu hồi token?', desc: <p>AI đang dùng <b>{t.name}</b> sẽ mất kết nối ngay.</p>, ok: 'Thu hồi', danger: true })) revoke.mutate(t.id);
  };
  const url = tools.data?.url ?? `${location.origin}/mcp`;
  return (
    <>
      <div>
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Cho Claude, Codex… tạo và sửa việc trong dự án của bạn. Địa chỉ: <code className="break-all rounded bg-fill-2 px-1.5 py-0.5 text-[12.5px]">{url}</code>
        </p>
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); create.mutate(name.trim() || 'MCP client'); }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên token, VD: Claude Desktop ở máy nhà" maxLength={80} className="h-10" />
          <Button type="submit" disabled={create.isPending} className="h-10 shrink-0"><Plug size={16} /> Tạo token</Button>
        </form>
        {tokens.data && tokens.data.length > 0 && (
          <ul className="mt-3 divide-y divide-line">
            {tokens.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-[13.5px]">
                <span className="min-w-0 flex-1 truncate font-semibold">{t.name}</span>
                <span className="shrink-0 text-[12px] text-muted">{t.lastUsedAt ? `dùng ${timeAgo(t.lastUsedAt)}` : 'chưa dùng'} · tạo {timeAgo(t.createdAt)}</span>
                <Button variant="ghost" size="sm" onClick={() => del(t)} className="text-danger">Thu hồi</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Sheet open={!!fresh} onClose={() => setFresh(null)} title="Token MCP mới" wide>
        {fresh && <TokenHelp token={fresh.token} url={fresh.url} />}
      </Sheet>
    </>
  );
}

function TokenHelp({ token, url }: { token: string; url: string }) {
  const { toast } = useFeedback();
  const blocks = [
    { label: 'Token (chỉ hiện một lần — chép ngay)', code: token },
    { label: 'Claude Code', code: `claude mcp add --transport http vnlab-project ${url} --header "Authorization: Bearer ${token}"` },
    { label: 'Codex (~/.codex/config.toml)', code: `[mcp_servers.vnlab-project]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }` },
    { label: 'Claude Desktop / client khác (JSON)', code: JSON.stringify({ mcpServers: { 'vnlab-project': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
  ];
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('Đã chép'); } catch { toast('Không chép được — chọn và sao chép tay', 'error'); } };
  return (
    <div className="space-y-3 pb-2">
      <p className="text-[13.5px] text-danger">Ai có token này sửa được mọi dự án của bạn. Đừng gửi cho người khác.</p>
      {blocks.map((b) => (
        <div key={b.label}>
          <div className="mb-1 flex items-center justify-between text-[12px] font-semibold text-muted">
            <span>{b.label}</span>
            <button type="button" onClick={() => copy(b.code)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-primary-soft"><Copy size={13} /> Chép</button>
          </div>
          <pre className="overflow-x-auto rounded-xl bg-fill p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-all">{b.code}</pre>
        </div>
      ))}
      <p className="text-[12.5px] text-muted">Thử: "Liệt kê dự án của tôi", "Thêm việc <i>Viết tài liệu hướng dẫn</i> vào nhóm Kiểm thử, An phụ trách, 14–21/3", "Việc nào quá hạn?".</p>
    </div>
  );
}
