import { Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Subtask } from '../lib/api';
import { Button, IconButton, Input } from './ui';

/**
 * Task con dạng bảng gọn: mỗi dòng = số thứ tự · tên · phụ trách · %.
 * Enter ở ô tên / phụ trách / % thì xuống dòng kế; ở dòng cuối (đã có tên) thì thêm dòng mới — không submit form task.
 */
export function SubtasksEditor({ items, onChange, readOnly }: { items: Subtask[]; onChange: (items: Subtask[]) => void; readOnly: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const patch = (id: string, value: Partial<Subtask>) => onChange(items.map((item) => (item.id === id ? { ...item, ...value } : item)));
  const add = () => {
    if (readOnly || items.length >= 100) return;
    const id = crypto.randomUUID();
    onChange([...items, { id, name: '', assignee: '', progress: 0 }]);
    setFocusId(id);
  };
  useEffect(() => {
    if (!focusId) return;
    box.current?.querySelector<HTMLInputElement>(`input[data-sub-name="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId, items]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (i < items.length - 1) box.current?.querySelectorAll<HTMLInputElement>('input[data-sub-name]')[i + 1]?.focus();
    else if (items[i].name.trim()) add();
  };
  const head = 'px-1 text-[10.5px] font-bold uppercase tracking-wider text-muted';
  return (
    <section className="mb-4 rounded-2xl border border-line p-3" aria-label="Task con">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-bold">Task con{items.length ? <span className="num font-semibold text-muted"> · {items.length}</span> : null}</span>
        {!readOnly && <Button type="button" size="sm" variant="secondary" disabled={items.length >= 100} onClick={add}><Plus size={14} /> Thêm</Button>}
      </div>
      <p className="mb-3 text-xs text-muted">Lịch và ngày công theo task cha; tiến độ cha = trung bình các task con.</p>
      {items.length > 0 && (
        <div ref={box} className="grid grid-cols-[22px_minmax(0,1fr)_minmax(84px,28%)_68px_28px] items-center gap-x-1.5 gap-y-1">
          <span className={`${head} text-right`}>#</span>
          <span className={head}>Tên</span>
          <span className={head}>Phụ trách</span>
          <span className={`${head} text-center`}>%</span>
          <span />
          {items.map((item, i) => (
            <div key={item.id} className="contents">
              <span className="num pr-1 text-right text-[12px] text-muted">{i + 1}</span>
              <Input data-sub-name={item.id} aria-label={`Tên task con ${i + 1}`} value={item.name} required maxLength={300} placeholder="Đầu việc nhỏ" disabled={readOnly} onKeyDown={(e) => onKey(e, i)} onChange={(e) => patch(item.id, { name: e.target.value })} />
              <Input aria-label={`Phụ trách task con ${i + 1}`} list="prj-names" maxLength={160} value={item.assignee} placeholder="Ai làm" disabled={readOnly} onKeyDown={(e) => onKey(e, i)} onChange={(e) => patch(item.id, { assignee: e.target.value })} />
              <Input aria-label={`Tiến độ task con ${i + 1} (%)`} type="number" inputMode="numeric" min={0} max={100} step={1} value={item.progress} disabled={readOnly} className="num px-1 text-center" onKeyDown={(e) => onKey(e, i)} onChange={(e) => patch(item.id, { progress: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })} />
              {readOnly ? <span /> : <IconButton label={`Xoá task con ${i + 1}`} type="button" className="h-8 w-7" onClick={() => onChange(items.filter((s) => s.id !== item.id))}><Trash size={14} /></IconButton>}
            </div>
          ))}
        </div>
      )}
      {!items.length && <p className="text-xs text-muted">Chia việc lớn thành các đầu việc nhỏ, mỗi đầu việc có người phụ trách và % riêng.</p>}
    </section>
  );
}
