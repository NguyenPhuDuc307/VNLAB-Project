import { CaretRight, Check } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui';

export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; onSelect?: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; children?: MenuItem[] }
  | 'sep';
export type MenuState = { x: number; y: number; items: MenuItem[]; title?: string } | null;

/**
 * Menu chuột phải: nổi tại vị trí chuột, tự lật khi chạm mép màn hình, có menu con (rê / mũi tên phải),
 * điều khiển bằng phím (↑ ↓ Enter → ← Esc). Đóng khi bấm ra ngoài, cuộn, đổi kích thước cửa sổ.
 */
export function ContextMenu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.ctx-menu')) onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [state, onClose]);
  if (!state) return null;
  return createPortal(<MenuPanel x={state.x} y={state.y} items={state.items} title={state.title} onClose={onClose} root />, document.body);
}

function MenuPanel({ x, y, items, title, onClose, root, flipX }: { x: number; y: number; items: MenuItem[]; title?: string; onClose: () => void; root?: boolean; flipX?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    if (left + r.width > vw - 8) left = flipX !== undefined ? flipX - r.width : Math.max(8, vw - r.width - 8);
    if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
    setPos({ left, top, ready: true });
  }, [x, y, flipX]);
  useEffect(() => { if (root) ref.current?.focus(); }, [root]);
  const selectable = items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const run = (i: number) => {
    const it = items[i];
    if (it === 'sep' || it.disabled) return;
    if (it.children?.length) { setOpen(i); return; }
    onClose();
    it.onSelect?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const at = selectable.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(selectable[(at + 1) % selectable.length]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(selectable[(at - 1 + selectable.length) % selectable.length]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (active >= 0) run(active); }
    else if (e.key === 'ArrowRight') { const it = items[active]; if (it && it !== 'sep' && it.children?.length) { e.preventDefault(); setOpen(active); } }
    else if (e.key === 'ArrowLeft' && !root) { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  return (
    <div ref={ref} role="menu" tabIndex={-1} className="ctx-menu" style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {title && <p className="ctx-title">{title}</p>}
      {items.map((it, i) => it === 'sep' ? <div key={`s${i}`} className="ctx-sep" role="separator" /> : (
        <div key={`${it.label}${i}`} className="relative" onMouseEnter={() => { setActive(i); setOpen(it.children?.length ? i : null); }}>
          <button type="button" role="menuitem" disabled={it.disabled} aria-haspopup={it.children?.length ? 'menu' : undefined}
            className={cx('ctx-item', it.danger && 'danger', active === i && 'active')} onClick={() => run(i)}>
            <span className="ctx-icon">{it.checked ? <Check size={14} weight="bold" /> : it.icon}</span>
            <span className="min-w-0 flex-1 truncate text-left">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
            {it.children?.length ? <CaretRight size={12} weight="bold" className="text-muted" /> : null}
          </button>
          {open === i && it.children?.length ? <SubPanel anchor={ref} index={i} items={it.children} onCloseAll={onClose} onBack={() => setOpen(null)} /> : null}
        </div>
      ))}
    </div>
  );
}

function SubPanel({ anchor, index, items, onCloseAll, onBack }: { anchor: React.RefObject<HTMLDivElement | null>; index: number; items: MenuItem[]; onCloseAll: () => void; onBack: () => void }) {
  const host = anchor.current;
  const row = host?.children[index + (host.querySelector('.ctx-title') ? 1 : 0)] as HTMLElement | undefined;
  const r = row?.getBoundingClientRect();
  const hr = host?.getBoundingClientRect();
  if (!r || !hr) return null;
  return createPortal(
    <MenuPanel x={hr.right - 4} y={r.top - 6} flipX={hr.left + 4} items={items} onClose={() => { onBack(); onCloseAll(); }} />,
    document.body,
  );
}
