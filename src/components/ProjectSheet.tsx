import { ArrowSquareOut, ArrowsClockwise, UserPlus, X } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL, useAction, useCan, useMe, useProjects, type GoogleStatus, type Member, type Project, type ProjectDetail } from '../lib/api';
import { ColumnPicker, normalizeColumns } from './ColumnPicker';
import { ProjectSettings } from './ProjectSettings';
import { Avatar, Button, Chip, DateInput, Field, IconButton, Input, Segmented, Select, Sheet, StepDots, SectionLabel, Textarea, Toggle, useFeedback, cx } from './ui';

export const PROJECT_COLORS = ['#4274bc', '#6e9edc', '#0f7c8c', '#1f8a4c', '#b8860b', '#c74a1c', '#5b4bc4', '#a23b8a', '#6b5a52'];

export type ProjectForm = { name: string; code: string; customer: string; description: string; startDate: string; color: string; satWeight: number; sunWeight: number; archived: boolean; aiContext: string };
type Form = ProjectForm;
export const emptyProjectForm: Form = { name: '', code: '', customer: '', description: '', startDate: '', color: PROJECT_COLORS[0], satWeight: 0.5, sunWeight: 0, archived: false, aiContext: '' };
export const formOf = (p: ProjectDetail): Form => ({ name: p.name, code: p.code, customer: p.customer, description: p.description, startDate: p.startDate ?? '', color: p.color, satWeight: p.satWeight, sunWeight: p.sunWeight, archived: p.archived, aiContext: p.aiContext ?? '' });

/** Tạo dự án mới (2 bước); dự án có sẵn thì mở Cài đặt dự án (ProjectSettings). */
export function ProjectSheet({ open, onClose, project, onImport }: { open: boolean; onClose: () => void; project?: ProjectDetail | null; onImport?: () => void }) {
  if (project) return <ProjectSettings open={open} onClose={onClose} project={project} onImport={onImport} />;
  return <NewProjectSheet open={open} onClose={onClose} />;
}

/** Ô thông tin dự án: phần "Thông tin" (tên, khách hàng, mã, mô tả) và phần "Kế hoạch" (ngày bắt đầu, màu, ngày công cuối tuần). */
export function ProjectInfoFields({ f, setF, part, autoFocus }: { f: Form; setF: (f: Form) => void; part: 'info' | 'plan'; autoFocus?: boolean }) {
  if (part === 'info') return (
    <>
      <Field label="Tên dự án">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={160} autoFocus={autoFocus} placeholder="VD: Website bán hàng" />
      </Field>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Khách hàng">
          <Input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} maxLength={160} placeholder="VD: Công ty ABC" />
        </Field>
        <Field label="Mã dự án">
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} placeholder="VD: WEB01" />
        </Field>
      </div>
      <Field label="Mô tả">
        <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} rows={2} />
      </Field>
    </>
  );
  return (
    <div className="grid gap-x-3 sm:grid-cols-2">
      <Field label="Ngày bắt đầu">
        <DateInput value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} optional />
      </Field>
      <Field label="Màu nhận diện" group>
        <div className="flex h-11 flex-wrap items-center gap-2">
          {PROJECT_COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Màu ${c}`} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} className={cx('h-7 w-7 rounded-full transition', f.color === c && 'ring-2 ring-offset-2 ring-offset-surface')} style={{ background: c, ['--tw-ring-color' as string]: c }} />
          ))}
        </div>
      </Field>
      <Field label="Thứ bảy tính" group hint="Dùng khi tự tính cột Ngày công">
        <Segmented value={String(f.satWeight)} onChange={(v) => setF({ ...f, satWeight: Number(v) })} options={[{ value: '0', label: 'Nghỉ' }, { value: '0.5', label: '½ ngày' }, { value: '1', label: '1 ngày' }]} />
      </Field>
      <Field label="Chủ nhật tính" group>
        <Segmented value={String(f.sunWeight)} onChange={(v) => setF({ ...f, sunWeight: Number(v) })} options={[{ value: '0', label: 'Nghỉ' }, { value: '0.5', label: '½ ngày' }, { value: '1', label: '1 ngày' }]} />
      </Field>
    </div>
  );
}

function NewProjectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useFeedback();
  const nav = useNavigate();
  const [f, setF] = useState<Form>(emptyProjectForm);
  const [step, setStep] = useState(1);
  useEffect(() => { if (open) { setF(emptyProjectForm); setStep(1); } }, [open]);
  const save = useAction(async (b: Form) => {
    const { archived: _a, aiContext: _c, ...create } = { ...b, startDate: b.startDate || null };
    return api<Project>('/projects', { method: 'POST', body: create });
  }, { onSuccess: (p) => { toast('Đã tạo dự án'); onClose(); nav(`/du-an/${p.id}`); } });
  const busy = save.isPending;
  return (
    <Sheet
      wide
      open={open}
      onClose={onClose}
      title={<span className="flex items-center justify-between gap-3">Dự án mới<StepDots step={step} total={2} titles={['Thông tin', 'Kế hoạch']} /></span>}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="ml-auto" onClick={step === 2 ? () => setStep(1) : onClose}>{step === 2 ? 'Quay lại' : 'Huỷ'}</Button>
          <Button type="submit" form="project-form" disabled={busy || !f.name.trim()}>{busy ? 'Đang lưu…' : step === 1 ? 'Tiếp tục' : 'Tạo dự án'}</Button>
        </div>
      }
    >
      <form id="project-form" className="pt-1" onSubmit={(e) => { e.preventDefault(); if (step === 1) { setStep(2); return; } save.mutate({ ...f, name: f.name.trim() }); }}>
        {step === 2 && <div className="mb-4 flex min-w-0 items-center gap-2 rounded-full bg-fill px-4 py-2.5 text-sm"><span className="size-3 shrink-0 rounded-full" style={{ background: f.color }} /><span className="truncate font-semibold">{f.name}</span>{f.code && <span className="truncate text-muted">{f.code}</span>}</div>}
        <div hidden={step !== 1}><ProjectInfoFields f={f} setF={setF} part="info" autoFocus /></div>
        <div hidden={step !== 2}><SectionLabel>Kế hoạch làm việc</SectionLabel><ProjectInfoFields f={f} setF={setF} part="plan" /></div>
      </form>
    </Sheet>
  );
}

/** Thành viên: chủ dự án mời theo email VNLab ID, đổi quyền, gỡ; thành viên tự rời. */
export function MembersSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: ProjectDetail }) {
  return (
    <Sheet open={open} onClose={onClose} title="Thành viên">
      <MembersPanel project={project} onLeft={onClose} />
    </Sheet>
  );
}

/** Danh sách thành viên + mời / đổi quyền / gỡ (chủ dự án) hoặc rời dự án (thành viên). Dùng ở MembersSheet và Cài đặt dự án. */
export function MembersPanel({ project, onLeft }: { project: ProjectDetail; onLeft?: () => void }) {
  const onClose = () => onLeft?.();
  const { toast, confirm } = useFeedback();
  const me = useMe();
  const nav = useNavigate();
  const owner = project.myRole === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const add = useAction((b: { email: string; role: 'editor' | 'viewer' }) => api<{ known: boolean }>(`/projects/${project.id}/members`, { method: 'POST', body: b }), {
    onSuccess: (r) => { setEmail(''); toast(r.known ? 'Đã thêm thành viên' : 'Đã mời — họ sẽ thấy dự án khi đăng nhập'); },
  });
  const change = useAction((b: { email: string; role: 'editor' | 'viewer' }) => api(`/projects/${project.id}/members/${encodeURIComponent(b.email)}`, { method: 'PATCH', body: { role: b.role } }));
  const remove = useAction((em: string) => api(`/projects/${project.id}/members/${encodeURIComponent(em)}`, { method: 'DELETE' }), {
    onSuccess: (_r, em) => { if (em === 'me') { toast('Đã rời dự án'); onClose(); nav('/du-an'); } },
  });
  const kick = async (m: Member) => {
    if (await confirm({ title: 'Gỡ thành viên?', desc: <p><b>{m.name || m.email}</b> sẽ không còn thấy dự án này.</p>, ok: 'Gỡ', danger: true })) remove.mutate(m.email);
  };
  const leave = async () => {
    if (await confirm({ title: 'Rời dự án?', desc: <p>Bạn sẽ không còn thấy <b>{project.name}</b>. Chủ dự án có thể mời lại.</p>, ok: 'Rời', danger: true })) remove.mutate('me');
  };

  return (
    <>
      <ul className="divide-y divide-line">
        <li className="flex items-center gap-3 py-3">
          <Avatar name={project.owner.name || project.owner.email} src={project.owner.avatar} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold">{project.owner.name || project.owner.email}{me.data?.email === project.owner.email ? ' (bạn)' : ''}</span>
            <span className="block truncate text-[12px] text-muted">{project.owner.email}</span>
          </span>
          <Chip tone="primary">{ROLE_LABEL.owner}</Chip>
        </li>
        {project.members.map((m) => (
          <li key={m.email} className="flex items-center gap-3 py-3">
            <Avatar name={m.name || m.email} src={m.avatar} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold">{m.name || m.email}{me.data?.email === m.email ? ' (bạn)' : ''}</span>
              <span className="block truncate text-[12px] text-muted">{m.email}{!m.userId && ' · chưa đăng nhập Project'}</span>
            </span>
            {owner ? (
              <>
                <Select value={m.role} onChange={(e) => change.mutate({ email: m.email, role: e.target.value as 'editor' | 'viewer' })} className="h-9 w-auto px-2.5 text-[13px]" aria-label={`Quyền của ${m.email}`}>
                  <option value="editor">Được sửa</option>
                  <option value="viewer">Chỉ xem</option>
                </Select>
                <IconButton label="Gỡ thành viên" onClick={() => kick(m)} className="!h-9 !w-9 text-danger hover:bg-danger-soft"><X size={16} /></IconButton>
              </>
            ) : <Chip>{ROLE_LABEL[m.role]}</Chip>}
          </li>
        ))}
      </ul>
      {owner && (
        <form className="mt-4" onSubmit={(e) => { e.preventDefault(); add.mutate({ email: email.trim(), role }); }}>
          <SectionLabel>Mời theo email VNLab ID</SectionLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ten@vnlab.id.vn" required className="h-10" />
            <Select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} className="h-10 sm:w-36">
              <option value="editor">Được sửa</option>
              <option value="viewer">Chỉ xem</option>
            </Select>
            <Button type="submit" disabled={add.isPending || !email.trim()} className="h-10 shrink-0"><UserPlus size={16} /> Mời</Button>
          </div>
          <p className="mt-2 px-1 text-[12px] text-muted">Người được mời cần có tài khoản VNLab ID.</p>
        </form>
      )}
      {!owner && <Button variant="danger" block className="mt-4" onClick={leave} disabled={remove.isPending}>Rời dự án</Button>}
    </>
  );
}

/** Liên kết Google Sheet: người dùng tạo sheet (Google không cho service account tạo file), Share Editor cho service account, dán link; bật tự đồng bộ. */
export function GoogleSheetBox({ project }: { project: ProjectDetail }) {
  const { toast, confirm } = useFeedback();
  const status = useQuery({ queryKey: ['google-status'], queryFn: () => api<GoogleStatus>('/google/status'), staleTime: Infinity });
  const [url, setUrl] = useState('');
  const link = useAction((b: { sheetUrl?: string | null; sheetAuto?: boolean; sheetCollapseSubtasks?: boolean }) => api<Project>(`/projects/${project.id}/sheet`, { method: 'PATCH', body: b }), { onSuccess: (_r, b) => { if (b.sheetUrl) { setUrl(''); toast('Đã liên kết — bấm Đồng bộ ngay để ghi lần đầu'); } else if (b.sheetCollapseSubtasks !== undefined) toast('Đã lưu cách hiển thị — bấm Đồng bộ ngay để áp dụng'); } });
  const sync = useAction(() => api<{ sheetUrl: string }>(`/projects/${project.id}/sheet/sync`, { method: 'POST', body: {} }), { onSuccess: () => toast('Đã đồng bộ sang Google Sheet') });
  const unlink = async () => {
    if (await confirm({ title: 'Bỏ liên kết Google Sheet?', desc: <p>Sheet vẫn còn trên Google Drive; app chỉ thôi ghi vào đó.</p>, ok: 'Bỏ liên kết', danger: true })) link.mutate({ sheetUrl: null });
  };
  const saveCols = useAction((cols: string[]) => api(`/projects/${project.id}`, { method: 'PATCH', body: { exportColumns: cols } }));
  const copyEmail = async () => { try { await navigator.clipboard.writeText(status.data?.email ?? ''); toast('Đã chép email service account'); } catch { toast('Không chép được — chọn và sao chép tay', 'error'); } };
  const newSheetUrl = `https://docs.google.com/spreadsheets/create?title=${encodeURIComponent(`${project.name} — VNLab Project`)}`;
  const busy = link.isPending || sync.isPending;
  const err = (link.error ?? sync.error) as Error | null;
  const email = status.data?.email;
  return (
    <div>
      {status.data && !status.data.configured && <p className="mt-1 text-[12.5px] text-muted">Máy chủ chưa kết nối Google.</p>}
      {project.sheetUrl ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a href={project.sheetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-primary hover:underline"><ArrowSquareOut size={15} /> Mở Google Sheet</a>
            <span className="text-[12px] text-muted">{project.sheetSyncedAt ? `đồng bộ lần cuối ${new Date(project.sheetSyncedAt).toLocaleString('vi-VN')}` : 'chưa đồng bộ lần nào'}</span>
          </div>
          {project.sheetError && <p className="mt-1 text-[12.5px] text-danger">{project.sheetError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => sync.mutate(undefined)} disabled={busy || !status.data?.configured}><ArrowsClockwise size={14} /> Đồng bộ ngay</Button>
            <Button size="sm" variant="ghost" onClick={unlink} disabled={busy} className="text-danger">Bỏ liên kết</Button>
          </div>
          {email && <p className="mt-2 text-[12px] text-muted">Sheet phải Share quyền <b>Người chỉnh sửa</b> cho <code className="rounded-md bg-fill px-1.5 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></p>}
          <div className="mt-3"><Toggle checked={project.sheetAuto} onChange={(v) => link.mutate({ sheetAuto: v })} label="Tự đồng bộ" desc="Tự ghi sang sheet sau mỗi thay đổi" /></div>
          <fieldset disabled={busy}>
            <Toggle checked={project.sheetCollapseSubtasks ?? true} onChange={(v) => link.mutate({ sheetCollapseSubtasks: v })} label="Thu gọn task con khi đồng bộ" desc="Chỉ hiện việc chính, bấm +/− để xem task con" />
          </fieldset>
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-2">Cột đồng bộ</p>
          <ColumnPicker value={normalizeColumns(project.exportColumns)} onChange={(v) => saveCols.mutate(v)} disabled={saveCols.isPending} />
        </>
      ) : (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Ghi kế hoạch sang Google Sheet. Tab <b>PLAN</b> và <b>Dữ liệu</b> sẽ bị ghi đè.</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-2">
            <li><a href={newSheetUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">Tạo Google Sheet mới</a> hoặc dùng sheet có sẵn.</li>
            <li>Trong sheet bấm <b>Chia sẻ</b>, dán email {email ? <><code className="rounded-md bg-fill px-1.5 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></> : 'service account'}, quyền <b>Người chỉnh sửa</b>.</li>
            <li>Dán link sheet vào ô dưới và bấm <b>Liên kết</b>, rồi <b>Đồng bộ ngay</b>.</li>
          </ol>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (url.trim()) link.mutate({ sheetUrl: url.trim() }); }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" className="h-10" />
            <Button type="submit" disabled={busy || !url.trim() || !status.data?.configured} className="h-10 shrink-0">Liên kết</Button>
          </form>
        </>
      )}
      {err && <p className="mt-2 text-[12.5px] text-danger">{err.message}</p>}
    </div>
  );
}

/** Liên kết Google Calendar: người dùng chia sẻ lịch cho service account (quyền "Thay đổi sự kiện"), dán Mã lịch; app tự đồng bộ sau mỗi thay đổi. */
export function GoogleCalendarBox({ project, owner }: { project: ProjectDetail; owner: boolean }) {
  const { toast, confirm } = useFeedback();
  const can = useCan();
  const status = useQuery({ queryKey: ['google-status'], queryFn: () => api<GoogleStatus>('/google/status'), staleTime: Infinity });
  const [cal, setCal] = useState('');
  type SyncR = { created: number; updated: number; deleted: number; unchanged: number };
  const sync = useAction(() => api<SyncR>(`/projects/${project.id}/gcal/sync`, { method: 'POST', body: {} }), {
    onSuccess: (r) => toast(r.created || r.updated || r.deleted ? `Đã đồng bộ lịch: thêm ${r.created}, sửa ${r.updated}, xoá ${r.deleted} sự kiện` : 'Lịch đã khớp, không có gì đổi'),
  });
  const link = useAction((calendar: string | null) => api<Project>(`/projects/${project.id}/gcal`, { method: 'PATCH', body: { calendar } }), {
    // Liên kết xong ghi luôn lần đầu để biết ngay lịch đã chia sẻ đúng chưa.
    onSuccess: (_r, calendar) => { if (calendar) { setCal(''); sync.mutate(undefined); } else toast('Đã bỏ liên kết lịch và xoá các sự kiện app đã tạo'); },
  });
  const unlink = async () => {
    if (await confirm({ title: 'Bỏ liên kết Google Calendar?', desc: <p>Sự kiện app đã tạo sẽ bị xoá, sự kiện khác giữ nguyên.</p>, ok: 'Bỏ liên kết', danger: true })) link.mutate(null);
  };
  const email = status.data?.email;
  const copyEmail = async () => { try { await navigator.clipboard.writeText(email ?? ''); toast('Đã chép email service account'); } catch { toast('Không chép được — chọn và sao chép tay', 'error'); } };
  const busy = link.isPending || sync.isPending;
  const err = (link.error ?? sync.error) as Error | null;
  const emailEl = email ? <><code className="break-all rounded-md bg-fill px-1.5 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></> : 'service account';
  return (
    <div>
      {status.data && !status.data.configured && <p className="mt-1 text-[12.5px] text-muted">Máy chủ chưa kết nối Google.</p>}
      {project.gcalId ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {project.gcalUrl && <a href={project.gcalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-primary hover:underline"><ArrowSquareOut size={15} /> Mở Google Calendar</a>}
            <span className="text-[12px] text-muted">{project.gcalSyncedAt ? `đồng bộ lần cuối ${new Date(project.gcalSyncedAt).toLocaleString('vi-VN')}` : 'chưa đồng bộ lần nào'}</span>
          </div>
          <p className="mt-1 break-all text-[12px] text-muted">Lịch: {project.gcalId}</p>
          {project.gcalError && <p className="mt-1 text-[12.5px] text-danger">{project.gcalError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {can('project.project.write') && <Button size="sm" onClick={() => sync.mutate(undefined)} disabled={busy || !status.data?.configured}><ArrowsClockwise size={14} className={sync.isPending ? 'animate-spin' : undefined} /> Đồng bộ ngay</Button>}
            {owner && <Button size="sm" variant="ghost" onClick={unlink} disabled={busy} className="text-danger">Bỏ liên kết</Button>}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">Tự cập nhật theo kế hoạch. Sửa trên Google Calendar sẽ bị ghi đè.</p>
        </>
      ) : owner ? (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Đưa việc có ngày lên Google Calendar. Nên dùng lịch riêng cho dự án.</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-2">
            <li>Trong <a href="https://calendar.google.com/calendar/u/0/r/settings/createcalendar" target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">Google Calendar</a> tạo lịch mới (VD “{project.name}”) hoặc dùng lịch có sẵn.</li>
            <li>Vào <b>Cài đặt lịch</b> → <b>Chia sẻ với những người cụ thể</b> → thêm {emailEl}, quyền <b>Thay đổi sự kiện</b>.</li>
            <li>Chép <b>Mã lịch</b> ở mục <b>Tích hợp lịch</b>, dán vào ô dưới.</li>
          </ol>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (cal.trim()) link.mutate(cal.trim()); }}>
            <Input value={cal} onChange={(e) => setCal(e.target.value)} placeholder="abc123…@group.calendar.google.com" className="h-10" autoCapitalize="none" spellCheck={false} />
            <Button type="submit" disabled={busy || !cal.trim() || !status.data?.configured} className="h-10 shrink-0">Liên kết</Button>
          </form>
        </>
      ) : null}
      {err && <p className="mt-2 text-[12.5px] text-danger">{err.message}</p>}
    </div>
  );
}

/** Gộp một dự án khác (của mình) vào dự án này thành một phase — dùng khi hai "dự án" thực ra là hai giai đoạn. */
export function MergeBox({ project }: { project: ProjectDetail }) {
  const { toast, confirm } = useFeedback();
  const projects = useProjects();
  const others = (projects.data ?? []).filter((x) => x.id !== project.id && x.myRole === 'owner' && !x.archived);
  const unphased = project.tasks.filter((t) => !t.phaseId).length;
  const [f, setF] = useState({ sourceId: '', sourcePhase: '', targetPhase: '' });
  const merge = useAction(() => api<{ moved: number; tagged: number; sourceName: string }>(`/projects/${project.id}/merge`, { method: 'POST', body: { sourceId: f.sourceId, sourcePhase: f.sourcePhase.trim(), targetPhase: f.targetPhase.trim() || undefined } }), {
    onSuccess: (r) => { toast(`Đã gộp “${r.sourceName}”: chuyển ${r.moved} việc${r.tagged ? `, gán phase cho ${r.tagged} việc sẵn có` : ''}`); setF({ sourceId: '', sourcePhase: '', targetPhase: '' }); },
  });
  if (!others.length) return null;
  const src = others.find((x) => x.id === f.sourceId);
  const go = async () => {
    if (!src || !f.sourcePhase.trim()) return;
    if (await confirm({ title: `Gộp “${src.name}” vào “${project.name}”?`, desc: <p>Việc của “{src.name}” chuyển sang đây thành phase <b>{f.sourcePhase.trim()}</b>. “{src.name}” sẽ được lưu trữ.</p>, ok: 'Gộp dự án' })) merge.mutate(undefined);
  };
  return (
    <section aria-label="Gộp dự án thành phase">
      <p className="mb-3 px-1 text-[12px] text-muted">Dùng khi hai dự án thực ra là hai giai đoạn.</p>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Dự án được gộp">
          <Select value={f.sourceId} onChange={(e) => { const x = others.find((o) => o.id === e.target.value); setF({ ...f, sourceId: e.target.value, sourcePhase: f.sourcePhase || (x ? x.name.replace(project.name, '').trim() || x.name : '') }); }}>
            <option value="">Chọn dự án</option>
            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <Field label="Thành phase">
          <Input value={f.sourcePhase} onChange={(e) => setF({ ...f, sourcePhase: e.target.value })} maxLength={80} placeholder="VD: Tháng 11" />
        </Field>
        {unphased > 0 && (
          <Field label={`Phase cho ${unphased} việc hiện có ở đây`} hint="Để trống thì giữ là chưa có phase.">
            <Input value={f.targetPhase} onChange={(e) => setF({ ...f, targetPhase: e.target.value })} maxLength={80} placeholder="VD: Tháng 10" />
          </Field>
        )}
      </div>
      <Button size="sm" variant="secondary" disabled={!src || !f.sourcePhase.trim() || merge.isPending} onClick={() => void go()}>{merge.isPending ? 'Đang gộp…' : 'Gộp dự án'}</Button>
    </section>
  );
}
