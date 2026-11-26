import { CalendarDots, CaretDoubleLeft, CaretDoubleRight, FolderSimple, GearSix, Robot, SquaresFour, type Icon } from '@phosphor-icons/react';
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveEvents, useMe, useOverview } from '../lib/api';
import { Avatar, BrandLogo, cx, IconButton, useFeedback } from './ui';

const NAV: { to: string; label: string; icon: Icon; match?: (p: string) => boolean }[] = [
  { to: '/', label: 'Tổng quan', icon: SquaresFour },
  { to: '/du-an', label: 'Dự án', icon: FolderSimple, match: (p) => p.startsWith('/du-an') },
  { to: '/lich', label: 'Lịch', icon: CalendarDots },
  { to: '/cai-dat', label: 'Cài đặt', icon: GearSix },
];

const WIDE = '(min-width: 1024px)';
const subscribeWide = (onChange: () => void) => {
  const m = matchMedia(WIDE);
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
};

const readCollapsed = () => {
  try { return localStorage.getItem('sidebar:collapsed') === '1'; } catch { return false; }
};

/**
 * Bố cục: màn rộng có thanh bên kính (như Stock) vì Gantt cần bề ngang; màn hẹp
 * có thanh trên và thanh điều hướng kính nổi ở đáy (như Finance/Home).
 */
export function Layout() {
  const me = useMe();
  const { toast } = useFeedback();
  // Thời gian thực ở mọi trang; AI sửa qua MCP thì báo ở góc dưới bên phải, kèm tên dự án.
  useLiveEvents((ev) => {
    if (ev.source !== 'mcp') return;
    const what = ev.deleted ? 'Xoá dự án' : ev.action ?? 'Cập nhật dự án';
    toast(what, 'ok', { title: `AI qua MCP · ${ev.actor ?? 'AI'}`, meta: ev.projectName ? `Dự án ${ev.projectName}` : undefined, icon: <Robot size={18} weight="fill" /> });
  });
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { pathname } = useLocation();
  useEffect(() => { try { localStorage.setItem('sidebar:collapsed', collapsed ? '1' : '0'); } catch { /* riêng tư */ } }, [collapsed]);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const user = me.data;
  // Chấm đỏ trên nút Tổng quan khi có việc quá hạn (như chấm "node offline" bên VNLab Home).
  const overdue = useOverview().data?.overdue.length ?? 0;

  return (
    <div className="flex min-h-dvh">
      {wide && (
        <aside className={cx('sidebar sticky top-0 z-10 flex h-dvh shrink-0 flex-col', collapsed ? 'w-16' : 'w-60')}>
          <div className={cx('flex items-center gap-2.5 py-5', collapsed ? 'justify-center px-2' : 'px-4')}>
            <span className={cx('liquid-glass flex h-10 w-10 shrink-0 items-center justify-center rounded-full', collapsed && 'hidden')}><BrandLogo className="h-6 w-6" alt="" /></span>
            <span className={cx('min-w-0 leading-tight', collapsed && 'hidden')}>
              <span className="eyebrow block text-[9.5px] text-primary">VNLab</span>
              <span className="block text-[17px] font-extrabold tracking-tight">Project</span>
            </span>
            <div className={collapsed ? '' : 'ml-auto shrink-0'}>
              <IconButton label={collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'} aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
                {collapsed ? <CaretDoubleRight size={18} /> : <CaretDoubleLeft size={18} />}
              </IconButton>
            </div>
          </div>
          <nav className={cx('flex flex-col gap-1', collapsed ? 'items-center px-2' : 'px-3')}>
            {NAV.map((n) => <SideLink key={n.to} {...n} collapsed={collapsed} active={n.match ? n.match(pathname) : pathname === n.to} badge={n.to === '/' ? overdue : 0} />)}
          </nav>
          <div className="mt-auto p-3">
            {user && (
              <div title={user.name || user.email} className={cx('flex items-center gap-2.5 py-1', collapsed ? 'justify-center' : 'px-1')}>
                <Avatar name={user.name || user.email} src={user.avatar} size={30} />
                <span className={cx('min-w-0', collapsed && 'hidden')}>
                  <span className="block truncate text-sm font-semibold">{user.name || user.email}</span>
                  <span className="block truncate text-[11.5px] text-muted">{user.email}</span>
                </span>
              </div>
            )}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <header className="topbar sticky top-0 z-30 flex items-center gap-2.5 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
            <span className="liquid-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full"><BrandLogo className="h-5 w-5" alt="" /></span>
            <span className="leading-none">
              <span className="eyebrow block text-[9px] text-primary">VNLab</span>
              <span className="block text-[15px] font-extrabold tracking-tight">Project</span>
            </span>
            {user && <span className="ml-auto"><Avatar name={user.name || user.email} src={user.avatar} size={30} /></span>}
          </header>
        )}
        <main className={cx('mx-auto w-full min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7', !/^\/du-an\/[^/]+(\/phase\/[^/]+)?$/.test(pathname) && 'max-w-[1400px]', !wide && 'pb-[calc(84px+max(8px,calc(env(safe-area-inset-bottom)-14px)))]')}>
          {/* Trang con tải lười: giữ khung (menu) khi đang tải chunk của trang. */}
          <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center"><span className="h-8 w-8 animate-pulse rounded-full bg-current opacity-20" /></div>}>
            <Outlet />
          </Suspense>
        </main>
        {!wide && (
          // Thanh điều hướng nổi y như VNLab Home: chỉ icon trong ô tròn 48px. Bo đúng
          // nửa chiều cao (ô 48 + 2×6 đệm + 2 viền = 62px), không dùng rounded-full:
          // WebKit cắt sai góc 9999px khi có backdrop-filter + overflow cuộn.
          <nav aria-label="Điều hướng chính" className="liquid-glass fixed bottom-[max(8px,calc(env(safe-area-inset-bottom)-14px))] left-1/2 z-40 flex max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-[31px] border p-1.5">
            {NAV.map((n) => <Tab key={n.to} {...n} active={n.match ? n.match(pathname) : pathname === n.to} badge={n.to === '/' ? overdue : 0} />)}
          </nav>
        )}
      </div>
    </div>
  );
}

/** Mục thanh bên: viên thuốc (thu gọn = ô tròn 40px chỉ icon). Đang chọn = nền pha màu chính, nét icon đậm hơn. */
function SideLink({ to, label, icon: I, collapsed, active, badge }: { to: string; label: string; icon: Icon; collapsed: boolean; active: boolean; badge?: number }) {
  return (
    <NavLink to={to} title={label} aria-label={badge ? `${label} (${badge} việc quá hạn)` : undefined}
      className={cx('relative flex h-10 items-center gap-3 rounded-full text-[14px] font-semibold transition-colors', active ? 'side-active' : 'text-ink-2 hover:bg-fill hover:text-ink', collapsed ? 'w-10 justify-center' : 'px-3.5')}>
      <span className="relative flex items-center justify-center">
        <I size={20} weight={active ? 'bold' : 'regular'} />
        {!!badge && <span className="absolute -right-1.5 -top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-[var(--bg)]" aria-hidden="true" />}
      </span>
      <span className={cx(collapsed && 'sr-only')}>{label}</span>
    </NavLink>
  );
}

/**
 * Nút thanh điều hướng đáy như NavButton của VNLab Home: chỉ icon, ô tròn 48×48.
 * Tên tab vẫn có qua aria-label (đọc màn hình) và title (tooltip). Tab đang chọn:
 * nền tròn pha màu chính + nét icon đậm hơn. Chạm thì ô nhún nhẹ.
 */
function Tab({ to, label, icon: I, active, badge }: { to: string; label: string; icon: Icon; active: boolean; badge?: number }) {
  return (
    <NavLink to={to} title={label} aria-label={badge ? `${label} (${badge})` : label} aria-current={active ? 'page' : undefined}
      className={cx('relative grid size-12 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] active:scale-[0.92]', active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-fill hover:text-ink')}>
      <span className="relative flex items-center justify-center">
        <I size={22} weight={active ? 'bold' : 'regular'} />
        {!!badge && <span className="absolute -right-1.5 -top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-[var(--bg)]" aria-hidden="true" />}
      </span>
    </NavLink>
  );
}
