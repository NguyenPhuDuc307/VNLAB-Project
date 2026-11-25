import {
  Archive, ArrowsMerge, CalendarBlank, CaretLeft, CaretRight, CloudArrowUp, Info, Plus, Robot, Table, Tag, Trash, UserPlus, Users, type Icon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL, useAction, useCan, useProjects, type Project, type ProjectDetail } from '../lib/api';
import { GetflyBox, useGetflyStatus } from './GetflyBox';
import { formOf, GoogleCalendarBox, GoogleSheetBox, MembersPanel, MergeBox, ProjectInfoFields, type ProjectForm } from './ProjectSheet';
import { ScopesEditor } from './ScopesEditor';
import { Avatar, Button, Chip, Field, IconButton, SectionLabel, Sheet, Textarea, useFeedback, cx } from './ui';

// Cài đặt dự án theo bố cục cài đặt của VNLab Smart Home: nhóm (nhãn nhỏ) -> thẻ bo tròn -> từng dòng
// (ô icon tròn 40px, tiêu đề + một dòng phụ, mũi tên). Bấm dòng mở trang con trong cùng sheet để sửa chi tiết.
type View = 'list' | 'general' | 'plan' | 'members' | 'scopes' | 'sheet' | 'calendar' | 'getfly' | 'ai' | 'merge';
const TITLES: Record<Exclude<View, 'list'>, string> = {
  general: 'Thông tin chung', plan: 'Kế hoạch làm việc', members: 'Thành viên', scopes: 'Phạm vi', sheet: 'Google Sheets',
  calendar: 'Google Calendar', getfly: 'Getfly CRM', ai: 'Hướng dẫn cho AI', merge: 'Gộp dự án thành phase',
};
type Tone = 'primary' | 'ok' | 'warning' | 'danger' | 'muted';
const TONES: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary', ok: 'bg-ok-soft text-ok', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', muted: 'bg-fill text-muted',
};

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <SectionLabel className="!mb-2 px-1">{label}</SectionLabel>
      <div className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-card">{children}</div>
    </section>
  );
}

function Row({ icon: I, tone = 'primary', title, sub, subTone, onClick, right, danger, disabled, lead }: {
  icon?: Icon; tone?: Tone; title: ReactNode; sub?: ReactNode; subTone?: 'danger' | 'ok'; onClick?: () => void; right?: ReactNode; danger?: boolean; disabled?: boolean; lead?: ReactNode;
}) {
  const body = (
    <>
      {lead ?? (I && <span className={cx('grid size-10 shrink-0 place-items-center rounded-full', TONES[danger ? 'danger' : tone])}><I size={19} /></span>)}
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-[15px] font-semibold leading-tight', danger && 'text-danger')}>{title}</span>
        {sub && <span className={cx('mt-0.5 block truncate text-[12px]', subTone === 'danger' ? 'text-danger' : subTone === 'ok' ? 'text-ok' : 'text-muted')}>{sub}</span>}
      </span>
      {right ?? (onClick && <CaretRight size={16} className="shrink-0 text-muted" />)}
    </>
  );
  const cls = 'flex min-h-[60px] w-full items-center gap-3 px-3.5 py-2.5 text-left';
  return onClick
    ? <button type="button" className={cx(cls, 'transition hover:bg-fill/60 disabled:opacity-50')} onClick={onClick} disabled={disabled}>{body}</button>
    : <div className={cls}>{body}</div>;
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');
const linkSub = (linked: boolean, syncedAt?: string | null, error?: string | null): [string, 'danger' | 'ok' | undefined] =>
  !linked ? ['Chưa kết nối', undefined] : error ? ['Lỗi đồng bộ', 'danger'] : [`Đã kết nối${syncedAt ? ` · đồng bộ ${when(syncedAt)}` : ''}`, 'ok'];

/** Cài đặt dự án có sẵn. Giữ nguyên quyền: chủ dự án (lưu trữ, xoá, Sheet, Calendar, gộp), người được sửa (thông tin, phạm vi, Getfly, AI). */
export function ProjectSettings({ open, onClose, project, onImport }: { open: boolean; onClose: () => void; project: ProjectDetail; onImport?: () => void }) {
  const { toast, confirm } = useFeedback();
  const can = useCan();
  const nav = useNavigate();
  const gf = useGetflyStatus();
  const projects = useProjects();
  const [view, setView] = useState<View>('list');
  const [f, setF] = useState<ProjectForm>(() => formOf(project));
  useEffect(() => { if (open) { setView('list'); setF(formOf(project)); } }, [open, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const owner = project.myRole === 'owner';
  const editor = project.myRole !== 'viewer' && can('project.project.write');
  const back = () => { setF(formOf(project)); setView('list'); };

  const save = useAction((b: Partial<Omit<ProjectForm, 'startDate'>> & { startDate?: string | null }) => api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: b }), {
    onSuccess: (_p, b) => { toast(b.archived !== undefined ? (b.archived ? 'Đã lưu trữ dự án' : 'Đã bỏ lưu trữ') : 'Đã lưu'); setView('list'); },
  });
  const remove = useAction(() => api(`/projects/${project.id}`, { method: 'DELETE' }), { onSuccess: () => { toast('Đã xoá dự án'); onClose(); nav('/du-an'); } });
  const del = async () => {
    if (await confirm({ title: 'Xoá dự án?', desc: <p><b>{project.name}</b> cùng mọi nhóm việc và việc bên trong sẽ bị xoá. Không hoàn tác được.</p>, ok: 'Xoá dự án', danger: true })) remove.mutate(undefined);
  };
  const archive = async () => {
    const next = !project.archived;
    if (!next || await confirm({ title: 'Lưu trữ dự án?', desc: <p>Ẩn khỏi Tổng quan, vẫn mở được trong danh sách Dự án.</p>, ok: 'Lưu trữ' })) save.mutate({ archived: next });
  };
  const submit = () => {
    if (view === 'general') save.mutate({ name: f.name.trim(), code: f.code, customer: f.customer, description: f.description });
    if (view === 'plan') save.mutate({ startDate: f.startDate || null, color: f.color, satWeight: f.satWeight, sunWeight: f.sunWeight });
    if (view === 'ai') save.mutate({ aiContext: f.aiContext });
  };
  const busy = save.isPending || remove.isPending;
  const formView = view === 'general' || view === 'plan' || view === 'ai';

  const scopes = project.scopes ?? [];
  const sheet = linkSub(!!project.sheetUrl, project.sheetSyncedAt, project.sheetError);
  const cal = linkSub(!!project.gcalId, project.gcalSyncedAt, project.gcalError);
  const gfReady = !!project.getflyCreatorId || Object.keys(project.getflyGroups ?? {}).length > 0;
  const getfly: [string, 'danger' | 'ok' | undefined] = !gf.data?.configured ? ['Máy chủ chưa kết nối', undefined]
    : project.getflyError ? ['Lỗi đồng bộ', 'danger'] : gfReady ? [`Đã cấu hình${project.getflySyncedAt ? ` · đồng bộ ${when(project.getflySyncedAt)}` : ''}`, 'ok'] : ['Chưa cấu hình', undefined];
  const canMerge = owner && (projects.data ?? []).some((x) => x.id !== project.id && x.myRole === 'owner' && !x.archived);
  const weekend = (w: number) => (w === 0 ? 'nghỉ' : w === 0.5 ? '½' : '1 ngày');

  const title = view === 'list' ? 'Cài đặt dự án' : (
    <span className="flex items-center gap-1">
      <IconButton label="Quay lại" onClick={back} className="-ml-2 !h-9 !w-9"><CaretLeft size={18} /></IconButton>
      <span className="truncate">{TITLES[view]}</span>
    </span>
  );
  const footer = formView && editor ? (
    <div className="flex gap-2">
      <Button variant="secondary" className="ml-auto" onClick={back}>Huỷ</Button>
      <Button type="submit" form="project-settings-form" disabled={busy || !f.name.trim()}>{busy ? 'Đang lưu…' : 'Lưu'}</Button>
    </div>
  ) : undefined;

  return (
    <Sheet wide open={open} onClose={onClose} title={title} footer={footer}>
      {view === 'list' && (
        <div className="pt-1">
          <Group label="Chung">
            <Row lead={<span className="grid size-10 shrink-0 place-items-center rounded-full text-[15px] font-bold text-white" style={{ background: project.color }}>{project.name.slice(0, 1).toUpperCase()}</span>}
              title={project.name} sub={[project.code, project.customer].filter(Boolean).join(' · ') || 'Tên, mã, khách hàng, mô tả'} onClick={editor ? () => setView('general') : undefined} />
            <Row icon={CalendarBlank} title="Kế hoạch làm việc" sub={`${project.startDate ? `Bắt đầu ${new Date(`${project.startDate}T00:00:00`).toLocaleDateString('vi-VN')} · ` : ''}T7 ${weekend(project.satWeight)} · CN ${weekend(project.sunWeight)}`} onClick={editor ? () => setView('plan') : undefined} />
          </Group>

          <Group label="Thành viên">
            <Row lead={<Avatar name={project.owner.name || project.owner.email} src={project.owner.avatar} size={40} />} title={project.owner.name || project.owner.email} sub={project.owner.email} right={<Chip tone="primary">{ROLE_LABEL.owner}</Chip>} />
            {project.members.slice(0, 4).map((m) => (
              <Row key={m.email} lead={<Avatar name={m.name || m.email} src={m.avatar} size={40} />} title={m.name || m.email} sub={m.email} right={<Chip>{ROLE_LABEL[m.role]}</Chip>} onClick={() => setView('members')} />
            ))}
            {project.members.length > 4 && <Row icon={Users} tone="muted" title={`${project.members.length - 4} người khác`} onClick={() => setView('members')} />}
            <Row icon={owner ? UserPlus : Users} title={owner ? 'Mời thành viên' : 'Xem thành viên'} onClick={() => setView('members')} />
          </Group>

          <Group label="Phạm vi">
            {scopes.map((sc) => (
              <Row key={sc.id} lead={<span className="grid size-10 shrink-0 place-items-center"><span className="size-3.5 rounded-full" style={{ background: sc.color }} /></span>}
                title={sc.name} sub={sc.owner ? `Phụ trách: ${sc.owner}` : `${project.tasks.filter((t) => t.scopeId === sc.id).length} việc`} onClick={() => setView('scopes')} />
            ))}
            <Row icon={scopes.length ? Tag : Plus} title={editor ? 'Thêm phạm vi' : 'Xem phạm vi'} sub={scopes.length ? undefined : 'Gắn tag cho việc để lọc theo mảng'} onClick={() => setView('scopes')} />
          </Group>

          <Group label="Kết nối">
            {owner && <Row icon={Table} tone={sheet[1] === 'ok' ? 'ok' : 'primary'} title="Google Sheets" sub={sheet[0]} subTone={sheet[1]} onClick={() => setView('sheet')} />}
            {(owner || project.gcalId) && <Row icon={CalendarBlank} tone={cal[1] === 'ok' ? 'ok' : 'primary'} title="Google Calendar" sub={cal[0]} subTone={cal[1]} onClick={() => setView('calendar')} />}
            <Row icon={CloudArrowUp} tone={getfly[1] === 'ok' ? 'ok' : 'primary'} title="Getfly CRM" sub={getfly[0]} subTone={getfly[1]} onClick={() => setView('getfly')} />
          </Group>

          <Group label="AI & dữ liệu">
            <Row icon={Robot} title="Hướng dẫn cho AI" sub={project.aiContext?.trim() ? project.aiContext.trim().split('\n')[0] : 'Chưa có'} onClick={() => setView('ai')} />
            {onImport && <Row icon={Table} title="Nhập kế hoạch" sub="Dán từ Excel / Google Sheets" onClick={onImport} />}
            {canMerge && <Row icon={ArrowsMerge} title="Gộp dự án khác thành phase" onClick={() => setView('merge')} />}
          </Group>

          {owner && (
            <Group label="Vùng nguy hiểm">
              <Row icon={Archive} tone="warning" title={project.archived ? 'Bỏ lưu trữ' : 'Lưu trữ dự án'} sub={project.archived ? 'Đang ẩn khỏi Tổng quan' : 'Ẩn khỏi Tổng quan'} onClick={() => void archive()} disabled={busy} />
              {can('project.project.delete') && <Row icon={Trash} danger title="Xoá dự án" sub="Xoá mọi nhóm và việc, không hoàn tác" onClick={() => void del()} disabled={busy} />}
            </Group>
          )}
          {!editor && <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted"><Info size={14} /> Bạn chỉ được xem dự án này.</p>}
        </div>
      )}

      {formView && (
        <form id="project-settings-form" className="pt-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <fieldset disabled={!editor}>
            {view === 'general' && <ProjectInfoFields f={f} setF={setF} part="info" />}
            {view === 'plan' && <ProjectInfoFields f={f} setF={setF} part="plan" />}
            {view === 'ai' && (
              <Field label="Quy ước cho AI (MCP)" hint="AI đọc trước khi tạo, sửa việc.">
                <Textarea value={f.aiContext} onChange={(e) => setF({ ...f, aiContext: e.target.value })} maxLength={20000} rows={10} placeholder={'VD:\n- Tên việc bắt đầu bằng động từ.\n- Việc nào cũng gắn phạm vi; phạm vi Kho do Lương phụ trách.'} />
              </Field>
            )}
          </fieldset>
        </form>
      )}
      {view === 'members' && <MembersPanel project={project} onLeft={onClose} />}
      {view === 'scopes' && <ScopesEditor project={project} canEdit={editor} />}
      {view === 'sheet' && owner && <GoogleSheetBox project={project} />}
      {view === 'calendar' && <GoogleCalendarBox project={project} owner={owner} />}
      {view === 'getfly' && <GetflyBox project={project} canEdit={editor} />}
      {view === 'merge' && owner && <MergeBox project={project} />}
    </Sheet>
  );
}
