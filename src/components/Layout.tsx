import { CaretDoubleLeft, CaretDoubleRight, FolderSimple, GearSix, SquaresFour, type Icon } from '@phosphor-icons/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveEvents, useMe } from '../lib/api';
import { Avatar, BrandLogo, cx, IconButton, useFeedback } from './ui';

const NAV: { to: string; label: string; icon: Icon; match?: (p: string) => boolean }[] = [
  { to: '/', label: 'Tổng quan', icon: SquaresFour },
  { to: '/du-an', label: 'Dự án', icon: FolderSimple, match: (p) => p.startsWith('/du-an') },
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
    toast(`MCP · ${ev.actor ?? 'AI'}: ${what}${ev.projectName ? ` — ${ev.projectName}` : ''}`);
  });
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { pathname } = useLocation();
  useEffect(() => { try { localStorage.setItem('sidebar:collapsed', collapsed ? '1' : '0'); } catch { /* riêng tư */ } }, [collapsed]);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const user = me.data;

  return (
    <div className="flex min-h-dvh">
      {wide && (
        <aside className={cx('sidebar sticky top-0 z-10 flex h-dvh shrink-0 flex-col', collapsed ? 'w-16' : 'w-60')}>
          <div className={cx('flex items-center gap-2.5 py-5', collapsed ? 'justify-center px-2' : 'px-4')}>
            <span className={cx('liquid-glass flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px]', collapsed && 'hidden')}><BrandLogo className="h-7 w-7" alt="" /></span>
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
          <nav className="flex flex-col gap-1 px-2">
            {NAV.map((n) => <SideLink key={n.to} {...n} collapsed={collapsed} active={n.match ? n.match(pathname) : pathname === n.to} />)}
          </nav>
          <div className="mt-auto border-t border-line p-2">
            {user && (
              <div title={user.name || user.email} className={cx('flex items-center gap-2.5 py-2', collapsed ? 'justify-center' : 'px-3')}>
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
            <span className="liquid-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]"><BrandLogo className="h-6 w-6" alt="" /></span>
            <span className="leading-none">
              <span className="eyebrow block text-[9px] text-primary">VNLab</span>
              <span className="block text-[15px] font-extrabold tracking-tight">Project</span>
            </span>
            {user && <span className="ml-auto"><Avatar name={user.name || user.email} src={user.avatar} size={30} /></span>}
          </header>
        )}
        <main className={cx('mx-auto w-full min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7', !/^\/du-an\/[^/]+$/.test(pathname) && 'max-w-[1400px]', !wide && 'pb-[calc(84px+max(8px,calc(env(safe-area-inset-bottom)-14px)))]')}>
          <Outlet />
        </main>
        {!wide && (
          <nav aria-label="Điều hướng chính" className="liquid-glass fixed bottom-[max(8px,calc(env(safe-area-inset-bottom)-14px))] left-1/2 z-40 flex max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-0.5 rounded-[22px] border p-1.5">
            {NAV.map((n) => <Tab key={n.to} {...n} active={n.match ? n.match(pathname) : pathname === n.to} />)}
          </nav>
        )}
      </div>
    </div>
  );
}

function SideLink({ to, label, icon: I, collapsed, active }: { to: string; label: string; icon: Icon; collapsed: boolean; active: boolean }) {
  return (
    <NavLink to={to} title={label} className={cx('relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-semibold transition', active ? 'side-active' : 'text-ink-2 hover:bg-fill hover:text-ink', collapsed && 'justify-center px-0')}>
      <I size={20} weight={active ? 'fill' : 'regular'} />
      <span className={cx(collapsed && 'sr-only')}>{label}</span>
    </NavLink>
  );
}

function Tab({ to, label, icon: I, active }: { to: string; label: string; icon: Icon; active: boolean }) {
  return (
    <NavLink to={to} title={label} className="block">
      <span className={cx('flex h-12 min-w-[72px] shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-2xl px-2 text-[10px] font-semibold transition-colors', active ? 'bg-primary-soft text-primary' : 'text-muted hover:text-ink')}>
        <I size={22} weight={active ? 'fill' : 'regular'} />
        {label}
      </span>
    </NavLink>
  );
}
