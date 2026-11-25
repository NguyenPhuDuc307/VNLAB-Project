import { CloudArrowUp, LinkBreak } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, type ProjectDetail } from '../lib/api';
import { getflyBookmarklet } from '../lib/getfly-bookmarklet';
import type { PendingDone } from '../pages/GetflyDone';
import { Button, Field, Input, SectionLabel, Sheet, useFeedback, cx } from './ui';

export type GetflyResult = { created: number; adopted?: number; updated: number; deleted: number; unlinked?: number; unchanged: number; errors: string[]; warnings: string[]; syncedAt: string };
export const useGetflyStatus = () => useQuery({ queryKey: ['getfly-status'], queryFn: () => api<{ configured: boolean; host: string | null; webOrigin: string }>('/getfly/status'), staleTime: 300_000 });

/** Tóm tắt kết quả đồng bộ thành một câu cho toast. */
export function getflySummary(r: GetflyResult) {
  const parts = [r.adopted && `nhận ${r.adopted} có sẵn`, r.created && `tạo ${r.created}`, r.updated && `sửa ${r.updated}`, r.deleted && `xoá ${r.deleted}`, r.unlinked && `gỡ liên kết ${r.unlinked}`].filter(Boolean);
  return parts.length ? `Getfly: ${parts.join(', ')} việc` : r.warnings.length ? `Getfly: ${r.warnings.length} lưu ý khi đồng bộ` : 'Getfly đã khớp, không có gì thay đổi';
}

export type GetflyScope = { groupId?: string; taskId?: string };
/** Gỡ khỏi Getfly: xoá việc lá app đã tạo; việc có sẵn / việc cha chỉ gỡ liên kết (không bao giờ xoá). */
export type GetflyUnsyncResult = { deleted: number; unlinked: number; errors: string[]; warnings?: string[] };

// Toast chỉ chứa được một dòng; danh sách đủ lỗi/lưu ý mở trong GetflyReport.
const REPORT_EVENT = 'getfly-report';
type ReportDetail = { projectId: string; result: GetflyResult };
const openGetflyReport = (projectId: string, result: GetflyResult) =>
  window.dispatchEvent(new CustomEvent<ReportDetail>(REPORT_EVENT, { detail: { projectId, result } }));

/** Bảng kết quả đồng bộ Getfly gần nhất: mọi lỗi và lưu ý, đọc đủ để sửa. */
export function GetflyReport({ projectId }: { projectId: string }) {
  const [result, setResult] = useState<GetflyResult | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<ReportDetail>).detail; if (d.projectId === projectId) setResult(d.result); };
    window.addEventListener(REPORT_EVENT, on);
    return () => window.removeEventListener(REPORT_EVENT, on);
  }, [projectId]);
  const r = result;
  return (
    <Sheet open={!!r} onClose={() => setResult(null)} title="Kết quả đồng bộ Getfly" footer={<Button variant="secondary" block onClick={() => setResult(null)}>Đóng</Button>}>
      {r && (
        <div className="space-y-4 pb-2 text-[14px]">
          <p className="text-ink-2">{getflySummary(r)}{r.syncedAt ? ` · ${new Date(r.syncedAt).toLocaleString('vi-VN')}` : ''}</p>
          {r.errors.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-danger">{r.errors.length} lỗi</h3>
              <ul className="space-y-1.5">{r.errors.map((e, i) => <li key={i} className="select-text break-words rounded-[18px] bg-danger-soft px-3.5 py-2">{e}</li>)}</ul>
            </section>
          )}
          {r.warnings.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-muted">{r.warnings.length} lưu ý</h3>
              <ul className="space-y-1.5">{r.warnings.map((w, i) => <li key={i} className="select-text break-words rounded-[18px] bg-fill px-3.5 py-2">{w}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}

export type GetflyJob = {
  id: string; kind: 'sync' | 'unsync'; scope?: GetflyScope; status: 'running' | 'done' | 'error'; done: number; total: number;
  startedAt: string; finishedAt: string | null; result: (GetflyResult | GetflyUnsyncResult) | null; error: string | null;
};

/**
 * Job Getfly chạy nền của dự án: bắt đầu (sync / unsync), hỏi tiến độ mỗi 1,2 giây khi đang chạy,
 * xong thì báo kết quả ở góc màn hình và tải lại dự án. Dùng chung cho thanh công cụ và hộp Getfly.
 */
// Dùng chung giữa các nơi gọi hook (thanh công cụ + hộp Getfly) để mỗi job chỉ báo kết quả một lần.
const watchingJobs = new Set<string>();
const reportedJobs = new Set<string>();

export function useGetflyJob(projectId: string) {
  const { toast } = useFeedback();
  const qc = useQueryClient();
  const key = ['getfly-job', projectId];
  const job = useQuery({
    queryKey: key,
    queryFn: () => api<GetflyJob | null>(`/projects/${projectId}/getfly/job`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1200 : false),
  });
  useEffect(() => {
    const j = job.data;
    if (!j) return;
    if (j.status === 'running') { watchingJobs.add(j.id); return; }
    // Chỉ báo job đã thấy chạy trong phiên này (không báo lại job cũ khi mở trang), và chỉ một lần.
    if (!watchingJobs.has(j.id) || reportedJobs.has(j.id)) return;
    reportedJobs.add(j.id);
    if (j.status === 'error') toast(j.error ?? 'Đồng bộ Getfly lỗi', 'error');
    else if (j.kind === 'unsync') {
      const r = j.result as GetflyUnsyncResult;
      const done = `Đã xoá ${r.deleted} việc app tạo, gỡ liên kết ${r.unlinked ?? 0} việc (giữ nguyên trên Getfly)`;
      toast(r.errors.length ? `${done}, ${r.errors.length} lỗi` : done, r.errors.length ? 'error' : 'ok', r.errors.length ? { meta: r.errors[0] } : undefined);
    } else {
      const r = j.result as GetflyResult;
      toast(getflySummary(r), r.errors.length ? 'error' : 'ok', r.errors.length || r.warnings.length ? {
        title: r.errors.length ? `${r.errors.length} việc lỗi` : 'Lưu ý', meta: (r.errors[0] ?? r.warnings[0]).slice(0, 160),
        action: { label: 'Xem chi tiết', onClick: () => openGetflyReport(projectId, r) },
      } : undefined);
    }
    void qc.invalidateQueries({ queryKey: ['project', projectId] });
  }, [job.data, projectId, qc, toast]);
  const start = useAction(({ kind, scope }: { kind: 'sync' | 'unsync'; scope?: GetflyScope }) => api<GetflyJob>(`/projects/${projectId}/getfly/${kind}`, { method: 'POST', body: scope ?? {} }), {
    // Báo ngay khi bấm: đồng bộ chạy nền vài chục giây, không báo gì là người dùng
    // tưởng nút không ăn và bấm lại.
    onSuccess: (j, v) => {
      watchingJobs.add(j.id); qc.setQueryData(key, j);
      if (j.status === 'running') toast(v.kind === 'unsync' ? 'Đang gỡ khỏi Getfly…' : 'Đang đồng bộ lên Getfly…', 'ok', { meta: 'Xong sẽ báo ở đây.' });
    },
  });
  const running = job.data?.status === 'running' || start.isPending;
  const progress = job.data?.status === 'running' && job.data.total ? `${job.data.done}/${job.data.total}` : '';
  return { job: job.data ?? null, running, progress, sync: () => start.mutate({ kind: 'sync' }), unsync: () => start.mutate({ kind: 'unsync' }), syncScope: (scope: GetflyScope) => start.mutate({ kind: 'sync', scope }), unsyncScope: (scope: GetflyScope) => start.mutate({ kind: 'unsync', scope }) };
}

type GUser = { id: string; name: string; email: string; dept: string };

/** Cấu hình đồng bộ Getfly CRM: cha riêng theo nhóm, người tạo, ghép người phụ trách -> người dùng Getfly. */
export function GetflyBox({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const status = useGetflyStatus();
  const gUsers = useQuery({ queryKey: ['getfly-users'], queryFn: () => api<GUser[]>('/getfly/users'), enabled: !!status.data?.configured, staleTime: 600_000 });
  const [users, setUsers] = useState<Record<string, string>>(project.getflyUsers ?? {});
  useEffect(() => { setUsers(project.getflyUsers ?? {}); }, [project.getflyUsers]);
  const { toast } = useFeedback();
  const qc = useQueryClient();
  const [groupRef, setGroupRef] = useState<Record<string, string>>({});
  const save = useAction((b: { creatorId?: string; users?: Record<string, string>; groups?: Record<string, string> }) => api(`/projects/${project.id}/getfly`, { method: 'PATCH', body: b }), {
    onSuccess: (_r) => { toast('Đã lưu cấu hình Getfly'); setGroupRef({}); void qc.invalidateQueries({ queryKey: ['project', project.id] }); },
  });
  const gj = useGetflyJob(project.id);
  const { confirm } = useFeedback();
  const askRemoveGroup = async (id: string, name: string) => {
    if (save.isPending) return;
    if (await confirm({ title: 'Bỏ liên kết nhóm trên Getfly?', desc: <p>Nhóm <b>{name}</b> sẽ không được đồng bộ nữa.</p>, ok: 'Bỏ liên kết', danger: true })) save.mutate({ groups: { [id]: '' } });
  };
  const askUnsync = async () => {
    if (await confirm({ title: 'Gỡ dự án khỏi Getfly?', desc: <p>Xoá các việc app đã tạo trên Getfly. Việc có sẵn (nhận theo tên) và việc cha được giữ nguyên, chỉ gỡ liên kết.</p>, ok: 'Gỡ khỏi Getfly', danger: true })) gj.unsync();
  };
  // Ghép người dùng cho các việc chính được đồng bộ.
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const t of project.tasks) {
      for (const n of `${t.assignee},${t.support}`.split(',')) if (n.trim()) set.add(n.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [project.tasks]);
  const clean = (u: Record<string, string>) => Object.fromEntries(Object.entries(u).filter(([, v]) => v));
  const dirtyUsers = JSON.stringify(clean(users)) !== JSON.stringify(project.getflyUsers ?? {});
  const ready = !!project.getflyCreatorId;
  const userSelect = (value: string, onChange: (v: string) => void, label: string, emptyText: string) => (
    <select aria-label={label} value={value} disabled={!canEdit || !gUsers.data} onChange={(e) => onChange(e.target.value)}
      className="select-chevron h-9 w-full min-w-0 appearance-none rounded-full border border-line bg-card pl-3.5 pr-9 text-[13px] outline-none focus:border-primary">
      <option value="">{gUsers.isLoading ? 'Đang tải…' : emptyText}</option>
      {(gUsers.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}{u.dept ? ` · ${u.dept}` : ''}</option>)}
    </select>
  );

  return (
    <section className="mt-1" aria-label="Getfly CRM">
      <SectionLabel action={status.data?.configured && ready && <Button size="sm" variant="secondary" onClick={gj.sync} disabled={gj.running || !canEdit}><CloudArrowUp size={15} className={gj.running ? 'animate-pulse' : undefined} /> {gj.running ? `${gj.job?.kind === 'unsync' ? 'Đang gỡ' : 'Đang đồng bộ'}${gj.progress ? ` ${gj.progress}` : '…'}` : 'Đồng bộ ngay'}</Button>}>Getfly CRM</SectionLabel>
      <p className="mb-3 px-1 text-[12px] text-muted">Đẩy việc lên Getfly. Chỉ nhóm đã gắn việc cha mới được đồng bộ.</p>
      {!status.data?.configured ? (
        <p className="rounded-[20px] bg-fill px-4 py-2.5 text-[12px] text-muted">Máy chủ chưa kết nối Getfly.</p>
      ) : (
        <>
          {project.groups.length > 0 && (
            <Field group label="Nhóm việc trên Getfly" hint="Dán link hoặc mã việc cha cho từng nhóm.">
              <div className="space-y-1.5">
                {project.groups.flatMap((g) => {
                  // Một dòng chung cho nhóm, thêm một dòng cho mỗi phase có việc trong nhóm (gắn riêng thì ưu tiên).
                  const phasesHere = (project.phases ?? []).filter((x) => project.tasks.some((t) => t.groupId === g.id && t.phaseId === x.id));
                  const rows = [{ key: g.id, label: g.name, sub: phasesHere.length ? 'mọi phase' : '' }, ...phasesHere.map((x) => ({ key: `${x.id}:${g.id}`, label: '', sub: x.name }))];
                  return rows.map((row) => {
                    const m = project.getflyGroups?.[row.key];
                    const inherited = row.key.includes(':') && !m ? project.getflyGroups?.[g.id] : undefined;
                    return (
                      <div key={row.key} className={cx('flex items-center gap-2 text-[13px]', !row.label && 'pl-4')}>
                        <span className="w-2/5 min-w-0 break-words">
                          {row.label && <span className="font-semibold">{row.label}</span>}
                          {row.sub && <span className={cx('text-muted', row.label && 'ml-1 text-[12px]')}>{row.label ? `· ${row.sub}` : `› ${row.sub}`}</span>}
                        </span>
                        {m ? (
                          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-fill px-3.5 py-1.5">
                            <span className="min-w-0 flex-1 break-words">{m.name} <span className="text-muted">· {m.code}</span></span>
                            {canEdit && <button type="button" className="text-[12px] font-semibold text-muted hover:text-danger disabled:opacity-50" disabled={save.isPending} onClick={() => row.label ? void askRemoveGroup(g.id, g.name) : save.mutate({ groups: { [row.key]: '' } })}>Bỏ</button>}
                          </span>
                        ) : canEdit ? (
                          <form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); const v = groupRef[row.key]?.trim(); if (v) save.mutate({ groups: { [row.key]: v } }); }}>
                            <Input aria-label={`Link việc Getfly cho ${g.name}${row.sub && !row.label ? ` (${row.sub})` : ''}`} className="!h-9 min-w-0 flex-1 !text-[13px]" value={groupRef[row.key] ?? ''} onChange={(e) => setGroupRef({ ...groupRef, [row.key]: e.target.value })}
                              placeholder={inherited ? `Dùng chung: ${inherited.name}` : row.label ? 'Dán link / id / mã việc cha' : 'Dán link nếu phase này có việc cha riêng'} />
                            {groupRef[row.key]?.trim() && <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>Gắn</Button>}
                          </form>
                        ) : <span className="text-muted">{inherited ? `Dùng chung: ${inherited.name}` : 'Chưa gắn cha — bỏ qua'}</span>}
                      </div>
                    );
                  });
                })}
              </div>
            </Field>
          )}
          {(project.groups.some((g) => !project.getflyGroups?.[g.id]?.id) || project.tasks.some((t) => !t.groupId)) && (
            <div className="mb-4 rounded-[20px] bg-fill px-4 py-3 text-[13px] text-muted">
              <p className="font-semibold">Các mục chưa đồng bộ:</p>
              {project.groups.filter((g) => !project.getflyGroups?.[g.id]?.id).map((g) => <p key={g.id}>Nhóm {g.name}: chưa gắn việc cha.</p>)}
              {project.tasks.filter((t) => !t.groupId).map((t) => <p key={t.id}>Việc {t.name}: chưa phân nhóm.</p>)}
            </div>
          )}
          {gj.job?.kind === 'sync' && gj.job.status === 'done' && (gj.job.result as GetflyResult)?.warnings?.map((w, i) => <p key={i} className="mb-2 text-[13px] text-muted">{w}</p>)}
          <Field label="Người tạo việc trên Getfly" hint="Việc trên Getfly sẽ đứng tên người này.">
            {userSelect(project.getflyCreatorId ?? '', (v) => save.mutate({ creatorId: v }), 'Người tạo việc trên Getfly', 'Chọn người tạo')}
          </Field>
          {names.length > 0 && (
            <Field group label="Ghép người phụ trách → người dùng Getfly" hint="Chưa ghép thì giao cho người tạo.">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-x-2 gap-y-1.5">
                {names.map((n) => (
                  <div key={n} className="contents">
                    <span className="truncate text-[13px]">{n}</span>
                    {userSelect(users[n] ?? '', (v) => setUsers({ ...users, [n]: v }), `Người dùng Getfly cho ${n}`, 'Chưa ghép')}
                  </div>
                ))}
              </div>
              {canEdit && dirtyUsers && <Button className="mt-2" size="sm" variant="secondary" onClick={() => save.mutate({ users: clean(users) })}>Lưu ghép người</Button>}
            </Field>
          )}
          {gUsers.error && <p className="text-[12px] text-danger">{(gUsers.error as Error).message}</p>}
          {gj.running && <p className="mb-1 text-[12px] font-semibold text-primary">{gj.job?.kind === 'unsync' ? 'Đang gỡ khỏi Getfly' : 'Đang đồng bộ'} {gj.progress} — có thể đóng hộp này.</p>}
          {project.getflySyncedAt && <p className="text-[12px] text-muted">Đồng bộ lần cuối {new Date(project.getflySyncedAt).toLocaleString('vi-VN')}</p>}
          {canEdit && (
            <button type="button" className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-danger hover:underline disabled:opacity-50" disabled={gj.running} onClick={() => void askUnsync()}>
              <LinkBreak size={13} /> {gj.running && gj.job?.kind === 'unsync' ? `Đang gỡ khỏi Getfly ${gj.progress}` : 'Gỡ khỏi Getfly (xoá việc app đã tạo, giữ việc có sẵn và việc cha)'}
            </button>
          )}
          {project.getflyError && <p className="mt-1 whitespace-pre-wrap text-[12px] text-danger">{project.getflyError}</p>}
          {canEdit && <GetflyDoneLink projectId={project.id} getflyOrigin={status.data.webOrigin} />}
        </>
      )}
    </section>
  );
}

/**
 * Nút dấu trang (bookmarklet) đánh dấu "Hoàn thành" + 5 sao trên Getfly cho việc đã xong 100% — API Getfly không làm được,
 * nên bookmarklet bấm hộ trên tab Getfly đã đăng nhập (src/lib/getfly-bookmarklet.ts). Tiến độ tụt dưới 100% thì bên Project
 * quên dấu "đã đánh dấu" để lần sau làm lại; trạng thái trên Getfly KHÔNG tự mở lại.
 */
function GetflyDoneLink({ projectId, getflyOrigin }: { projectId: string; getflyOrigin: string }) {
  const { toast } = useFeedback();
  const pending = useQuery({ queryKey: ['getfly-pending-done'], queryFn: () => api<PendingDone[]>('/getfly/pending-done'), staleTime: 60_000 });
  const here = pending.data?.filter((p) => p.projectId === projectId).length ?? 0;
  const others = (pending.data?.length ?? 0) - here;
  // React 19 chặn href "javascript:" khi render -> gắn bằng tay sau khi mount.
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute('href', getflyBookmarklet(window.location.origin, getflyOrigin)); }, [getflyOrigin]);
  return (
    <div className="mt-4 rounded-[20px] bg-fill px-4 py-3 text-[13px]">
      <p className="font-semibold">Đánh dấu hoàn thành trên Getfly</p>
      <p className="mt-0.5 text-muted">API Getfly không cho đổi trạng thái. Nút dưới đây chạy ngay trên tab Getfly của bạn: đánh dấu "Hoàn thành" + 5 sao cho mọi việc đã xong 100% (mọi dự án bạn được sửa).</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a ref={ref} href="#" draggable onClick={(e) => { e.preventDefault(); toast('Kéo nút này lên thanh dấu trang, rồi bấm khi đang mở Getfly'); }}
          className="inline-flex h-8 cursor-grab items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-semibold text-on-primary">
          ✓ Hoàn thành Getfly
        </a>
        {pending.data && <span className="text-[12px] text-muted">{here ? `${here} việc của dự án này đang chờ` : 'Dự án này không có việc chờ'}{others > 0 ? ` · ${others} việc ở dự án khác` : ''}</span>}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">Kéo nút này lên thanh dấu trang, rồi bấm khi đang mở Getfly. Việc tụt dưới 100% sẽ được đánh dấu lại lần sau; trạng thái trên Getfly không tự mở lại.</p>
    </div>
  );
}
