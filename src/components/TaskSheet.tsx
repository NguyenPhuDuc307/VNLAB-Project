import { SubtasksEditor } from './SubtasksEditor';
import { ArrowDown, ArrowUp, ClockCounterClockwise, Trash } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, planShift, useAction, useCan, type GetflyTaskLink, type ProjectDetail, type Task, type TaskHistory, type TaskInput } from '../lib/api';
import { useGetflyStatus } from './GetflyBox';
import { fmtNum, fmtShort, workDays } from '../lib/dates';
import { Button, DateInput, Field, IconButton, Input, MoreButton, Select, Sheet, SectionLabel, Textarea, useFeedback } from './ui';

type Props = {
  open: boolean;
  onClose: () => void;
  project: ProjectDetail;
  /** Có task = sửa; không = tạo mới vào nhóm `groupId`. */
  task?: Task | null;
  groupId?: string | null;
  /** Việc mới: phase mặc định (phase đang xem). */
  phaseId?: string | null;
  canEdit: boolean;
};

const empty = (groupId: string | null, phaseId: string | null = null): TaskInput => ({ subtasks: [], name: '', groupId, phaseId, scopeId: null, parentTaskId: null, assignee: '', support: '', progress: 0, startDate: null, endDate: null, days: null, note: '' });

export function TaskSheet({ open, onClose, project, task, groupId = null, phaseId = null, canEdit }: Props) {
  const { toast, confirm } = useFeedback();
  const can = useCan();
  const [f, setF] = useState<TaskInput>(() => empty(groupId));
  const [daysText, setDaysText] = useState('');
  useEffect(() => {
    if (!open) return;
    const { getfly: _getfly, ...init } = task ? { ...task } : { ...empty(groupId, phaseId), getfly: undefined };
    setF(init);
    setDaysText(init.days == null ? '' : String(init.days).replace('.', ','));
  }, [open, task, groupId, phaseId]);

  const auto = f.startDate && f.endDate ? workDays(f.startDate, f.endDate, project.satWeight, project.sunWeight) : null;
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const t of project.tasks) for (const n of `${t.assignee},${t.support}`.split(',')) if (n.trim()) set.add(n.trim());
    for (const m of project.members) if (m.name) set.add(m.name);
    if (project.owner.name) set.add(project.owner.name);
    return [...set].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [project]);

  const save = useAction(async (body: TaskInput) =>
    task ? api<Task>(`/projects/${project.id}/tasks/${task.id}`, { method: 'PATCH', body }) : api<Task>(`/projects/${project.id}/tasks`, { method: 'POST', body }),
  { onSuccess: () => { toast(task ? 'Đã lưu việc' : 'Đã thêm việc'); onClose(); } });
  const remove = useAction(() => api(`/projects/${project.id}/tasks/${task!.id}`, { method: 'DELETE' }), { onSuccess: () => { toast('Đã xoá việc'); onClose(); } });
  const reorder = useAction((p: { groupId: string | null; ids: string[] }) => api(`/projects/${project.id}/tasks/order`, { method: 'PUT', body: p }));
  const rebase = useAction(() => api<Task>(`/projects/${project.id}/tasks/${task!.id}/rebaseline`, { method: 'POST', body: {} }), { onSuccess: () => toast('Đã chốt kế hoạch gốc mới') });
  const history = useQuery({ queryKey: ['task-history', task?.id], queryFn: () => api<TaskHistory[]>(`/projects/${project.id}/tasks/${task!.id}/history`), enabled: open && !!task });
  const shift = task ? planShift(task) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const days = daysText.trim() === '' ? null : Number(daysText.replace(',', '.'));
    if (days != null && (!Number.isFinite(days) || days < 0)) return toast('Ngày công phải là số ≥ 0', 'error');
    if (f.startDate && f.endDate && f.endDate < f.startDate) return toast('Ngày kết thúc phải từ ngày bắt đầu trở đi', 'error');
    save.mutate({ ...f, name: f.name.trim(), days, startDate: f.startDate || null, endDate: f.endDate || null });
  };
  const del = async () => {
    if (await confirm({ title: 'Xoá việc này?', desc: <p><b>{task?.name}</b> sẽ bị xoá khỏi dự án. Không hoàn tác được.</p>, ok: 'Xoá', danger: true })) remove.mutate(undefined);
  };
  const move = (dir: -1 | 1) => {
    if (!task) return;
    const siblings = project.tasks.filter((t) => (t.groupId ?? null) === (task.groupId ?? null)).map((t) => t.id);
    const i = siblings.indexOf(task.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    reorder.mutate({ groupId: task.groupId ?? null, ids: siblings });
  };
  // Việc cha: việc khác cùng nhóm, bản thân không có cha (chỉ một cấp).
  const parentOptions = project.tasks.filter((t) => t.id !== task?.id && (t.groupId ?? null) === (f.groupId ?? null) && !t.parentTaskId);
  const hasChildren = !!task && project.tasks.some((t) => t.parentTaskId === task.id);
  const children = f.subtasks ?? [];
  const progress = children.length ? Math.round(children.reduce((sum, item) => sum + item.progress, 0) / children.length) : f.progress ?? 0;
  const setChildren = (subtasks: NonNullable<Task['subtasks']>) => setF({ ...f, subtasks });
  const splitName = () => {
    const lines = f.name.split('\n').map((line) => line.trim().replace(/^[•*\-]\s*/, '')).filter(Boolean);
    if (lines.length < 2) return;
    setF({ ...f, name: lines[0], subtasks: [...children, ...lines.slice(1).map((name) => ({ id: crypto.randomUUID(), name, assignee: f.assignee ?? '', progress: f.progress ?? 0 }))].slice(0, 100) });
  };
  const busy = save.isPending || remove.isPending;
  const readOnly = !canEdit || !can('project.task.write');

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={task ? (readOnly ? 'Chi tiết việc' : 'Sửa việc') : 'Thêm việc'}
      side
      footer={
        readOnly ? <Button variant="secondary" block onClick={onClose}>Đóng</Button> : (
          <div className="flex items-center gap-2">
            {/* Như bảng sửa lịch bên VNLab Home: xoá là nút tròn ở chân sheet; đổi thứ tự (ít dùng) nằm trong "⋯". */}
            {task && (
              <>
                {can('project.task.delete') && <IconButton label="Xoá việc" onClick={del} className="!h-10 !w-10 bg-danger-soft text-danger hover:brightness-95" disabled={busy}><Trash size={18} /></IconButton>}
                <MoreButton className="!h-10 !w-10 bg-fill hover:bg-fill-2" label="Thứ tự việc" items={() => [
                  { label: 'Chuyển lên', icon: <ArrowUp size={14} />, disabled: reorder.isPending, onSelect: () => move(-1) },
                  { label: 'Chuyển xuống', icon: <ArrowDown size={14} />, disabled: reorder.isPending, onSelect: () => move(1) },
                ]} />
              </>
            )}
            <Button variant="secondary" className="ml-auto" onClick={onClose}>Huỷ</Button>
            <Button type="submit" form="task-form" disabled={busy || !f.name.trim() || children.some((s) => !s.name.trim())}>{busy ? 'Đang lưu…' : task ? 'Lưu' : 'Thêm'}</Button>
          </div>
        )
      }
    >
      <form id="task-form" onSubmit={submit} className="form-dense pt-1">
        <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
          <Field label="Tên việc">
            <Textarea rows={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={300} autoFocus={!task} placeholder="VD: Thiết kế màn hình đăng nhập" />
          </Field>
          {!readOnly && f.name.includes('\n') && <Button className="mb-3" type="button" size="sm" variant="ghost" onClick={splitName}>Tách các dòng thành task con</Button>}
          <SubtasksEditor items={children} onChange={setChildren} readOnly={readOnly} />
          <SectionLabel>Phân công và tiến độ</SectionLabel>
          <div className="grid gap-x-3 sm:grid-cols-2 md:grid-cols-3">
            {(project.phases?.length ?? 0) > 0 && (
              <Field label="Phase">
                <Select value={f.phaseId ?? ''} onChange={(e) => setF({ ...f, phaseId: e.target.value || null })}>
                  <option value="">Chưa có phase</option>
                  {project.phases.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Phạm vi" hint={(() => { const s = project.scopes?.find((x) => x.id === f.scopeId); return s?.owner ? `Phụ trách phạm vi: ${s.owner}` : project.scopes?.length ? undefined : 'Tạo phạm vi trong Cài đặt dự án'; })()}>
              <Select value={f.scopeId ?? ''} onChange={(e) => setF({ ...f, scopeId: e.target.value || null })}>
                <option value="">Chưa gắn phạm vi</option>
                {(project.scopes ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.owner ? ` · ${s.owner}` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Nhóm">
              {/* Việc cha phải cùng nhóm: đổi nhóm thì bỏ việc cha. */}
              <Select value={f.groupId ?? ''} onChange={(e) => setF({ ...f, groupId: e.target.value || null, parentTaskId: null })}>
                <option value="">Chưa phân nhóm</option>
                {project.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
            <Field label="Việc cha" hint={hasChildren ? 'Việc này đang có việc con' : undefined}>
              <Select value={f.parentTaskId ?? ''} disabled={hasChildren} onChange={(e) => setF({ ...f, parentTaskId: e.target.value || null })}>
                <option value="">— Không —</option>
                {parentOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Tiến độ" hint={<span className="num">{progress}%{children.length ? " · Tự tổng hợp" : ""}</span>}>
              <div className="flex h-11 items-center gap-2">
                <input type="range" min={0} max={100} step={5} disabled={children.length > 0} value={progress} onChange={(e) => setF({ ...f, progress: Number(e.target.value) })} className="w-full accent-[var(--primary)]" aria-label="Tiến độ" />
                <Input type="number" min={0} max={100} disabled={children.length > 0} value={progress} onChange={(e) => setF({ ...f, progress: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className="num w-16 shrink-0 text-center" />
              </div>
            </Field>
            <Field label="Phụ trách">
              <Input list="prj-names" value={f.assignee ?? ''} onChange={(e) => setF({ ...f, assignee: e.target.value })} maxLength={160} placeholder="VD: An" />
            </Field>
            <Field label="Hỗ trợ" hint="Nhiều người cách nhau bằng dấu phẩy">
              <Input list="prj-names" value={f.support ?? ''} onChange={(e) => setF({ ...f, support: e.target.value })} maxLength={300} placeholder="VD: Bình, Chi" />
            </Field>
            <Field label="Bắt đầu">
              <DateInput value={f.startDate ?? ''} onChange={(v) => setF({ ...f, startDate: v || null })} optional />
            </Field>
            <Field label="Kết thúc">
              <DateInput value={f.endDate ?? ''} onChange={(v) => setF({ ...f, endDate: v || null })} optional min={f.startDate ?? undefined} />
            </Field>
            <Field label="Ngày công" hint={auto != null ? `Để trống thì tự tính: ${fmtNum(auto)} ngày` : 'Để trống thì tự tính theo ngày bắt đầu, kết thúc'}>
              <Input inputMode="decimal" value={daysText} onChange={(e) => setDaysText(e.target.value)} placeholder={auto != null ? fmtNum(auto) : '—'} className="num" />
            </Field>
          </div>
          <SectionLabel>Ghi chú</SectionLabel>
          <Field label="Ghi chú">
            {/* Ghi chú việc thường dài nhiều đoạn: giãn theo nội dung (6–30 dòng), quá thì cuộn. */}
            <Textarea value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={4000} className="leading-relaxed"
              rows={Math.min(30, Math.max(6, (f.note ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 90)), 0) + 1))} />
          </Field>
          {(project.getflyCreatorId || f.getflyNote) && (
            <label className="-mt-1 mb-3 flex items-start gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={!!f.getflyNote} onChange={(e) => setF({ ...f, getflyNote: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]" />
              <span>Gửi ghi chú lên Getfly <span className="text-muted">— bỏ tích thì chỉ lưu ở đây</span></span>
            </label>
          )}
          {task && <GetflyLinkField project={project} task={task} readOnly={readOnly} />}
          {task && (
            <div className="mb-3 text-[13px]">
              <SectionLabel>Kế hoạch gốc</SectionLabel>
              <div className="flex flex-wrap items-center gap-2 px-1">
                {task.baselineStart && task.baselineEnd ? (
                  <span className="num">{fmtShort(task.baselineStart)} → {fmtShort(task.baselineEnd)}</span>
                ) : <span className="text-muted">chưa có (cần đủ ngày bắt đầu, kết thúc)</span>}
                {shift && (
                  <span className={shift.end > 0 ? 'rounded-full bg-warning-soft px-2 py-0.5 text-[12px] font-semibold text-warning' : 'rounded-full bg-ok-soft px-2 py-0.5 text-[12px] font-semibold text-ok'}>
                    {shift.end > 0 ? `gia hạn ${shift.end} ngày` : shift.end < 0 ? `rút ngắn ${-shift.end} ngày` : `dời ${shift.start > 0 ? 'lùi' : 'sớm'} ${Math.abs(shift.start)} ngày`}
                  </span>
                )}
                {!readOnly && shift && <Button type="button" size="sm" variant="ghost" onClick={() => rebase.mutate(undefined)} disabled={rebase.isPending}>Chốt ngày hiện tại làm kế hoạch gốc</Button>}
              </div>
              {history.data && history.data.length > 0 && (
                <details className="mt-2 px-1">
                  <summary className="cursor-pointer select-none text-[12.5px] font-semibold text-ink-2"><ClockCounterClockwise size={14} className="mr-1 inline" />Lịch sử thay đổi ({history.data.length})</summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[12.5px] text-ink-2">
                    {history.data.map((h) => <li key={h.id}><span className="num text-muted">{new Date(h.at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> · {h.user ?? 'AI / hệ thống'} · {describeChange(h)}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
          <datalist id="prj-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </fieldset>
      </form>
    </Sheet>
  );
}

/** "Mã Getfly": việc tương ứng trên Getfly; gắn tay bằng link / id / mã khi đồng bộ báo trùng tên. Không xoá gì trên Getfly. */
function GetflyLinkField({ project, task, readOnly }: { project: ProjectDetail; task: Task; readOnly: boolean }) {
  const status = useGetflyStatus();
  // Sheet giữ bản chụp của việc lúc mở: kết quả gắn / bỏ gắn lưu ở đây để hiện ngay.
  const [link, setLink] = useState<GetflyTaskLink | null>(task.getfly ?? null);
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setLink(task.getfly ?? null); setRef(''); setError(''); }, [task]);
  const act = useAction((r: string) => api<{ getfly: GetflyTaskLink | null }>(`/projects/${project.id}/tasks/${task.id}/getfly-link`, { method: 'PUT', body: { ref: r } }), {
    onSuccess: (r) => { setLink(r.getfly); setRef(''); setError(''); },
  });
  if (!status.data?.configured || (!project.getflyCreatorId && !link)) return null;
  if (readOnly && !link) return null;
  const submit = () => { const v = ref.trim(); if (!v || act.isPending) return; setError(''); act.mutate(v, { onError: (e) => setError((e as Error).message) }); };
  const unlink = () => { if (act.isPending) return; setError(''); act.mutate('', { onError: (e) => setError((e as Error).message) }); };
  return (
    <Field group label="Mã Getfly" error={error || undefined} hint={readOnly ? undefined : link ? 'Bỏ gắn chỉ quên liên kết, việc trên Getfly giữ nguyên.' : 'Dán link / id / mã việc có sẵn trên Getfly để gắn tay (khi đồng bộ báo trùng tên).'}>
      {link && (
        <div className="mb-1.5 flex min-w-0 items-center gap-2 rounded-[18px] bg-fill px-3.5 py-1.5 text-[13px]">
          {link.id ? <a href={`${status.data.webOrigin}/#/tasks/?task_id=${link.id}`} target="_blank" rel="noreferrer" className="num min-w-0 break-words font-semibold text-primary hover:underline">{link.code || `id ${link.id}`}</a>
            : <span className="num min-w-0 break-words font-semibold">{link.code}</span>}
          {link.adopted && <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-semibold text-ok">có sẵn</span>}
          {!readOnly && <button type="button" className="ml-auto shrink-0 text-[12px] font-semibold text-muted hover:text-danger disabled:opacity-50" disabled={act.isPending} onClick={unlink}>Bỏ gắn</button>}
        </div>
      )}
      {!readOnly && (
        <div className="flex min-w-0 gap-1.5">
          <Input aria-label="Link, id hoặc mã việc Getfly" className="!h-9 min-w-0 flex-1 !text-[13px]" value={ref} maxLength={500}
            onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder={link ? 'Đổi sang việc khác: dán link / id / mã' : 'VD #/tasks/?task_id=9136 hoặc CVI/2026-11/009123'} />
          <Button type="button" size="sm" variant="secondary" className="!h-9" disabled={act.isPending || !ref.trim()} onClick={submit}>{act.isPending ? 'Đang gắn…' : 'Gắn'}</Button>
        </div>
      )}
    </Field>
  );
}

const FIELD_LABEL: Record<string, string> = { project: 'dự án', name: 'tên', groupId: 'nhóm', assignee: 'phụ trách', support: 'hỗ trợ', progress: 'tiến độ', startDate: 'bắt đầu', endDate: 'kết thúc', days: 'ngày công', note: 'ghi chú', getflyNote: 'gửi ghi chú Getfly', baseline: 'kế hoạch gốc', subtasks: 'task con' };
const fmtVal = (field: string, v: string | null) => {
  if (v === null) return 'trống';
  if (field === 'subtasks') { try { return `${JSON.parse(v).length} task con`; } catch { return v; } }
  if (field === 'startDate' || field === 'endDate') return fmtShort(v);
  if (field === 'progress') return `${v}%`;
  if (field === 'baseline') return v.split('..').map(fmtShort).join(' → ');
  if (field === 'groupId') return 'nhóm khác';
  return v.length > 40 ? `${v.slice(0, 40)}…` : v;
};
function describeChange(h: TaskHistory) {
  const label = FIELD_LABEL[h.field] ?? h.field;
  if (h.field === 'baseline') return `chốt ${label}: ${fmtVal(h.field, h.newValue)}`;
  return `${label}: ${fmtVal(h.field, h.oldValue)} → ${fmtVal(h.field, h.newValue)}`;
}
