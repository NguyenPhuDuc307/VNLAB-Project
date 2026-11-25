import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, LogoTile, Select, Textarea } from '../components/ui';
import { useGetflyStatus } from '../components/GetflyBox';
import { api, useProjects } from '../lib/api';
import { MSG_KPI_DRAFT, MSG_KPI_RESULT, MSG_KPI_STEP } from '../lib/getfly-kpi-bookmarklet';

type Criterion = { name: string; description: string; value: number; unit: string; weight: number };
type Draft = { name: string; month: string; description: string; criteria: Criterion[]; start: string; end: string; employeeName: string; lines: number; projectName: string };

const AMMS = 'ed9e4fda-856b-48eb-8227-664d01f7502d';
const KEY = 'vnlab-kpi-project';
const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Cửa sổ bật lên của bookmarklet "✓ KPI": chọn tháng / dự án, sửa bản nháp, gửi sang tab Getfly và theo dõi từng bước. */
export function GetflyKpiPage() {
  const status = useGetflyStatus();
  const origin = status.data?.webOrigin;
  const projects = useProjects();
  const now = new Date();
  const months = [monthOf(now), monthOf(new Date(now.getFullYear(), now.getMonth() + 1, 1))];
  const [month, setMonth] = useState(months[1]);
  const [projectId, setProjectId] = useState<string>(() => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } });
  const list = useMemo(() => (projects.data ?? []).filter((p) => !p.archived && p.myRole !== 'viewer'), [projects.data]);
  useEffect(() => {
    if (!list.length || list.some((p) => p.id === projectId)) return;
    setProjectId((list.find((p) => p.id === AMMS) ?? list.find((p) => p.getflyCreatorId || Object.keys(p.getflyGroups ?? {}).length) ?? list[0]).id);
  }, [list, projectId]);
  useEffect(() => { try { if (projectId) localStorage.setItem(KEY, projectId); } catch { /* bỏ qua */ } }, [projectId]);

  const draftQ = useQuery({ queryKey: ['kpi-draft', projectId, month], queryFn: () => api<Draft>(`/getfly/kpi-draft?projectId=${projectId}&month=${month}`), enabled: !!projectId, retry: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (draftQ.data) setDraft(draftQ.data); }, [draftQ.data]);
  const [progress, setProgress] = useState<{ step: number; label: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; step?: number; error?: string; cancelled?: boolean } | null>(null);
  const [sent, setSent] = useState(false);
  const opener = typeof window !== 'undefined' ? (window.opener as Window | null) : null;

  useEffect(() => {
    if (!origin) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || !opener || e.source !== opener || !e.data || typeof e.data !== 'object') return;
      const d = e.data as { type?: string; step?: number; label?: string; ok?: boolean; error?: string; cancelled?: boolean };
      if (d.type === MSG_KPI_STEP) setProgress({ step: Number(d.step), label: String(d.label ?? '') });
      if (d.type === MSG_KPI_RESULT) { setResult({ ok: !!d.ok, step: d.step, error: d.error, cancelled: d.cancelled }); setSent(false); }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [origin, opener]);

  const weight = draft?.criteria.reduce((n, c) => n + (Number(c.weight) || 0), 0) ?? 0;
  const setCrit = (i: number, patch: Partial<Criterion>) => draft && setDraft({ ...draft, criteria: draft.criteria.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const send = () => {
    if (!draft || !opener || !origin) return;
    const criteria = draft.criteria.map((c, i) => (i === 0 ? { ...c, description: draft.description } : c));
    opener.postMessage({ type: MSG_KPI_DRAFT, draft: { name: draft.name, start: draft.start, end: draft.end, employeeName: draft.employeeName, criteria } }, origin);
    setSent(true); setResult(null); setProgress(null);
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col gap-3 px-4 py-4 text-[14px]">
      <header className="flex items-center gap-3">
        <LogoTile className="h-9 w-9 rounded-full" logoClassName="h-6 w-6" />
        <h1 className="text-[17px] font-bold">KPI tháng trên Getfly</h1>
      </header>
      {!opener && <p className="text-[12px] text-muted">Mở bằng nút ✓ KPI trên Getfly.</p>}
      <div className="grid grid-cols-2 gap-2">
        <Select aria-label="Tháng" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>Tháng {Number(m.slice(5))}/{m.slice(0, 4)}</option>)}
        </Select>
        <Select aria-label="Dự án" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      {draftQ.isFetching && !draft ? <p className="flex items-center gap-2 text-muted"><CircleNotch className="animate-spin" size={16} /> Đang lập bản nháp…</p>
        : draftQ.error ? <p className="text-danger">{(draftQ.error as Error).message}</p>
          : draft && (
            <>
              <Input aria-label="Tên KPI" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <p className="text-[12px] text-muted">{draft.start} – {draft.end} · {draft.employeeName} · {draft.lines} việc</p>
              <Textarea aria-label="Mô tả chỉ tiêu Triển khai" rows={9} className="!text-[13px]" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              <div className="space-y-1.5">
                <div className="grid grid-cols-[1fr_64px_64px] gap-2 px-1 text-[12px] text-muted"><span>Chỉ tiêu</span><span>Giá trị</span><span>Trọng số</span></div>
                {draft.criteria.map((c, i) => (
                  <div key={c.name} className="grid grid-cols-[1fr_64px_64px] items-center gap-2">
                    <span className="truncate">{c.name}</span>
                    <Input aria-label={`Giá trị ${c.name}`} inputMode="decimal" className="!h-9 !px-3 !text-[13px]" value={String(c.value)} onChange={(e) => setCrit(i, { value: Number(e.target.value) || 0 })} />
                    <Input aria-label={`Trọng số ${c.name}`} inputMode="numeric" className="!h-9 !px-3 !text-[13px]" value={String(c.weight)} onChange={(e) => setCrit(i, { weight: Number(e.target.value) || 0 })} />
                  </div>
                ))}
                {weight !== 100 && <p className="text-[12px] text-danger">Tổng trọng số {weight}% (cần 100%)</p>}
              </div>
              <Button block disabled={!opener || !origin || sent || !!result || weight !== 100 || !draft.name.trim()} onClick={send}>{sent ? 'Đang tạo trên Getfly…' : 'Gửi sang Getfly'}</Button>
            </>
          )}
      {sent && progress && <p className="flex items-center gap-2 text-muted"><CircleNotch className="animate-spin" size={16} /> Bước {progress.step}/6: {progress.label}</p>}
      {result && (result.ok
        ? <p className="flex items-center gap-2 font-semibold text-ok"><CheckCircle size={16} weight="fill" /> Đã tạo KPI trên Getfly</p>
        : <p className="flex items-start gap-2 text-danger"><WarningCircle size={16} className="mt-0.5 shrink-0" /> {result.cancelled ? 'Đã huỷ' : `Dừng ở bước ${result.step ?? '?'}: ${result.error ?? 'lỗi'} — bấm lại ✓ KPI để thử lại`}</p>)}
      {result?.ok && <Button variant="secondary" block onClick={() => window.close()}>Đóng</Button>}
    </div>
  );
}
