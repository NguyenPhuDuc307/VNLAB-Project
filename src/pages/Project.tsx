import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowsClockwise, ArrowsInLineVertical, ArrowsOutLineVertical, CalendarBlank, Flag, FolderPlus, ListPlus, CaretLeft, ClockCounterClockwise, CrosshairSimple, DownloadSimple, GearSix, Minus, Plus, SortAscending, TableIcon, Trash, Users } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Gantt, spanOf, UNGROUPED, type GanttView } from '../components/Gantt';
import { ImportSheet } from '../components/ImportSheet';
import { MembersSheet, ProjectSheet } from '../components/ProjectSheet';
import { TaskSheet } from '../components/TaskSheet';
import { ColumnPicker, normalizeColumns, type ColKey } from '../components/ColumnPicker';
import { Button, Chip, Empty, Field, IconButton, Input, PageHeader, Segmented, Sheet, Skeleton, useFeedback, cx, Select } from '../components/ui';
import { api, canEditRole, ROLE_LABEL, useAction, useCan, useProject, type Group, type ProjectDetail, type Task, type TaskInput } from '../lib/api';
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
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useProject(id);
  const qc = useQueryClient();
  const can = useCan();
  const { toast, confirm } = useFeedback();
  // Cập nhật thời gian thực + báo MCP: do useLiveEvents ở khung trang (Layout) lo cho mọi trang.
  const today = todayStr();
  const [view, setView] = useState<GanttView>(() => pref('project:view', 'gantt', (v): v is GanttView => v === 'gantt' || v === 'list'));
  const [dayWidth, setDayWidth] = useState(() => pref('project:day', 30, (v): v is number => typeof v === 'number' && v >= 18 && v <= 60));
  const [focus, setFocus] = useState({ date: today, tick: 0 });
  const [showBaseline, setShowBaseline] = useState(() => pref('project:baseline', true, (v): v is boolean => typeof v === 'boolean'));
  useEffect(() => savePref('project:baseline', showBaseline), [showBaseline]);
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
  const shown = useMemo<ProjectDetail | undefined>(() => p && {
    ...p,
    groups: p.groups.map((g) => ({ ...g, collapsed: collapsed.includes(g.id) })),
    tasks: !activeScope ? p.tasks : p.tasks.filter((t) => (activeScope === 'none' ? !t.scopeId : t.scopeId === activeScope)),
  }, [p, collapsed, activeScope]);

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
  const span = spanOf(p.tasks);
  const done = p.tasks.filter((t) => t.progress >= 100).length;
  const overdue = p.tasks.filter((t) => t.endDate && t.endDate < today && t.progress < 100).length;
  const avg = p.tasks.length ? Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length) : 0;

  return (
    <div>
      <Link to="/du-an" className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink"><CaretLeft size={14} weight="bold" /> Dự án</Link>
      <PageHeader
        eyebrow={`VNLab / Project${p.code ? ` / ${p.code}` : ''}`}
        title={<span className="flex items-center gap-2.5"><span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: p.color }} />{p.name}</span>}
        sub={
          <span className="flex flex-wrap items-center gap-1.5">
            {p.customer && <Chip>KH: {p.customer}</Chip>}
            <Chip>PM: {p.owner.name || p.owner.email}</Chip>
            <Chip tone="primary">{avg}% · {done}/{p.tasks.length} việc</Chip>
            {overdue > 0 && <Chip tone="danger">{overdue} quá hạn</Chip>}
            {span && <Chip className="num">{fmtShort(span.start)} → {fmtShort(span.end)}{span.end >= today ? ` · còn ${diffDays(today, span.end)} ngày` : ''}</Chip>}
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'gantt', label: 'Gantt' }, { value: 'list', label: 'Danh sách' }]} className="w-44" />
        {!!p.scopes?.length && (
          <Select aria-label="Lọc theo phạm vi" value={activeScope} onChange={(e) => setScopeFilter(e.target.value)} className={cx('h-9 w-auto max-w-[200px] py-0 text-[13px]', activeScope && 'border-primary text-primary')}>
            <option value="">Mọi phạm vi</option>
            {p.scopes.map((s) => <option key={s.id} value={s.id}>{s.name}{s.owner ? ` · ${s.owner}` : ''}</option>)}
            <option value="none">Chưa gắn phạm vi</option>
          </Select>
        )}
        {view === 'gantt' && (
          <>
            <IconButton label="Hôm nay" onClick={() => setFocus({ date: today, tick: focus.tick + 1 })}><CrosshairSimple size={18} /></IconButton>
            <IconButton label="Đầu tháng" onClick={() => setFocus({ date: `${today.slice(0, 7)}-01`, tick: focus.tick + 1 })}><CalendarBlank size={18} /></IconButton>
            {p.startDate && <IconButton label="Đầu dự án" className="hidden md:inline-flex" onClick={() => setFocus({ date: p.startDate!, tick: focus.tick + 1 })}><Flag size={18} /></IconButton>}
            <IconButton label="Kế hoạch gốc" className={cx("hidden md:inline-flex", showBaseline && "bg-fill text-primary")} onClick={() => setShowBaseline((v) => !v)} title="Kế hoạch gốc: khung nét đứt là khoảng ngày ban đầu" aria-pressed={showBaseline}>
              <ClockCounterClockwise size={18} />
            </IconButton>
            <span className="inline-flex items-center rounded-lg bg-fill p-0.5">
              <IconButton label="Thu nhỏ" className="h-7 w-7 rounded-md" onClick={() => setDayWidth((w) => Math.max(18, w - 4))} disabled={dayWidth <= 18}><Minus size={14} weight="bold" /></IconButton>
              <IconButton label="Phóng to" className="h-7 w-7 rounded-md" onClick={() => setDayWidth((w) => Math.min(60, w + 4))} disabled={dayWidth >= 60}><Plus size={14} weight="bold" /></IconButton>
            </span>
          </>
        )}
        {p.tasks.some((t) => t.subtasks?.length) && <span className="inline-flex items-center gap-1">
          <IconButton label="Thu gọn tất cả task con" onClick={() => {
            setCollapsedTasks(p.tasks.filter((t) => t.subtasks?.length).map((t) => t.id));
          }}><ArrowsInLineVertical size={18} /></IconButton>
          <IconButton label="Mở rộng tất cả task con" onClick={() => setCollapsedTasks([])}><ArrowsOutLineVertical size={18} /></IconButton>
        </span>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {p.sheetUrl && editor && can('project.project.write') && (
            <IconButton label="Đồng bộ Sheets" onClick={() => syncSheet.mutate()} disabled={syncSheet.isPending} title={p.sheetSyncedAt ? `Đồng bộ Sheets · lần cuối ${new Date(p.sheetSyncedAt).toLocaleString('vi-VN')}` : 'Đồng bộ Sheets'}>
              <ArrowsClockwise size={18} className={syncSheet.isPending ? 'animate-spin' : undefined} />
            </IconButton>
          )}
          {can('project.data.export') && <IconButton label="Xuất" onClick={() => setExportOpen(true)}><DownloadSimple size={18} /></IconButton>}
          {canTask && p.tasks.length > 1 && <IconButton label="Sắp xếp theo ngày" onClick={sortAll} disabled={sortByDate.isPending} title="Sắp xếp việc trong từng nhóm theo ngày bắt đầu"><SortAscending size={18} /></IconButton>}
          {canStruct && <IconButton label="Thêm nhóm" onClick={() => setGroupSheet({ open: true, group: null })}><FolderPlus size={18} /></IconButton>}
          {canTask && <Button size="sm" className="w-9 !px-0" aria-label="Thêm việc" title="Thêm việc" onClick={() => setTaskSheet({ open: true, task: null, groupId: p.groups[0]?.id ?? null })}><ListPlus size={18} /></Button>}
        </span>
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
      />
      )}
      {view === 'gantt' && !full && <p className="mt-2 hidden px-1 text-[12px] text-muted md:block">Bấm vào ô để sửa tại chỗ (Enter lưu, Esc huỷ, Tab sang ô kế); bấm số thứ tự để mở chi tiết, ghi chú, lịch sử. Kéo thanh để dời ngày, kéo hai mép đổi ngày bắt đầu / kết thúc. Khung nét đứt "gốc" là khoảng ngày ban đầu của việc đã dời / gia hạn. Kéo ô số thứ tự để đổi thứ tự trong nhóm; nút ⤢ ở góc bảng để phóng to cả bảng ra toàn màn hình (Esc thoát).</p>}
      </div>

      <TaskSheet open={taskSheet.open} onClose={() => setTaskSheet((s) => ({ ...s, open: false }))} project={p} task={taskSheet.task} groupId={taskSheet.groupId ?? null} canEdit={editor} />
      <GroupSheet open={groupSheet.open} onClose={() => setGroupSheet((s) => ({ ...s, open: false }))} project={p} group={groupSheet.group} confirm={confirm} onSort={(g) => { sortByDate.mutate(g.id); setGroupSheet((s) => ({ ...s, open: false })); }} />
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
          <Button block onClick={() => { location.assign(`/api/projects/${p.id}/export?format=xlsx&cols=${(exportCols ?? normalizeColumns(p.exportColumns)).join(',')}`); setExportOpen(false); }}><DownloadSimple size={16} /> Tải Excel (mẫu kế hoạch Gantt)</Button>
          <Button variant="secondary" block onClick={() => { location.assign(`/api/projects/${p.id}/export?format=csv`); setExportOpen(false); }}><DownloadSimple size={16} /> Tải CSV</Button>
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
  useEffect(() => { if (open) setName(group?.name ?? ''); }, [open, group]);
  const count = group ? project.tasks.filter((t) => t.groupId === group.id).length : 0;
  const save = useAction((n: string) => group ? api(`/projects/${project.id}/groups/${group.id}`, { method: 'PATCH', body: { name: n } }) : api(`/projects/${project.id}/groups`, { method: 'POST', body: { name: n } }), {
    onSuccess: () => { toast(group ? 'Đã đổi tên nhóm' : 'Đã thêm nhóm'); onClose(); },
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
      </form>
    </Sheet>
  );
}
