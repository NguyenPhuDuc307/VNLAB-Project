import { Archive, CalendarCheck, CheckCircle, FolderSimple, Plus } from '@phosphor-icons/react';
import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ProjectSheet } from '../components/ProjectSheet';
import { Button, Empty, PageHeader, ProgressBar, Section, Skeleton, cx } from '../components/ui';
import { useCan, useMe, useOverview, type OverviewTask, type ProjectSummary } from '../lib/api';
import { diffDays, fmtShort } from '../lib/dates';
import { GRID_CARDS_NARROW, GRID_GAP, ICON_CIRCLE, RADIUS_SHORT, RADIUS_TALL, SURFACE } from '../lib/grid';

export function Home() {
  const me = useMe();
  const can = useCan();
  const ov = useOverview();
  const [create, setCreate] = useState(false);
  const d = ov.data;
  const hello = me.data?.name ? me.data.name.split(' ').slice(-1)[0] : '';

  return (
    <div>
      <PageHeader
        title={hello ? `Chào ${hello}` : 'Tổng quan'}
        sub={d ? `${d.projects.length} dự án đang chạy` : undefined}
      />

      {ov.isPending && <div className={cx('grid md:grid-cols-3', GRID_GAP)}><Skeleton className="h-36" /><Skeleton className="h-36" /><Skeleton className="h-36" /></div>}
      {d && !d.projects.length && (
        <div className={cx(SURFACE, RADIUS_TALL)}>
          <Empty icon={<FolderSimple size={26} />} title="Chưa có dự án nào" desc="Tạo dự án mới hoặc chờ người khác mời bạn." action={can('project.project.create') && <Button onClick={() => setCreate(true)}>Tạo dự án đầu tiên</Button>} />
        </div>
      )}

      {d && d.projects.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Section title="Dự án đang chạy" action={<span className="text-xs font-medium text-muted">{d.projects.length} dự án</span>}>
            <div className={cx('grid', GRID_CARDS_NARROW, GRID_GAP)}>
              {d.projects.map((p) => <ProjectCard key={p.id} p={p} today={d.today} />)}
              {can('project.project.create') && <AddTile label="Dự án mới" onClick={() => setCreate(true)} />}
            </div>
          </Section>
          <div>
            <Section title={<span className={d.overdue.length ? 'text-danger' : undefined}>Quá hạn · {d.overdue.length}</span>}>
              <TaskList tasks={d.overdue} today={d.today} empty="Không có việc quá hạn" icon={<CalendarCheck size={16} />} />
            </Section>
            <Section title={`Đến hạn trong 7 ngày · ${d.upcoming.length}`}>
              <TaskList tasks={d.upcoming} today={d.today} empty="Tuần này chưa có việc tới hạn" icon={<CalendarCheck size={16} />} />
            </Section>
          </div>
        </div>
      )}
      <ProjectSheet open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

/**
 * Thẻ dự án như thẻ lịch trình bên VNLab Home: vòng icon 44px màu dự án, tên,
 * một dòng phụ, thanh tiến độ, một dòng trạng thái. Mỗi thông tin xuất hiện một lần.
 */
export function ProjectCard({ p, today }: { p: ProjectSummary; today: string }) {
  const s = p.stats;
  const done = s.progress >= 100;
  const left = s.lastEnd && s.lastEnd >= today ? diffDays(today, s.lastEnd) : null;
  const state = [
    `${s.doneCount}/${s.taskCount} việc xong`,
    s.firstStart && s.lastEnd ? `${fmtShort(s.firstStart)} → ${fmtShort(s.lastEnd)}${left != null ? ` · còn ${left} ngày` : ''}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <Link
      to={`/du-an/${p.id}`}
      className={cx('hoverable flex h-full flex-col gap-2.5 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', SURFACE, RADIUS_SHORT, p.archived && 'opacity-75')}
      style={{ '--pc': p.color } as CSSProperties}
    >
      <div className="flex w-full items-start gap-3">
        <span aria-hidden className={cx(ICON_CIRCLE, 'bg-[color-mix(in_srgb,var(--pc)_86%,#0b1c30)] text-white')}>
          {p.archived ? <Archive size={20} /> : done ? <CheckCircle size={20} /> : <FolderSimple size={20} />}
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block truncate py-px text-[15px] font-semibold leading-snug tracking-tight">{p.name}</span>
          <span className="block truncate text-xs font-medium text-muted">{[p.code, p.customer, p.owner.name || p.owner.email].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="num shrink-0 pt-0.5 text-[15px] font-bold">{s.progress}%</span>
      </div>
      <ProgressBar value={s.progress} color={p.color} size="sm" />
      <p className="num truncate text-xs font-medium text-muted">
        {s.overdueCount > 0 && <span className="font-semibold text-danger">{s.overdueCount} quá hạn · </span>}
        {state}{p.archived ? ' · đã lưu trữ' : ''}
      </p>
    </Link>
  );
}

/** Ô "Thêm …" cùng cỡ thẻ, viền nét đứt, vòng icon 44px — như ô Thêm lịch trình bên VNLab Home. */
export function AddTile({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('add-tile flex min-h-[124px] w-full flex-col items-center justify-center gap-2 p-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', RADIUS_SHORT, className)}>
      <span className={cx(ICON_CIRCLE, 'bg-fill')}><Plus size={20} /></span>
      {label}
    </button>
  );
}

function TaskList({ tasks, today, empty, icon }: { tasks: OverviewTask[]; today: string; empty: string; icon: React.ReactNode }) {
  if (!tasks.length) return <p className="px-1 text-sm text-muted"><span className="mr-1.5 inline-flex align-[-3px] text-ok">{icon}</span>{empty}</p>;
  return (
    <ul className={cx('divide-y divide-line overflow-hidden', SURFACE, RADIUS_TALL)}>
      {tasks.slice(0, 12).map((t) => {
        const late = t.endDate! < today;
        const left = diffDays(today, t.endDate!);
        return (
          <li key={t.id}>
            <Link to={`/du-an/${t.projectId}?task=${t.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-fill">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.projectColor }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{t.name}</span>
                <span className="block truncate text-[12px] text-muted">{t.projectName}{t.assignee ? ` · ${t.assignee}` : ''}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={cx('num block text-[12.5px] font-semibold', late ? 'text-danger' : left === 0 ? 'text-warning' : 'text-ink-2')}>{late ? `trễ ${-left} ngày` : left === 0 ? 'hôm nay' : `còn ${left} ngày`}</span>
                <span className="num block text-[11px] text-muted">{fmtShort(t.endDate)} · {t.progress}%</span>
              </span>
            </Link>
          </li>
        );
      })}
      {tasks.length > 12 && <li className="px-4 py-2 text-center text-[12px] text-muted">và {tasks.length - 12} việc nữa</li>}
    </ul>
  );
}
