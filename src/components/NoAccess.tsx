import { LockKey } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useCan, type PermissionKey } from '../lib/api';
import { Empty, PageHeader } from './ui';

const ACCOUNT_URL = 'https://account.vnlab.id.vn';

export function NoAccess({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="card">
        <Empty
          icon={<LockKey size={30} />}
          title="Bạn chưa có quyền dùng mục này"
          desc="Quyền trong Project do quản trị viên VNLab cấp ở VNLab Account. Được cấp rồi thì tải lại trang."
          action={<a href={ACCOUNT_URL} className="text-sm font-semibold text-primary">Mở VNLab Account</a>}
        />
      </div>
    </div>
  );
}

export function RequirePerm({ perm, title, children }: { perm: PermissionKey; title: string; children: ReactNode }) {
  const can = useCan();
  return can(perm) ? <>{children}</> : <NoAccess title={title} />;
}
