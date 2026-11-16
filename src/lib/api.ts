import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type { PermissionKey } from '../../server/permissions.ts';

export type { PermissionKey };

export type User = {
  id: string; email: string; name: string; avatar: string | null;
  consentAt: string | null; consentRequired: boolean; policyVersion: string;
  /** Role Logto project:* và quyền hiệu dụng — quản lý ở VNLab Account. */
  roles: string[]; permissions: PermissionKey[];
};
export type MemberRole = 'owner' | 'editor' | 'viewer';
export type Project = {
  id: string; ownerId: string; name: string; code: string; customer: string; description: string; startDate: string | null;
  color: string; satWeight: number; sunWeight: number; archived: boolean; createdAt: string; updatedAt: string;
  /** Google Sheet liên kết (đồng bộ một chiều app -> sheet). */
  sheetId: string | null; sheetUrl: string | null; sheetAuto: boolean; sheetCollapseSubtasks: boolean; sheetSyncedAt: string | null; sheetError: string | null;
  /** Google Calendar liên kết (đồng bộ một chiều app -> lịch, tự chạy sau mỗi thay đổi). */
  gcalId: string | null; gcalUrl: string | null; gcalSyncedAt: string | null; gcalError: string | null;
  /** Cột xuất Excel / đồng bộ Sheets (null = tất cả). */
  exportColumns: string[] | null;
  /** Hướng dẫn / ngữ cảnh cho AI (MCP) của dự án. */
  aiContext: string;
  /** Đồng bộ Getfly CRM: việc cha (mã + tên), dự án Getfly, ghép tên -> username. */
  getflyParentCode?: string; getflyParentName?: string; getflyProjectName?: string; getflyUsers?: Record<string, string>;
  getflySyncedAt?: string | null; getflyError?: string | null;
  getflyParentId?: number | null; getflyProjectId?: string; getflyCreatorId?: string;
  getflyGroups?: Record<string, { id: number; code: string; name: string; projectId?: string; projectName?: string }>;
};
export type GoogleStatus = { configured: boolean; email: string | null };
export type ProjectStats = { taskCount: number; doneCount: number; overdueCount: number; progress: number; firstStart: string | null; lastEnd: string | null };
export type ProjectSummary = Project & { myRole: MemberRole; owner: { name: string; email: string }; memberCount: number; stats: ProjectStats };
export type Group = { id: string; name: string; sort: number; collapsed: boolean };
/** Phase (giai đoạn) trong dự án — dùng chung cấu hình dự án. */
export type Phase = { id: string; name: string; startDate: string | null; endDate: string | null; note: string; sort: number };
/** Phạm vi (tag) của dự án; owner = người phụ trách phạm vi (điền tay). */
export type Scope = { id: string; name: string; color: string; owner: string; note: string; sort: number };
export type Subtask = { id: string; name: string; assignee: string; progress: number };
export type Task = {
  subtasks?: Subtask[];
  id: string; projectId: string; groupId: string | null; name: string; assignee: string; support: string; progress: number;
  scopeId?: string | null;
  phaseId?: string | null;
  startDate: string | null; endDate: string | null;
  /** Ngày công ước tính; null = tự tính từ khoảng ngày. */
  days: number | null; note: string; sort: number;
  /** Kế hoạch gốc (ngày lúc lập); khác ngày hiện tại = đã dời / gia hạn. */
  baselineStart: string | null; baselineEnd: string | null;
};
export type TaskHistory = { id: number; at: string; field: string; oldValue: string | null; newValue: string | null; user: string | null };
export type Member = { email: string; role: 'editor' | 'viewer'; userId: string | null; name: string; avatar: string | null; createdAt: string };
export type ProjectDetail = Project & {
  myRole: MemberRole; owner: { name: string; email: string; avatar: string | null }; members: Member[]; groups: Group[]; scopes: Scope[]; phases: Phase[]; tasks: Task[];
};
export type OverviewTask = Task & { projectName: string; projectColor: string };
export type Overview = { today: string; projects: ProjectSummary[]; overdue: OverviewTask[]; upcoming: OverviewTask[] };
export type TaskInput = Partial<Omit<Task, 'id' | 'projectId' | 'sort' | 'baselineStart' | 'baselineEnd'>> & { name: string };

/** Chênh lệch so với kế hoạch gốc (ngày): dương = gia hạn / lùi. */
export function planShift(t: Pick<Task, 'startDate' | 'endDate' | 'baselineStart' | 'baselineEnd'>) {
  if (!t.baselineEnd || !t.endDate) return null;
  const day = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const end = day(t.endDate) - day(t.baselineEnd);
  const start = t.startDate && t.baselineStart ? day(t.startDate) - day(t.baselineStart) : 0;
  return end === 0 && start === 0 ? null : { end, start };
}
export type ApiToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type McpTool = { name: string; title: string; description: string; write: boolean };

export class ApiError extends Error {
  status: number;
  reauth: boolean;
  constructor(status: number, message: string, reauth = false) {
    super(message);
    this.status = status;
    this.reauth = reauth;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { error?: string; reauth?: boolean } | null;
    throw new ApiError(res.status, d?.error ?? `Lỗi ${res.status}`, !!d?.reauth);
  }
  return data as T;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<User>('/me'), retry: false, staleTime: Infinity });

/** Hỏi quyền theo tính năng. Chỉ để ẩn/khoá giao diện — server mới là nơi chặn thật (403). */
export function useCan() {
  const { data } = useMe();
  const perms = data?.permissions;
  return useCallback((key: PermissionKey) => !!perms?.includes(key), [perms]);
}

export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects') });
export const useProject = (id: string | undefined) =>
  useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectDetail>(`/projects/${id}`), enabled: !!id, placeholderData: (p) => p });
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview') });
export type CalendarData = { today: string; projects: { id: string; name: string; code: string; color: string; myRole: MemberRole }[]; groups: Record<string, string>; tasks: Task[] };
export const useCalendar = () => useQuery({ queryKey: ['calendar'], queryFn: () => api<CalendarData>('/calendar'), placeholderData: (p) => p });

/**
 * Theo dõi dự án theo thời gian thực: nghe luồng SSE /projects/:id/events, mỗi khi server báo `changed`
 * (ai đó sửa trên web khác, AI sửa qua MCP, nhập liệu…) thì tải lại dự án. Gộp các sự kiện dồn dập trong 300 ms.
 * EventSource tự kết nối lại khi rớt; lúc nối lại thì tải lại để không bỏ sót thay đổi trong lúc mất kết nối.
 */
const BASE = '/api';
export type LiveChange = { at: number; projectId?: string; projectName?: string; deleted?: boolean; source?: 'web' | 'mcp'; actor?: string; actorId?: string; action?: string };

/**
 * Luồng sự kiện toàn cục (/api/events) — mở một lần ở khung trang. Mỗi thay đổi ở dự án mình thấy:
 * tải lại dự án đó, danh sách dự án, tổng quan; gọi onChange (khung trang báo ở góc nếu nguồn là MCP).
 */
export function useLiveEvents(onChange?: (ev: LiveChange) => void) {
  const qc = useQueryClient();
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const pending = new Set<string>();
    let timer: number | undefined;
    let opened = false;
    let last = { key: '', at: 0 };
    const flush = () => {
      for (const pid of pending) void qc.invalidateQueries({ queryKey: ['project', pid] });
      pending.clear();
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    };
    const refresh = (pid?: string) => { if (pid) pending.add(pid); window.clearTimeout(timer); timer = window.setTimeout(flush, 300); };
    const es = new EventSource(`${BASE}/events`);
    es.addEventListener('changed', (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as LiveChange;
        refresh(ev.projectId);
        // Một lệnh MCP (vd. thêm 10 việc) phát nhiều sự kiện cùng mô tả -> chỉ báo một lần trong 1,5 giây.
        const key = `${ev.projectId}|${ev.source}|${ev.actorId}|${ev.action ?? ''}`;
        if (key === last.key && Date.now() - last.at < 1500) return;
        last = { key, at: Date.now() };
        cb.current?.(ev);
      } catch { refresh(); }
    });
    // Nối lại sau khi rớt: tải lại mọi thứ để không sót thay đổi.
    es.addEventListener('open', () => { if (opened) { void qc.invalidateQueries(); } opened = true; });
    return () => { window.clearTimeout(timer); es.close(); };
  }, [qc]);
}
export function useProjectLive(id: string | undefined, onChange?: (ev: LiveChange) => void) {
  const qc = useQueryClient();
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!id || typeof EventSource === 'undefined') return;
    let timer: number | undefined;
    let opened = false;
    let last = { key: '', at: 0 };
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['project', id] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      }, 300);
    };
    const es = new EventSource(`${BASE}/projects/${id}/events`);
    es.addEventListener('changed', (e) => {
      refresh();
      try {
        const ev = JSON.parse((e as MessageEvent).data) as LiveChange;
        // Một lệnh MCP (vd. thêm 10 việc) phát nhiều sự kiện cùng mô tả -> chỉ báo một lần trong 1,5 giây.
        const key = `${ev.source}|${ev.actorId}|${ev.action ?? ''}`;
        if (key === last.key && Date.now() - last.at < 1500) return;
        last = { key, at: Date.now() };
        cb.current?.(ev);
      } catch { /* sự kiện không có JSON */ }
    });
    es.addEventListener('open', () => { if (opened) refresh(); opened = true; });
    return () => { window.clearTimeout(timer); es.close(); };
  }, [id, qc]);
}

/** Mọi lệnh ghi đều làm mới toàn bộ cache (trừ /me): dự án, tổng quan, thống kê phụ thuộc chéo nhau. */
export function useAction<A, R = unknown>(fn: (a: A) => Promise<R>, opts: { onSuccess?: (r: R, a: A) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, a) => {
      qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      opts.onSuccess?.(r, a);
    },
  });
}

export const canEditRole = (role: MemberRole | undefined) => role === 'owner' || role === 'editor';
export const ROLE_LABEL: Record<MemberRole, string> = { owner: 'Chủ dự án', editor: 'Được sửa', viewer: 'Chỉ xem' };

/** Tên viết tắt cho ô avatar: "Trần Văn An" -> "VA". */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const last = parts[parts.length - 1];
  const first = parts.length > 1 ? parts[parts.length - 2] : '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}
