import { FolderSimple, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { ProjectSheet } from '../components/ProjectSheet';
import { Button, Empty, PageHeader, Segmented, Skeleton } from '../components/ui';
import { useCan, useProjects } from '../lib/api';
import { todayStr } from '../lib/dates';
import { ProjectCard } from './Home';

export function Projects() {
  const can = useCan();
  const q = useProjects();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [create, setCreate] = useState(false);
  const today = todayStr();
  const list = (q.data ?? []).filter((p) => p.archived === (tab === 'archived'));
  const archivedCount = (q.data ?? []).filter((p) => p.archived).length;

  return (
    <div>
      <PageHeader title="Dự án" sub={q.data ? `${q.data.length - archivedCount} đang chạy · ${archivedCount} lưu trữ` : undefined} action={can('project.project.create') && <Button onClick={() => setCreate(true)}><Plus size={16} weight="bold" /> Dự án mới</Button>} />
      {archivedCount > 0 && <Segmented className="mb-4 max-w-xs" value={tab} onChange={setTab} options={[{ value: 'active', label: 'Đang chạy' }, { value: 'archived', label: `Lưu trữ (${archivedCount})` }]} />}
      {q.isPending && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-36" /><Skeleton className="h-36" /><Skeleton className="h-36" /></div>}
      {q.data && !list.length && (
        <div className="card"><Empty icon={<FolderSimple size={30} />} title={tab === 'archived' ? 'Chưa lưu trữ dự án nào' : 'Chưa có dự án nào'} desc={tab === 'archived' ? undefined : 'Tạo dự án mới hoặc chờ người khác mời bạn.'} action={tab === 'active' && can('project.project.create') && <Button onClick={() => setCreate(true)}>Tạo dự án</Button>} /></div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => <ProjectCard key={p.id} p={p} today={today} />)}
      </div>
      <ProjectSheet open={create} onClose={() => setCreate(false)} />
    </div>
  );
}
