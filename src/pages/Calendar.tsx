// Lịch chung: việc có ngày của mọi dự án đang chạy, mỗi dự án một màu. Bấm chip dự án để ẩn / hiện
// (nhớ trên máy). Bấm việc mở thẳng việc đó trong dự án; kéo thanh để dời ngày (dự án mình được sửa).
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarView } from '../components/CalendarView';
import { PageHeader, Skeleton, useFeedback, cx } from '../components/ui';
import { api, canEditRole, useCalendar, useCan, type CalendarData, type Task } from '../lib/api';
import { todayStr } from '../lib/dates';

const HIDDEN_KEY = 'project:calendar-hidden';

export function CalendarPage() {
  const q = useCalendar();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const { toast } = useFeedback();
  const [hidden, setHidden] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const toggle = (id: string) => setHidden((xs) => {
    const next = xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id];
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* riêng tư */ }
    return next;
  });

  const d = q.data;
  const byId = useMemo(() => new Map((d?.projects ?? []).map((p) => [p.id, p])), [d]);
  const tasks = useMemo(() => (d?.tasks ?? []).filter((t) => !hidden.includes(t.projectId)), [d, hidden]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of d?.tasks ?? []) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [d]);

  const move = async (t: Task, startDate: string, endDate: string) => {
    const prev = qc.getQueryData<CalendarData>(['calendar']);
    if (prev) qc.setQueryData<CalendarData>(['calendar'], { ...prev, tasks: prev.tasks.map((x) => (x.id === t.id ? { ...x, startDate, endDate } : x)) });
    try {
      await api(`/projects/${t.projectId}/tasks/${t.id}`, { method: 'PATCH', body: { startDate, endDate } });
    } catch (e) {
      if (prev) qc.setQueryData(['calendar'], prev);
      toast((e as Error).message, 'error');
    } finally {
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'me' });
    }
  };

  if (q.isPending) return <div><Skeleton className="mb-5 h-16 max-w-md" /><Skeleton className="h-[560px]" /></div>;
  if (!d) return <PageHeader title="Lịch" sub="Không tải được lịch." />;
  const today = todayStr();
  const label = (pid: string) => { const p = byId.get(pid); return p ? p.code || p.name : ''; };

  return (
    <div>
      <PageHeader title="Lịch" sub="Việc của mọi dự án đang chạy. Kéo thanh để dời ngày." />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {d.projects.filter((p) => counts.get(p.id)).map((p) => {
          const off = hidden.includes(p.id);
          return (
            <button key={p.id} type="button" aria-pressed={!off} onClick={() => toggle(p.id)} title={off ? `Hiện ${p.name}` : `Ẩn ${p.name}`}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-semibold transition', off ? 'border-line text-muted opacity-55 hover:opacity-80' : 'border-transparent text-ink')}
              style={off ? undefined : { background: `color-mix(in srgb, ${p.color} 16%, var(--surface))` }}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: off ? 'var(--line)' : p.color }} />
              {p.name}
              <span className="text-[11.5px] font-medium text-muted">{counts.get(p.id)}</span>
            </button>
          );
        })}
      </div>
      <CalendarView
        tasks={tasks}
        today={today}
        canEdit={(t) => canEditRole(byId.get(t.projectId)?.myRole) && can('project.task.write')}
        colorOf={(t) => byId.get(t.projectId)?.color ?? 'var(--primary)'}
        prefix={(t) => label(t.projectId)}
        subtitle={(t) => [byId.get(t.projectId)?.name, t.groupId ? d.groups[t.groupId] : undefined].filter(Boolean).join(' · ')}
        onEditTask={(t) => navigate(`/du-an/${t.projectId}?task=${t.id}`)}
        onChangeDates={(t, s, e) => void move(t, s, e)}
      />
    </div>
  );
}
