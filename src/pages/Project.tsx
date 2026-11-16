import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowSquareOut, ArrowUp, ArrowsClockwise, ArrowsDownUp, ArrowsInLineVertical, ArrowsOutLineVertical, CalendarBlank, CaretLeft, CheckCircle, CircleNotch, ClockCounterClockwise, CloudArrowUp, Copy, CornersIn, CornersOut, CrosshairSimple, DownloadSimple, Flag, FolderPlus, FolderSimple, GearSix, ListPlus, Minus, PencilSimple, Percent, Plus, SortAscending, TableIcon, Tag, Trash, Users } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Gantt, spanOf, UNGROUPED, type GanttView, type MenuTarget } from '../components/Gantt';
import { CalendarView } from '../components/CalendarView';

type PageView = GanttView | 'calendar';
import type { MenuItem } from '../components/ContextMenu';
import { GetflyBox, GetflyReport, useGetflyJob, useGetflyStatus, type GetflyScope } from '../components/GetflyBox';
import { PhaseBar } from '../components/PhaseBar';
import { ImportSheet } from '../components/ImportSheet';
import { MembersSheet, ProjectSheet } from '../components/ProjectSheet';
import { TaskSheet } from '../components/TaskSheet';
import { ColumnPicker, normalizeColumns, type ColKey } from '../components/ColumnPicker';
import { Button, Chip, Empty, Field, IconButton, Input, PageHeader, Segmented, Sheet, Skeleton, useFeedback, cx } from '../components/ui';
import { api, canEditRole, planShift, ROLE_LABEL, useAction, useCan, useProject, type Group, type ProjectDetail, type Task, type TaskInput } from '../lib/api';
import { diffDays, fmtShort, todayStr } from '../lib/dates';

const pref = <T,>(key: string, fallback: T, ok: (v: unknown) => v is T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const savePref = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* riêng tư */ } };

export function ProjectPage() {
  const { id = '', phase: phaseKey } = useParams();
  const navigate = useNavigate();
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const q = useProject(id);
  const getfly = useGetflyStatus();
  const getflyJob = useGetflyJob(id);
  const qc = useQueryClient();
  const can = useCan();
  const { toast, confirm } = useFeedback();
  // Cập nhật thời gian thực + báo MCP: do useLiveEvents ở khung trang (Layout) lo cho mọi trang.
  const today = todayStr();
  const [view, setView] = useState<PageView>(() => pref('project:view', 'gantt', (v): v is PageView => v === 'gantt' || v === 'list' || v === 'calendar'));
  const [dayWidth, setDayWidth] = useState(() => pref('project:day', 30, (v): v is number => typeof v === 'number' && v >= 18 && v <= 60));
  const [focus, setFocus] = useState({ date: today, tick: 0 });
  const [showBaseline, setShowBaseline] = useState(() => pref('project:baseline', true, (v): v is boolean => typeof v === 'boolean'));
  useEffect(() => savePref('project:baseline', showBaseline), [showBaseline]);
  const [showScopes, setShowScopes] = useState(() => pref('project:scopes-visible', true, (v): v is boolean => typeof v === 'boolean'));
  useEffect(() => savePref('project:scopes-visible', showScopes), [showScopes]);
  // Toàn màn hình: thanh công cụ + cả bảng phủ kín cửa sổ (trên sidebar, dưới hộp thoại); Esc thoát, khoá cuộn trang.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Đang có hộp thoại / đang gõ trong ô nhập thì Esc thuộc về chúng, không thoát toàn màn hình.
      if (document.querySelector('[role="dialog"]') || (e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      setFull(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [full]);
  const [collapsed, setCollapsed] = useState<string[]>(() => pref(`project:${id}:collapsed`, [], (v): v is string[] => Array.isArray(v)));
  const [collapsedTasks, setCollapsedTasks] = useState<string[]>(() => pref(`project:${id}:collapsed-tasks`, [], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')));
  const [taskSheet, setTaskSheet] = useState<{ open: boolean; task?: Task | null; groupId?: string | null }>({ open: false });
  const [groupSheet, setGroupSheet] = useState<{ open: boolean; group?: Group | null }>({ open: false });
  const [settings, setSettings] = useState(false);
  const [getflyOpen, setGetflyOpen] = useState(false);
  const [members, setMembers] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => savePref('project:view', view), [view]);
  useEffect(() => savePref('project:day', dayWidth), [dayWidth]);
  useEffect(() => savePref(`project:${id}:collapsed`, collapsed), [collapsed, id]);
  useEffect(() => savePref(`project:${id}:collapsed-tasks`, collapsedTasks), [collapsedTasks, id]);

  const p = q.data;
  // Từ Tổng quan tới thẳng một việc: ?task=<id>.
  useEffect(() => {
    const tid = params.get('task');
    if (!tid || !p) return;
    const t = p.tasks.find((x) => x.id === tid);
    if (t) setTaskSheet({ open: true, task: t });
    setParams({}, { replace: true });
  }, [p, params, setParams]);

  // Thu gọn nhóm là sở thích riêng từng máy (không ghi server, người chỉ xem cũng gập được).
  // Lọc theo phạm vi: '' = tất cả, 'none' = chưa gắn, còn lại = id phạm vi. Nhớ theo dự án trên máy.
  const [scopeFilter, setScopeFilter] = useState(() => { try { return localStorage.getItem(`project:scope:${id}`) ?? ''; } catch { return ''; } });
  useEffect(() => { try { scopeFilter ? localStorage.setItem(`project:scope:${id}`, scopeFilter) : localStorage.removeItem(`project:scope:${id}`); } catch { /* riêng tư */ } }, [scopeFilter, id]);
  const activeScope = scopeFilter && scopeFilter !== 'none' && !p?.scopes?.some((s) => s.id === scopeFilter) ? '' : scopeFilter;
  // Phase đang xem: '' = tất cả, 'none' = chưa có phase, còn lại = id phase. Nhớ theo dự án trên máy.
  // Phase lấy từ đường dẫn /du-an/:id/phase/:phase ('all' = tất cả, 'none' = chưa có phase); đổi phase = đổi đường dẫn.
  const phaseFilter = phaseKey && phaseKey !== 'all' ? phaseKey : '';
  const setPhaseFilter = (v: string) => navigate(`/du-an/${id}/phase/${v || 'all'}${loc.search}`, { replace: true });
  const activePhase = phaseFilter && phaseFilter !== 'none' && !p?.phases?.some((x) => x.id === phaseFilter) ? '' : phaseFilter;
  const phaseTasks = useMemo(() => (!p ? [] : !activePhase ? p.tasks : p.tasks.filter((t) => (activePhase === 'none' ? !t.phaseId : t.phaseId === activePhase))), [p, activePhase]);
  const shown = useMemo<ProjectDetail | undefined>(() => p && {
    ...p,
    // Xem một phase: chỉ hiện nhóm có việc trong phase đó (và nhóm còn trống để thêm việc).
    groups: p.groups.filter((g) => !activePhase || phaseTasks.some((t) => t.groupId === g.id) || !p.tasks.some((t) => t.groupId === g.id)).map((g) => ({ ...g, collapsed: collapsed.includes(g.id) })),
    tasks: !activeScope ? phaseTasks : phaseTasks.filter((t) => (activeScope === 'none' ? !t.scopeId : t.scopeId === activeScope)),
  }, [p, collapsed, activeScope, activePhase, phaseTasks]);

  const editor = canEditRole(p?.myRole);
  const canTask = editor && can('project.task.write');
  const canStruct = editor && can('project.project.write');

  // Kéo thanh Gantt / sửa tại chỗ: cập nhật lạc quan để ô và thanh đứng yên chỗ vừa sửa.
  const patchTask = useMutation({
    mutationFn: (a: { task: Task; patch: Partial<TaskInput> }) => api<Task>(`/projects/${id}/tasks/${a.task.id}`, { method: 'PATCH', body: a.patch }),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: ['project', id] });
      const prev = qc.getQueryData<ProjectDetail>(['project', id]);
      if (prev) qc.setQueryData<ProjectDetail>(['project', id], { ...prev, tasks: prev.tasks.map((t) => { if (t.id !== a.task.id) return t; const next = { ...t, ...a.patch } as Task; if (next.subtasks?.length) next.progress = Math.round(next.subtasks.reduce((sum, s) => sum + s.progress, 0) / next.subtasks.length); return next; }) });
      return { prev };
    },
    onError: (e, _a, ctx) => { if (ctx?.prev) qc.setQueryData(['project', id], ctx.prev); toast((e as Error).message, 'error'); },
    onSettled: () => qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' }),
  });
  // Kéo thả đổi thứ tự trong nhóm: đổi vị trí trong cache ngay, server lưu sort.
  // Kéo thả đổi thứ tự nhóm: đổi trong cache ngay, server lưu sort.
  const reorderGroups = useMutation({
    mutationFn: (ids: string[]) => api(`/projects/${id}/groups/order`, { method: 'PUT', body: { ids } }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['project', id] });
      const prev = qc.getQueryData<ProjectDetail>(['project', id]);
      if (prev) {
        const byId = new Map(prev.groups.map((g) => [g.id, g]));
        qc.setQueryData<ProjectDetail>(['project', id], { ...prev, groups: ids.map((x) => byId.get(x)).filter((g): g is Group => !!g) });
      }
      return { prev };
    },
    onError: (e, _a, ctx) => { if (ctx?.prev) qc.setQueryData(['project', id], ctx.prev); toast((e as Error).message, 'error'); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  });
  const reorder = useMutation({
    mutationFn: (a: { groupId: string | null; ids: string[] }) => api(`/projects/${id}/tasks/order`, { method: 'PUT', body: a }),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: ['project', id] });
      const prev = qc.getQueryData<ProjectDetail>(['project', id]);
      if (prev) {
        const inGroup = new Map(prev.tasks.filter((t) => (t.groupId ?? null) === a.groupId).map((t) => [t.id, t]));
        const ordered = a.ids.map((x) => inGroup.get(x)).filter((t): t is Task => !!t);
        let k = 0;
        qc.setQueryData<ProjectDetail>(['project', id], { ...prev, tasks: prev.tasks.map((t) => ((t.groupId ?? null) === a.groupId ? ordered[k++] ?? t : t)) });
      }
      return { prev };
    },
    onError: (e, _a, ctx) => { if (ctx?.prev) qc.setQueryData(['project', id], ctx.prev); toast((e as Error).message, 'error'); },
    onSettled: () => qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' }),
  });
  const sortByDate = useAction((groupId?: string | null) => api<{ moved: number }>(`/projects/${id}/tasks/sort`, { method: 'POST', body: groupId === undefined ? {} : { groupId } }), { onSuccess: (r) => toast(r.moved ? `Đã sắp xếp lại ${r.moved} việc theo ngày` : 'Thứ tự đã đúng theo ngày') });
  const sortAll = async () => {
    if (await confirm({ title: 'Sắp xếp mọi nhóm theo ngày?', desc: <p>Các nhóm xếp theo ngày bắt đầu sớm nhất của việc trong nhóm; việc trong từng nhóm xếp theo ngày bắt đầu (trống xếp cuối), rồi kết thúc, rồi tên. Thứ tự tay hiện tại sẽ mất.</p>, ok: 'Sắp xếp' })) sortByDate.mutate(undefined);
  };
  const [exportCols, setExportCols] = useState<ColKey[] | null>(null);
  const saveCols = useAction((cols: ColKey[]) => api(`/projects/${id}`, { method: 'PATCH', body: { exportColumns: cols } }), { onSuccess: () => toast('Đã lưu cột xuất cho dự án') });

  const syncSheet = useMutation({
    mutationFn: () => api<{ sheetUrl: string }>(`/projects/${id}/sheet/sync`, { method: 'POST', body: {} }),
    onSuccess: () => { toast('Đã đồng bộ sang Google Sheet'); qc.invalidateQueries({ queryKey: ['project', id] }); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  if (q.isPending) return <div><Skeleton className="mb-5 h-16 max-w-md" /><Skeleton className="h-[480px]" /></div>;
  if (!p || !shown) {
    return (
      <div>
        <PageHeader title="Không tìm thấy dự án" sub="Dự án không tồn tại hoặc bạn không được mời." />
        <Link to="/du-an" className="text-sm font-semibold text-primary">← Về danh sách dự án</Link>
      </div>
    );
  }
  // Số liệu đầu trang theo phase đang xem.
  const curPhase = p.phases?.find((x) => x.id === activePhase) ?? null;
  const span = spanOf(phaseTasks);
  const done = phaseTasks.filter((t) => t.progress >= 100).length;
  const overdue = phaseTasks.filter((t) => t.endDate && t.endDate < today && t.progress < 100).length;
  const avg = phaseTasks.length ? Math.round(phaseTasks.reduce((s, t) => s + t.progress, 0) / phaseTasks.length) : 0;

  // ---- Cụm nút điều khiển đặt ở khoảng trống đầu bảng (trên cột # / Việc).
  const parentsWithSubs = p.tasks.filter((t) => t.subtasks?.length).map((t) => t.id);
  const allSubsCollapsed = parentsWithSubs.length > 0 && parentsWithSubs.every((x) => collapsedTasks.includes(x));
  // IconButton mặc định h-9 w-9: cx không gộp lớp Tailwind, nên dùng ! để cỡ nhỏ thắng.
  const tb = '!h-7 !w-7 !rounded-lg';
  const scopeTools = (<>
        {!!p.scopes?.length && (
          <span className="inline-flex items-center gap-1">
            <select aria-label="Lọc theo phạm vi" value={activeScope} onChange={(e) => setScopeFilter(e.target.value)}
              className={cx('h-7 max-w-[180px] rounded-xl border bg-card px-2.5 text-[12px] font-semibold outline-none transition focus:border-primary', activeScope ? 'border-primary text-primary' : 'border-line text-ink-2')}>
              <option value="">Mọi phạm vi</option>
              {p.scopes.map((s) => <option key={s.id} value={s.id}>{s.name}{s.owner ? ` · ${s.owner}` : ''}</option>)}
              <option value="none">Chưa gắn phạm vi</option>
            </select>
            <IconButton label={showScopes ? 'Ẩn nhãn phạm vi' : 'Hiện nhãn phạm vi'} aria-pressed={showScopes} className={cx(tb, showScopes && 'bg-fill text-primary')} onClick={() => setShowScopes((v) => !v)}><Tag size={18} weight={showScopes ? 'fill' : 'regular'} /></IconButton>
          </span>
        )}
  </>);
  const actionTools = (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          {getfly.data?.configured && editor && can('project.project.write') && (
            <IconButton
              className={tb}
              label={getflyJob.running ? `Đang chạy Getfly ${getflyJob.progress}` : !p.getflyCreatorId ? 'Thiết lập đồng bộ Getfly' : p.getflySyncedAt ? `Đồng bộ Getfly (lần cuối ${new Date(p.getflySyncedAt).toLocaleString('vi-VN')})` : 'Đồng bộ Getfly'}
              disabled={getflyJob.running}
              onClick={() => {
                // Chưa chọn người tạo thì mở hộp cấu hình Getfly; xong rồi thì bấm là đồng bộ (chuột phải để mở cấu hình).
                if (!p.getflyCreatorId) { setGetflyOpen(true); return; }
                getflyJob.sync();
              }}
              onContextMenu={(e) => { e.preventDefault(); setGetflyOpen(true); }}
            >
              <CloudArrowUp size={18} className={getflyJob.running ? 'animate-pulse text-primary' : undefined} />
            </IconButton>
          )}
          {getflyJob.running && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-primary" role="status" aria-live="polite">
              <CircleNotch size={13} className="animate-spin" /> Getfly {getflyJob.progress || '…'}
            </span>
          )}
          {p.sheetUrl && editor && can('project.project.write') && (
            <IconButton className={tb} label="Đồng bộ Sheets" onClick={() => syncSheet.mutate()} disabled={syncSheet.isPending} title={p.sheetSyncedAt ? `Đồng bộ Sheets · lần cuối ${new Date(p.sheetSyncedAt).toLocaleString('vi-VN')}` : 'Đồng bộ Sheets'}>
              <ArrowsClockwise size={18} className={syncSheet.isPending ? 'animate-spin' : undefined} />
            </IconButton>
          )}
          {can('project.data.export') && <IconButton className={tb} label="Xuất" onClick={() => setExportOpen(true)}><DownloadSimple size={18} /></IconButton>}
          {canTask && p.tasks.length > 1 && <IconButton className={tb} label="Sắp xếp theo ngày" onClick={sortAll} disabled={sortByDate.isPending} title="Sắp xếp việc trong từng nhóm theo ngày bắt đầu"><SortAscending size={18} /></IconButton>}
          {canStruct && <IconButton className={tb} label="Thêm nhóm" onClick={() => setGroupSheet({ open: true, group: null })}><FolderPlus size={18} /></IconButton>}
          {canTask && <Button size="sm" className="!h-7 !w-7 !rounded-lg !px-0" aria-label="Thêm việc" title="Thêm việc" onClick={() => setTaskSheet({ open: true, task: null, groupId: p.groups[0]?.id ?? null })}><ListPlus size={18} /></Button>}
        </span>
  );
  const headerTools = (
    <>
      {view === 'gantt' && (
        <>
          <IconButton label="Về hôm nay" className={tb} onClick={() => setFocus({ date: today, tick: focus.tick + 1 })}><CrosshairSimple size={16} /></IconButton>
          <IconButton label="Đầu tháng" className={tb} onClick={() => setFocus({ date: `${today.slice(0, 7)}-01`, tick: focus.tick + 1 })}><CalendarBlank size={16} /></IconButton>
          {p.startDate && <IconButton label="Đầu dự án" className={cx(tb, 'hidden md:inline-flex')} onClick={() => setFocus({ date: p.startDate!, tick: focus.tick + 1 })}><Flag size={16} /></IconButton>}
          <IconButton label={showBaseline ? 'Ẩn kế hoạch gốc' : 'Hiện kế hoạch gốc'} className={cx(tb, 'hidden md:inline-flex', showBaseline && 'bg-fill text-primary')} onClick={() => setShowBaseline((v) => !v)} aria-pressed={showBaseline}><ClockCounterClockwise size={16} /></IconButton>
          <span className="mx-0.5 inline-flex items-center rounded-lg bg-fill p-0.5">
            <IconButton label="Thu nhỏ lịch" className="!h-6 !w-6 !rounded-md" onClick={() => setDayWidth((w) => Math.max(18, w - 4))} disabled={dayWidth <= 18}><Minus size={13} weight="bold" /></IconButton>
            <IconButton label="Phóng to lịch" className="!h-6 !w-6 !rounded-md" onClick={() => setDayWidth((w) => Math.min(60, w + 4))} disabled={dayWidth >= 60}><Plus size={13} weight="bold" /></IconButton>
          </span>
        </>
      )}
      {parentsWithSubs.length > 0 && (
        <IconButton label={allSubsCollapsed ? 'Mở rộng tất cả task con' : 'Thu gọn tất cả task con'} className={tb} onClick={() => setCollapsedTasks(allSubsCollapsed ? [] : parentsWithSubs)}>
          {allSubsCollapsed ? <ArrowsOutLineVertical size={16} /> : <ArrowsInLineVertical size={16} />}
        </IconButton>
      )}
      <span className="ml-auto inline-flex shrink-0 items-center gap-2">{scopeTools}{actionTools}</span>
    </>
  );

  // ---- Menu chuột phải trên bảng: thao tác theo chỗ được bấm.
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', id] });
  const ask = async (title: string, desc: string, ok: string) => confirm({ title, desc: <p>{desc}</p>, ok, danger: true });
  const setDone = (t: Task, done: boolean) => t.subtasks?.length
    ? patchTask.mutate({ task: t, patch: { subtasks: t.subtasks.map((s) => ({ ...s, progress: done ? 100 : 0 })) } })
    : patchTask.mutate({ task: t, patch: { progress: done ? 100 : 0 } });
  const groupIds = (gid: string | null) => p.tasks.filter((x) => (x.groupId ?? null) === gid).map((x) => x.id);
  const moveInGroup = (t: Task, where: 'top' | 'bottom' | 'up' | 'down') => {
    const ids = groupIds(t.groupId ?? null);
    const i = ids.indexOf(t.id);
    ids.splice(i, 1);
    const at = where === 'top' ? 0 : where === 'bottom' ? ids.length : where === 'up' ? Math.max(0, i - 1) : Math.min(ids.length, i + 1);
    ids.splice(at, 0, t.id);
    reorder.mutate({ groupId: t.groupId ?? null, ids });
  };
  const duplicate = async (t: Task) => {
    try {
      const body: TaskInput = { name: `${t.name} (bản sao)`, groupId: t.groupId, scopeId: t.scopeId ?? null, assignee: t.assignee, support: t.support, progress: 0, startDate: t.startDate, endDate: t.endDate, days: t.days, note: t.note, subtasks: (t.subtasks ?? []).map((s) => ({ ...s, id: crypto.randomUUID(), progress: 0 })) };
      await api(`/projects/${id}/tasks`, { method: 'POST', body });
      toast('Đã nhân bản việc');
      refresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const removeTask = async (t: Task) => {
    if (!(await ask('Xoá việc này?', `“${t.name}” sẽ bị xoá khỏi dự án. Không hoàn tác được.`, 'Xoá việc'))) return;
    try { await api(`/projects/${id}/tasks/${t.id}`, { method: 'DELETE' }); toast('Đã xoá việc'); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const rebaseline = async (t: Task) => {
    try { await api(`/projects/${id}/tasks/${t.id}/rebaseline`, { method: 'POST', body: {} }); toast('Đã chốt kế hoạch gốc mới'); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const moveGroup = (g: Group, dir: -1 | 1) => {
    const ids = p.groups.map((x) => x.id);
    const i = ids.indexOf(g.id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderGroups.mutate(ids);
  };
  const toggleCollapse = (gid: string, c: boolean) => setCollapsed((xs) => (c ? [...new Set([...xs, gid])] : xs.filter((x) => x !== gid)));
  const blankItems = (date?: string): MenuItem[] => [
    ...(canTask ? [{ label: 'Thêm việc', icon: <Plus size={14} />, onSelect: () => setTaskSheet({ open: true, task: null, groupId: p.groups[0]?.id ?? null }) }] : []),
    ...(canStruct ? [{ label: 'Thêm nhóm', icon: <FolderPlus size={14} />, onSelect: () => setGroupSheet({ open: true, group: null }) }] : []),
    ...(canTask || canStruct ? ['sep' as const] : []),
    { label: 'Về hôm nay', icon: <CrosshairSimple size={14} />, onSelect: () => setFocus({ date: today, tick: focus.tick + 1 }) },
    ...(date ? [{ label: `Cuộn tới ${fmtShort(date)}`, icon: <CalendarBlank size={14} />, onSelect: () => setFocus({ date, tick: focus.tick + 1 }) }] : []),
    { label: 'Thu gọn mọi nhóm', icon: <ArrowsInLineVertical size={14} />, onSelect: () => setCollapsed([...p.groups.map((g) => g.id), UNGROUPED]) },
    { label: 'Mở mọi nhóm', icon: <ArrowsOutLineVertical size={14} />, onSelect: () => setCollapsed([]) },
    ...(canTask && p.tasks.length > 1 ? ['sep' as const, { label: 'Sắp xếp tất cả theo ngày', icon: <SortAscending size={14} />, onSelect: () => void sortAll() }] : []),
    'sep', { label: full ? 'Thoát toàn màn hình' : 'Toàn màn hình', icon: full ? <CornersIn size={14} /> : <CornersOut size={14} />, hint: full ? 'Esc' : undefined, onSelect: () => setFull((v) => !v) },
  ];
  const getflyItems = (scope: GetflyScope, label: string, groupId: string | null): MenuItem[] => {
    if (!getfly.data?.configured || !editor || !can('project.project.write')) return [];
    const ready = !!p.getflyCreatorId && !!groupId && !!p.getflyGroups?.[groupId]?.id;
    return [
      'sep',
      { label: 'Đồng bộ lên Getfly', icon: <CloudArrowUp size={14} />, disabled: getflyJob.running, onSelect: () => {
        if (!ready) { toast('Chọn người tạo và gắn việc cha Getfly cho nhóm trước khi đồng bộ', 'error'); setGetflyOpen(true); return; }
        getflyJob.syncScope(scope);
      } },
      { label: 'Xoá khỏi Getfly…', icon: <Trash size={14} />, danger: true, disabled: getflyJob.running, onSelect: async () => {
        if (await confirm({ title: 'Xoá khỏi Getfly?', desc: <p>Chỉ xoá các việc app đã tạo trên Getfly cho <b>{label}</b>. Việc cha Getfly được giữ nguyên. Dữ liệu trong VNLab vẫn còn. Không hoàn tác được; lần đồng bộ sau có thể tạo lại.</p>, ok: 'Xoá khỏi Getfly', danger: true })) getflyJob.unsyncScope(scope);
      } },
    ];
  };
  const menuFor = (target: MenuTarget): MenuItem[] => {
    if (target.kind === 'blank') return blankItems(target.date);
    if (target.kind === 'group') {
      const g = target.group, gid = g?.id ?? null, key = g?.id ?? UNGROUPED;
      const isCollapsed = collapsed.includes(key);
      const gi = g ? p.groups.findIndex((x) => x.id === g.id) : -1;
      return [
        ...(canTask ? [{ label: 'Thêm việc vào nhóm', icon: <Plus size={14} />, onSelect: () => setTaskSheet({ open: true, task: null, groupId: gid }) }] : []),
        { label: isCollapsed ? 'Mở nhóm' : 'Thu gọn nhóm', icon: isCollapsed ? <ArrowsOutLineVertical size={14} /> : <ArrowsInLineVertical size={14} />, onSelect: () => toggleCollapse(key, !isCollapsed) },
        ...(canTask && target.tasks.length > 1 ? [{ label: 'Sắp xếp việc trong nhóm theo ngày', icon: <SortAscending size={14} />, onSelect: () => sortByDate.mutate(gid) }] : []),
        ...(g ? getflyItems({ groupId: g.id }, `nhóm ${g.name}`, g.id) : []),
        ...(g && canStruct ? [
          'sep' as const,
          { label: 'Lên trên', icon: <ArrowUp size={14} />, disabled: gi <= 0, onSelect: () => moveGroup(g, -1) },
          { label: 'Xuống dưới', icon: <ArrowDown size={14} />, disabled: gi >= p.groups.length - 1, onSelect: () => moveGroup(g, 1) },
          'sep' as const,
          { label: 'Đổi tên, xoá nhóm…', icon: <PencilSimple size={14} />, onSelect: () => setGroupSheet({ open: true, group: g }) },
        ] : []),
      ];
    }
    if (target.kind === 'subtask') {
      const { task: t, subtask: s } = target;
      const done = s.progress >= 100;
      return [
        { label: 'Mở chi tiết task cha', icon: <ArrowSquareOut size={14} />, onSelect: () => setTaskSheet({ open: true, task: t }) },
        ...(canTask ? [
          'sep' as const,
          { label: done ? 'Đánh dấu chưa xong' : 'Đánh dấu xong', icon: <CheckCircle size={14} />, onSelect: () => patchTask.mutate({ task: t, patch: { subtasks: (t.subtasks ?? []).map((x) => (x.id === s.id ? { ...x, progress: done ? 0 : 100 } : x)) } }) },
          { label: 'Tiến độ', icon: <Percent size={14} />, children: [0, 25, 50, 75, 100].map((v) => ({ label: `${v}%`, checked: s.progress === v, onSelect: () => patchTask.mutate({ task: t, patch: { subtasks: (t.subtasks ?? []).map((x) => (x.id === s.id ? { ...x, progress: v } : x)) } }) })) },
          'sep' as const,
          { label: 'Xoá task con', icon: <Trash size={14} />, danger: true, onSelect: async () => { if (await ask('Xoá task con?', `“${s.name}” sẽ bị xoá khỏi “${t.name}”.`, 'Xoá')) patchTask.mutate({ task: t, patch: { subtasks: (t.subtasks ?? []).filter((x) => x.id !== s.id) } }); } },
        ] : []),
      ];
    }
    const t = target.task;
    const done = t.progress >= 100;
    const ids = groupIds(t.groupId ?? null), pos = ids.indexOf(t.id);
    const d = target.date;
    if (!canTask) return [{ label: 'Mở chi tiết', icon: <ArrowSquareOut size={14} />, onSelect: () => setTaskSheet({ open: true, task: t }) }, ...getflyItems({ taskId: t.id }, t.name, t.groupId)];
    return [
      { label: 'Mở chi tiết', icon: <ArrowSquareOut size={14} />, onSelect: () => setTaskSheet({ open: true, task: t }) },
      ...getflyItems({ taskId: t.id }, t.name, t.groupId),
      ...(d ? [
        'sep' as const,
        { label: `Bắt đầu từ ${fmtShort(d)}`, icon: <CalendarBlank size={14} />, onSelect: () => patchTask.mutate({ task: t, patch: { startDate: d, endDate: t.endDate && t.endDate >= d ? t.endDate : d } }) },
        { label: `Kết thúc vào ${fmtShort(d)}`, icon: <Flag size={14} />, onSelect: () => patchTask.mutate({ task: t, patch: { endDate: d, startDate: t.startDate && t.startDate <= d ? t.startDate : d } }) },
      ] : []),
      'sep',
      { label: done ? 'Đánh dấu chưa xong' : 'Đánh dấu xong', icon: <CheckCircle size={14} />, onSelect: () => setDone(t, !done) },
      ...(t.subtasks?.length ? [] : [{ label: 'Tiến độ', icon: <Percent size={14} />, children: [0, 25, 50, 75, 100].map((v) => ({ label: `${v}%`, checked: t.progress === v, onSelect: () => patchTask.mutate({ task: t, patch: { progress: v } }) })) }]),
      ...(p.scopes?.length ? [{ label: 'Phạm vi', icon: <Tag size={14} />, children: [
        ...p.scopes.map((sc) => ({ label: sc.owner ? `${sc.name} · ${sc.owner}` : sc.name, checked: t.scopeId === sc.id, icon: <span className="block h-2.5 w-2.5 rounded-full" style={{ background: sc.color }} />, onSelect: () => patchTask.mutate({ task: t, patch: { scopeId: sc.id } }) })),
        'sep' as const,
        { label: 'Bỏ phạm vi', checked: !t.scopeId, onSelect: () => patchTask.mutate({ task: t, patch: { scopeId: null } }) },
      ] }] : []),
      ...(p.phases?.length ? [{ label: 'Phase', icon: <CalendarBlank size={14} />, children: [
        ...p.phases.map((x) => ({ label: x.name, checked: t.phaseId === x.id, onSelect: () => patchTask.mutate({ task: t, patch: { phaseId: x.id } }) })),
        'sep' as const,
        { label: 'Chưa có phase', checked: !t.phaseId, onSelect: () => patchTask.mutate({ task: t, patch: { phaseId: null } }) },
      ] }] : []),
      { label: 'Chuyển nhóm', icon: <FolderSimple size={14} />, children: [
        ...p.groups.map((g) => ({ label: g.name, checked: t.groupId === g.id, onSelect: () => patchTask.mutate({ task: t, patch: { groupId: g.id } }) })),
        'sep' as const,
        { label: 'Chưa phân nhóm', checked: !t.groupId, onSelect: () => patchTask.mutate({ task: t, patch: { groupId: null } }) },
      ] },
      { label: 'Thứ tự', icon: <ArrowsDownUp size={14} />, children: [
        { label: 'Lên đầu nhóm', disabled: pos <= 0, onSelect: () => moveInGroup(t, 'top') },
        { label: 'Lên một bậc', disabled: pos <= 0, onSelect: () => moveInGroup(t, 'up') },
        { label: 'Xuống một bậc', disabled: pos >= ids.length - 1, onSelect: () => moveInGroup(t, 'down') },
        { label: 'Xuống cuối nhóm', disabled: pos >= ids.length - 1, onSelect: () => moveInGroup(t, 'bottom') },
      ] },
      'sep',
      { label: 'Thêm task con…', icon: <ListPlus size={14} />, onSelect: () => setTaskSheet({ open: true, task: t }) },
      { label: 'Nhân bản việc', icon: <Copy size={14} />, onSelect: () => void duplicate(t) },
      ...(planShift(t) ? [{ label: 'Chốt kế hoạch gốc', icon: <ClockCounterClockwise size={14} />, onSelect: () => void rebaseline(t) }] : []),
      'sep',
      { label: 'Xoá việc', icon: <Trash size={14} />, danger: true, onSelect: () => void removeTask(t) },
    ];
  };

  return (
    <div>
      {p.phases?.length
        ? <Link to={`/du-an/${p.id}`} className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink"><CaretLeft size={14} weight="bold" /> Các phase · {p.name}</Link>
        : <Link to="/du-an" className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink"><CaretLeft size={14} weight="bold" /> Dự án</Link>}
      <PageHeader
        eyebrow={`VNLab / Project${p.code ? ` / ${p.code}` : ''}`}
        title={p.name}
        sub={
          <span className="flex flex-wrap items-center gap-1.5">
            {p.customer && <Chip>KH: {p.customer}</Chip>}
            <Chip>PM: {p.owner.name || p.owner.email}</Chip>
            <Chip tone="primary">{curPhase ? `${curPhase.name}: ` : ''}{avg}% · {done}/{phaseTasks.length} việc</Chip>
            {overdue > 0 && <Chip tone="danger">{overdue} quá hạn</Chip>}
            {/* Bắt đầu = ngày bắt đầu dự án (Cài đặt); chưa đặt thì lấy ngày bắt đầu sớm nhất của việc. Kết thúc = hạn muộn nhất của việc. */}
            {(p.startDate || span || curPhase?.startDate) && (() => {
              const start = curPhase ? curPhase.startDate ?? span?.start ?? '' : p.startDate ?? span!.start;
              const end = curPhase?.endDate ?? span?.end;
              if (!start) return null;
              return <Chip className="num">{fmtShort(start)}{end ? ` → ${fmtShort(end)}` : ''}{end && end >= today ? ` · còn ${diffDays(today, end)} ngày` : ''}</Chip>;
            })()}
            {p.myRole !== 'owner' && <Chip tone="warning">{ROLE_LABEL[p.myRole]}</Chip>}
            {p.archived && <Chip tone="warning">Đã lưu trữ</Chip>}
          </span>
        }
        action={
          <>
            <Button variant="secondary" size="sm" onClick={() => setMembers(true)}><Users size={15} /> Thành viên{p.members.length ? ` · ${p.members.length + 1}` : ''}</Button>
            {editor && can('project.project.write') && <Button variant="secondary" size="sm" onClick={() => setSettings(true)}><GearSix size={15} /> Cài đặt</Button>}
          </>
        }
      />

      <div className={cx(full && 'gantt-full fixed inset-0 z-[45] flex flex-col overflow-hidden p-3 md:p-4')} style={full ? { background: 'var(--bg-grad, var(--bg))' } : undefined}>
      <PhaseBar project={p} value={activePhase} onChange={setPhaseFilter} canEdit={editor && can('project.project.write')} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'gantt', label: 'Gantt' }, { value: 'list', label: 'Danh sách' }, { value: 'calendar', label: 'Lịch' }]} className="w-60" />
        {!p.groups.length && !p.tasks.length && <span className="ml-auto flex flex-wrap items-center gap-1">{scopeTools}{actionTools}</span>}
      </div>

      {!p.groups.length && !p.tasks.length ? (
        <div className="card">
          <Empty
            icon={<TableIcon size={30} />}
            title="Dự án chưa có việc nào"
            desc="Thêm nhóm việc (giai đoạn / hạng mục) rồi thêm việc, hoặc dán thẳng kế hoạch từ Excel / Google Sheets. AI bên ngoài cũng thêm được qua MCP (Cài đặt)."
            action={canTask && (
              <span className="flex flex-wrap justify-center gap-2">
                {canStruct && <Button variant="secondary" onClick={() => setGroupSheet({ open: true, group: null })}><Plus size={14} weight="bold" /> Thêm nhóm</Button>}
                {can('project.data.import') && <Button onClick={() => setImportOpen(true)}><TableIcon size={15} /> Dán từ bảng tính</Button>}
              </span>
            )}
          />
        </div>
      ) : view === 'calendar' ? (
      <CalendarView
        tasks={shown.tasks}
        today={today}
        canEdit={() => canTask}
        colorOf={(t) => (t.progress >= 100 ? 'var(--ok)' : p.scopes?.find((x) => x.id === t.scopeId)?.color ?? p.color)}
        subtitle={(t) => p.groups.find((g) => g.id === t.groupId)?.name}
        onEditTask={(t) => setTaskSheet({ open: true, task: t })}
        onChangeDates={(task, startDate, endDate) => patchTask.mutate({ task, patch: { startDate, endDate } })}
        menuFor={menuFor}
        tools={<>{scopeTools}{actionTools}</>}
      />
      ) : (
      <Gantt
        project={shown}
        today={today}
        view={view}
        dayWidth={dayWidth}
        canEdit={canTask}
        focus={focus}
        collapsedTasks={collapsedTasks}
        onToggleTask={(taskId) => setCollapsedTasks((ids) => ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId])}
        collapsedUngrouped={collapsed.includes(UNGROUPED)}
        onToggleUngrouped={(c) => setCollapsed((ids) => c ? [...new Set([...ids, UNGROUPED])] : ids.filter((id) => id !== UNGROUPED))}
        onEditTask={(t) => setTaskSheet({ open: true, task: t })}
        onAddTask={(groupId) => setTaskSheet({ open: true, task: null, groupId })}
        onGroupMenu={(g) => setGroupSheet({ open: true, group: g })}
        onToggleGroup={(g, c) => setCollapsed((xs) => (c ? [...new Set([...xs, g.id])] : xs.filter((x) => x !== g.id)))}
        onChangeDates={(task, startDate, endDate) => patchTask.mutate({ task, patch: { startDate, endDate } })}
        onPatchTask={(task, patch) => patchTask.mutate({ task, patch })}
        showBaseline={showBaseline}
        onReorder={(groupId, ids) => activeScope ? toast('Bỏ lọc phạm vi để kéo thả đổi thứ tự', 'error') : reorder.mutate({ groupId, ids })}
        onReorderGroups={canStruct ? (ids) => reorderGroups.mutate(ids) : undefined}
        fullscreen={full}
        onToggleFullscreen={() => setFull((v) => !v)}
        menuFor={menuFor}
        headerTools={headerTools}
        showScopes={showScopes}
      />
      )}
      {view === 'gantt' && !full && <p className="mt-2 hidden px-1 text-[12px] text-muted md:block">Bấm đúp vào ô để sửa tại chỗ (Enter lưu, Esc huỷ, Tab sang ô kế); bấm số thứ tự để mở chi tiết, ghi chú, lịch sử. Kéo thanh để dời ngày, kéo hai mép đổi ngày bắt đầu / kết thúc. Khung nét đứt "gốc" là khoảng ngày ban đầu của việc đã dời / gia hạn. Kéo ô số thứ tự để đổi thứ tự trong nhóm; nút ⤢ ở góc bảng để phóng to cả bảng ra toàn màn hình (Esc thoát).</p>}
      </div>

      <TaskSheet open={taskSheet.open} onClose={() => setTaskSheet((s) => ({ ...s, open: false }))} project={p} task={taskSheet.task} groupId={taskSheet.groupId ?? null} phaseId={activePhase && activePhase !== 'none' ? activePhase : null} canEdit={editor} />
      <GroupSheet open={groupSheet.open} onClose={() => setGroupSheet((s) => ({ ...s, open: false }))} project={p} group={groupSheet.group} confirm={confirm} onSort={(g) => { sortByDate.mutate(g.id); setGroupSheet((s) => ({ ...s, open: false })); }} />
      <Sheet wide open={getflyOpen} onClose={() => setGetflyOpen(false)} title="Đồng bộ Getfly CRM">
        <GetflyBox project={p} canEdit={editor && can('project.project.write')} />
      </Sheet>
      <GetflyReport projectId={p.id} />
      <ProjectSheet open={settings} onClose={() => setSettings(false)} project={p} onImport={canTask && can('project.data.import') ? () => { setSettings(false); setImportOpen(true); } : undefined} />
      <MembersSheet open={members} onClose={() => setMembers(false)} project={p} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} project={p} />
      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title="Xuất dự án">
        <p className="mb-3 text-[13.5px] text-ink-2">Excel theo mẫu kế hoạch Gantt (bảng việc + lưới ngày theo tuần, thanh tự vẽ theo ngày bắt đầu/kết thúc, sheet "Dữ liệu" để dán ngược lại). CSV phẳng có BOM. JSON giữ nguyên cấu trúc nhóm và việc.</p>
        <div className="mb-3 rounded-2xl border border-line bg-card p-3">
          <p className="mb-2 text-[12.5px] font-semibold text-ink-2">Cột trong sheet PLAN (Excel và Google Sheets)</p>
          <ColumnPicker value={exportCols ?? normalizeColumns(p.exportColumns)} onChange={setExportCols} />
          {canStruct && exportCols && JSON.stringify(exportCols) !== JSON.stringify(normalizeColumns(p.exportColumns)) && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => saveCols.mutate(exportCols)} disabled={saveCols.isPending}>Lưu làm mặc định cho dự án (dùng cho Google Sheets)</Button>
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2">
          <Button block onClick={() => { location.assign(`/api/projects/${p.id}/export?format=xlsx&cols=${(exportCols ?? normalizeColumns(p.exportColumns)).join(',')}${curPhase ? `&phase=${curPhase.id}` : ''}`); setExportOpen(false); }}><DownloadSimple size={16} /> Tải Excel (mẫu kế hoạch Gantt)</Button>
          <Button variant="secondary" block onClick={() => { location.assign(`/api/projects/${p.id}/export?format=csv${curPhase ? `&phase=${curPhase.id}` : ''}`); setExportOpen(false); }}><DownloadSimple size={16} /> Tải CSV</Button>
          <Button variant="secondary" block onClick={() => { location.assign(`/api/projects/${p.id}/export`); setExportOpen(false); }}><DownloadSimple size={16} /> Tải JSON</Button>
        </div>
      </Sheet>
    </div>
  );
}

/** Tạo / đổi tên / xoá nhóm việc. */
function GroupSheet({ open, onClose, project, group, confirm, onSort }: {
  open: boolean; onClose: () => void; project: ProjectDetail; group?: Group | null; confirm: ReturnType<typeof useFeedback>['confirm']; onSort: (g: Group) => void;
}) {
  const { toast } = useFeedback();
  const [name, setName] = useState('');
  const [parentRef, setParentRef] = useState('');
  const linkedParent = group ? project.getflyGroups?.[group.id] : undefined;
  useEffect(() => { if (open) { setName(group?.name ?? ''); setParentRef(linkedParent?.code ?? ''); } }, [open, group, linkedParent?.code]);
  const count = group ? project.tasks.filter((t) => t.groupId === group.id).length : 0;
  const save = useAction((n: string) => group ? api(`/projects/${project.id}/groups/${group.id}`, { method: 'PATCH', body: { name: n, getflyParent: parentRef.trim() === (linkedParent?.code ?? '') ? undefined : parentRef.trim() } }) : api(`/projects/${project.id}/groups`, { method: 'POST', body: { name: n, getflyParent: parentRef.trim() === (linkedParent?.code ?? '') ? undefined : parentRef.trim() } }), {
    onSuccess: () => { toast(group ? 'Đã lưu nhóm' : 'Đã thêm nhóm'); onClose(); },
  });
  const remove = useAction((keep: boolean) => api(`/projects/${project.id}/groups/${group!.id}${keep ? '?keepTasks=1' : ''}`, { method: 'DELETE' }), { onSuccess: () => { toast('Đã xoá nhóm'); onClose(); } });
  const del = async (keep: boolean) => {
    const ok = await confirm({
      title: keep ? 'Xoá nhóm, giữ việc?' : `Xoá nhóm cùng ${count} việc?`,
      desc: keep ? <p>Các việc trong <b>{group?.name}</b> chuyển thành "Chưa phân nhóm".</p> : <p>Mọi việc trong <b>{group?.name}</b> bị xoá theo. Không hoàn tác được.</p>,
      ok: 'Xoá', danger: true,
    });
    if (ok) remove.mutate(keep);
  };
  return (
    <Sheet
      wide
      open={open}
      onClose={onClose}
      title={group ? 'Nhóm việc' : 'Thêm nhóm việc'}
      footer={
        <div className="flex flex-col gap-2">
          {group && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line pb-2">
              {count > 1 && <Button variant="ghost" size="sm" onClick={() => onSort(group)}><SortAscending size={14} /> Sắp xếp theo ngày</Button>}
              {count > 0 && <Button variant="ghost" size="sm" onClick={() => del(true)} disabled={remove.isPending}>Xoá nhóm, giữ {count} việc</Button>}
              <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft" onClick={() => del(false)} disabled={remove.isPending}><Trash size={14} /> {count ? 'Xoá nhóm cùng việc' : 'Xoá nhóm'}</Button>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Huỷ</Button>
            <Button type="submit" form="group-form" disabled={save.isPending || !name.trim()}>{group ? 'Lưu' : 'Thêm'}</Button>
          </div>
        </div>
      }
    >
      <form id="group-form" className="pt-1" onSubmit={(e) => { e.preventDefault(); save.mutate(name.trim()); }}>
        <Field label="Tên nhóm" hint="VD: Thiết kế, Lập trình, Kiểm thử — mỗi nhóm là một giai đoạn hoặc hạng mục">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} autoFocus />
        </Field>
        <Field label="Việc cha trên Getfly" hint="Dán link, id hoặc mã việc cha cho nhóm này. Để trống để bỏ qua nhóm khi đồng bộ.">
          <Input value={parentRef} onChange={(e) => setParentRef(e.target.value)} maxLength={500} placeholder="https://…/#/tasks/?task_id=… hoặc CVI/…" />
        </Field>
        {linkedParent && <p className="mb-4 break-words text-[13px] text-muted">Đang gắn: {linkedParent.name} · {linkedParent.code}{linkedParent.projectName ? ` · ${linkedParent.projectName}` : ''}</p>}
      </form>
    </Sheet>
  );
}
