import { Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { api, useAction, type ProjectDetail, type Scope } from '../lib/api';
import { Button, IconButton, Input, SectionLabel, useFeedback } from './ui';

/**
 * Quản lý phạm vi (tag) của dự án: tên, màu, người phụ trách (điền tay), số việc đang gắn.
 * Sửa xong rời ô là lưu ngay (không đợi nút Lưu của form dự án).
 */
export function ScopesEditor({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const { toast, confirm } = useFeedback();
  const scopes = project.scopes ?? [];
  const count = (id: string) => project.tasks.filter((t) => t.scopeId === id).length;
  const [draft, setDraft] = useState({ name: '', owner: '' });
  const create = useAction((b: { name: string; owner: string }) => api<Scope>(`/projects/${project.id}/scopes`, { method: 'POST', body: b }), { onSuccess: () => setDraft({ name: '', owner: '' }) });
  const patch = useAction((a: { id: string; body: Partial<Scope> }) => api<Scope>(`/projects/${project.id}/scopes/${a.id}`, { method: 'PATCH', body: a.body }));
  const remove = useAction((s: Scope) => api<{ untagged: number }>(`/projects/${project.id}/scopes/${s.id}`, { method: 'DELETE' }), { onSuccess: (r) => toast(r.untagged ? `Đã xoá phạm vi, bỏ tag ${r.untagged} việc` : 'Đã xoá phạm vi') });
  const del = async (s: Scope) => {
    const n = count(s.id);
    if (await confirm({ title: `Xoá phạm vi “${s.name}”?`, desc: <p>{n ? `${n} việc sẽ bị bỏ tag, không bị xoá.` : 'Chưa có việc nào gắn phạm vi này.'}</p>, ok: 'Xoá phạm vi', danger: true })) remove.mutate(s);
  };
  const add = () => { if (draft.name.trim()) create.mutate({ name: draft.name.trim(), owner: draft.owner.trim() }); };

  return (
    <section className="mt-1" aria-label="Phạm vi">
      <SectionLabel>Phạm vi <span className="num">· {scopes.length}</span></SectionLabel>
      <p className="mb-3 px-1 text-[12px] text-muted">Gắn tag cho việc để lọc và biết ai phụ trách mảng nào.</p>
      {scopes.length > 0 && (
        <div className="mb-3 grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_40px_32px] items-center gap-x-2 gap-y-1.5">
          <span />
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Tên</span>
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Phụ trách</span>
          <span className="text-center text-[10.5px] font-semibold uppercase tracking-wider text-muted">Việc</span>
          <span />
          {scopes.map((s) => <ScopeRowEdit key={s.id} scope={s} count={count(s.id)} canEdit={canEdit} onPatch={(body) => patch.mutate({ id: s.id, body })} onDelete={() => del(s)} />)}
        </div>
      )}
      {canEdit && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input className="min-w-0 flex-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} placeholder="Tên phạm vi, VD: Giao hàng" aria-label="Tên phạm vi mới" />
          <Input className="min-w-0 flex-1" value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} maxLength={200} placeholder="Người phụ trách" list="prj-names" aria-label="Người phụ trách phạm vi mới" />
          <Button type="submit" size="sm" variant="secondary" disabled={!draft.name.trim() || create.isPending}><Plus size={14} /> Thêm</Button>
        </form>
      )}
    </section>
  );
}

function ScopeRowEdit({ scope, count, canEdit, onPatch, onDelete }: { scope: Scope; count: number; canEdit: boolean; onPatch: (b: Partial<Scope>) => void; onDelete: () => void }) {
  const [name, setName] = useState(scope.name);
  const [owner, setOwner] = useState(scope.owner);
  useEffect(() => { setName(scope.name); setOwner(scope.owner); }, [scope.name, scope.owner]);
  return (
    <div className="contents">
      <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full" style={{ background: scope.color }} title="Đổi màu">
        <input type="color" value={scope.color} disabled={!canEdit} onChange={(e) => onPatch({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Màu phạm vi ${scope.name}`} />
      </label>
      <Input value={name} disabled={!canEdit} maxLength={80} aria-label="Tên phạm vi" onChange={(e) => setName(e.target.value)} onBlur={() => { const v = name.trim(); if (v && v !== scope.name) onPatch({ name: v }); else setName(scope.name); }} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLInputElement).blur())} />
      <Input value={owner} disabled={!canEdit} maxLength={200} placeholder="Chưa có" list="prj-names" aria-label="Người phụ trách phạm vi" onChange={(e) => setOwner(e.target.value)} onBlur={() => { if (owner.trim() !== scope.owner) onPatch({ owner: owner.trim() }); }} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLInputElement).blur())} />
      <span className="num text-center text-[12px] text-muted">{count}</span>
      {canEdit ? <IconButton label={`Xoá phạm vi ${scope.name}`} className="!h-8 !w-8 text-danger hover:bg-danger-soft" onClick={onDelete}><Trash size={15} /></IconButton> : <span />}
    </div>
  );
}

/** Nhãn phạm vi nhỏ (Gantt, danh sách). */
export function ScopeChip({ scope, className }: { scope: Pick<Scope, 'name' | 'color' | 'owner'>; className?: string }) {
  return (
    <span className={`scope-chip ${className ?? ''}`} style={{ ['--scope' as string]: scope.color }} title={scope.owner ? `Phạm vi ${scope.name} · phụ trách: ${scope.owner}` : `Phạm vi ${scope.name}`}>
      {scope.name}
    </span>
  );
}
