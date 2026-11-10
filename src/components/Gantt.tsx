import { CaretDown, CaretRight, CheckCircle, CornersIn, CornersOut, DotsSixVertical, DotsThree, Plus } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { planShift, type Group, type ProjectDetail, type Task, type TaskInput, type Subtask } from '../lib/api';
import { addDays, coveredDays, dayNumber, diffDays, fmtDayMonth, fmtShort, fmtNum, fromDayNumber, mondayOf, WEEKDAY_SHORT, weekday, workDays } from '../lib/dates';
import { cx, IconButton } from './ui';

export type GanttView = 'gantt' | 'list';

type Props = {
  project: ProjectDetail;
  today: string;
  view: GanttView;
  dayWidth: number;
  canEdit: boolean;
  /** Đổi giá trị để cuộn tới ngày đó (VD: bấm "Hôm nay"). */
  focus: { date: string; tick: number };
  onEditTask: (t: Task) => void;
  onAddTask: (groupId: string | null) => void;
  onGroupMenu: (g: Group, anchor: HTMLElement) => void;
  onToggleGroup: (g: Group, collapsed: boolean) => void;
  collapsedTasks: string[];
  onToggleTask: (id: string) => void;
  collapsedUngrouped: boolean;
  onToggleUngrouped: (collapsed: boolean) => void;
  onChangeDates: (t: Task, startDate: string, endDate: string) => void;
  /** Sửa tại chỗ một ô (tên, phụ trách, hỗ trợ, tiến độ, ngày, ngày công). */
  onPatchTask: (t: Task, patch: Partial<TaskInput>) => void;
  /** Vẽ khung kế hoạch gốc cho việc đã dời / gia hạn (mặc định có). */
  showBaseline?: boolean;
  /** Kéo thả đổi thứ tự việc trong nhóm: danh sách id theo thứ tự mới. */
  onReorder: (groupId: string | null, ids: string[]) => void;
  /** Đang phóng to cả bảng ra toàn màn hình; có hàm thì hiện nút ở góc bảng. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export type EditField = 'name' | 'assignee' | 'support' | 'progress' | 'startDate' | 'endDate' | 'days';
const FIELD_ORDER: EditField[] = ['name', 'assignee', 'support', 'progress', 'startDate', 'endDate', 'days'];

type Row = { kind: 'group'; group: Group | null; tasks: Task[] } | { kind: 'task'; task: Task; index: number } | { kind: 'subtask'; task: Task; subtask: Subtask; index: string };

export const UNGROUPED = '__none__';

/** Hàng hiển thị: mỗi nhóm một hàng tóm tắt, rồi các việc (nếu nhóm không thu gọn); việc chưa phân nhóm xếp cuối. */
export function buildRows(project: ProjectDetail, collapsedTasks: string[] = [], collapsedUngrouped = false): Row[] {
  const rows: Row[] = [];
  let index = 0;
  const pushTask = (task: Task) => {
    rows.push({ kind: 'task', task, index: ++index });
    if (!collapsedTasks.includes(task.id)) for (const [i, subtask] of (task.subtasks ?? []).entries()) rows.push({ kind: 'subtask', task, subtask, index: `${index}.${i + 1}` });
  };
  const byGroup = new Map<string, Task[]>();
  for (const t of project.tasks) {
    const k = t.groupId ?? UNGROUPED;
    byGroup.set(k, [...(byGroup.get(k) ?? []), t]);
  }
  for (const g of project.groups) {
    const tasks = byGroup.get(g.id) ?? [];
    rows.push({ kind: 'group', group: g, tasks });
    if (!g.collapsed) for (const t of tasks) pushTask(t);
  }
  const loose = byGroup.get(UNGROUPED) ?? [];
  if (loose.length) {
    rows.push({ kind: 'group', group: null, tasks: loose });
    if (!collapsedUngrouped) for (const t of loose) pushTask(t);
  }
  return rows;
}

/** Khoảng ngày của một tập việc (bỏ việc chưa có ngày). */
export function spanOf(tasks: Task[]): { start: string; end: string } | null {
  let start: string | null = null, end: string | null = null;
  for (const t of tasks) {
    const s = t.startDate ?? t.endDate, e = t.endDate ?? t.startDate;
    if (!s || !e) continue;
    if (!start || s < start) start = s;
    if (!end || e > end) end = e;
  }
  return start && end ? { start, end } : null;
}

const isOverdue = (t: Task, today: string) => !!t.endDate && t.endDate < today && t.progress < 100;

export function Gantt({ project, today, view, dayWidth, canEdit, focus, onEditTask, onAddTask, onGroupMenu, onToggleGroup, collapsedTasks, onToggleTask, collapsedUngrouped, onToggleUngrouped, onChangeDates, onPatchTask, showBaseline = true, onReorder, fullscreen, onToggleFullscreen }: Props) {
  // Kéo thả hàng (ở ô số thứ tự): chưa di quá 4px thì coi là bấm -> mở chi tiết.
  type RowDrag = { task: Task; groupKey: string; x0: number; y0: number; active: boolean; overId: string | null; after: boolean };
  const [rowDrag, setRowDrag] = useState<RowDrag | null>(null);
  const beginRow = (e: RPointerEvent<HTMLElement>, t: Task) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setRowDrag({ task: t, groupKey: t.groupId ?? UNGROUPED, x0: e.clientX, y0: e.clientY, active: false, overId: null, after: false });
  };
  const moveRow = (e: RPointerEvent<HTMLElement>) => {
    if (!rowDrag) return;
    const active = rowDrag.active || Math.hypot(e.clientX - rowDrag.x0, e.clientY - rowDrag.y0) > 4;
    if (!active) return;
    if (!canEdit) { setRowDrag(null); return; }
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.taskRow) as HTMLElement | undefined;
    let overId: string | null = null, after = false;
    if (el && el.dataset.group === rowDrag.groupKey) {
      overId = el.dataset.taskRow!;
      const r = el.getBoundingClientRect();
      after = e.clientY > r.top + r.height / 2;
    }
    setRowDrag({ ...rowDrag, active: true, overId, after });
  };
  const endRow = (e: RPointerEvent<HTMLElement>) => {
    if (!rowDrag) return;
    const d = rowDrag;
    setRowDrag(null);
    e.stopPropagation();
    if (!d.active) { onEditTask(d.task); return; }
    if (!d.overId || d.overId === d.task.id) return;
    const ids = project.tasks.filter((t) => (t.groupId ?? UNGROUPED) === d.groupKey).map((t) => t.id).filter((id) => id !== d.task.id);
    const at = ids.indexOf(d.overId);
    if (at < 0) return;
    ids.splice(at + (d.after ? 1 : 0), 0, d.task.id);
    onReorder(d.groupKey === UNGROUPED ? null : d.groupKey, ids);
  };
  const rows = useMemo(() => buildRows(project, collapsedTasks, collapsedUngrouped), [project, collapsedTasks, collapsedUngrouped]);
  // Sửa tại chỗ: ô đang sửa; Enter lưu, Esc huỷ, Tab sang ô kế trong hàng.
  const [edit, setEdit] = useState<{ id: string; field: EditField } | null>(null);
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const t of project.tasks) for (const n of `${t.assignee},${t.support}`.split(',')) if (n.trim()) set.add(n.trim());
    for (const m of project.members) if (m.name) set.add(m.name);
    if (project.owner.name) set.add(project.owner.name);
    return [...set].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [project]);
  const commitEdit = (t: Task, field: EditField, raw: string) => {
    let patch: Partial<TaskInput> | null = null;
    switch (field) {
      case 'name': { const v = raw.trim(); if (v && v !== t.name) patch = { name: v }; break; }
      case 'assignee': case 'support': { const v = raw.trim(); if (v !== t[field]) patch = { [field]: v }; break; }
      case 'progress': { const n = Math.round(Number(raw.replace(',', '.').replace('%', ''))); if (Number.isFinite(n) && Math.max(0, Math.min(100, n)) !== t.progress) patch = { progress: Math.max(0, Math.min(100, n)) }; break; }
      case 'startDate': case 'endDate': { const v = raw || null; if (v !== t[field]) patch = { [field]: v }; break; }
      case 'days': { const str = raw.trim().replace(',', '.'); const v = str === '' ? null : Number(str); if (str !== '' && (!Number.isFinite(v!) || v! < 0)) return; if (v !== t.days) patch = { days: v }; break; }
    }
    if (patch) onPatchTask(t, patch);
  };
  const nextField = (t: Task, field: EditField) => setEdit({ id: t.id, field: FIELD_ORDER[(FIELD_ORDER.indexOf(field) + 1) % FIELD_ORDER.length] });
  const editable = (t: Task, field: EditField) => canEdit && edit?.id === t.id && edit.field === field;
  const startEdit = (t: Task, field: EditField) => (e: React.MouseEvent) => { if (field === 'progress' && t.subtasks?.length) return; if (!canEdit) return; e.stopPropagation(); setEdit({ id: t.id, field }); };
  const inputFor = (t: Task, field: EditField, type: 'text' | 'number' | 'date', value: string, extra: Record<string, unknown> = {}) => (
    <InlineInput key={`${t.id}-${field}`} type={type} value={value} list={field === 'assignee' || field === 'support' ? 'gantt-names' : undefined} {...extra}
      onCommit={(v) => { setEdit(null); commitEdit(t, field, v); }} onCancel={() => setEdit(null)} onNext={(v) => { commitEdit(t, field, v); nextField(t, field); }} />
  );

  // Khoảng ngày của lưới: bắt đầu từ ngày 1 của tháng chứa mốc sớm nhất (việc sớm nhất;
  // chưa có việc thì ngày bắt đầu dự án; không có gì thì hôm nay), tới sau mốc muộn nhất
  // 2 tuần, tối thiểu 10 tuần, tối đa 2 năm.
  const range = useMemo(() => {
    const span = spanOf(project.tasks);
    const anchor = span?.start ?? project.startDate ?? today;
    const first = anchor < today ? anchor : today;
    const lasts = [span?.end, today, project.startDate].filter((x): x is string => !!x);
    const last = lasts.reduce((a, b) => (a > b ? a : b));
    const start = `${first.slice(0, 7)}-01`;
    let end = addDays(mondayOf(last), 7 * 3 - 1);
    if (diffDays(start, end) < 70) end = addDays(start, 69);
    if (diffDays(start, end) > 730) end = addDays(start, 730);
    return { start, end, days: diffDays(start, end) + 1 };
  }, [project.tasks, project.startDate, today]);

  const days = useMemo(() => Array.from({ length: range.days }, (_, i) => addDays(range.start, i)), [range]);
  const weeks = useMemo(() => {
    const out: { start: string; count: number }[] = [];
    for (let i = 0; i < days.length;) {
      const count = Math.min(7 - ((weekday(days[i]) + 6) % 7), days.length - i);
      out.push({ start: days[i], count });
      i += count;
    }
    return out;
  }, [days]);

  const shell = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active || !box.current) return;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const textWidth = (text: string, el: Element | null, fallback: string) => {
        const style = el ? getComputedStyle(el) : null;
        ctx.font = style?.font || fallback;
        const spacing = parseFloat(style?.letterSpacing || '0') || 0;
        return ctx.measureText(text).width + spacing * text.length;
      };
      const widths: Record<string, string> = {};
      const fit = (key: string, selector: string, values: string[], min = 0, max = 160) => {
        const head = box.current!.querySelector(`.gantt-head ${selector}`);
        const cell = box.current!.querySelector(`[data-task-row] ${selector}`);
        const header = textWidth((head?.textContent ?? '').toLocaleUpperCase('vi'), head, '700 10.5px sans-serif');
        const content = Math.max(0, ...values.map((v) => textWidth(v, cell, '12px sans-serif')));
        widths[`--col-${key}`] = `${Math.ceil(Math.min(max, Math.max(min, header + 14, content + 14)))}px`;
      };
      fit('asg', '.c-asg', project.tasks.flatMap((t) => [t.assignee, ...(t.subtasks ?? []).map((s) => s.assignee)]));
      fit('sup', '.c-sup', project.tasks.map((t) => t.support));
      fit('start', '.c-start', project.tasks.map((t) => fmtShort(t.startDate)));
      fit('end', '.c-end', project.tasks.map((t) => fmtShort(t.endDate)));
      // Huy hiệu gia hạn nằm cùng ô ngày kết thúc.
      const badge = Math.max(0, ...project.tasks.map((t) => { const shift = planShift(t); return shift ? 16 + String(shift.end || '↔').length * 7 : 0; }));
      widths['--col-end'] = `${parseInt(widths['--col-end']) + badge}px`;
      fit('days', '.c-days', project.tasks.map((t) => fmtNum(effortOf(t, project))));
      widths['--col-progress'] = '76px';
      setColumnWidths(widths);
    };
    measure();
    void document.fonts.ready.then(measure);
    return () => { active = false; };
  }, [project, view]);

  const [split, setSplit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('project:gantt-split'));
      if (saved >= 0.2 && saved <= 0.85) return saved;
    } catch { /* riêng tư */ }
    return 0.6;
  });
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const el = shell.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { localStorage.setItem('project:gantt-split', String(split)); } catch { /* riêng tư */ }
  }, [split]);
  const minLeft = Math.min(240, width * 0.52);
  const maxLeft = Math.max(minLeft, width - Math.min(320, width * 0.42));
  const leftWidth = Math.round(Math.max(minLeft, Math.min(maxLeft, width * split)));
  const density = leftWidth >= 900 ? 'wide' : leftWidth >= 620 ? 'full' : leftWidth >= 540 ? 'medium' : leftWidth >= 440 ? 'compact' : leftWidth >= 300 ? 'tight' : 'narrow';
  const resizeSplit = (pixels: number) => {
    if (width) setSplit(Math.max(0.2, Math.min(0.85, Math.max(minLeft, Math.min(maxLeft, pixels)) / width)));
  };
  const previousDayWidth = useRef(dayWidth);
  // Giữ nguyên ngày ở mép trái khi phóng/thu lịch.
  useLayoutEffect(() => {
    if (box.current) box.current.scrollLeft *= dayWidth / previousDayWidth.current;
    previousDayWidth.current = dayWidth;
  }, [dayWidth]);
  const x = (d: string) => (dayNumber(d) - dayNumber(range.start)) * dayWidth;

  // Lần đầu hiển thị đủ đầu tháng; các nút điều hướng vẫn tới ngày được yêu cầu.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (view !== 'gantt') { el.scrollTo({ left: 0 }); return; }
    const target = !focus.tick ? range.start : focus.date >= range.start && focus.date <= range.end ? focus.date : today;
    el.scrollTo({ left: Math.max(0, x(target) - dayWidth * 2), behavior: focus.tick ? 'smooth' : 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.tick, view, range.start]);

  // ---- kéo thanh: di chuyển hoặc kéo dài/ngắn
  type Drag = { task: Task; mode: 'move' | 'l' | 'r'; x0: number; delta: number; start: string; end: string };
  const [drag, setDrag] = useState<Drag | null>(null);
  const begin = (e: RPointerEvent<HTMLElement>, task: Task, mode: Drag['mode']) => {
    if (!canEdit || e.button !== 0) return;
    const start = task.startDate ?? task.endDate!, end = task.endDate ?? task.startDate!;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ task, mode, x0: e.clientX, delta: 0, start, end });
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / dayWidth);
    if (delta !== drag.delta) setDrag({ ...drag, delta });
  };
  const finish = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    e.stopPropagation();
    if (d.delta === 0) {
      if (d.mode === 'move') onEditTask(d.task); // bấm không kéo = mở sửa
      return;
    }
    const { start, end } = dragged(d);
    if (start !== d.start || end !== d.end) onChangeDates(d.task, start, end);
  };
  const dragged = (d: Drag) => {
    if (d.mode === 'move') return { start: addDays(d.start, d.delta), end: addDays(d.end, d.delta) };
    if (d.mode === 'l') return { start: fromDayNumber(Math.min(dayNumber(d.start) + d.delta, dayNumber(d.end))), end: d.end };
    return { start: d.start, end: fromDayNumber(Math.max(dayNumber(d.end) + d.delta, dayNumber(d.start))) };
  };

  const list = view === 'list';
  const dayCells = (rowKey: string) => (
    <>
      {days.map((d) => {
        const wd = weekday(d);
        return <span key={`${rowKey}-${d}`} className={cx('gantt-day', (wd === 0 || wd === 6) && 'weekend', d === today && 'today', d.endsWith('-01') && 'month-start')} />;
      })}
    </>
  );

  return (
    <div ref={shell} className={cx('gantt-shell', resizing && 'resizing')} style={{ ['--left' as string]: `${leftWidth}px` }}>
    <div ref={box} data-density={density} className={cx('gantt', list && 'list')} style={{ ...columnWidths, ['--day' as string]: `${dayWidth}px` }} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => setDrag(null)}>
      {/* ---- đầu bảng */}
      <div className="gantt-head border-b border-line">
        <div className="gantt-row">
          <div className="gantt-left h-full items-stretch">
            <div className="c-no flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">#</div>
            <div className="flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Việc</div>
            <div className="c-asg flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Phụ trách</div>
            <div className="c-sup flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Hỗ trợ</div>
            <div className="flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Tiến độ</div>
            <div className="c-start flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Bắt đầu</div>
            <div className="c-end flex h-full items-end px-2 pb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">Kết thúc</div>
            <div className="c-days flex h-full items-end px-2 pb-1.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-muted">Ngày</div>
          </div>
          {!list && (
            <div className="gantt-days flex-col" style={{ backgroundImage: 'none' }}>
              <div className="flex">
                {weeks.map((w) => (
                  <div key={w.start} className="shrink-0 overflow-hidden border-l border-line px-2 pt-2 text-[11px] font-semibold whitespace-nowrap text-ink-2" style={{ width: w.count * dayWidth }}>
                    {w.count >= 3 ? `${fmtDayMonth(w.start)} – ${fmtDayMonth(addDays(w.start, w.count - 1))}${w.start.slice(0, 4) !== today.slice(0, 4) || w.start.slice(5, 7) === '01' ? ` ${w.start.slice(0, 4)}` : ''}` : ''}
                  </div>
                ))}
              </div>
              <div className="flex">
                {days.map((d) => {
                  const wd = weekday(d);
                  return (
                    <div key={d} className={cx('gantt-day flex flex-col items-center justify-end pb-1.5 text-center leading-none', (wd === 0 || wd === 6) && 'weekend', d === today && 'today', d.endsWith('-01') && 'month-start')}>
                      {/* Mồng 1 ghi kèm tháng (1/12) khi cột đủ rộng để đánh dấu sang tháng mới. */}
                      <span className={cx('num font-bold', d === today ? 'rounded-full bg-primary px-1.5 py-0.5 text-on-primary' : d.endsWith('-01') ? 'text-primary' : 'text-ink', d.endsWith('-01') && dayWidth >= 26 ? 'text-[10.5px]' : 'text-[11.5px]')}>{d.endsWith('-01') && dayWidth >= 26 ? `1/${Number(d.slice(5, 7))}` : Number(d.slice(8))}</span>
                      <span className="mt-0.5 text-[9px] font-semibold text-muted">{WEEKDAY_SHORT[wd]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---- thân bảng */}
      {rows.map((r) => {
        if (r.kind === 'group') {
          const g = r.group;
          const key = g?.id ?? UNGROUPED;
          const span = spanOf(r.tasks);
          const avg = r.tasks.length ? Math.round(r.tasks.reduce((s, t) => s + t.progress, 0) / r.tasks.length) : 0;
          // Ngày có việc của nhóm: việc chạy song song chỉ tính một lần (không cộng dồn từng việc).
          const totalDays = coveredDays(r.tasks, project.satWeight, project.sunWeight);
          const collapsed = g ? !!g.collapsed : collapsedUngrouped;
          const toggleGroup = () => g ? onToggleGroup(g, !collapsed) : onToggleUngrouped(!collapsed);
          return (
            <div key={`g-${key}`} className="gantt-row gantt-group border-b border-line">
              <div className="gantt-left min-h-9 gantt-group-left">
                <div className="c-no flex items-center justify-center">
                  <IconButton label={collapsed ? 'Mở nhóm' : 'Thu gọn nhóm'} className="h-7 w-7 rounded-lg" onClick={toggleGroup}>
                      {collapsed ? <CaretRight size={14} weight="bold" /> : <CaretDown size={14} weight="bold" />}
                    </IconButton>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 px-2">
                  <button type="button" className="min-w-0 line-clamp-2 break-words text-left text-[13px] font-extrabold leading-snug tracking-tight hover:text-primary" title={g ? g.name : undefined} onClick={toggleGroup}>
                    {g ? g.name : 'Chưa phân nhóm'}
                  </button>
                  <span className="num shrink-0 text-[11px] font-semibold text-muted">{r.tasks.length}</span>
                  {canEdit && (
                    <span className="ml-auto flex shrink-0 items-center">
                      <IconButton label="Thêm việc vào nhóm" className="h-7 w-7 rounded-lg" onClick={() => onAddTask(g?.id ?? null)}><Plus size={14} weight="bold" /></IconButton>
                      {g && <IconButton label="Tuỳ chọn nhóm" className="h-7 w-7 rounded-lg" onClick={(e) => onGroupMenu(g, e.currentTarget)}><DotsThree size={16} weight="bold" /></IconButton>}
                    </span>
                  )}
                </div>
                <div className="c-asg" />
                <div className="c-sup" />
                <div className="num px-2 text-[12px] font-bold text-ink-2">{r.tasks.length ? `${avg}%` : ''}</div>
                <div className="c-start num px-2 text-[12px] text-muted">{span ? fmtShort(span.start) : ''}</div>
                <div className="c-end num px-2 text-[12px] text-muted">{span ? fmtShort(span.end) : ''}</div>
                <div className="c-days num px-2 text-right text-[12px] font-bold text-ink-2" title="Số ngày công có việc trong nhóm; ngày có nhiều việc gối nhau chỉ tính một lần">{totalDays ? fmtNum(totalDays) : ''}</div>
              </div>
              {!list && (
                <div className="gantt-days min-h-9">
                  {dayCells(`g-${key}`)}
                  {span && (
                    <span className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ left: x(span.start) + 2, width: (diffDays(span.start, span.end) + 1) * dayWidth - 4, background: 'var(--fill-2)' }} />
                  )}
                </div>
              )}
            </div>
          );
        }
        if (r.kind === 'subtask') return <SubtaskRow key={`sub-${r.subtask.id}`} parent={r.task} subtask={r.subtask} index={r.index} canEdit={canEdit} onPatch={onPatchTask}>
          {!list && <div className="gantt-days min-h-10">{dayCells(`sub-${r.subtask.id}`)}</div>}
        </SubtaskRow>;
        const t = r.task;
        const late = isOverdue(t, today);
        const effort = effortOf(t, project);
        const d = drag?.task.id === t.id ? dragged(drag) : null;
        const start = d?.start ?? t.startDate ?? t.endDate;
        const end = d?.end ?? t.endDate ?? t.startDate;
        const color = t.progress >= 100 ? 'var(--ok)' : project.color;
        const shift = planShift(t);
        return (
          <div key={t.id} data-task-row={t.id} data-group={t.groupId ?? UNGROUPED} className={cx('gantt-row group border-b border-line last:border-b-0 hover:bg-fill/40', rowDrag?.active && rowDrag.task.id === t.id && 'is-dragging', rowDrag?.active && rowDrag.overId === t.id && (rowDrag.after ? 'drop-after' : 'drop-before'))}>
            <div className={cx('gantt-left min-h-10 py-1.5', !canEdit && 'cursor-pointer')} onClick={canEdit ? undefined : () => onEditTask(t)} onDoubleClick={canEdit ? () => onEditTask(t) : undefined} role={canEdit ? undefined : 'button'} tabIndex={canEdit ? undefined : 0} onKeyDown={canEdit ? undefined : (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onEditTask(t))}>
              <button type="button" className={cx('c-no group/no relative mx-auto flex h-7 w-7 items-center justify-center rounded-lg text-[12px] text-muted hover:bg-fill hover:text-ink', canEdit && 'cursor-grab active:cursor-grabbing')} title={canEdit ? 'Bấm: mở chi tiết · Kéo: đổi thứ tự trong nhóm' : 'Mở chi tiết'} style={{ touchAction: 'none' }}
                onPointerDown={(e) => beginRow(e, t)} onPointerMove={moveRow} onPointerUp={endRow} onPointerCancel={() => setRowDrag(null)} onClick={(e) => e.stopPropagation()}>
                <span className="num group-hover/no:hidden">{r.index}</span>
                <DotsSixVertical size={16} weight="bold" className="hidden group-hover/no:block" />
              </button>
              <div className={cx('flex min-w-0 items-center gap-1.5 px-2', canEdit && 'cursor-text')} onClick={startEdit(t, 'name')}>
                {!!t.subtasks?.length && <button type="button" className="flex h-5 w-4 shrink-0 items-center justify-center rounded text-primary hover:bg-fill"
                  aria-label={collapsedTasks.includes(t.id) ? 'Mở rộng task con' : 'Thu gọn task con'} aria-expanded={!collapsedTasks.includes(t.id)}
                  onClick={(e) => { e.stopPropagation(); onToggleTask(t.id); }} onDoubleClick={(e) => e.stopPropagation()}>
                  {collapsedTasks.includes(t.id) ? <CaretRight size={12} /> : <CaretDown size={12} />}
                </button>}
                {t.progress >= 100 && !editable(t, 'name') && <CheckCircle size={15} weight="fill" className="shrink-0 text-ok" aria-label="Đã xong" />}
                {editable(t, 'name') ? <InlineTaskName value={t.name} onCommit={(v) => { setEdit(null); commitEdit(t, 'name', v); }} onCancel={() => setEdit(null)} onNext={(v) => { commitEdit(t, 'name', v); nextField(t, 'name'); }} /> : <div className="min-w-0 flex-1"><TaskName text={t.name} completed={t.progress >= 100} />

                </div>}
                {late && !editable(t, 'name') && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="Quá hạn" />}
              </div>
              <div className={cx('c-asg min-w-0 px-2 text-[12px] text-ink-2', canEdit && 'cursor-text')} title={t.assignee} onClick={startEdit(t, 'assignee')}>
                {editable(t, 'assignee') ? inputFor(t, 'assignee', 'text', t.assignee) : <span className="block truncate">{t.assignee || (canEdit ? <span className="text-muted/60">—</span> : '')}</span>}
              </div>
              <div className={cx('c-sup min-w-0 px-2 text-[12px] text-muted', canEdit && 'cursor-text')} title={t.support} onClick={startEdit(t, 'support')}>
                {editable(t, 'support') ? inputFor(t, 'support', 'text', t.support) : <span className="block truncate">{t.support || (canEdit ? <span className="text-muted/60">—</span> : '')}</span>}
              </div>
              <div className={cx('flex items-center gap-2 px-2', canEdit && 'cursor-text')} onClick={startEdit(t, 'progress')}>
                {editable(t, 'progress') ? inputFor(t, 'progress', 'number', String(t.progress), { min: 0, max: 100, step: 5 }) : (
                  <>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full" style={{ width: `${t.progress}%`, background: color }} /></span>
                    <span className="num w-8 shrink-0 text-right text-[12px] font-semibold">{t.progress}%</span>
                  </>
                )}
              </div>
              <div className={cx('c-start num px-2 text-[12px]', t.startDate ? 'text-ink-2' : 'text-muted', canEdit && 'cursor-text')} onClick={startEdit(t, 'startDate')}>
                {editable(t, 'startDate') ? inputFor(t, 'startDate', 'date', t.startDate ?? '') : fmtShort(t.startDate)}
              </div>
              <div className={cx('c-end num flex items-center gap-1 px-2 text-[12px]', late ? 'font-semibold text-danger' : t.endDate ? 'text-ink-2' : 'text-muted', canEdit && 'cursor-text')} onClick={startEdit(t, 'endDate')}>
                {editable(t, 'endDate') ? inputFor(t, 'endDate', 'date', t.endDate ?? '', { min: t.startDate ?? undefined }) : (
                  <>
                    {fmtShort(t.endDate)}
                    {shift && <span className={cx('rounded px-1 text-[10px] font-bold leading-4', shift.end > 0 ? 'bg-warning-soft text-warning' : 'bg-ok-soft text-ok')} title={`Kế hoạch gốc ${fmtShort(t.baselineStart)} → ${fmtShort(t.baselineEnd)}; ${shift.end > 0 ? `gia hạn ${shift.end} ngày` : shift.end < 0 ? `rút ngắn ${-shift.end} ngày` : 'dời ngày bắt đầu'}`}>
                      {shift.end > 0 ? `+${shift.end}` : shift.end < 0 ? `${shift.end}` : '↔'}
                    </span>}
                  </>
                )}
              </div>
              <div className={cx('c-days num px-2 text-right text-[12px]', t.days == null ? 'text-muted' : 'font-semibold text-ink-2', canEdit && 'cursor-text')} title={t.days == null ? 'Tự tính từ ngày bắt đầu/kết thúc — gõ số để nhập tay, xoá trống để tự tính' : 'Ngày công nhập tay'} onClick={startEdit(t, 'days')}>
                {editable(t, 'days') ? inputFor(t, 'days', 'text', t.days == null ? '' : String(t.days).replace('.', ','), { placeholder: effort ? fmtNum(effort) : '' }) : (effort ? fmtNum(effort) : '')}
              </div>
            </div>
            {!list && (
              <div className="gantt-days min-h-10">
                {dayCells(t.id)}
                {showBaseline && shift && t.baselineStart && t.baselineEnd && (
                  <span className="gantt-baseline" style={{ left: x(t.baselineStart) + 1, width: (diffDays(t.baselineStart, t.baselineEnd) + 1) * dayWidth - 2 }} title={`Kế hoạch gốc ${fmtShort(t.baselineStart)} → ${fmtShort(t.baselineEnd)} · hiện tại ${fmtShort(t.startDate)} → ${fmtShort(t.endDate)} (${shift.end > 0 ? `gia hạn ${shift.end} ngày` : shift.end < 0 ? `rút ngắn ${-shift.end} ngày` : 'dời ngày'})`} />
                )}
                {start && end && (
                  <div
                    className={cx('gantt-bar', late && 'ring-2 ring-danger/70', !canEdit && 'cursor-default')}
                    style={{ left: x(start) + 1, width: (diffDays(start, end) + 1) * dayWidth - 2, background: color, opacity: d ? 0.85 : 1 }}
                    title={`${t.name} · ${fmtShort(start)} → ${fmtShort(end)} · ${t.progress}%`}
                    onPointerDown={(e) => begin(e, t, 'move')}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="fill" style={{ width: `${t.progress}%` }} />
                    {(diffDays(start, end) + 1) * dayWidth > 56 && <span className="label flex h-full items-center">{t.progress}%{d ? ` · ${fmtShort(start)} → ${fmtShort(end)}` : ''}</span>}
                    {canEdit && <span className="gantt-handle l" onPointerDown={(e) => begin(e, t, 'l')} />}
                    {canEdit && <span className="gantt-handle r" onPointerDown={(e) => begin(e, t, 'r')} />}
                  </div>
                )}
                {start && end && (diffDays(start, end) + 1) * dayWidth <= 56 && (
                  <span className="gantt-bar-out" style={{ left: x(end) + dayWidth + 4 }}>{t.progress}%{d ? ` · ${fmtShort(start)} → ${fmtShort(end)}` : ''}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
      <datalist id="gantt-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      {!rows.length && <div className="px-6 py-12 text-center text-sm text-muted">Chưa có việc nào. Thêm nhóm việc rồi thêm việc, hoặc dán từ bảng tính.</div>}
    </div>
    {!list && <div
      className="gantt-splitter"
      role="separator"
      aria-label="Đổi độ rộng bảng việc và lịch"
      aria-orientation="vertical"
      aria-valuemin={Math.round(minLeft)}
      aria-valuemax={Math.round(maxLeft)}
      aria-valuenow={leftWidth}
      tabIndex={0}
      title="Kéo để đổi độ rộng bảng việc · Nhấp đúp để đặt lại"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setResizing(true);
      }}
      onPointerMove={(e) => {
        if (resizing && shell.current) resizeSplit(e.clientX - shell.current.getBoundingClientRect().left);
      }}
      onPointerUp={(e) => {
        setResizing(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => setResizing(false)}
      onLostPointerCapture={() => setResizing(false)}
      onDoubleClick={() => setSplit(0.6)}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        resizeSplit(e.key === 'Home' ? minLeft : e.key === 'End' ? maxLeft : leftWidth + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 50 : 10));
      }}
    ><span /></div>}
    {onToggleFullscreen && (
      <button type="button" className={cx('gantt-max', fullscreen && 'on')} aria-pressed={!!fullscreen} title={fullscreen ? 'Thoát toàn màn hình (Esc)' : 'Phóng to cả bảng ra toàn màn hình'} onClick={onToggleFullscreen}>
        {fullscreen ? <CornersIn size={14} weight="bold" /> : <CornersOut size={14} weight="bold" />}
      </button>
    )}
    </div>
  );
}

/** Ngày công hiển thị: nhập tay thì lấy, không thì tính từ khoảng ngày theo trọng số dự án. */
export function effortOf(t: Task, p: { satWeight: number; sunWeight: number }) {
  if (t.days != null) return t.days;
  if (t.startDate && t.endDate) return workDays(t.startDate, t.endDate, p.satWeight, p.sunWeight);
  return 0;
}


/** Ô nhập tại chỗ: tự focus, Enter lưu, Esc huỷ, Tab lưu rồi sang ô kế; blur cũng lưu (một lần). */
function InlineInput({ type, value, list, onCommit, onCancel, onNext, ...rest }: {
  type: 'text' | 'number' | 'date'; value: string; list?: string;
  onCommit: (v: string) => void; onCancel: () => void; onNext: (v: string) => void;
} & Record<string, unknown>) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (type === 'text' || type === 'number') el.select();
  }, [type]);
  const finish = (fn: () => void) => { if (done.current) return; done.current = true; fn(); };
  return (
    <input
      ref={ref}
      type={type}
      list={list}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(() => onCommit(v))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(() => onCommit(v)); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(onCancel); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(() => onNext(v)); }
      }}
      className="gantt-input"
      {...rest}
    />
  );
}

/** Enter lưu; Shift+Enter xuống dòng trong tên việc. */
function InlineTaskName({ value, onCommit, onCancel, onNext }: {
  value: string; onCommit: (value: string) => void; onCancel: () => void; onNext: (value: string) => void;
}) {
  const [valueNow, setValueNow] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [valueNow]);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (fn: () => void) => { if (!done.current) { done.current = true; fn(); } };
  return <textarea ref={ref} value={valueNow} rows={1} maxLength={300}
    aria-label="Tên việc" title="Enter để lưu · Shift+Enter để xuống dòng"
    className="gantt-input min-w-0 flex-1 resize-none overflow-hidden"
    onChange={(e) => setValueNow(e.target.value)}
    onClick={(e) => e.stopPropagation()}
    onBlur={() => finish(() => onCommit(valueNow))}
    onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(() => onCommit(valueNow)); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(onCancel); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(() => onNext(valueNow)); }
    }} />;
}

/** Giữ hàng Gantt gọn; vẫn xem được đầy đủ tên và các dòng mô tả. */
function TaskName({ text, completed }: { text: string; completed: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > parseFloat(getComputedStyle(el).lineHeight) * 3 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return <div className="min-w-0 flex-1">
    <span ref={ref} className={cx('gantt-task-name min-w-0 whitespace-pre-wrap break-words text-[13px] font-medium leading-snug', expanded ? 'block' : 'line-clamp-3', completed && 'text-ink-2')} title={text}>{text}</span>
    {long && <button type="button" className="block text-[11px] font-semibold leading-5 text-primary hover:underline" aria-expanded={expanded}
      onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {expanded ? 'Thu gọn' : 'Xem thêm'}
    </button>}
  </div>;
}

function SubtaskRow({ parent, subtask, index, canEdit, onPatch, children }: {
  parent: Task; subtask: Subtask; index: string; canEdit: boolean;
  onPatch: Props['onPatchTask']; children: React.ReactNode;
}) {
  const [editing, setEditing] = useState<'name' | 'assignee' | 'progress' | null>(null);
  const commit = (field: 'name' | 'assignee' | 'progress', value: string) => {
    setEditing(null);
    const v = field === 'progress' ? Math.max(0, Math.min(100, Math.round(Number(value)))) : value.trim();
    if (field === 'name' && !v || typeof v === 'number' && !Number.isFinite(v)) return;
    if (v !== subtask[field]) onPatch(parent, { subtasks: (parent.subtasks ?? []).map((s) => s.id === subtask.id ? { ...s, [field]: v } : s) });
  };
  const edit = (field: 'name' | 'assignee' | 'progress') => { if (canEdit) setEditing(field); };
  return <div className="gantt-row border-b border-line" data-subtask-row={subtask.id}>
    <div className="gantt-left min-h-10 bg-fill/30 py-1.5 text-[13px]">
      <span className="c-no num text-center text-[11px] text-muted">{index}</span>
      {/* Task con: thụt lề tên vào một chút, cùng cỡ chữ với task cha cho dễ đọc. */}
      <div className="flex min-w-0 items-center pl-5" onClick={() => edit('name')}>
        {editing === 'name' ? <InlineTaskName value={subtask.name} onCommit={(v) => commit('name', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('name', v)} /> : <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" title={subtask.name}>{subtask.name}</span>}
      </div>
      <div className="c-asg min-w-0" onClick={() => edit('assignee')}>
        {editing === 'assignee' ? <InlineInput type="text" value={subtask.assignee} list="gantt-names" onCommit={(v) => commit('assignee', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('assignee', v)} /> : <span className="block truncate" title={subtask.assignee}>{subtask.assignee || '—'}</span>}
      </div>
      <span className="c-sup" />
      <div className="flex items-center gap-2" onClick={() => edit('progress')}>
        {editing === 'progress' ? <InlineInput type="number" value={String(subtask.progress)} min={0} max={100} onCommit={(v) => commit('progress', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('progress', v)} /> : <><span className="h-1 flex-1 rounded bg-fill"><span className="block h-full rounded bg-primary" style={{ width: `${subtask.progress}%` }} /></span><span className="num w-8 shrink-0 text-right">{subtask.progress}%</span></>}
      </div>
      <span className="c-start text-muted" title="Lịch do task cha quản lý">—</span>
      <span className="c-end text-muted" title="Lịch do task cha quản lý">—</span>
      <span className="c-days text-right text-muted" title="Ngày công được tính ở task cha">—</span>
    </div>
    {children}
  </div>;
}
