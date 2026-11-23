import { CaretLeft, CheckCircle, Flag, SquaresFour } from '@phosphor-icons/react';
import { useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { spanOf } from '../components/Gantt';
import { PhaseSheet } from '../components/PhaseBar';
import { PageHeader, Skeleton, cx } from '../components/ui';
import { GRID_CARDS, GRID_GAP, ICON_CIRCLE, RADIUS_SHORT, SURFACE } from '../lib/grid';
import { AddTile } from './Home';
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
      <Link to="/du-an" className="-ml-1 mb-2 inline-flex h-8 items-center gap-1 rounded-full px-2 text-[13px] font-semibold text-ink-2 transition-colors hover:bg-fill hover:text-ink"><CaretLeft size={14} weight="bold" /> Dự án</Link>
      <PageHeader
        eyebrow={p.code || undefined}
        title={p.name}
        sub={`PM ${p.owner.name || p.owner.email} · ${p.phases.length} phase · ${p.tasks.length} việc`}
        action={<Link to={`/du-an/${p.id}/phase/all`} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-fill px-3 text-[13px] font-semibold transition-colors hover:bg-fill-2"><SquaresFour size={15} /> Xem tất cả</Link>}
      />
      <div className={cx('grid', GRID_CARDS, GRID_GAP)}>
        {cards.map((c) => <PhaseCard key={c.key} to={`/du-an/${p.id}/phase/${c.key}`} name={c.name} tasks={c.tasks} start={c.start} end={c.end} today={today} color={p.color} />)}
        {editor && <AddTile label="Thêm phase" onClick={() => setSheet(true)} />}
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
  const state = running ? 'Đang chạy' : finished ? 'Đã qua' : from && from > today ? 'Sắp tới' : null;
  // Thẻ phase như thẻ lịch trình VNLab Home: vòng icon 44px, tên, một dòng ngày, thanh tiến độ, một dòng trạng thái.
  // Phase đang chạy = thẻ "sống": nền pha màu chính, vòng icon màu dự án; còn lại vòng icon xám.
  return (
    <Link to={to} className={cx('hoverable group flex h-full flex-col gap-2.5 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', SURFACE, RADIUS_SHORT, running && 'is-active')} style={{ '--pc': color } as CSSProperties}>
      <div className="flex w-full items-start gap-3">
        <span aria-hidden className={cx(ICON_CIRCLE, running ? 'bg-[color-mix(in_srgb,var(--pc)_86%,#0b1c30)] text-white' : avg >= 100 ? 'bg-ok-soft text-ok' : 'bg-fill text-ink-2')}>
          {avg >= 100 ? <CheckCircle size={20} /> : <Flag size={20} />}
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block break-words py-px text-[15px] font-semibold leading-snug tracking-tight group-hover:text-primary">{name}</span>
          <span className="num block truncate text-xs font-medium text-muted">
            {from ? `${fmtShort(from)}${to2 ? ` → ${fmtShort(to2)}` : ''}` : 'Chưa có ngày'}
            {running && to2 ? ` · còn ${diffDays(today, to2)} ngày` : ''}
          </span>
        </span>
        <span className="num shrink-0 pt-0.5 text-[15px] font-bold">{avg}%</span>
      </div>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-fill"><span className="block h-full rounded-full" style={{ width: `${avg}%`, background: avg >= 100 ? 'var(--ok)' : color }} /></span>
      <p className="num truncate text-xs font-medium text-muted">
        {overdue > 0 && <span className="font-semibold text-danger">{overdue} quá hạn · </span>}
        {done}/{tasks.length} việc xong{state ? ` · ${state}` : ''}
      </p>
    </Link>
  );
}
