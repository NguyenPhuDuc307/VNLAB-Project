// Lịch kiểu Google Calendar: Ngày / Tuần / Tháng / Năm / Lịch biểu. Mỗi việc có ngày là một thanh trải
// từ ngày bắt đầu tới ngày kết thúc. Tuần bắt đầu thứ hai. Kéo thanh sang ngày khác để dời việc
// (giữ nguyên độ dài), bấm để mở chi tiết, chuột phải có menu như Gantt.
// Phím tắt như Google Calendar: d / w / m / y / a đổi kiểu xem, t về hôm nay, j / n sau, k / p trước.
import { CaretLeft, CaretRight, CheckCircle, Warning } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Task } from '../lib/api';
import { addDays, diffDays, fmtDate, fmtShort, mondayOf, weekday } from '../lib/dates';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import type { MenuTarget } from './Gantt';
import { Button, IconButton, Segmented, Sheet, cx } from './ui';

export type CalMode = 'day' | 'week' | 'month' | 'year' | 'agenda';
const MODES: { value: CalMode; label: string; key: string }[] = [
  { value: 'day', label: 'Ngày', key: 'd' },
  { value: 'week', label: 'Tuần', key: 'w' },
  { value: 'month', label: 'Tháng', key: 'm' },
  { value: 'year', label: 'Năm', key: 'y' },
  { value: 'agenda', label: 'Lịch biểu', key: 'a' },
];
const MODE_KEY = 'project:cal-mode';
const MONTH_LANES = 4; // tháng: số thanh tối đa mỗi tuần; còn lại gom vào "+n"
const DAY_HEAD = 26; // chỗ cho số ngày trong ô tháng
const LANE_H = 22;
const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const WEEKDAY_LONG = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const AGENDA_DAYS = 30;

type Props = {
  tasks: Task[];
  today: string;
  /** Được kéo thanh để dời ngày việc này không. */
  canEdit: (t: Task) => boolean;
  colorOf: (t: Task) => string;
  /** Dòng phụ (nhóm, dự án…) trong danh sách việc. */
  subtitle?: (t: Task) => string | undefined;
  /** Nhãn ngắn đứng trước tên trên thanh (VD mã dự án ở lịch chung). */
  prefix?: (t: Task) => string | undefined;
  onEditTask: (t: Task) => void;
  onChangeDates: (t: Task, startDate: string, endDate: string) => void;
  menuFor?: (t: MenuTarget) => MenuItem[];
  /** Lọc phạm vi + nút thao tác của trang (đặt bên phải thanh điều khiển). */
  tools?: ReactNode;
};

type Span = { start: string; end: string };
const spanOfTask = (t: Task): Span | null => {
  const a = t.startDate ?? t.endDate, b = t.endDate ?? t.startDate;
  if (!a || !b) return null;
  return a <= b ? { start: a, end: b } : { start: b, end: a };
};
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const shiftMonth = (d: string, n: number) => {
  const [y, m] = d.split('-').map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`;
};
const monthEnd = (d: string) => addDays(shiftMonth(d, 1), -1);
const loadMode = (): CalMode => {
  try { const v = localStorage.getItem(MODE_KEY); return MODES.some((m) => m.value === v) ? (v as CalMode) : 'month'; } catch { return 'month'; }
};

export function CalendarView(props: Props) {
  const { tasks, today, colorOf, subtitle, onEditTask, tools } = props;
  const [mode, setModeRaw] = useState<CalMode>(loadMode);
  const [cursor, setCursor] = useState(today);
  const [list, setList] = useState<{ title: string; tasks: Task[] } | null>(null);
  const setMode = (m: CalMode) => { setModeRaw(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* riêng tư */ } };

  const order = useMemo(() => new Map(tasks.map((t, i) => [t.id, i])), [tasks]);
  const dated = useMemo(() => tasks
    .map((t) => ({ t, s: spanOfTask(t) }))
    .filter((x): x is { t: Task; s: Span } => !!x.s)
    .sort((a, b) => a.s.start.localeCompare(b.s.start) || diffDays(b.s.start, b.s.end) - diffDays(a.s.start, a.s.end) || order.get(a.t.id)! - order.get(b.t.id)!), [tasks, order]);
  const undated = tasks.filter((t) => !spanOfTask(t));
  const on = (d: string) => dated.filter(({ s }) => s.start <= d && d <= s.end).map((x) => x.t);

  const step = (dir: 1 | -1) => setCursor((c) => {
    switch (mode) {
      case 'day': return addDays(c, dir);
      case 'week': return addDays(c, 7 * dir);
      case 'month': return shiftMonth(c, dir);
      case 'year': return `${Number(c.slice(0, 4)) + dir}-01-01`;
      case 'agenda': return addDays(c, AGENDA_DAYS * dir);
    }
  });

  // Phím tắt kiểu Google Calendar (bỏ qua khi đang gõ hoặc có hộp thoại).
  const keys = useRef({ step, setMode, today });
  keys.current = { step, setMode, today };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      const m = MODES.find((x) => x.key === k);
      if (m) keys.current.setMode(m.value);
      else if (k === 't') setCursor(keys.current.today);
      else if (k === 'j' || k === 'n') keys.current.step(1);
      else if (k === 'k' || k === 'p') keys.current.step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = (() => {
    const [y, m] = cursor.split('-').map(Number);
    switch (mode) {
      case 'day': return `${WEEKDAY_LONG[weekday(cursor)]}, ${fmtDate(cursor)}`;
      case 'week': {
        const ws = mondayOf(cursor), we = addDays(ws, 6);
        return ws.slice(0, 7) === we.slice(0, 7) ? `${Number(ws.slice(8))} – ${Number(we.slice(8))} tháng ${Number(ws.slice(5, 7))}, ${ws.slice(0, 4)}` : `${fmtShort(ws)} – ${fmtShort(we)}, ${we.slice(0, 4)}`;
      }
      case 'month': return `Tháng ${m}, ${y}`;
      case 'year': return `Năm ${y}`;
      case 'agenda': return `${fmtShort(cursor)} – ${fmtShort(addDays(cursor, AGENDA_DAYS - 1))}, ${addDays(cursor, AGENDA_DAYS - 1).slice(0, 4)}`;
    }
  })();
  const atToday = mode === 'day' ? cursor === today
    : mode === 'week' ? mondayOf(cursor) === mondayOf(today)
    : mode === 'month' ? cursor.slice(0, 7) === today.slice(0, 7)
    : mode === 'year' ? cursor.slice(0, 4) === today.slice(0, 4)
    : cursor === today;

  const openDay = (d: string) => { setCursor(d); setMode('day'); };
  const shared = { ...props, dated, on, openDay, setList };

  return (
    <div className="cal-shell card overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Button size="sm" variant="secondary" className="!h-7" onClick={() => setCursor(today)} disabled={atToday} title="Về hôm nay (T)">Hôm nay</Button>
        <span className="inline-flex items-center gap-0.5">
          <IconButton label="Trước (K)" className="!h-7 !w-7 !rounded-lg" onClick={() => step(-1)}><CaretLeft size={16} weight="bold" /></IconButton>
          <IconButton label="Sau (J)" className="!h-7 !w-7 !rounded-lg" onClick={() => step(1)}><CaretRight size={16} weight="bold" /></IconButton>
        </span>
        <h2 className="min-w-[140px] text-[15px] font-extrabold tracking-tight">{title}</h2>
        {undated.length > 0 && (
          <button type="button" className="text-[12.5px] font-semibold text-muted hover:text-ink" onClick={() => setList({ title: `${undated.length} việc chưa có ngày`, tasks: undated })}>
            {undated.length} việc chưa có ngày
          </button>
        )}
        <span className="ml-auto inline-flex shrink-0 flex-wrap items-center gap-2">
          <Segmented size="sm" value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} className="w-[19rem] max-w-full" />
          {tools}
        </span>
      </div>

      {/* Toàn màn hình: thanh công cụ đứng yên, phần lịch tự cuộn (index.css .gantt-full .cal-body). */}
      <div className="cal-body">
        {mode === 'month' && <MonthView {...shared} cursor={cursor} />}
        {mode === 'week' && <WeekView {...shared} cursor={cursor} />}
        {mode === 'day' && <DayView {...shared} cursor={cursor} />}
        {mode === 'year' && <YearView {...shared} cursor={cursor} />}
        {mode === 'agenda' && <AgendaView {...shared} cursor={cursor} />}
      </div>

      <Sheet open={!!list} onClose={() => setList(null)} title={list?.title ?? ''}>
        <ul className="divide-y divide-line">
          {(list?.tasks ?? []).map((t) => <TaskRow key={t.id} t={t} color={colorOf(t)} sub={subtitle?.(t)} onClick={() => { setList(null); onEditTask(t); }} />)}
        </ul>
      </Sheet>
    </div>
  );
}

type Shared = Props & {
  cursor: string;
  dated: { t: Task; s: Span }[];
  on: (d: string) => Task[];
  openDay: (d: string) => void;
  setList: (v: { title: string; tasks: Task[] } | null) => void;
};

// ---------------------------------------------------------------- thanh việc theo tuần (Tháng + Tuần)

type Bar = { t: Task; lane: number; col: number; len: number; startsHere: boolean; endsHere: boolean };
function layoutWeek(dated: Shared['dated'], ws: string, maxLanes: number) {
  const we = addDays(ws, 6);
  const lanes: string[][] = [];
  const bars: Bar[] = [];
  const hidden = Array.from({ length: 7 }, () => [] as Task[]);
  const all = Array.from({ length: 7 }, () => [] as Task[]);
  for (const { t, s } of dated) {
    if (s.end < ws || s.start > we) continue;
    const a = s.start < ws ? ws : s.start, b = s.end > we ? we : s.end;
    const col = diffDays(ws, a), len = diffDays(a, b) + 1;
    for (let c = col; c < col + len; c++) all[c].push(t);
    let lane = lanes.findIndex((occ) => occ.every((d, c) => !d || c < col || c >= col + len));
    if (lane < 0) { lanes.push(Array(7).fill('')); lane = lanes.length - 1; }
    for (let c = col; c < col + len; c++) lanes[lane][c] = t.id;
    if (lane < maxLanes) bars.push({ t, lane, col, len, startsHere: s.start >= ws, endsHere: s.end <= we });
    else for (let c = col; c < col + len; c++) hidden[c].push(t);
  }
  return { bars, hidden, all, used: Math.min(maxLanes, lanes.length) };
}

/** Một hàng tuần: 7 ô ngày (nhận thả khi kéo) + các thanh việc đặt tuyệt đối theo làn. */
function WeekRow({ ws, inMonth, maxLanes, head, minHeight, ...p }: Shared & { ws: string; inMonth?: (d: string) => boolean; maxLanes: number; head: boolean; minHeight?: number }) {
  const { today, canEdit, colorOf, prefix, onEditTask, onChangeDates, menuFor, dated, setList } = p;
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const drag = useRef<{ task: Task; grab: string } | null>(null);
  const { bars, hidden, all, used } = useMemo(() => layoutWeek(dated, ws, maxLanes), [dated, ws, maxLanes]);
  const top = head ? DAY_HEAD : 6;
  const height = Math.max(minHeight ?? 0, top + Math.max(used, 2) * LANE_H + (hidden.some((h) => h.length) ? 20 : 6));
  const drop = (date: string) => {
    const d = drag.current;
    drag.current = null;
    setOver(null);
    if (!d) return;
    const s = spanOfTask(d.task)!;
    const shift = diffDays(d.grab, date);
    if (shift) onChangeDates(d.task, addDays(s.start, shift), addDays(s.end, shift));
  };
  return (
    <div className="relative grid grid-cols-7 border-b border-line last:border-b-0" style={{ minHeight: height }}>
      {Array.from({ length: 7 }, (_, c) => {
        const d = addDays(ws, c);
        const isToday = d === today;
        const muted = inMonth ? !inMonth(d) : false;
        return (
          <div
            key={d}
            className={cx('relative border-r border-line last:border-r-0', muted && 'bg-fill/50', c >= 5 && !muted && 'bg-fill/25', isToday && 'cal-today', over === d && 'bg-primary/10')}
            onDragOver={(e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== d) setOver(d); } }}
            onDrop={(e) => { e.preventDefault(); drop(d); }}
          >
            {head && (
              <button
                type="button"
                className={cx('absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[12px] font-semibold tabular-nums', isToday ? 'bg-primary text-white' : muted ? 'text-muted/70 hover:bg-fill' : 'text-ink-2 hover:bg-fill')}
                title={`${fmtDate(d)}${all[c].length ? ` · ${all[c].length} việc` : ''} — xem ngày`}
                onClick={() => p.openDay(d)}
              >
                {d.slice(8) === '01' ? `${Number(d.slice(8))}/${Number(d.slice(5, 7))}` : Number(d.slice(8))}
              </button>
            )}
            {hidden[c].length > 0 && (
              <button type="button" className="absolute bottom-0.5 left-1 right-1 truncate rounded px-1 text-left text-[11.5px] font-semibold text-muted hover:bg-fill hover:text-ink"
                onClick={() => setList({ title: `Ngày ${fmtDate(d)}`, tasks: all[c] })}>
                +{hidden[c].length} việc
              </button>
            )}
          </div>
        );
      })}
      {bars.map(({ t, lane, col, len, startsHere, endsHere }) => {
        const color = colorOf(t);
        const done = t.progress >= 100;
        const late = !done && !!t.endDate && t.endDate < today;
        const s = spanOfTask(t)!;
        const pre = prefix?.(t);
        return (
          <button
            key={t.id}
            type="button"
            draggable={canEdit(t)}
            onDragStart={(e) => {
              const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
              const c = Math.min(6, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * 7)));
              drag.current = { task: t, grab: addDays(ws, c) };
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.id);
            }}
            onDragEnd={() => { drag.current = null; setOver(null); }}
            onClick={() => onEditTask(t)}
            onContextMenu={(e) => {
              const items = menuFor?.({ kind: 'task', task: t }) ?? [];
              if (!items.length) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, items });
            }}
            title={`${t.name}\n${fmtShort(s.start)} → ${fmtShort(s.end)} · ${t.progress}%${t.assignee ? ` · ${t.assignee}` : ''}${t.note.trim() ? `\n\n${t.note.trim()}` : ''}`}
            className={cx(
              'absolute z-[1] flex items-center gap-1 overflow-hidden px-1.5 text-left text-[12px] font-semibold leading-none text-ink transition hover:brightness-95',
              startsHere ? 'rounded-l-md' : 'rounded-l-none',
              endsHere ? 'rounded-r-md' : 'rounded-r-none',
              canEdit(t) && 'cursor-grab active:cursor-grabbing',
            )}
            style={{
              top: top + lane * LANE_H,
              height: LANE_H - 3,
              left: `calc(${(col / 7) * 100}% + ${startsHere ? 3 : 0}px)`,
              width: `calc(${(len / 7) * 100}% - ${(startsHere ? 3 : 0) + (endsHere ? 3 : 0)}px)`,
              background: `color-mix(in srgb, ${color} 20%, var(--surface))`,
              boxShadow: startsHere ? `inset 3px 0 0 ${color}` : undefined,
            }}
          >
            {done && <CheckCircle size={13} weight="fill" className="shrink-0 text-ok" />}
            {late && <Warning size={13} weight="fill" className="shrink-0 text-danger" />}
            {pre && <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-wide opacity-70">{pre}</span>}
            <span className="truncate">{t.name}</span>
            {!done && t.progress > 0 && len > 1 && <span className="ml-auto shrink-0 text-[11px] font-medium text-muted">{t.progress}%</span>}
          </button>
        );
      })}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function WeekdayHeader({ ws, today, onPick }: { ws?: string; today: string; onPick?: (d: string) => void }) {
  return (
    <div className="grid grid-cols-7 border-b border-line bg-fill/60 text-center">
      {WEEKDAYS.map((name, i) => {
        const d = ws ? addDays(ws, i) : null;
        const isToday = !!d && d === today;
        // Tháng: hôm nay rơi vào thứ nào thì tô thứ đó (chỉ khi đang xem tháng có hôm nay).
        const isTodayDow = !ws && (weekday(today) + 6) % 7 === i;
        return (
          <div key={name} className={cx('py-1.5 text-[11.5px] font-semibold', isToday || isTodayDow ? 'text-primary' : 'text-muted', isToday && 'cal-today')}>
            {name}
            {d && (
              <button type="button" onClick={() => onPick?.(d)} title="Xem ngày"
                className={cx('mx-auto mt-0.5 grid h-8 w-8 place-items-center rounded-full text-[18px] font-bold tabular-nums', isToday ? 'bg-primary text-white' : 'text-ink hover:bg-fill')}>
                {Number(d.slice(8))}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MonthView(p: Shared) {
  const first = monthStart(p.cursor);
  const gridStart = mondayOf(first);
  const weeks = Math.ceil((diffDays(gridStart, monthEnd(first)) + 1) / 7);
  const month = first.slice(0, 7);
  const showsToday = p.today.slice(0, 7) === month;
  return (
    <>
      <WeekdayHeader today={showsToday ? p.today : '0000-00-00'} />
      {Array.from({ length: weeks }, (_, w) => {
        const ws = addDays(gridStart, w * 7);
        return <WeekRow key={ws} {...p} ws={ws} maxLanes={MONTH_LANES} head inMonth={(d) => d.slice(0, 7) === month} />;
      })}
    </>
  );
}

function WeekView(p: Shared) {
  const ws = mondayOf(p.cursor);
  return (
    <>
      <WeekdayHeader ws={ws} today={p.today} onPick={p.openDay} />
      <WeekRow {...p} ws={ws} maxLanes={Infinity} head={false} minHeight={420} />
    </>
  );
}

// ---------------------------------------------------------------- Ngày

function DayView(p: Shared) {
  const d = p.cursor;
  const items = p.on(d);
  const starting = items.filter((t) => spanOfTask(t)!.start === d);
  const ending = items.filter((t) => spanOfTask(t)!.end === d && spanOfTask(t)!.start !== d);
  const ongoing = items.filter((t) => !starting.includes(t) && !ending.includes(t));
  const block = (title: string, ts: Task[]) => ts.length > 0 && (
    <section className="mb-4">
      <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-wider text-muted">{title} · {ts.length}</h3>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {ts.map((t) => <TaskRow key={t.id} t={t} color={p.colorOf(t)} sub={p.subtitle?.(t)} today={p.today} note onClick={() => p.onEditTask(t)} />)}
      </ul>
    </section>
  );
  return (
    <div className={cx('min-h-[360px] p-3 md:p-4', d === p.today && 'cal-today')}>
      {items.length === 0 ? <p className="py-16 text-center text-[13.5px] text-muted">Không có việc nào trong ngày {fmtDate(d)}.</p> : (
        <>
          {block('Bắt đầu hôm nay', starting)}
          {block('Đến hạn hôm nay', ending)}
          {block('Đang diễn ra', ongoing)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Năm

function YearView(p: Shared) {
  const y = p.cursor.slice(0, 4);
  const start = `${y}-01-01`, end = `${y}-12-31`;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const { s } of p.dated) {
      if (s.end < start || s.start > end) continue;
      const a = s.start < start ? start : s.start, b = s.end > end ? end : s.end;
      for (let d = a; d <= b; d = addDays(d, 1)) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  }, [p.dated, start, end]);
  const max = Math.max(1, ...counts.values());
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }, (_, i) => {
        const first = `${y}-${String(i + 1).padStart(2, '0')}-01`;
        const gs = mondayOf(first);
        const weeks = Math.ceil((diffDays(gs, monthEnd(first)) + 1) / 7);
        return (
          <div key={first}>
            <p className={cx('mb-1.5 text-[13px] font-bold', first.slice(0, 7) === p.today.slice(0, 7) ? 'text-primary' : 'text-ink')}>Tháng {i + 1}</p>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[10.5px] font-semibold text-muted">
              {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
              {Array.from({ length: weeks * 7 }, (_, k) => {
                const d = addDays(gs, k);
                if (d.slice(0, 7) !== first.slice(0, 7)) return <span key={d} />;
                const n = counts.get(d) ?? 0;
                return (
                  <button key={d} type="button" onClick={() => p.openDay(d)} title={`${fmtDate(d)}${n ? ` · ${n} việc` : ''}`}
                    className={cx('grid aspect-square place-items-center rounded-md text-[11.5px] tabular-nums transition hover:ring-1 hover:ring-primary', d === p.today ? 'bg-primary font-bold text-white' : n ? 'font-semibold text-ink' : 'text-ink-2')}
                    style={d !== p.today && n ? { background: `color-mix(in srgb, var(--primary) ${Math.round(10 + (n / max) * 45)}%, transparent)` } : undefined}>
                    {Number(d.slice(8))}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Lịch biểu

function AgendaView(p: Shared) {
  const from = p.cursor, to = addDays(from, AGENDA_DAYS - 1);
  const ongoing = p.dated.filter(({ s }) => s.start < from && s.end >= from).map((x) => x.t);
  const byStart = new Map<string, Task[]>();
  for (const { t, s } of p.dated) if (s.start >= from && s.start <= to) byStart.set(s.start, [...(byStart.get(s.start) ?? []), t]);
  const days = [...byStart.keys()].sort();
  const row = (t: Task) => <TaskRow key={t.id} t={t} color={p.colorOf(t)} sub={p.subtitle?.(t)} today={p.today} onClick={() => p.onEditTask(t)} />;
  return (
    <div className="min-h-[360px] p-3 md:p-4">
      {!ongoing.length && !days.length && <p className="py-16 text-center text-[13.5px] text-muted">Không có việc nào từ {fmtDate(from)} tới {fmtDate(to)}.</p>}
      {ongoing.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-wider text-muted">Đang diễn ra · {ongoing.length}</h3>
          <ul className="divide-y divide-line rounded-2xl border border-line">{ongoing.map(row)}</ul>
        </section>
      )}
      {days.map((d) => (
        <section key={d} className="mb-3 grid grid-cols-[64px_minmax(0,1fr)] gap-3">
          <button type="button" onClick={() => p.openDay(d)} className={cx('flex h-fit flex-col items-center rounded-xl py-1.5 hover:bg-fill', d === p.today && 'cal-today')}>
            <span className={cx('text-[11px] font-semibold', d === p.today ? 'text-primary' : 'text-muted')}>{WEEKDAYS[(weekday(d) + 6) % 7]}</span>
            <span className={cx('grid h-8 w-8 place-items-center rounded-full text-[17px] font-bold tabular-nums', d === p.today ? 'bg-primary text-white' : 'text-ink')}>{Number(d.slice(8))}</span>
            <span className="text-[10.5px] text-muted">th {Number(d.slice(5, 7))}</span>
          </button>
          <ul className="divide-y divide-line rounded-2xl border border-line">{byStart.get(d)!.map(row)}</ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- một dòng việc (danh sách, Ngày, Lịch biểu)

function TaskRow({ t, color, sub, today, note, onClick }: { t: Task; color: string; sub?: string; today?: string; note?: boolean; onClick: () => void }) {
  const s = spanOfTask(t);
  const done = t.progress >= 100;
  const late = !!today && !done && !!t.endDate && t.endDate < today;
  return (
    <li>
      <button type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-fill/60" onClick={onClick}>
        <span className="mt-0.5 h-9 w-1 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {done && <CheckCircle size={14} weight="fill" className="shrink-0 text-ok" />}
            {late && <Warning size={14} weight="fill" className="shrink-0 text-danger" />}
            <span className="truncate text-[14px] font-semibold">{t.name}</span>
          </span>
          <span className="block truncate text-[12.5px] text-muted">
            {[s ? `${fmtShort(s.start)} → ${fmtShort(s.end)}` : 'Chưa có ngày', sub, t.assignee].filter(Boolean).join(' · ')}
          </span>
          {note && t.note.trim() && <span className="mt-1 line-clamp-3 whitespace-pre-line text-[12.5px] text-ink-2">{t.note.trim()}</span>}
        </span>
        <span className={cx('num shrink-0 text-[13px] font-bold', late && 'text-danger')}>{t.progress}%</span>
      </button>
    </li>
  );
}
