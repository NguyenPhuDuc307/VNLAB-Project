import { CaretLeft, CheckCircle, Plus, SquaresFour, WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { spanOf } from '../components/Gantt';
import { PhaseSheet } from '../components/PhaseBar';
import { Chip, PageHeader, Skeleton, cx } from '../components/ui';
import { canEditRole, useCan, useProject, type Task } from '../lib/api';
import { diffDays, fmtShort, todayStr } from '../lib/dates';
import { ProjectPage } from './Project';

/**
 * Vào một dự án: có phase thì hiện màn chọn phase (thẻ mỗi phase: tiến độ, số việc, quá hạn, khoảng ngày) rồi mới vào Gantt;
 * chưa có phase, hoặc link mở thẳng một việc (?task=…), thì vào thẳng trang dự án.
 */
export function ProjectHome() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const q = useProject(id);
  const can = useCan();
  const [sheet, setSheet] = useState(false);
  const p = q.data;
  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-40" /></div>;
  if (!p || !p.phases?.length || params.get('task')) return <ProjectPage />;
  const today = todayStr();
  const editor = canEditRole(p.myRole) && can('project.project.write');
  const unphased = p.tasks.filter((t) => !t.phaseId);
  const cards = [
    ...p.phases.map((x) => ({ key: x.id, name: x.name, tasks: p.tasks.filter((t) => t.phaseId === x.id), start: x.startDate, end: x.endDate })),
    ...(unphased.length ? [{ key: 'none', name: 'Chưa có phase', tasks: unphased, start: null, end: null }] : []),
  ];
  return (
    <div>
      <Link to="/du-an" className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink"><CaretLeft size={14} weight="bold" /> Dự án</Link>
      <PageHeader
        eyebrow={`VNLab / Project${p.code ? ` / ${p.code}` : ''}`}
        title={<span className="flex items-center gap-2.5"><span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: p.color }} />{p.name}</span>}
        sub={<span className="flex flex-wrap items-center gap-1.5"><Chip>PM: {p.owner.name || p.owner.email}</Chip><Chip tone="primary">{p.phases.length} phase · {p.tasks.length} việc</Chip></span>}
        action={<Link to={`/du-an/${p.id}/phase/all`} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-[13px] font-semibold hover:bg-fill"><SquaresFour size={15} /> Xem tất cả</Link>}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => <PhaseCard key={c.key} to={`/du-an/${p.id}/phase/${c.key}`} name={c.name} tasks={c.tasks} start={c.start} end={c.end} today={today} color={p.color} />)}
        {editor && (
          <button type="button" onClick={() => setSheet(true)} className="flex min-h-[150px] flex-col items-center justify-center gap-1.5 rounded-[20px] border-2 border-dashed border-line text-[14px] font-semibold text-muted transition hover:border-primary hover:text-primary">
            <Plus size={20} weight="bold" /> Thêm phase
          </button>
        )}
      </div>
      <PhaseSheet open={sheet} phase={null} project={p} unphased={unphased.length} onClose={() => setSheet(false)} onCreated={() => undefined} onDeleted={() => undefined} />
    </div>
  );
}

function PhaseCard({ to, name, tasks, start, end, today, color }: { to: string; name: string; tasks: Task[]; start: string | null; end: string | null; today: string; color: string }) {
  const span = spanOf(tasks);
  const from = start ?? span?.start ?? null, to2 = end ?? span?.end ?? null;
  const done = tasks.filter((t) => t.progress >= 100).length;
  const overdue = tasks.filter((t) => t.endDate && t.endDate < today && t.progress < 100).length;
  const avg = tasks.length ? Math.round(tasks.reduce((s, t) => s + t.progress, 0) / tasks.length) : 0;
  const running = !!from && !!to2 && from <= today && today <= to2;
  const finished = !!to2 && to2 < today;
  return (
    <Link to={to} className={cx('card group block p-4 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]', running && 'ring-2 ring-primary/40')}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words text-[17px] font-extrabold tracking-tight group-hover:text-primary">{name}</p>
        {running ? <Chip tone="primary">Đang chạy</Chip> : finished ? <Chip>Đã qua</Chip> : from && from > today ? <Chip>Sắp tới</Chip> : null}
      </div>
      <p className="num mt-0.5 text-[12.5px] text-muted">
        {from ? `${fmtShort(from)}${to2 ? ` → ${fmtShort(to2)}` : ''}` : 'Chưa có ngày'}
        {running && to2 ? ` · còn ${diffDays(today, to2)} ngày` : ''}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full" style={{ width: `${avg}%`, background: avg >= 100 ? 'var(--ok)' : color }} /></span>
        <span className="num w-10 text-right text-[13px] font-bold">{avg}%</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
        <span className="inline-flex items-center gap-1"><CheckCircle size={14} className="text-ok" /> {done}/{tasks.length} việc xong</span>
        {overdue > 0 && <span className="inline-flex items-center gap-1 text-danger"><WarningCircle size={14} /> {overdue} quá hạn</span>}
      </div>
    </Link>
  );
}
