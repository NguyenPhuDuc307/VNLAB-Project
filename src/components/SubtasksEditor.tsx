import { Plus, Trash } from '@phosphor-icons/react';
import type { Subtask } from '../lib/api';
import { Button, IconButton, Input } from './ui';

export function SubtasksEditor({ items, onChange, readOnly }: { items: Subtask[]; onChange: (items: Subtask[]) => void; readOnly: boolean }) {
  const patch = (id: string, value: Partial<Subtask>) => onChange(items.map((item) => item.id === id ? { ...item, ...value } : item));
  return <section className="mb-4 rounded-2xl border border-line p-3" aria-label="Task con">
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-sm font-bold">Task con{items.length ? ` · ${items.length}` : ''}</span>
      {!readOnly && <Button type="button" size="sm" variant="secondary" disabled={items.length >= 100} onClick={() => onChange([...items, { id: crypto.randomUUID(), name: '', assignee: '', progress: 0 }])}><Plus size={14} /> Task con</Button>}
    </div>
    <p className="mb-3 text-xs text-muted">Lịch và ngày công do task cha quản lý. Tiến độ cha là trung bình tiến độ các task con.</p>
    <div className="space-y-3">
      {items.map((item, i) => <div key={item.id} className="rounded-xl bg-fill/60 p-2">
        <div className="flex items-center gap-1">
          <Input aria-label={`Tên task con ${i + 1}`} value={item.name} required maxLength={300} placeholder="Tên đầu việc nhỏ" onChange={(e) => patch(item.id, { name: e.target.value })} />
          {!readOnly && <IconButton label={`Xoá task con ${i + 1}`} type="button" onClick={() => onChange(items.filter((s) => s.id !== item.id))}><Trash size={15} /></IconButton>}
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_90px] gap-2">
          <label className="text-xs text-muted">Phụ trách<Input aria-label={`Phụ trách task con ${i + 1}`} list="prj-names" maxLength={160} value={item.assignee} onChange={(e) => patch(item.id, { assignee: e.target.value })} /></label>
          <label className="text-xs text-muted">Tiến độ (%)<Input aria-label={`Tiến độ task con ${i + 1}`} type="number" min={0} max={100} step={1} value={item.progress} onChange={(e) => patch(item.id, { progress: Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} /></label>
        </div>
      </div>)}
      {!items.length && <p className="text-xs text-muted">Chia việc lớn thành các đầu việc có người phụ trách riêng.</p>}
    </div>
  </section>;
}
