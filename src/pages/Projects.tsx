import { FolderSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { ProjectSheet } from '../components/ProjectSheet';
import { Button, Empty, PageHeader, Segmented, Skeleton, cx } from '../components/ui';
import { useCan, useProjects } from '../lib/api';
import { todayStr } from '../lib/dates';
import { GRID_CARDS, GRID_GAP, RADIUS_TALL, SURFACE } from '../lib/grid';
import { AddTile, ProjectCard } from './Home';

export function Projects() {
  const can = useCan();
  const q = useProjects();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [create, setCreate] = useState(false);
  const today = todayStr();
  const list = (q.data ?? []).filter((p) => p.archived === (tab === 'archived'));
  const archivedCount = (q.data ?? []).filter((p) => p.archived).length;
  // Nút tạo dự án là ô "Dự án mới" viền nét đứt cuối lưới (như Thêm lịch trình bên VNLab Home), không lặp thêm nút trên tiêu đề.
  const canCreate = tab === 'active' && can('project.project.create');

  return (
    <div>
      <PageHeader title="Dự án" sub={q.data ? `${q.data.length - archivedCount} đang chạy · ${archivedCount} lưu trữ` : undefined} />
      {archivedCount > 0 && <Segmented className="mb-4 max-w-xs" value={tab} onChange={setTab} options={[{ value: 'active', label: 'Đang chạy' }, { value: 'archived', label: `Lưu trữ (${archivedCount})` }]} />}
      {q.isPending && <div className={cx('grid', GRID_CARDS, GRID_GAP)}><Skeleton className="h-36" /><Skeleton className="h-36" /><Skeleton className="h-36" /></div>}
      {q.data && !list.length && (
        <div className={cx('mb-3', SURFACE, RADIUS_TALL)}><Empty icon={<FolderSimple size={26} />} title={tab === 'archived' ? 'Chưa lưu trữ dự án nào' : 'Chưa có dự án nào'} desc={tab === 'archived' ? undefined : 'Tạo dự án mới hoặc chờ người khác mời bạn.'} action={canCreate && <Button onClick={() => setCreate(true)}>Tạo dự án</Button>} /></div>
      )}
      {(list.length > 0) && (
        <div className={cx('grid', GRID_CARDS, GRID_GAP)}>
          {list.map((p) => <ProjectCard key={p.id} p={p} today={today} />)}
          {canCreate && <AddTile label="Dự án mới" onClick={() => setCreate(true)} />}
        </div>
      )}
      <ProjectSheet open={create} onClose={() => setCreate(false)} />
    </div>
  );
}
