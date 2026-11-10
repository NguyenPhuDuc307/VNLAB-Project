import { Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { api, useAction, type Phase, type ProjectDetail } from '../lib/api';
import { fmtShort } from '../lib/dates';
import { Button, DateInput, Field, Input, Sheet, cx, useFeedback } from './ui';

/** Giá trị lọc phase: '' = tất cả, 'none' = chưa có phase, còn lại = id phase. */
export type PhaseFilter = string;

/**
 * Thanh phase ở đầu trang dự án: Tất cả · từng phase · Chưa có phase · + Phase.
 * Bấm đúp / chuột phải vào một phase để sửa tên, ngày hoặc xoá.
 */
export function PhaseBar({ project, value, onChange, canEdit }: { project: ProjectDetail; value: PhaseFilter; onChange: (v: PhaseFilter) => void; canEdit: boolean }) {
  const [sheet, setSheet] = useState<{ open: boolean; phase: Phase | null }>({ open: false, phase: null });
  const phases = project.phases ?? [];
  const count = (id: string | null) => project.tasks.filter((t) => (t.phaseId ?? null) === id).length;
  const unphased = count(null);
  const tab = (key: string, label: React.ReactNode, n: number, title?: string, phase?: Phase) => (
    <button key={key} type="button" title={title} aria-pressed={value === key}
      className={cx('phase-tab', value === key && 'on')}
      onClick={() => onChange(key)}
      onDoubleClick={phase && canEdit ? () => setSheet({ open: true, phase }) : undefined}
      onContextMenu={phase && canEdit ? (e) => { e.preventDefault(); setSheet({ open: true, phase }); } : undefined}>
      <span className="truncate">{label}</span>
      <span className="num text-[11px] font-semibold opacity-70">{n}</span>
    </button>
  );
  if (!phases.length && !canEdit) return null;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Phase">
        {phases.length > 0 && tab('', 'Tất cả', project.tasks.length)}
        {phases.map((x) => tab(x.id, x.name, count(x.id), [x.startDate && x.endDate ? `${fmtShort(x.startDate)} → ${fmtShort(x.endDate)}` : null, canEdit ? 'Bấm đúp để sửa' : null].filter(Boolean).join(' · ') || undefined, x))}
        {phases.length > 0 && unphased > 0 && tab('none', 'Chưa có phase', unphased)}
        {canEdit && (
          <button type="button" className="phase-tab add" onClick={() => setSheet({ open: true, phase: null })}>
            <Plus size={13} weight="bold" /> {phases.length ? 'Phase' : 'Chia phase (giai đoạn)'}
          </button>
        )}
      </div>
      <PhaseSheet open={sheet.open} phase={sheet.phase} project={project} unphased={unphased} onClose={() => setSheet((s) => ({ ...s, open: false }))} onCreated={(x) => onChange(x.id)} onDeleted={() => onChange('')} />
    </>
  );
}

function PhaseSheet({ open, phase, project, unphased, onClose, onCreated, onDeleted }: {
  open: boolean; phase: Phase | null; project: ProjectDetail; unphased: number; onClose: () => void; onCreated: (p: Phase) => void; onDeleted: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const [f, setF] = useState({ name: '', startDate: '', endDate: '', takeUnphased: true });
  useEffect(() => {
    if (open) setF({ name: phase?.name ?? '', startDate: phase?.startDate ?? '', endDate: phase?.endDate ?? '', takeUnphased: !phase && !project.phases?.length && unphased > 0 });
  }, [open, phase, project.phases?.length, unphased]);
  const save = useAction(async () => {
    const body = { name: f.name.trim(), startDate: f.startDate || null, endDate: f.endDate || null };
    if (phase) return api<Phase>(`/projects/${project.id}/phases/${phase.id}`, { method: 'PATCH', body });
    const created = await api<Phase>(`/projects/${project.id}/phases`, { method: 'POST', body });
    if (f.takeUnphased && unphased) await api(`/projects/${project.id}/tasks/phase`, { method: 'POST', body: { phaseId: created.id, unphased: true } });
    return created;
  }, { onSuccess: (x) => { toast(phase ? 'Đã lưu phase' : 'Đã tạo phase'); if (!phase) onCreated(x); onClose(); } });
  const assign = useAction(() => api<{ moved: number }>(`/projects/${project.id}/tasks/phase`, { method: 'POST', body: { phaseId: phase!.id, unphased: true } }), { onSuccess: (r) => toast(`Đã đưa ${r.moved} việc vào phase`) });
  const remove = useAction((deleteTasks: boolean) => api<{ tasks: number }>(`/projects/${project.id}/phases/${phase!.id}${deleteTasks ? '?deleteTasks=1' : ''}`, { method: 'DELETE' }), { onSuccess: () => { toast('Đã xoá phase'); onDeleted(); onClose(); } });
  const n = phase ? project.tasks.filter((t) => t.phaseId === phase.id).length : 0;
  const del = async (deleteTasks: boolean) => {
    if (await confirm({ title: `Xoá phase “${phase?.name}”?`, desc: <p>{deleteTasks ? `${n} việc trong phase sẽ bị xoá luôn. Không hoàn tác được.` : `${n} việc trong phase được giữ lại, thành "chưa có phase".`}</p>, ok: 'Xoá phase', danger: true })) remove.mutate(deleteTasks);
  };
  return (
    <Sheet open={open} onClose={onClose} title={phase ? 'Sửa phase' : 'Phase mới'}
      footer={
        <div className="flex flex-col gap-2">
          {phase && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line pb-2">
              {unphased > 0 && <Button variant="ghost" size="sm" onClick={() => assign.mutate(undefined)} disabled={assign.isPending}>Đưa {unphased} việc chưa có phase vào đây</Button>}
              <Button variant="ghost" size="sm" onClick={() => del(false)} disabled={remove.isPending}>Xoá phase, giữ {n} việc</Button>
              {n > 0 && <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft" onClick={() => del(true)} disabled={remove.isPending}>Xoá phase cùng việc</Button>}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Huỷ</Button>
            <Button type="submit" form="phase-form" disabled={save.isPending || !f.name.trim()}>{phase ? 'Lưu' : 'Tạo phase'}</Button>
          </div>
        </div>
      }>
      <form id="phase-form" className="pt-1" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <Field label="Tên phase" hint="VD: Tháng 10, Tháng 11, Giai đoạn 1 — mọi phase dùng chung thành viên, phạm vi, nhóm việc và cấu hình của dự án.">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} autoFocus placeholder="VD: Tháng 11" />
        </Field>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Bắt đầu"><DateInput value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} optional /></Field>
          <Field label="Kết thúc"><DateInput value={f.endDate} onChange={(v) => setF({ ...f, endDate: v })} optional /></Field>
        </div>
        {!phase && unphased > 0 && (
          <label className="mt-1 flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={f.takeUnphased} onChange={(e) => setF({ ...f, takeUnphased: e.target.checked })} className="accent-[var(--primary)]" />
            Đưa {unphased} việc hiện chưa có phase vào phase này
          </label>
        )}
      </form>
    </Sheet>
  );
}
