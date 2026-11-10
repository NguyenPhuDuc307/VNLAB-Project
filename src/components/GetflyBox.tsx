import { ArrowSquareOut, CloudArrowUp, Trash } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, useAction, type ProjectDetail } from '../lib/api';
import { Button, Field, Input, useFeedback } from './ui';

export type GetflyResult = { created: number; updated: number; completed: number; deleted: number; unchanged: number; errors: string[]; warnings: string[]; syncedAt: string };
export const useGetflyStatus = () => useQuery({ queryKey: ['getfly-status'], queryFn: () => api<{ configured: boolean; host: string | null }>('/getfly/status'), staleTime: 300_000 });

/** Tóm tắt kết quả đồng bộ thành một câu cho toast. */
export function getflySummary(r: GetflyResult) {
  const parts = [r.created && `tạo ${r.created}`, r.updated && `sửa ${r.updated}`, r.completed && `hoàn thành ${r.completed}`, r.deleted && `xoá ${r.deleted}`].filter(Boolean);
  return parts.length ? `Getfly: ${parts.join(', ')} việc` : 'Getfly đã khớp, không có gì thay đổi';
}

/** Hook nút "Đồng bộ Getfly" (dùng chung ở thanh công cụ và Cài đặt). */
export function useGetflySync(projectId: string) {
  const { toast } = useFeedback();
  const qc = useQueryClient();
  return useAction(() => api<GetflyResult>(`/projects/${projectId}/getfly/sync`, { method: 'POST', body: {} }), {
    onSuccess: (r) => {
      toast(getflySummary(r), r.errors.length ? 'error' : 'ok', r.errors.length || r.warnings.length ? { title: r.errors.length ? `${r.errors.length} việc lỗi` : 'Lưu ý', meta: (r.errors[0] ?? r.warnings[0]).slice(0, 160) } : undefined);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

type GUser = { id: string; name: string; email: string; dept: string };

/** Cấu hình đồng bộ Getfly CRM của dự án: việc cha (dự án Getfly theo việc cha), người tạo, ghép người phụ trách -> người dùng Getfly. */
export function GetflyBox({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const status = useGetflyStatus();
  const gUsers = useQuery({ queryKey: ['getfly-users'], queryFn: () => api<GUser[]>('/getfly/users'), enabled: !!status.data?.configured, staleTime: 600_000 });
  const [parent, setParent] = useState('');
  const [users, setUsers] = useState<Record<string, string>>(project.getflyUsers ?? {});
  useEffect(() => { setUsers(project.getflyUsers ?? {}); }, [project.getflyUsers]);
  const { toast } = useFeedback();
  const qc = useQueryClient();
  const [groupRef, setGroupRef] = useState<Record<string, string>>({});
  const save = useAction((b: { parent?: string; creatorId?: string; users?: Record<string, string>; groups?: Record<string, string> }) => api(`/projects/${project.id}/getfly`, { method: 'PATCH', body: b }), {
    onSuccess: (_r, b) => { toast(b.parent !== undefined ? (b.parent ? 'Đã đặt việc cha trên Getfly' : 'Đã bỏ việc cha') : 'Đã lưu cấu hình Getfly'); setParent(''); setGroupRef({}); void qc.invalidateQueries({ queryKey: ['project', project.id] }); },
  });
  const sync = useGetflySync(project.id);
  const { confirm } = useFeedback();
  const unsync = useAction(() => api<{ deleted: number; errors: string[] }>(`/projects/${project.id}/getfly/unsync`, { method: 'POST', body: {} }), {
    onSuccess: (r) => { toast(r.errors.length ? `Đã xoá ${r.deleted} việc, ${r.errors.length} lỗi` : `Đã xoá ${r.deleted} việc khỏi Getfly`, r.errors.length ? 'error' : 'ok', r.errors.length ? { meta: r.errors[0] } : undefined); void qc.invalidateQueries({ queryKey: ['project', project.id] }); },
  });
  const askUnsync = async () => {
    if (await confirm({ title: 'Gỡ dự án khỏi Getfly?', desc: <p>Xoá trên Getfly mọi việc app đã tạo cho dự án này (việc của nhóm, việc, task con). Việc cha và việc có sẵn đã gắn cho nhóm được giữ nguyên. Không hoàn tác được.</p>, ok: 'Xoá khỏi Getfly', danger: true })) unsync.mutate(undefined);
  };
  // Mọi tên người phụ trách / hỗ trợ trong dự án (cả task con) để ghép người dùng Getfly.
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const t of project.tasks) {
      for (const n of `${t.assignee},${t.support}`.split(',')) if (n.trim()) set.add(n.trim());
      for (const s of t.subtasks ?? []) if (s.assignee.trim()) set.add(s.assignee.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [project.tasks]);
  const clean = (u: Record<string, string>) => Object.fromEntries(Object.entries(u).filter(([, v]) => v));
  const dirtyUsers = JSON.stringify(clean(users)) !== JSON.stringify(project.getflyUsers ?? {});
  const base = status.data?.host ? `https://${status.data.host}` : null;
  const ready = !!project.getflyParentCode && !!project.getflyCreatorId;
  const userSelect = (value: string, onChange: (v: string) => void, label: string, emptyText: string) => (
    <select aria-label={label} value={value} disabled={!canEdit || !gUsers.data} onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full min-w-0 rounded-xl border border-line bg-card px-2.5 text-[13px] outline-none focus:border-primary">
      <option value="">{gUsers.isLoading ? 'Đang tải…' : emptyText}</option>
      {(gUsers.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}{u.dept ? ` · ${u.dept}` : ''}</option>)}
    </select>
  );

  return (
    <section className="mt-5 rounded-2xl border border-line p-4" aria-label="Getfly CRM">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold">Getfly CRM</p>
        {status.data?.configured && ready && <Button size="sm" variant="secondary" onClick={() => sync.mutate(undefined)} disabled={sync.isPending || !canEdit}><CloudArrowUp size={15} className={sync.isPending ? 'animate-pulse' : undefined} /> {sync.isPending ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}</Button>}
      </div>
      <p className="mb-3 mt-0.5 text-[12px] text-muted">Bấm đồng bộ để tạo việc mới, sửa việc đã đổi và xoá việc đã xoá trên Getfly. Cây trên Getfly: việc cha → nhóm việc → việc → task con. Không gửi ghi chú. Việc xong 100% thì anh đánh dấu hoàn thành tay trên Getfly (API không cho).</p>
      {!status.data?.configured ? (
        <p className="rounded-xl bg-fill px-3 py-2 text-[12px] text-muted">Máy chủ chưa có thông tin Getfly. Chạy <code>./scripts/getfly-setup.sh</code> để lưu API key lên VPS.</p>
      ) : (
        <>
          <Field label="Việc cha trên Getfly" hint={project.getflyParentCode ? undefined : 'Mở việc cha trên Getfly, copy link (có task_id=…) dán vào đây; cũng nhận id hoặc mã việc. Dự án Getfly lấy theo việc cha.'}>
            {project.getflyParentCode && (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-fill px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{project.getflyParentName || project.getflyParentCode}</b>
                  <span className="block truncate text-[12px] text-muted">{project.getflyParentCode}{project.getflyProjectName ? ` · Dự án ${project.getflyProjectName}` : ''}</span>
                </span>
                {base && project.getflyParentId && <a className="text-primary" href={`${base}/#/tasks/?task_id=${project.getflyParentId}`} target="_blank" rel="noopener noreferrer" aria-label="Mở việc cha trên Getfly"><ArrowSquareOut size={15} /></a>}
                {canEdit && <button type="button" className="text-[12px] font-semibold text-muted hover:text-danger" onClick={() => save.mutate({ parent: '' })}>Bỏ</button>}
              </div>
            )}
            {canEdit && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (parent.trim()) save.mutate({ parent: parent.trim() }); }}>
                <Input className="min-w-0 flex-1" value={parent} onChange={(e) => setParent(e.target.value)} placeholder={base ? `${base}/#/tasks/?…task_id=…` : 'Link / id / mã việc'} />
                <Button type="submit" size="sm" variant="secondary" disabled={!parent.trim() || save.isPending}>{save.isPending ? 'Đang tìm…' : project.getflyParentCode ? 'Đổi' : 'Đặt'}</Button>
              </form>
            )}
          </Field>
          {project.getflyParentCode && project.groups.length > 0 && (
            <Field label="Nhóm việc trên Getfly" hint="Mỗi nhóm là một việc nằm dưới việc cha; việc trong nhóm nằm dưới nó. Mặc định app tự tạo — dán link nếu nhóm đã có việc sẵn trên Getfly.">
              <div className="space-y-1.5">
                {project.groups.map((g) => {
                  const m = project.getflyGroups?.[g.id];
                  return (
                    <div key={g.id} className="flex items-center gap-2 text-[13px]">
                      <span className="w-2/5 min-w-0 truncate font-semibold">{g.name}</span>
                      {m ? (
                        <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-fill px-2.5 py-1.5">
                          <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-muted">· {m.code}</span></span>
                          {canEdit && <button type="button" className="text-[12px] font-semibold text-muted hover:text-danger" onClick={() => save.mutate({ groups: { [g.id]: '' } })}>Bỏ</button>}
                        </span>
                      ) : canEdit ? (
                        <form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); const v = groupRef[g.id]?.trim(); if (v) save.mutate({ groups: { [g.id]: v } }); }}>
                          <Input className="!h-9 min-w-0 flex-1 !text-[13px]" value={groupRef[g.id] ?? ''} onChange={(e) => setGroupRef({ ...groupRef, [g.id]: e.target.value })} placeholder="Tự tạo — hoặc dán link việc có sẵn" />
                          {groupRef[g.id]?.trim() && <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>Gắn</Button>}
                        </form>
                      ) : <span className="text-muted">Tự tạo</span>}
                    </div>
                  );
                })}
              </div>
            </Field>
          )}
          <Field label="Người tạo việc trên Getfly" hint="Getfly bắt buộc có người tạo; việc đẩy sang sẽ đứng tên người này.">
            {userSelect(project.getflyCreatorId ?? '', (v) => save.mutate({ creatorId: v }), 'Người tạo việc trên Getfly', 'Chọn người tạo')}
          </Field>
          {names.length > 0 && (
            <Field label="Ghép người phụ trách → người dùng Getfly" hint="Người chưa ghép thì Getfly tự giao việc cho người tạo.">
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
          {project.getflySyncedAt && <p className="text-[12px] text-muted">Đồng bộ lần cuối {new Date(project.getflySyncedAt).toLocaleString('vi-VN')}</p>}
          {canEdit && project.getflyParentCode && (
            <button type="button" className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-danger hover:underline disabled:opacity-50" disabled={unsync.isPending} onClick={() => void askUnsync()}>
              <Trash size={13} /> {unsync.isPending ? 'Đang xoá trên Getfly…' : 'Gỡ khỏi Getfly (xoá các việc app đã tạo)'}
            </button>
          )}
          {project.getflyError && <p className="mt-1 whitespace-pre-wrap text-[12px] text-danger">{project.getflyError}</p>}
        </>
      )}
    </section>
  );
}
