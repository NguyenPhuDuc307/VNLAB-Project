import { CalendarBlank, CheckCircle, DotsThree, WarningCircle, X } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { initials } from '../lib/api';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

// ------------------------------------------------------------------ Button

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
};
export function Button({ variant = 'primary', size = 'md', block, className, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        // Viên thuốc như nút VNLab Home: màu phẳng, không gradient, không bóng phát sáng.
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap [&_svg]:shrink-0',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-[15px]',
        variant === 'primary' && 'bg-primary text-on-primary shadow-[var(--shadow-xs)] hover:brightness-110',
        variant === 'secondary' && 'bg-fill text-ink hover:bg-fill-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-fill',
        variant === 'danger' && 'bg-danger-soft text-danger hover:brightness-95',
        block && 'w-full',
        className,
      )}
    />
  );
}

export function IconButton({ label, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-2 transition hover:bg-fill active:scale-95 disabled:opacity-40 disabled:pointer-events-none', className)}
    />
  );
}

/** Nút "⋯" mở menu các thao tác ít dùng (thay cho một hàng nút icon rời). */
export function MoreButton({ label = 'Thêm thao tác', items, title, className, size = 18 }: { label?: string; items: () => MenuItem[]; title?: string; className?: string; size?: number }) {
  const [menu, setMenu] = useState<MenuState>(null);
  return (
    <>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={!!menu} className={className}
        onClick={(e) => {
          if (menu) { setMenu(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          const list = items();
          if (list.length) setMenu({ x: r.left, y: r.bottom + 6, items: list, title });
        }}>
        <DotsThree size={size} weight="bold" />
      </IconButton>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </>
  );
}

/** Tiêu đề một phần trong sheet/form: chữ nhỏ in hoa + vạch mảnh (thay cho khung lồng khung). */
export function SectionLabel({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 flex items-center gap-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted', className)}>
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-line" />
      {action && <span className="shrink-0 normal-case tracking-normal">{action}</span>}
    </div>
  );
}

/** Chấm bước của sheet nhiều bước (như Đặt lịch bên VNLab Home). */
export function StepDots({ step, total, titles }: { step: number; total: number; titles?: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1" role="img" aria-label={`Bước ${step}/${total}${titles?.[step - 1] ? ` · ${titles[step - 1]}` : ''}`}>
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <span key={n} className={cx('h-1.5 rounded-full transition-all', n === step ? 'w-4 bg-primary' : n < step ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-fill-2')} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ Sheet

function useVisualViewport(active: boolean) {
  const [vp, setVp] = useState<{ top: number; height: number; keyboard: boolean } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const update = () => setVp({ top: vv.offsetTop, height: vv.height, keyboard: window.innerHeight - vv.height > 120 });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return vp;
}

/** Bảng trượt từ đáy (điện thoại) / hộp thoại giữa màn (máy tính). */
/**
 * `side`: từ md trở lên là ngăn trượt từ cạnh phải, cao hết màn hình (form dài
 * như Sửa việc); điện thoại vẫn là bottom sheet như mọi Sheet khác.
 */
export function Sheet({ open, onClose, title, children, footer, wide, side }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; side?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const vp = useVisualViewport(open);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className={cx('fixed inset-x-0 top-0 z-50 flex h-dvh items-end justify-center', side ? 'md:items-stretch md:justify-end' : 'md:items-center md:p-6')} style={vp ? { top: vp.top, height: vp.height } : undefined}>
      <div className="anim-fade absolute inset-0 bg-[#0b1521]/45" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cx(
          'relative flex min-h-0 max-h-[92%] w-full flex-col overflow-hidden rounded-t-[28px] border border-line bg-surface shadow-[var(--shadow-lg)] outline-none focus-visible:outline-none',
          side ? 'anim-drawer md:h-full md:max-h-full md:max-w-[760px] md:rounded-none md:rounded-l-[28px] md:border-y-0 md:border-r-0' : 'anim-sheet md:rounded-[28px]',
          vp?.keyboard && 'max-h-full rounded-t-none',
          !side && (wide ? 'md:max-w-2xl' : 'md:max-w-lg'),
        )}
      >
        <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-fill-2 md:hidden" />
        <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 px-5 pb-2 pt-3 md:pt-5">
          <h2 className="min-w-0 flex-1 text-[17px] font-bold tracking-tight">{title}</h2>
          <IconButton label="Đóng" onClick={onClose} className="-mr-2 !h-10 !w-10"><X size={20} /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer && <div className={cx('shrink-0 px-5 pt-3', !vp?.keyboard && 'pb-safe')}><div className="pb-4">{footer}</div></div>}
        {!footer && !vp?.keyboard && <div className="shrink-0 pb-safe" />}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ Form

export function Field({ label, children, hint, error, group, className }: { label: string; children: ReactNode; hint?: ReactNode; error?: string; group?: boolean; className?: string }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={cx('mb-4 block min-w-0', className)}>
      <span className="mb-1.5 block px-1 text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block px-1 text-[13px] text-danger">{error}</span> : hint ? <span className="mt-1 block px-1 text-[13px] text-muted">{hint}</span> : null}
    </Tag>
  );
}

// Ô nhập viên thuốc như VNLab Home; ô nhiều dòng (Textarea) bo 20px.
export const inputCls = 'h-11 w-full rounded-full border border-line bg-card px-4 text-[16px] outline-none transition focus:border-primary focus:ring-3 focus:ring-primary/20 placeholder:text-muted disabled:bg-fill disabled:text-muted';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

/** Ô ngày: hiện dd/mm/yyyy, ô <input type="date"> gốc trong suốt phủ lên để vẫn mở bộ chọn của máy. */
export function DateInput({ value, onChange, optional, placeholder = 'Chọn ngày', min, max }: {
  value: string; onChange: (v: string) => void; optional?: boolean; placeholder?: string; min?: string; max?: string;
}) {
  const shown = value ? value.split('-').reverse().join('/') : '';
  return (
    <div className={cx(inputCls, 'relative flex min-w-0 items-center gap-2 focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/20')}>
      <span className={cx('num min-w-0 flex-1 truncate', !value && 'text-muted')}>{shown || placeholder}</span>
      {optional && value ? (
        <button type="button" aria-label="Xoá ngày" onClick={() => onChange('')} className="relative z-10 -mr-1.5 grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink"><X size={16} /></button>
      ) : (
        <CalendarBlank size={18} className="hidden shrink-0 text-muted min-[360px]:block" aria-hidden />
      )}
      <input type="date" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" style={{ right: optional && value ? 40 : 0 }} />
    </div>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  // Bỏ h-11 của ô một dòng: để chung với h-auto thì Tailwind v4 cho h-11 thắng,
  // ô nào cũng bẹp 44px và `rows` bị bỏ qua.
  return <textarea rows={2} {...props} className={cx(inputCls.replace('h-11 ', '').replace('rounded-full', 'rounded-[20px]'), 'resize-none py-3', props.className)} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, 'select-chevron appearance-none pr-10', className)} />;
}

export function Segmented<T extends string>({ options, value, onChange, className, size = 'md' }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className={cx('flex rounded-full bg-fill p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-full font-semibold transition whitespace-nowrap',
            size === 'md' ? 'h-8 px-3.5 text-[13px]' : 'h-7 px-3 text-[12px]',
            o.value === value ? 'bg-surface text-ink shadow-[var(--shadow-xs)]' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  const id = useId();
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-[15px] font-medium">{label}</span>
        {desc && <span className="block text-[13px] text-muted">{desc}</span>}
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cx('relative h-7 w-12 shrink-0 rounded-full transition', checked ? 'bg-primary' : 'bg-fill-2')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Display

export function ProgressBar({ value, color, size = 'md', className }: { value: number; color?: string; size?: 'sm' | 'md'; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cx('w-full overflow-hidden rounded-full bg-fill', size === 'sm' ? 'h-1.5' : 'h-2', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--ok)' : color ?? 'var(--primary)' }} />
    </div>
  );
}

export function Empty({ icon, title, desc, action }: { icon: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-primary">{icon}</div>
      <p className="font-semibold">{title}</p>
      {desc && <p className="mt-1 max-w-xs text-sm text-muted">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-6', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex items-baseline justify-between gap-3 px-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-[20px] bg-fill', className)} />;
}

/** Tiêu đề trang như VNLab Home: tiêu đề lớn, một dòng phụ, nút bên phải. Thương
 *  hiệu đã có ở thanh bên/thanh trên nên không lặp nhãn "VNLab / Project"; `eyebrow`
 *  chỉ dùng khi có thông tin riêng (VD: mã dự án). */
export function PageHeader({ title, sub, action, eyebrow }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; eyebrow?: string }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1 text-primary">{eyebrow}</p>}
        <h1 className="text-[28px] font-bold leading-tight tracking-tight md:text-[30px]">{title}</h1>
        {sub && <div className="mt-1 text-[14px] text-muted">{sub}</div>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

export function Avatar({ name, src, size = 28, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  if (src) return <img src={src} alt="" referrerPolicy="no-referrer" className={cx('shrink-0 rounded-full object-cover ring-2 ring-[var(--rim)]', className)} style={{ width: size, height: size }} />;
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-primary-grad font-bold text-on-primary', className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Chip({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'primary' | 'ok' | 'danger' | 'warning'; className?: string }) {
  return (
    <span className={cx(
      'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap',
      tone === 'neutral' && 'bg-fill text-ink-2',
      tone === 'primary' && 'bg-primary-soft text-primary',
      tone === 'ok' && 'bg-ok-soft text-ok',
      tone === 'danger' && 'bg-danger-soft text-danger',
      tone === 'warning' && 'bg-warning-soft text-warning',
      className,
    )}>{children}</span>
  );
}

// ------------------------------------------------------------------ Toast & confirm

type ToastOpts = { title?: string; meta?: string; icon?: ReactNode; duration?: number; action?: { label: string; onClick: () => void } };
type ToastT = { id: number; text: string; tone: 'ok' | 'error'; leaving?: boolean; duration: number } & ToastOpts;
type ConfirmReq = { title: string; desc?: ReactNode; ok?: string; danger?: boolean; resolve: (v: boolean) => void };
const FeedbackCtx = createContext<{ toast: (text: string, tone?: 'ok' | 'error', opts?: ToastOpts) => void; confirm: (o: Omit<ConfirmReq, 'resolve'>) => Promise<boolean> }>(null!);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 180);
  }, []);
  const toast = useCallback((text: string, tone: 'ok' | 'error' = 'ok', opts: ToastOpts = {}) => {
    const id = Date.now() + Math.random();
    // Có nút hành động thì để lâu hơn cho kịp bấm.
    const duration = opts.duration ?? (opts.action ? 10000 : tone === 'error' ? 5000 : opts.title ? 5000 : 3000);
    setToasts((t) => [...t.slice(-3), { id, text, tone, duration, ...opts }]);
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);
  const confirm = useCallback((o: Omit<ConfirmReq, 'resolve'>) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), []);
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <FeedbackCtx.Provider value={{ toast, confirm }}>
      {children}
      {/* Thông báo ở góc dưới bên phải (trên thanh điều hướng đáy ở điện thoại). */}
      <div aria-live="polite" className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+84px)] right-4 z-[60] flex max-w-[calc(100vw-32px)] flex-col items-end gap-2 md:bottom-5 md:right-5">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx('toast pointer-events-auto', t.tone === 'error' ? 'toast-error' : 'toast-ok', t.leaving && 'toast-leave')} style={{ ['--toast-ms' as string]: `${t.duration}ms` }}>
            <span className="toast-icon" aria-hidden="true">{t.icon ?? (t.tone === 'error' ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />)}</span>
            <div className="min-w-0 flex-1">
              {t.title && <p className="truncate text-[12px] font-bold uppercase tracking-wide text-[var(--toast-accent)]">{t.title}</p>}
              <p className="text-[13.5px] font-semibold leading-snug text-ink">{t.text}</p>
              {t.meta && <p className="mt-0.5 truncate text-[12px] text-muted">{t.meta}</p>}
              {t.action && <button type="button" className="mt-1 text-[12.5px] font-bold text-primary hover:underline" onClick={() => { dismiss(t.id); t.action!.onClick(); }}>{t.action.label}</button>}
            </div>
            <button type="button" className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-fill hover:text-ink" aria-label="Đóng thông báo" onClick={() => dismiss(t.id)}><X size={13} weight="bold" /></button>
            <span className="toast-bar" aria-hidden="true" />
          </div>
        ))}
      </div>
      <Sheet
        open={!!req}
        onClose={() => close(false)}
        title={req?.title}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => close(false)}>Huỷ</Button>
            <Button variant={req?.danger ? 'danger' : 'primary'} block onClick={() => close(true)}>{req?.ok ?? 'Đồng ý'}</Button>
          </div>
        }
      >
        {req?.desc && <div className="pb-2 text-ink-2">{req.desc}</div>}
      </Sheet>
    </FeedbackCtx.Provider>
  );
}

export const useFeedback = () => useContext(FeedbackCtx);

/** Logo VNLab Project: chế độ tối dùng bản DARK. */
export function BrandLogo({ className = '', alt = 'VNLab Project' }: { className?: string; alt?: string }) {
  return (
    <>
      <img src="/logo.svg?v=eco4-1109" alt={alt} className={`brand-logo-light ${className}`} />
      <img src="/logo-dark.svg?v=eco4-1109" alt={alt} className={`brand-logo-dark ${className}`} />
    </>
  );
}

export function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="liquid-glass flex h-20 w-20 animate-pulse items-center justify-center rounded-full"><BrandLogo className="h-12 w-12" /></span>
    </div>
  );
}

export function LogoTile({ className = '', logoClassName = 'h-9 w-9' }: { className?: string; logoClassName?: string }) {
  return <span className={cx('liquid-glass flex shrink-0 items-center justify-center', className)}><BrandLogo className={logoClassName} /></span>;
}

/** Theme sáng/tối/theo máy — lưu localStorage, áp vào <html data-theme>. */
export type Theme = 'system' | 'light' | 'dark';
export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch { /* riêng tư */ }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
