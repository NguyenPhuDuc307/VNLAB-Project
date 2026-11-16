import { CalendarCheck, FolderSimple, Plus, Warning } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ProjectSheet } from '../components/ProjectSheet';
import { Button, Chip, Empty, PageHeader, ProgressBar, Section, Skeleton, cx } from '../components/ui';
import { useCan, useMe, useOverview, type OverviewTask, type ProjectSummary } from '../lib/api';
import { diffDays, fmtShort } from '../lib/dates';

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
        sub={d ? `${d.projects.length} dự án đang chạy · ${d.overdue.length} việc quá hạn · ${d.upcoming.length} việc đến hạn trong 7 ngày` : undefined}
        action={can('project.project.create') && <Button onClick={() => setCreate(true)}><Plus size={16} weight="bold" /> Dự án mới</Button>}
      />

      {ov.isPending && <div className="grid gap-3 md:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>}
      {d && !d.projects.length && (
        <div className="card">
          <Empty icon={<FolderSimple size={30} />} title="Chưa có dự án nào" desc="Tạo dự án, thêm nhóm việc rồi dán kế hoạch từ bảng tính — hoặc chờ người khác mời bạn vào." action={can('project.project.create') && <Button onClick={() => setCreate(true)}>Tạo dự án đầu tiên</Button>} />
        </div>
      )}

      {d && d.projects.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Section title="Dự án đang chạy">
            <div className="grid gap-3 sm:grid-cols-2">
              {d.projects.map((p) => <ProjectCard key={p.id} p={p} today={d.today} />)}
            </div>
          </Section>
          <div>
            <Section title={<span className="text-danger">Quá hạn · {d.overdue.length}</span>}>
              <TaskList tasks={d.overdue} today={d.today} empty="Không có việc quá hạn" icon={<CalendarCheck size={26} />} />
            </Section>
            <Section title={`Đến hạn trong 7 ngày · ${d.upcoming.length}`}>
              <TaskList tasks={d.upcoming} today={d.today} empty="Tuần này chưa có việc tới hạn" icon={<CalendarCheck size={26} />} />
            </Section>
          </div>
        </div>
      )}
      <ProjectSheet open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

export function ProjectCard({ p, today }: { p: ProjectSummary; today: string }) {
  const s = p.stats;
  return (
    <Link
      to={`/du-an/${p.id}`}
      className="card block p-4 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]"
      style={{ background: `color-mix(in srgb, ${p.color} 14%, var(--surface))`, borderColor: `color-mix(in srgb, ${p.color} 35%, transparent)` }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-extrabold tracking-tight">{p.name}</p>
          <p className="truncate text-[12.5px] text-muted">{[p.code, p.customer, p.owner.name || p.owner.email].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="num text-[15px] font-extrabold">{s.progress}%</span>
      </div>
      <ProgressBar value={s.progress} color={p.color} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip>{s.taskCount} việc</Chip>
        {s.doneCount > 0 && <Chip tone="ok">{s.doneCount} xong</Chip>}
        {s.overdueCount > 0 && <Chip tone="danger"><Warning size={12} weight="bold" /> {s.overdueCount} quá hạn</Chip>}
        {s.firstStart && s.lastEnd && <Chip className="num">{fmtShort(s.firstStart)} → {fmtShort(s.lastEnd)}{s.lastEnd >= today ? ` · còn ${diffDays(today, s.lastEnd)} ngày` : ''}</Chip>}
        {p.archived && <Chip tone="warning">Đã lưu trữ</Chip>}
      </div>
    </Link>
  );
}

function TaskList({ tasks, today, empty, icon }: { tasks: OverviewTask[]; today: string; empty: string; icon: React.ReactNode }) {
  if (!tasks.length) return <div className="card"><Empty icon={icon} title={empty} /></div>;
  return (
    <ul className="card divide-y divide-line">
      {tasks.slice(0, 12).map((t) => {
        const late = t.endDate! < today;
        const left = diffDays(today, t.endDate!);
        return (
          <li key={t.id}>
            <Link to={`/du-an/${t.projectId}?task=${t.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-fill/50">
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
