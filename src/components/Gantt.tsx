import { CaretDown, CaretRight, CheckCircle, CornersIn, CornersOut, DotsSixVertical, DotsThree, DownloadSimple, Plus } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { planShift, type Group, type ProjectDetail, type Task, type TaskInput, type Subtask } from '../lib/api';
import { addDays, coveredDays, dayNumber, diffDays, fmtDayMonth, fmtShort, fmtNum, fromDayNumber, mondayOf, WEEKDAY_SHORT, weekday, workDays } from '../lib/dates';
import { cx, IconButton } from './ui';
import { ScopeChip } from './ScopesEditor';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';

export type GanttView = 'gantt' | 'list';

/** Chỗ được bấm chuột phải trên bảng. */
export type MenuTarget =
  | { kind: 'task'; task: Task; field?: string; date?: string }
  | { kind: 'subtask'; task: Task; subtask: Subtask }
  | { kind: 'group'; group: Group | null; tasks: Task[] }
  | { kind: 'blank'; date?: string };

type Props = {
  /** Menu chuột phải: trang dự án trả danh sách thao tác cho chỗ được bấm. */
  menuFor?: (t: MenuTarget) => MenuItem[];
  /** Nút điều khiển đặt ở khoảng trống đầu bảng (trên cột # / Việc). */
  headerTools?: React.ReactNode;
  /** Hiện nhãn phạm vi trên tên việc (mặc định có). */
  showScopes?: boolean;
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
  /** Tải Excel kế hoạch của riêng nhóm (không truyền = ẩn nút). */
  onDownloadGroup?: (g: Group) => void;
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
  /** Kéo thả đổi thứ tự nhóm: danh sách id nhóm theo thứ tự mới. */
  onReorderGroups?: (ids: string[]) => void;
  /** Đang phóng to cả bảng ra toàn màn hình; có hàm thì hiện nút ở góc bảng. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export type EditField = 'name' | 'assignee' | 'support' | 'progress' | 'startDate' | 'endDate' | 'days';
const FIELD_ORDER: EditField[] = ['name', 'assignee', 'support', 'progress', 'startDate', 'endDate', 'days'];

type Row = { kind: 'group'; group: Group | null; tasks: Task[] } | { kind: 'task'; task: Task; index: number; child?: boolean } | { kind: 'subtask'; task: Task; subtask: Subtask; index: string };

export const UNGROUPED = '__none__';

/** Hàng hiển thị: mỗi nhóm một hàng tóm tắt, rồi các việc (nếu nhóm không thu gọn); việc chưa phân nhóm xếp cuối. */
export function buildRows(project: ProjectDetail, collapsedTasks: string[] = [], collapsedUngrouped = false): Row[] {
  const rows: Row[] = [];
  let index = 0;
  const pushTask = (task: Task, child = false) => {
    rows.push({ kind: 'task', task, index: ++index, child });
    if (!collapsedTasks.includes(task.id)) for (const [i, subtask] of (task.subtasks ?? []).entries()) rows.push({ kind: 'subtask', task, subtask, index: `${index}.${i + 1}` });
  };
  const byGroup = new Map<string, Task[]>();
  for (const t of project.tasks) {
    const k = t.groupId ?? UNGROUPED;
    byGroup.set(k, [...(byGroup.get(k) ?? []), t]);
  }
  // Việc con (có việc cha cùng nhóm) xếp ngay sau việc cha, giữ thứ tự trong nhóm.
  const pushTree = (tasks: Task[]) => {
    const ids = new Set(tasks.map((t) => t.id));
    const isChild = (t: Task) => !!t.parentTaskId && ids.has(t.parentTaskId);
    for (const t of tasks) {
      if (isChild(t)) continue;
      pushTask(t);
      for (const c of tasks) if (c.parentTaskId === t.id) pushTask(c, true);
    }
  };
  for (const g of project.groups) {
    const tasks = byGroup.get(g.id) ?? [];
    rows.push({ kind: 'group', group: g, tasks });
    if (!g.collapsed) pushTree(tasks);
  }
  const loose = byGroup.get(UNGROUPED) ?? [];
  if (loose.length) {
    rows.push({ kind: 'group', group: null, tasks: loose });
    if (!collapsedUngrouped) pushTree(loose);
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

export function Gantt({ project, today, view, dayWidth, canEdit, focus, onEditTask, onAddTask, onGroupMenu, onDownloadGroup, onToggleGroup, collapsedTasks, onToggleTask, collapsedUngrouped, onToggleUngrouped, onChangeDates, onPatchTask, showBaseline = true, onReorder, onReorderGroups, fullscreen, onToggleFullscreen, menuFor, showScopes = true, headerTools }: Props) {
  const [menu, setMenu] = useState<MenuState>(null);
  // Kéo thả task con (ở số 1.1) trong cùng task cha; bấm không kéo thì không làm gì.
  type SubDrag = { parent: Task; parentId: string; id: string; y0: number; active: boolean; overId: string | null; after: boolean };
  const [subDrag, setSubDrag] = useState<SubDrag | null>(null);
  const beginSub = (e: RPointerEvent<HTMLElement>, parent: Task, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSubDrag({ parent, parentId: parent.id, id, y0: e.clientY, active: false, overId: null, after: false });
  };
  const moveSub = (e: RPointerEvent<HTMLElement>) => {
    if (!subDrag) return;
    if (!subDrag.active && Math.abs(e.clientY - subDrag.y0) <= 4) return;
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.subtaskRow) as HTMLElement | undefined;
    let overId: string | null = null, after = false;
    if (el && el.dataset.parent === subDrag.parentId) { overId = el.dataset.subtaskRow!; const r = el.getBoundingClientRect(); after = e.clientY > r.top + r.height / 2; }
    setSubDrag({ ...subDrag, active: true, overId, after });
  };
  const endSub = (e: RPointerEvent<HTMLElement>) => {
    if (!subDrag) return;
    const d = subDrag;
    setSubDrag(null);
    e.stopPropagation();
    if (!d.active || !d.overId || d.overId === d.id) return;
    const list = [...(d.parent.subtasks ?? [])];
    const moving = list.find((s) => s.id === d.id);
    if (!moving) return;
    const rest = list.filter((s) => s.id !== d.id);
    const at = rest.findIndex((s) => s.id === d.overId);
    if (at < 0) return;
    rest.splice(at + (d.after ? 1 : 0), 0, moving);
    onPatchTask(d.parent, { subtasks: rest });
  };
  // Kéo thả nhóm (ở ô mũi tên của hàng nhóm): chưa di quá 4px thì coi là bấm -> thu/mở nhóm.
  type GroupDrag = { id: string; y0: number; active: boolean; overId: string | null; after: boolean; toggle: () => void };
  const [groupDrag, setGroupDrag] = useState<GroupDrag | null>(null);
  const beginGroup = (e: RPointerEvent<HTMLElement>, id: string, toggle: () => void) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGroupDrag({ id, y0: e.clientY, active: false, overId: null, after: false, toggle });
  };
  const moveGroup = (e: RPointerEvent<HTMLElement>) => {
    if (!groupDrag) return;
    if (!groupDrag.active && Math.abs(e.clientY - groupDrag.y0) <= 4) return;
    if (!canEdit || !onReorderGroups) { setGroupDrag(null); return; }
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.groupRow) as HTMLElement | undefined;
    let overId: string | null = null, after = false;
    if (el) { overId = el.dataset.groupRow!; const r = el.getBoundingClientRect(); after = e.clientY > r.top + r.height / 2; }
    setGroupDrag({ ...groupDrag, active: true, overId, after });
  };
  const endGroup = (e: RPointerEvent<HTMLElement>) => {
    if (!groupDrag) return;
    const d = groupDrag;
    setGroupDrag(null);
    e.stopPropagation();
    if (!d.active) { d.toggle(); return; }
    if (!d.overId || d.overId === d.id || !onReorderGroups) return;
    const ids = project.groups.map((x) => x.id).filter((x) => x !== d.id);
    const at = ids.indexOf(d.overId);
    if (at < 0) return;
    ids.splice(at + (d.after ? 1 : 0), 0, d.id);
    onReorderGroups(ids);
  };
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
  const compactRef = useRef(false);
  // Màn hẹp (điện thoại): ô sửa tại chỗ quá nhỏ để chạm và cột số bị ẩn -> chạm vào hàng là mở chi tiết việc.
  const startEdit = (t: Task, field: EditField) => (e: React.MouseEvent) => {
    if (field === 'progress' && t.subtasks?.length) return; if (!canEdit) return; e.stopPropagation(); setEdit({ id: t.id, field });
  };
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
  const compact = width > 0 && width < 640;
  compactRef.current = compact;
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
  // Điện thoại: bảng việc tối thiểu ~60% bề ngang để tên việc không bị bẻ vụn; lịch vẫn kéo xem được.
  const minLeft = width > 0 && width < 640 ? width * 0.6 : Math.min(240, width * 0.52);
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
    // Mở trang / F5: luôn về hôm nay (nếu hôm nay nằm trong lịch), còn lại về ngày được yêu cầu.
    const inRange = (d: string) => d >= range.start && d <= range.end;
    const target = inRange(focus.date) ? focus.date : inRange(today) ? today : range.start;
    el.scrollTo({ left: Math.max(0, x(target) - dayWidth * 2), behavior: focus.tick ? 'smooth' : 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.tick, view, range.start, width > 0]);

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

  // Việc trong tuần này (T2–CN chứa hôm nay): khoảng ngày giao với tuần và chưa xong -> tô nổi trên bảng.
  const weekStart = mondayOf(today), weekEnd = addDays(mondayOf(today), 6);
  const inWeek = (t: Task) => {
    const s0 = t.startDate ?? t.endDate, e0 = t.endDate ?? t.startDate;
    return !!s0 && !!e0 && t.progress < 100 && s0 <= weekEnd && e0 >= weekStart;
  };
  // ---- menu chuột phải: xác định chỗ được bấm (việc / ô nào / ngày nào trên lịch, task con, nhóm, vùng trống)
  const onContext = (e: React.MouseEvent) => {
    if (!menuFor || e.shiftKey) return; // Shift + chuột phải = menu gốc của trình duyệt
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, select')) return;
    e.preventDefault();
    const daysEl = el.closest('.gantt-days') as HTMLElement | null;
    let date: string | undefined;
    if (daysEl && view === 'gantt') {
      const idx = Math.floor((e.clientX - daysEl.getBoundingClientRect().left) / dayWidth);
      if (idx >= 0 && idx < range.days) date = addDays(range.start, idx);
    }
    let target: MenuTarget = { kind: 'blank', date };
    const sub = el.closest('[data-subtask-row]') as HTMLElement | null;
    const row = el.closest('[data-task-row]') as HTMLElement | null;
    const grp = el.closest('[data-group-key]') as HTMLElement | null;
    if (sub) {
      const task = project.tasks.find((t) => t.id === sub.dataset.parent);
      const subtask = task?.subtasks?.find((s) => s.id === sub.dataset.subtaskRow);
      if (task && subtask) target = { kind: 'subtask', task, subtask };
    } else if (row) {
      const task = project.tasks.find((t) => t.id === row.dataset.taskRow);
      if (task) target = { kind: 'task', task, field: (el.closest('[data-field]') as HTMLElement | null)?.dataset.field, date };
    } else if (grp) {
      const key = grp.dataset.groupKey;
      const group = key === UNGROUPED ? null : project.groups.find((g) => g.id === key) ?? null;
      target = { kind: 'group', group, tasks: project.tasks.filter((t) => (t.groupId ?? UNGROUPED) === key) };
    }
    const items = menuFor(target);
    // Ô cụ thể của việc: thêm "Sửa ô này" (giống bấm đúp) lên đầu.
    if (target.kind === 'task' && target.field && canEdit && !compact) {
      const t = target.task, f = target.field as EditField;
      if (!(f === 'progress' && t.subtasks?.length)) items.unshift({ label: 'Sửa ô này', hint: 'Bấm đúp', onSelect: () => setEdit({ id: t.id, field: f }) }, 'sep');
    }
    const title = target.kind === 'task' ? target.task.name : target.kind === 'subtask' ? target.subtask.name : target.kind === 'group' ? target.group?.name ?? 'Chưa phân nhóm' : undefined;
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items, title: title && title.length > 48 ? `${title.slice(0, 46)}…` : title });
  };
  const scopeById = useMemo(() => new Map((project.scopes ?? []).map((s) => [s.id, s])), [project.scopes]);
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
    <div ref={box} onContextMenu={onContext} data-density={density} className={cx('gantt', list && 'list', !!headerTools && 'has-tools')} style={{ ...columnWidths, ['--day' as string]: `${dayWidth}px` }} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => setDrag(null)}>
      {/* ---- đầu bảng */}
      <div className="gantt-head border-b border-line">
        <div className="gantt-row">
          <div className="gantt-left h-full items-stretch">
            {headerTools && <div className="gantt-tools" onDoubleClick={(e) => e.stopPropagation()}>{headerTools}</div>}
            <div className="c-no flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">#</div>
            <div className="flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Việc</div>
            <div className="c-asg flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Phụ trách</div>
            <div className="c-sup flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Hỗ trợ</div>
            <div className="flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Tiến độ</div>
            <div className="c-start flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Bắt đầu</div>
            <div className="c-end flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Kết thúc</div>
            <div className="c-days flex h-full items-end px-2 pb-1.5 text-right text-[10.5px] font-semibold uppercase tracking-wider text-muted">Ngày</div>
            <div className="c-note flex h-full items-end px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Ghi chú</div>
          </div>
          {!list && (
            <div className="gantt-days flex-col" style={{ backgroundImage: 'none' }}>
              <div className="flex">
                {weeks.map((w) => (
                  <div key={w.start} className="shrink-0 overflow-hidden border-l border-line px-2 pt-2 text-[11px] font-semibold whitespace-nowrap text-muted" style={{ width: w.count * dayWidth }}>
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
            <div key={`g-${key}`} data-group-key={key} data-group-row={g?.id} className={cx('gantt-row gantt-group border-b border-line', groupDrag?.active && groupDrag.id === g?.id && 'is-dragging', groupDrag?.active && g && groupDrag.overId === g.id && (groupDrag.after ? 'drop-after' : 'drop-before'))}>
              <div className="gantt-left min-h-9 gantt-group-left">
                <div className="c-no flex items-center justify-center">
                  <IconButton label={collapsed ? 'Mở nhóm' : 'Thu gọn nhóm'} title={g && canEdit && onReorderGroups ? 'Bấm: thu/mở nhóm · Kéo: đổi thứ tự nhóm' : undefined} className={cx('!h-7 !w-7', g && canEdit && onReorderGroups && 'cursor-grab active:cursor-grabbing')} style={{ touchAction: 'none' }}
                    onPointerDown={g ? (e) => beginGroup(e, g.id, toggleGroup) : undefined} onPointerMove={g ? moveGroup : undefined} onPointerUp={g ? endGroup : undefined} onPointerCancel={() => setGroupDrag(null)}
                    onClick={g ? (e) => e.stopPropagation() : toggleGroup}>
                      {collapsed ? <CaretRight size={14} weight="bold" /> : <CaretDown size={14} weight="bold" />}
                    </IconButton>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 px-2">
                  <button type="button" className="min-w-0 line-clamp-2 break-words text-left text-[13px] font-bold leading-snug tracking-tight hover:text-primary" title={g ? g.name : undefined} onClick={toggleGroup}>
                    {g ? g.name : 'Chưa phân nhóm'}
                  </button>
                  <span className="num shrink-0 text-[11px] font-semibold text-muted">{r.tasks.length}</span>
                  {(canEdit || (g && onDownloadGroup) || menuFor) && (
                    <span className="ml-auto flex shrink-0 items-center">
                      {canEdit && <IconButton label="Thêm việc vào nhóm" className="g-add !h-7 !w-7" onClick={() => onAddTask(g?.id ?? null)}><Plus size={14} weight="bold" /></IconButton>}
                      {/* "⋯" mở cùng menu thao tác nhóm như chuột phải (tải Excel, sắp xếp, Getfly, đổi thứ tự, sửa/xoá) thay cho hàng nút rời. */}
                      {menuFor ? (
                        <IconButton label="Tuỳ chọn nhóm" className="!h-7 !w-7" onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const items = menuFor({ kind: 'group', group: g, tasks: r.tasks });
                          if (items.length) setMenu({ x: rect.left, y: rect.bottom + 6, items, title: g ? (g.name.length > 48 ? `${g.name.slice(0, 46)}…` : g.name) : 'Chưa phân nhóm' });
                        }}><DotsThree size={16} weight="bold" /></IconButton>
                      ) : (
                        <>
                          {g && onDownloadGroup && r.tasks.length > 0 && <IconButton label={`Tải Excel kế hoạch nhóm ${g.name}`} className="!h-7 !w-7" onClick={() => onDownloadGroup(g)}><DownloadSimple size={14} weight="bold" /></IconButton>}
                          {canEdit && g && <IconButton label="Tuỳ chọn nhóm" className="!h-7 !w-7" onClick={(e) => onGroupMenu(g, e.currentTarget)}><DotsThree size={16} weight="bold" /></IconButton>}
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className="c-asg" />
                <div className="c-sup" />
                <div className="num px-2 text-[12px] font-bold text-ink-2">{r.tasks.length ? `${avg}%` : ''}</div>
                <div className="c-start num px-2 text-[12px] text-muted">{span ? fmtShort(span.start) : ''}</div>
                <div className="c-end num px-2 text-[12px] text-muted">{span ? fmtShort(span.end) : ''}</div>
                <div className="c-days num px-2 text-right text-[12px] font-bold text-ink-2" title="Số ngày công của nhóm (ngày trùng chỉ tính một lần)">{totalDays ? fmtNum(totalDays) : ''}</div>
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
        if (r.kind === 'subtask') return <SubtaskRow key={`sub-${r.subtask.id}`} parent={r.task} subtask={r.subtask} index={r.index} canEdit={canEdit} onPatch={onPatchTask} onOpen={compact ? () => onEditTask(r.task) : undefined}
          drag={subDrag?.active && subDrag.parentId === r.task.id ? (subDrag.id === r.subtask.id ? 'is-dragging' : subDrag.overId === r.subtask.id ? (subDrag.after ? 'drop-after' : 'drop-before') : undefined) : undefined}
          handle={canEdit ? { onPointerDown: (e) => beginSub(e, r.task, r.subtask.id), onPointerMove: moveSub, onPointerUp: endSub, onPointerCancel: () => setSubDrag(null) } : undefined}>
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
          <div key={t.id} data-task-row={t.id} data-group={t.groupId ?? UNGROUPED} className={cx('gantt-row group border-b border-line last:border-b-0 hover:bg-fill/40', inWeek(t) && 'this-week', rowDrag?.active && rowDrag.task.id === t.id && 'is-dragging', rowDrag?.active && rowDrag.overId === t.id && (rowDrag.after ? 'drop-after' : 'drop-before'))}>
            <div className={cx('gantt-left min-h-10 py-1.5', (!canEdit || compact) && 'cursor-pointer')} onClick={canEdit && !compact ? undefined : () => onEditTask(t)} role={canEdit ? undefined : 'button'} tabIndex={canEdit ? undefined : 0} onKeyDown={canEdit ? undefined : (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onEditTask(t))}>
              <button type="button" className={cx('c-no group/no relative flex h-7 w-full items-center justify-start rounded-full pl-1.5 text-[12px] text-muted hover:bg-fill hover:text-ink', canEdit && 'cursor-grab active:cursor-grabbing')} title={canEdit ? 'Bấm: mở chi tiết · Kéo: đổi thứ tự trong nhóm' : 'Mở chi tiết'} style={{ touchAction: 'none' }}
                onPointerDown={(e) => beginRow(e, t)} onPointerMove={moveRow} onPointerUp={endRow} onPointerCancel={() => setRowDrag(null)} onClick={(e) => e.stopPropagation()}>
                <span className="num group-hover:hidden">{r.index}</span>
                <DotsSixVertical size={16} weight="bold" className="hidden group-hover:block" />
              </button>
              {/* Việc con: thụt vào + một vạch dọc mảnh nối về việc cha (không dùng ký tự └). */}
              <div className={cx('flex min-w-0 items-center gap-1.5 px-2', r.child && 'ml-3 border-l-2 border-line pl-3', canEdit && 'cursor-text')} data-field="name" onDoubleClick={startEdit(t, 'name')}>
                {!!t.subtasks?.length && <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-primary hover:bg-fill"
                  aria-label={collapsedTasks.includes(t.id) ? 'Mở rộng task con' : 'Thu gọn task con'} aria-expanded={!collapsedTasks.includes(t.id)}
                  onClick={(e) => { e.stopPropagation(); onToggleTask(t.id); }} onDoubleClick={(e) => e.stopPropagation()}>
                  {collapsedTasks.includes(t.id) ? <CaretRight size={12} /> : <CaretDown size={12} />}
                </button>}
                {/* Phạm vi đứng đầu (trước dấu xong và tên). */}
                {showScopes && t.scopeId && scopeById.get(t.scopeId) && !editable(t, 'name') && <ScopeChip scope={scopeById.get(t.scopeId)!} className="shrink-0 self-start mt-px" />}
                {t.progress >= 100 && !editable(t, 'name') && <CheckCircle size={15} weight="fill" className="shrink-0 text-ok" aria-label="Đã xong" />}
                {editable(t, 'name') ? <InlineTaskName value={t.name} onCommit={(v) => { setEdit(null); commitEdit(t, 'name', v); }} onCancel={() => setEdit(null)} onNext={(v) => { commitEdit(t, 'name', v); nextField(t, 'name'); }} /> : <div className="min-w-0 flex-1"><TaskName text={t.name} completed={t.progress >= 100} />

                </div>}
                {late && !editable(t, 'name') && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="Quá hạn" />}
              </div>
              <div className={cx('c-asg min-w-0 px-2 text-[12px] text-ink-2', canEdit && 'cursor-text')} title={t.assignee} data-field="assignee" onDoubleClick={startEdit(t, 'assignee')}>
                {editable(t, 'assignee') ? inputFor(t, 'assignee', 'text', t.assignee) : <span className="block truncate">{t.assignee || (canEdit ? <span className="text-muted/60">—</span> : '')}</span>}
              </div>
              <div className={cx('c-sup min-w-0 px-2 text-[12px] text-muted', canEdit && 'cursor-text')} title={t.support} data-field="support" onDoubleClick={startEdit(t, 'support')}>
                {editable(t, 'support') ? inputFor(t, 'support', 'text', t.support) : <span className="block truncate">{t.support || (canEdit ? <span className="text-muted/60">—</span> : '')}</span>}
              </div>
              <div className={cx('flex items-center gap-2 px-2', canEdit && 'cursor-text')} data-field="progress" onDoubleClick={startEdit(t, 'progress')}>
                {editable(t, 'progress') ? inputFor(t, 'progress', 'number', String(t.progress), { min: 0, max: 100, step: 5 }) : (
                  <>
                    <span className="prog-bar h-1.5 flex-1 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full" style={{ width: `${t.progress}%`, background: color }} /></span>
                    <span className="num w-8 shrink-0 text-right text-[12px] font-semibold">{t.progress}%</span>
                  </>
                )}
              </div>
              <div className={cx('c-start num px-2 text-[12px]', t.startDate ? 'text-ink-2' : 'text-muted', canEdit && 'cursor-text')} data-field="startDate" onDoubleClick={startEdit(t, 'startDate')}>
                {editable(t, 'startDate') ? inputFor(t, 'startDate', 'date', t.startDate ?? '') : fmtShort(t.startDate)}
              </div>
              <div className={cx('c-end num flex items-center gap-1 px-2 text-[12px]', late ? 'font-semibold text-danger' : t.endDate ? 'text-ink-2' : 'text-muted', canEdit && 'cursor-text')} data-field="endDate" onDoubleClick={startEdit(t, 'endDate')}>
                {editable(t, 'endDate') ? inputFor(t, 'endDate', 'date', t.endDate ?? '', { min: t.startDate ?? undefined }) : (
                  <>
                    {fmtShort(t.endDate)}
                    {shift && <span className={cx('rounded-full px-1.5 text-[10px] font-bold leading-4', shift.end > 0 ? 'bg-warning-soft text-warning' : 'bg-ok-soft text-ok')} title={`Kế hoạch gốc ${fmtShort(t.baselineStart)} → ${fmtShort(t.baselineEnd)}; ${shift.end > 0 ? `gia hạn ${shift.end} ngày` : shift.end < 0 ? `rút ngắn ${-shift.end} ngày` : 'dời ngày bắt đầu'}`}>
                      {shift.end > 0 ? `+${shift.end}` : shift.end < 0 ? `${shift.end}` : '↔'}
                    </span>}
                  </>
                )}
              </div>
              <div className={cx('c-days num px-2 text-right text-[12px]', t.days == null ? 'text-muted' : 'font-semibold text-ink-2', canEdit && 'cursor-text')} title={t.days == null ? 'Tự tính theo ngày — gõ số để nhập tay' : 'Ngày công nhập tay'} data-field="days" onDoubleClick={startEdit(t, 'days')}>
                {editable(t, 'days') ? inputFor(t, 'days', 'text', t.days == null ? '' : String(t.days).replace('.', ','), { placeholder: effort ? fmtNum(effort) : '' }) : (effort ? fmtNum(effort) : '')}
              </div>
              {/* Ghi chú nhiều dòng: chỉ hiện ở chế độ Danh sách; bấm để mở chi tiết và sửa. */}
              <div className="c-note min-w-0 cursor-pointer px-2 text-[12px] leading-snug text-ink-2" title={t.note || undefined} onClick={(e) => { e.stopPropagation(); onEditTask(t); }}>
                {t.note.trim() ? <span className="line-clamp-2 whitespace-pre-line break-words [overflow-wrap:anywhere]">{t.note.trim()}</span> : (canEdit ? <span className="text-muted/60">—</span> : '')}
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
                    className={cx('gantt-bar', late && 'late', t.progress >= 100 && 'done', d && 'dragging', !canEdit && 'cursor-default')}
                    style={{ left: x(start) + 1, width: (diffDays(start, end) + 1) * dayWidth - 2, ['--bar' as string]: color }}
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
    <ContextMenu state={menu} onClose={() => setMenu(null)} />
    {onToggleFullscreen && !list && (
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
/** Tên việc; `prefix` (nhãn phạm vi) đứng đầu dòng, cùng dòng với tên. */
function TaskName({ text, completed, prefix }: { text: string; completed: boolean; prefix?: React.ReactNode }) {
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
    <span ref={ref} className={cx('gantt-task-name min-w-0 whitespace-pre-wrap break-words text-[13px] font-medium leading-snug', expanded ? 'block' : 'line-clamp-3', completed && 'text-ink-2')} title={text}>{prefix}{text}</span>
    {long && <button type="button" className="block text-[11px] font-semibold leading-5 text-primary hover:underline" aria-expanded={expanded}
      onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {expanded ? 'Thu gọn' : 'Xem thêm'}
    </button>}
  </div>;
}

function SubtaskRow({ parent, subtask, index, canEdit, onPatch, children, drag, handle, onOpen }: {
  parent: Task; subtask: Subtask; index: string; canEdit: boolean;
  /** Màn hẹp: chạm task con là mở chi tiết task cha (nơi sửa task con). */
  onOpen?: () => void;
  onPatch: Props['onPatchTask']; children: React.ReactNode;
  drag?: string;
  handle?: Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
}) {
  const [editing, setEditing] = useState<'name' | 'assignee' | 'progress' | null>(null);
  const commit = (field: 'name' | 'assignee' | 'progress', value: string) => {
    setEditing(null);
    const v = field === 'progress' ? Math.max(0, Math.min(100, Math.round(Number(value)))) : value.trim();
    if (field === 'name' && !v || typeof v === 'number' && !Number.isFinite(v)) return;
    if (v !== subtask[field]) onPatch(parent, { subtasks: (parent.subtasks ?? []).map((s) => s.id === subtask.id ? { ...s, [field]: v } : s) });
  };
  const edit = (field: 'name' | 'assignee' | 'progress') => { if (onOpen) return; if (canEdit) setEditing(field); };
  return <div className={cx('gantt-row group/sub border-b border-line', drag)} data-subtask-row={subtask.id} data-parent={parent.id}>
    <div className="gantt-left min-h-10 bg-fill/30 py-1.5">
      {/* Số 1.1: rê chuột hiện tay kéo, kéo để đổi thứ tự task con trong task cha. */}
      <span className={cx('c-no flex h-7 w-full items-center rounded-full pl-1.5 text-[12px] text-muted', handle && 'cursor-grab hover:bg-fill hover:text-ink active:cursor-grabbing')} style={handle ? { touchAction: 'none' } : undefined}
        title={handle ? 'Kéo để đổi thứ tự task con' : undefined} {...handle}>
        <span className={cx('num', handle && 'group-hover/sub:hidden')}>{index}</span>
        {handle && <DotsSixVertical size={16} weight="bold" className="hidden group-hover/sub:block" />}
      </span>
      {/* Task con thụt vào sâu hơn tên task cha (cha: lề 6px + nút mũi tên 16px + khoảng cách 6px = 28px; con: 44px).
          Dùng style trực tiếp vì lớp padding của Tailwind nằm trong layer, bị rule `.gantt-left > *` đè. */}
      <div className={cx('flex min-w-0 items-center', canEdit && 'cursor-text')} style={{ paddingLeft: 44 }} onClick={onOpen} onDoubleClick={() => edit('name')}>
        {editing === 'name' ? <InlineTaskName value={subtask.name} onCommit={(v) => commit('name', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('name', v)} /> : <span className="min-w-0 whitespace-pre-wrap break-words text-[13px] font-medium leading-snug [overflow-wrap:anywhere]" title={subtask.name}>{subtask.name}</span>}
      </div>
      <div className={cx('c-asg min-w-0 px-2 text-[12px] text-ink-2', canEdit && 'cursor-text')} onClick={onOpen} onDoubleClick={() => edit('assignee')}>
        {editing === 'assignee' ? <InlineInput type="text" value={subtask.assignee} list="gantt-names" onCommit={(v) => commit('assignee', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('assignee', v)} /> : <span className="block truncate" title={subtask.assignee}>{subtask.assignee || <span className="text-muted/60">—</span>}</span>}
      </div>
      <span className="c-sup" />
      <div className={cx('flex items-center gap-2 px-2', canEdit && 'cursor-text')} onClick={onOpen} onDoubleClick={() => edit('progress')}>
        {editing === 'progress' ? <InlineInput type="number" value={String(subtask.progress)} min={0} max={100} onCommit={(v) => commit('progress', v)} onCancel={() => setEditing(null)} onNext={(v) => commit('progress', v)} /> : <><span className="prog-bar h-1.5 flex-1 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full bg-primary" style={{ width: `${subtask.progress}%` }} /></span><span className="num w-8 shrink-0 text-right text-[12px] font-semibold">{subtask.progress}%</span></>}
      </div>
      <span className="c-start px-2 text-[12px] text-muted/60" title="Lịch do task cha quản lý">—</span>
      <span className="c-end px-2 text-[12px] text-muted/60" title="Lịch do task cha quản lý">—</span>
      <span className="c-days px-2 text-right text-[12px] text-muted/60" title="Ngày công được tính ở task cha">—</span>
    </div>
    {children}
  </div>;
}
