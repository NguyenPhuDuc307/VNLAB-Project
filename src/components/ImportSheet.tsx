import { useMemo, useState } from 'react';
import { api, useAction, type ProjectDetail, type TaskInput } from '../lib/api';
import { fmtShort } from '../lib/dates';
import { parseSheet, type Parsed } from '../lib/sheet';
import { Button, Sheet, Textarea, useFeedback } from './ui';

export function ImportSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project: ProjectDetail }) {
  const { toast } = useFeedback();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseSheet(text), [text]);
  const total = parsed.groups.reduce((s, g) => s + g.tasks.length, 0);
  const run = useAction((b: Parsed['groups']) => api<{ groups: number; tasks: number }>(`/projects/${project.id}/import`, { method: 'POST', body: { groups: b } }), {
    onSuccess: (r) => { toast(`Đã nhập ${r.tasks} việc${r.groups ? `, tạo ${r.groups} nhóm` : ''}`); setText(''); onClose(); },
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Dán từ bảng tính"
      wide
      footer={
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted">{total ? `${total} việc · ${parsed.groups.filter((g) => g.name).length} nhóm` : 'Chưa nhận ra việc nào'}{parsed.skipped ? ` · bỏ ${parsed.skipped} dòng` : ''}</span>
          <Button variant="secondary" className="ml-auto" onClick={onClose}>Huỷ</Button>
          <Button onClick={() => run.mutate(parsed.groups)} disabled={!total || run.isPending}>{run.isPending ? 'Đang nhập…' : `Nhập ${total} việc`}</Button>
        </div>
      }
    >
      <p className="mb-3 text-[13px] leading-relaxed text-muted">
        Chép các dòng từ Excel hoặc Google Sheets rồi dán vào đây. Thứ tự cột:
        <b> STT · Việc · Phụ trách · Hỗ trợ · Tiến độ · Bắt đầu · Kết thúc · (bỏ) · Ngày</b>. Dòng chỉ có tên là tên nhóm.
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'Thiết kế\n1\tThiết kế màn hình đăng nhập\tAn\t\t100%\t2-Mar-26\t4-Mar-26\t\t3\n2\tThiết kế trang chủ\tAn\tBình, Chi\t0%\t5-Mar-26\t10-Mar-26\t\t4'} className="font-mono text-[13px]" />
      {total > 0 && (
        <div className="mt-3 max-h-72 overflow-auto rounded-2xl border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface text-left text-[10.5px] font-bold uppercase tracking-wider text-muted">
              <tr><th className="px-3 py-2">Việc</th><th className="px-2 py-2">Phụ trách</th><th className="px-2 py-2">%</th><th className="px-2 py-2">Bắt đầu</th><th className="px-2 py-2">Kết thúc</th><th className="px-2 py-2 text-right">Ngày</th></tr>
            </thead>
            <tbody>
              {parsed.groups.map((g, gi) => (
                <GroupRows key={gi} name={g.name} tasks={g.tasks} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Sheet>
  );
}

function GroupRows({ name, tasks }: { name: string | null; tasks: TaskInput[] }) {
  return (
    <>
      <tr className="bg-fill/60"><td colSpan={6} className="px-3 py-1.5 font-extrabold">{name ?? 'Chưa phân nhóm'} <span className="num font-semibold text-muted">{tasks.length}</span></td></tr>
      {tasks.map((t, i) => (
        <tr key={i} className="border-t border-line">
          <td className="max-w-[260px] truncate px-3 py-1.5" title={t.name}>{t.name}</td>
          <td className="truncate px-2 py-1.5 text-ink-2">{t.assignee}{t.support ? <span className="text-muted"> · {t.support}</span> : ''}</td>
          <td className="num px-2 py-1.5">{t.progress}%</td>
          <td className="num px-2 py-1.5">{fmtShort(t.startDate)}</td>
          <td className="num px-2 py-1.5">{fmtShort(t.endDate)}</td>
          <td className="num px-2 py-1.5 text-right">{t.days ?? ''}</td>
        </tr>
      ))}
    </>
  );
}
