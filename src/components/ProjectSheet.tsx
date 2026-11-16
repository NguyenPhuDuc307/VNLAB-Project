import { ArrowSquareOut, ArrowsClockwise, Table, Trash, UserPlus, X } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL, useAction, useCan, useMe, useProjects, type GoogleStatus, type Member, type Project, type ProjectDetail } from '../lib/api';
import { ColumnPicker, normalizeColumns } from './ColumnPicker';
import { ScopesEditor } from './ScopesEditor';
import { GetflyBox } from './GetflyBox';
import { Avatar, Button, Chip, DateInput, Field, IconButton, Input, Segmented, Select, Sheet, Textarea, Toggle, useFeedback, cx } from './ui';

export const PROJECT_COLORS = ['#4274bc', '#6e9edc', '#0f7c8c', '#1f8a4c', '#b8860b', '#c74a1c', '#5b4bc4', '#a23b8a', '#6b5a52'];

type Form = { name: string; code: string; customer: string; description: string; startDate: string; color: string; satWeight: number; sunWeight: number; archived: boolean; aiContext: string };
const SETTINGS_TABS = [{ value: 'info', label: 'Thông tin' }, { value: 'scopes', label: 'Phạm vi' }, { value: 'sync', label: 'Đồng bộ' }, { value: 'ai', label: 'AI' }] as const;
type SettingsTab = typeof SETTINGS_TABS[number]['value'];
const empty: Form = { name: '', code: '', customer: '', description: '', startDate: '', color: PROJECT_COLORS[0], satWeight: 0.5, sunWeight: 0, archived: false, aiContext: '' };

/** Tạo hoặc sửa dự án; chủ dự án còn lưu trữ / xoá được. */
export function ProjectSheet({ open, onClose, project, onImport }: { open: boolean; onClose: () => void; project?: ProjectDetail | null; onImport?: () => void }) {
  const { toast, confirm } = useFeedback();
  const can = useCan();
  const nav = useNavigate();
  const [f, setF] = useState<Form>(empty);
  const [tab, setTab] = useState<SettingsTab>('info');
  const tabId = useId();
  useEffect(() => { if (open) setTab('info'); }, [open, project?.id]);
  useEffect(() => {
    if (open) setF(project ? { name: project.name, code: project.code, customer: project.customer, description: project.description, startDate: project.startDate ?? '', color: project.color, satWeight: project.satWeight, sunWeight: project.sunWeight, archived: project.archived, aiContext: project.aiContext ?? '' } : empty);
  }, [open, project?.id]);
  const owner = !project || project.myRole === 'owner';

  const save = useAction(async (b: Form) => {
    const body = { ...b, startDate: b.startDate || null };
    if (project) return api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: owner ? body : { ...body, archived: undefined } });
    const { archived: _a, aiContext: _c, ...create } = body;
    return api<Project>('/projects', { method: 'POST', body: create });
  }, { onSuccess: (p) => { toast(project ? 'Đã lưu dự án' : 'Đã tạo dự án'); onClose(); if (!project) nav(`/du-an/${p.id}`); } });
  const remove = useAction(() => api(`/projects/${project!.id}`, { method: 'DELETE' }), { onSuccess: () => { toast('Đã xoá dự án'); onClose(); nav('/du-an'); } });

  const del = async () => {
    if (await confirm({ title: 'Xoá dự án?', desc: <p><b>{project?.name}</b> cùng mọi nhóm việc và việc bên trong sẽ bị xoá. Không hoàn tác được.</p>, ok: 'Xoá dự án', danger: true })) remove.mutate(undefined);
  };
  const busy = save.isPending || remove.isPending;

  return (
    <Sheet
      wide
      open={open}
      onClose={onClose}
      title={project ? 'Cài đặt dự án' : 'Dự án mới'}
      footer={
        <div className="flex items-center gap-2">
          {project && owner && can('project.project.delete') && <IconButton label="Xoá dự án" onClick={del} className="text-danger hover:bg-danger-soft" disabled={busy}><Trash size={18} /></IconButton>}
          <Button variant="secondary" className="ml-auto" onClick={onClose}>Huỷ</Button>
          {(!project || tab === 'info' || tab === 'ai') && <Button type="submit" form="project-form" disabled={busy || !f.name.trim()}>{busy ? 'Đang lưu…' : project ? 'Lưu' : 'Tạo dự án'}</Button>}
        </div>
      }
    >
      {project && (
        <div role="tablist" aria-label="Cài đặt dự án" className="sticky top-0 z-10 mb-4 flex gap-1 overflow-x-auto border-b border-line bg-surface py-2">
          {SETTINGS_TABS.map((item, i) => (
            <button key={item.value} type="button" role="tab" id={`${tabId}-tab-${item.value}`} aria-controls={`${tabId}-panel-${item.value}`} aria-selected={tab === item.value} tabIndex={tab === item.value ? 0 : -1}
              className={cx('shrink-0 rounded-xl px-3 py-2 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary', tab === item.value ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-fill')}
              onClick={() => setTab(item.value)} onKeyDown={(e) => {
                const next = e.key === 'ArrowRight' ? (i + 1) % SETTINGS_TABS.length : e.key === 'ArrowLeft' ? (i + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? SETTINGS_TABS.length - 1 : -1;
                if (next < 0) return;
                e.preventDefault(); setTab(SETTINGS_TABS[next].value); document.getElementById(`${tabId}-tab-${SETTINGS_TABS[next].value}`)?.focus();
              }}>{item.label}</button>
          ))}
        </div>
      )}
      <form id="project-form" className="pt-1" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...f, name: f.name.trim() }); }}>
        <div role={project ? 'tabpanel' : undefined} id={`${tabId}-panel-info`} aria-labelledby={project ? `${tabId}-tab-info` : undefined} hidden={!!project && tab !== 'info'}>
        <Field label="Tên dự án">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={160} autoFocus={!project} placeholder="VD: Website bán hàng" />
        </Field>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Khách hàng">
            <Input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} maxLength={160} placeholder="VD: Công ty ABC" />
          </Field>
          <Field label="Mã dự án">
            <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} placeholder="VD: WEB01" />
          </Field>
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
        <Field label="Mô tả">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} rows={2} />
        </Field>
        {project && owner && <Toggle checked={f.archived} onChange={(v) => setF({ ...f, archived: v })} label="Lưu trữ dự án" desc="Ẩn khỏi Tổng quan, vẫn mở được trong danh sách Dự án" />}
        </div>
        {project && (
          <div role="tabpanel" id={`${tabId}-panel-ai`} aria-labelledby={`${tabId}-tab-ai`} hidden={tab !== 'ai'}>
          <Field label="Hướng dẫn cho AI (MCP)" hint="AI bên ngoài đọc phần này trước khi tạo / sửa việc: quy ước đặt tên, cách chia phạm vi, ai phụ trách gì… AI cũng tự ghi thêm được khi bạn bảo nó nhớ.">
            <Textarea value={f.aiContext} onChange={(e) => setF({ ...f, aiContext: e.target.value })} maxLength={20000} rows={5} placeholder={'VD:\n- Tên việc bắt đầu bằng động từ.\n- Việc nào cũng gắn phạm vi; phạm vi Kho do Lương phụ trách.'} />
          </Field>
          </div>
        )}
      </form>
      {project && owner && <div hidden={tab !== 'info'}><MergeBox project={project} /></div>}
      {project && <div role="tabpanel" id={`${tabId}-panel-scopes`} aria-labelledby={`${tabId}-tab-scopes`} hidden={tab !== 'scopes'}><ScopesEditor project={project} canEdit={project.myRole !== 'viewer' && can('project.project.write')} /></div>}

      {project && onImport && (
        <div hidden={tab !== 'info'} className="mt-5 rounded-2xl border border-line bg-fill/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-bold">Nhập kế hoạch</p>
              <p className="mt-0.5 text-[12px] text-muted">Dán các dòng chọn từ Excel / Google Sheets; có xem trước trước khi thêm vào dự án.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={onImport}><Table size={15} /> Dán từ bảng tính</Button>
          </div>
        </div>
      )}
      {project && <div role="tabpanel" id={`${tabId}-panel-sync`} aria-labelledby={`${tabId}-tab-sync`} hidden={tab !== 'sync'}>
        <GetflyBox project={project} canEdit={project.myRole !== 'viewer' && can('project.project.write')} />
        {owner && <GoogleSheetBox project={project} />}
        {(owner || project.gcalId) && <GoogleCalendarBox project={project} owner={owner} />}
      </div>}
    </Sheet>
  );
}

/** Thành viên: chủ dự án mời theo email VNLab ID, đổi quyền, gỡ; thành viên tự rời. */
export function MembersSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: ProjectDetail }) {
  const { toast, confirm } = useFeedback();
  const me = useMe();
  const nav = useNavigate();
  const owner = project.myRole === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const add = useAction((b: { email: string; role: 'editor' | 'viewer' }) => api<{ known: boolean }>(`/projects/${project.id}/members`, { method: 'POST', body: b }), {
    onSuccess: (r) => { setEmail(''); toast(r.known ? 'Đã thêm thành viên' : 'Đã mời — người này sẽ thấy dự án khi đăng nhập Project bằng email đó'); },
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
    <Sheet open={open} onClose={onClose} title="Thành viên" footer={owner ? undefined : <Button variant="danger" block onClick={leave} disabled={remove.isPending}>Rời dự án</Button>}>
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
                <IconButton label="Gỡ thành viên" onClick={() => kick(m)} className="text-danger hover:bg-danger-soft"><X size={16} /></IconButton>
              </>
            ) : <Chip>{ROLE_LABEL[m.role]}</Chip>}
          </li>
        ))}
      </ul>
      {owner && (
        <form className="mt-3 rounded-2xl border border-line bg-card p-3" onSubmit={(e) => { e.preventDefault(); add.mutate({ email: email.trim(), role }); }}>
          <p className="mb-2 text-[13px] font-semibold text-ink-2">Mời theo email VNLab ID</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ten@vnlab.id.vn" required className="h-10" />
            <Select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} className="h-10 sm:w-36">
              <option value="editor">Được sửa</option>
              <option value="viewer">Chỉ xem</option>
            </Select>
            <Button type="submit" disabled={add.isPending || !email.trim()} className="h-10 shrink-0"><UserPlus size={16} /> Mời</Button>
          </div>
          <p className="mt-2 text-[12px] text-muted">Người được mời cần có VNLab ID với role Project (cấp ở VNLab Account). Chưa đăng nhập Project thì vẫn giữ lời mời.</p>
        </form>
      )}
    </Sheet>
  );
}

/** Liên kết Google Sheet: người dùng tạo sheet (Google không cho service account tạo file), Share Editor cho service account, dán link; bật tự đồng bộ. */
function GoogleSheetBox({ project }: { project: ProjectDetail }) {
  const { toast, confirm } = useFeedback();
  const status = useQuery({ queryKey: ['google-status'], queryFn: () => api<GoogleStatus>('/google/status'), staleTime: Infinity });
  const [url, setUrl] = useState('');
  const link = useAction((b: { sheetUrl?: string | null; sheetAuto?: boolean; sheetCollapseSubtasks?: boolean }) => api<Project>(`/projects/${project.id}/sheet`, { method: 'PATCH', body: b }), { onSuccess: (_r, b) => { if (b.sheetUrl) { setUrl(''); toast('Đã liên kết sheet, tự đồng bộ đã bật — bấm Đồng bộ ngay để ghi lần đầu'); } else if (b.sheetCollapseSubtasks !== undefined) toast('Đã lưu cách hiển thị — bấm Đồng bộ ngay để áp dụng'); } });
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
    <div className="mt-2 rounded-2xl border border-line bg-card p-3">
      <p className="text-[13px] font-semibold text-ink-2">Google Sheets</p>
      {status.data && !status.data.configured && <p className="mt-1 text-[12.5px] text-muted">Server chưa cấu hình Google service account — xem README (GOOGLE_SERVICE_ACCOUNT_FILE).</p>}
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
          {email && <p className="mt-2 text-[12px] text-muted">Sheet phải Share quyền <b>Người chỉnh sửa</b> cho <code className="rounded bg-fill px-1 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></p>}
          <div className="mt-3"><Toggle checked={project.sheetAuto} onChange={(v) => link.mutate({ sheetAuto: v })} label="Tự đồng bộ" desc="Sau mỗi thay đổi việc / nhóm, ghi sang sheet (gộp trong 30 giây)" /></div>
          <fieldset disabled={busy}>
            <Toggle checked={project.sheetCollapseSubtasks ?? true} onChange={(v) => link.mutate({ sheetCollapseSubtasks: v })} label="Thu gọn task con khi đồng bộ" desc="Bật: chỉ hiện việc chính, bấm +/− để mở chi tiết. Tắt: hiện đầy đủ task con. Áp dụng cho lần đồng bộ tiếp theo." />
          </fieldset>
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-2">Cột đồng bộ</p>
          <ColumnPicker value={normalizeColumns(project.exportColumns)} onChange={(v) => saveCols.mutate(v)} disabled={saveCols.isPending} />
        </>
      ) : (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Ghi kế hoạch (bảng việc + lưới Gantt theo tuần) sang Google Sheet của bạn, một chiều từ app. Tab <b>PLAN</b> và <b>Dữ liệu</b> bị ghi đè, các tab khác giữ nguyên.</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-2">
            <li><a href={newSheetUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">Tạo Google Sheet mới</a> (mở Google Sheets, tên đặt sẵn) hoặc dùng sheet có sẵn. File .xlsx thì chọn Tệp → Lưu dưới dạng Google Trang tính trước.</li>
            <li>Trong sheet bấm <b>Chia sẻ</b>, dán email {email ? <><code className="rounded bg-fill px-1 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></> : 'service account'}, chọn quyền <b>Người chỉnh sửa</b>, bỏ tick gửi thông báo.</li>
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
function GoogleCalendarBox({ project, owner }: { project: ProjectDetail; owner: boolean }) {
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
    if (await confirm({ title: 'Bỏ liên kết Google Calendar?', desc: <p>Các sự kiện app đã tạo trên lịch sẽ bị xoá; sự kiện khác trên lịch giữ nguyên.</p>, ok: 'Bỏ liên kết', danger: true })) link.mutate(null);
  };
  const email = status.data?.email;
  const copyEmail = async () => { try { await navigator.clipboard.writeText(email ?? ''); toast('Đã chép email service account'); } catch { toast('Không chép được — chọn và sao chép tay', 'error'); } };
  const busy = link.isPending || sync.isPending;
  const err = (link.error ?? sync.error) as Error | null;
  const emailEl = email ? <><code className="break-all rounded bg-fill px-1 py-0.5">{email}</code> <button type="button" onClick={copyEmail} className="font-semibold text-primary hover:underline">Chép</button></> : 'service account';
  return (
    <div className="mt-2 rounded-2xl border border-line bg-card p-3">
      <p className="text-[13px] font-semibold text-ink-2">Google Calendar</p>
      {status.data && !status.data.configured && <p className="mt-1 text-[12.5px] text-muted">Server chưa cấu hình Google service account — xem README (GOOGLE_SERVICE_ACCOUNT_FILE).</p>}
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
          <p className="mt-2 text-[12px] leading-relaxed text-muted">Mỗi việc có ngày là một sự kiện cả ngày (bắt đầu → kết thúc), việc xong có dấu ✓. Tự đồng bộ sau mỗi thay đổi (gộp trong 30 giây), kể cả thay đổi qua AI (MCP). Một chiều: sửa trên Google Calendar sẽ bị ghi đè.</p>
        </>
      ) : owner ? (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Đưa các việc có ngày lên Google Calendar thành sự kiện cả ngày, một chiều từ app, tự cập nhật khi kế hoạch đổi. Nên dùng một lịch riêng cho dự án.</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-ink-2">
            <li>Trong <a href="https://calendar.google.com/calendar/u/0/r/settings/createcalendar" target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">Google Calendar</a> tạo lịch mới (VD “{project.name}”) hoặc dùng lịch có sẵn.</li>
            <li>Vào <b>Cài đặt lịch</b> → <b>Chia sẻ với những người cụ thể</b> → thêm {emailEl}, quyền <b>Thay đổi sự kiện</b>.</li>
            <li>Kéo xuống <b>Tích hợp lịch</b>, chép <b>Mã lịch</b> (dạng …@group.calendar.google.com) dán vào ô dưới.</li>
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
function MergeBox({ project }: { project: ProjectDetail }) {
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
    if (await confirm({ title: `Gộp “${src.name}” vào “${project.name}”?`, desc: <p>Mọi việc của “{src.name}” chuyển sang đây thành phase <b>{f.sourcePhase.trim()}</b>; nhóm và phạm vi trùng tên được ghép, thành viên được thêm. “{src.name}” sẽ được lưu trữ (không xoá).</p>, ok: 'Gộp dự án' })) merge.mutate(undefined);
  };
  return (
    <section className="mt-5 rounded-2xl border border-line p-4" aria-label="Gộp dự án thành phase">
      <p className="text-[13px] font-bold">Gộp dự án khác vào đây thành phase</p>
      <p className="mb-3 mt-0.5 text-[12px] text-muted">Dùng khi hai dự án thực ra là hai giai đoạn (VD tháng 10 / tháng 11) dùng chung cấu hình.</p>
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
