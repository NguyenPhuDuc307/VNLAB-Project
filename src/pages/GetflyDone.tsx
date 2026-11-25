import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, LogoTile, cx } from '../components/ui';
import { useGetflyStatus } from '../components/GetflyBox';
import { api } from '../lib/api';
import { MSG_FINISHED, MSG_LIST, MSG_RESULT, MSG_SAVED } from '../lib/getfly-bookmarklet';

export type PendingDone = { projectId: string; projectName: string; taskId: string; name: string; getflyId: number; getflyCode: string };
type ItemState = { status: 'waiting' | 'done' | 'already' | 'error'; error?: string | null; saved?: boolean; saveError?: string };

/**
 * Cửa sổ bật lên do bookmarklet "✓ Getfly" mở từ tab Getfly (src/lib/getfly-bookmarklet.ts):
 * lấy danh sách việc xong 100% chưa đánh dấu, gửi về tab Getfly (postMessage, chỉ origin Getfly), nhận kết quả từng việc
 * và ghi nhận ở server (POST /api/getfly/mark-done). Cùng origin với Project nên dùng luôn phiên đăng nhập.
 */
export function GetflyDonePage() {
  const status = useGetflyStatus();
  const origin = status.data?.webOrigin;
  const list = useQuery({ queryKey: ['getfly-pending-done'], queryFn: () => api<PendingDone[]>('/getfly/pending-done'), staleTime: Infinity, retry: false });
  const [states, setStates] = useState<Record<number, ItemState>>({});
  const [finished, setFinished] = useState<null | { cancelled: boolean }>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const saving = useRef(Promise.resolve());
  const opener = typeof window !== 'undefined' ? (window.opener as Window | null) : null;

  // Gửi danh sách về tab Getfly (một lần, khi đã có cả danh sách lẫn origin Getfly).
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !opener || !origin || (!list.data && !list.error)) return;
    sent.current = true;
    if (list.error) { opener.postMessage({ type: MSG_LIST, items: [], error: (list.error as Error).message }, origin); return; }
    opener.postMessage({ type: MSG_LIST, items: list.data!.map(({ projectName, taskId, name, getflyId, getflyCode }) => ({ projectName, taskId, name, getflyId, getflyCode })) }, origin);
  }, [opener, origin, list.data, list.error]);
  // Việc server không nhận (Getfly chưa hoàn thành…) — báo lại cho khung nổi trên Getfly khi xong.
  const rejectedRef = useRef<{ getflyId: number; reason: string }[]>([]);

  useEffect(() => {
    if (!origin) return;
    const save = (getflyId: number) => {
      saving.current = saving.current.then(async () => {
        try {
          // Server tra lại trạng thái thật trên Getfly; chỉ nhận khi Getfly đã "Hoàn thành".
          const r = await api<{ marked: number[]; rejected: number[]; reasons?: Record<string, string> }>('/getfly/mark-done', { method: 'POST', body: { getflyIds: [getflyId] } });
          const ok = r.marked.includes(getflyId);
          const reason = r.reasons?.[getflyId] ?? 'Server không nhận';
          const saveError = reason === 'Getfly chưa hoàn thành' ? 'Chưa hoàn thành trên Getfly' : reason;
          if (!ok) rejectedRef.current.push({ getflyId, reason: saveError });
          setStates((s) => ({ ...s, [getflyId]: { ...s[getflyId], saved: ok, saveError: ok ? undefined : saveError } }));
        } catch (err) {
          rejectedRef.current.push({ getflyId, reason: (err as Error).message });
          setStates((s) => ({ ...s, [getflyId]: { ...s[getflyId], saved: false, saveError: (err as Error).message } }));
        }
      });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || !opener || e.source !== opener || !e.data || typeof e.data !== 'object') return;
      const d = e.data as { type?: string; getflyId?: unknown; ok?: unknown; already?: unknown; error?: unknown; cancelled?: unknown };
      if (d.type === MSG_RESULT && typeof d.getflyId === 'number') {
        const id = d.getflyId;
        const st: ItemState = { status: d.ok ? (d.already ? 'already' : 'done') : 'error', error: typeof d.error === 'string' ? d.error : null };
        setStates((s) => ({ ...s, [id]: st }));
        if (d.ok) save(id);
      } else if (d.type === MSG_FINISHED) {
        void saving.current.then(() => {
          opener.postMessage({ type: MSG_SAVED, rejected: rejectedRef.current }, origin);
          setFinished({ cancelled: !!d.cancelled });
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, opener]);

  // Xong hết và lưu được hết thì tự đóng sau vài giây.
  const items = list.data ?? [];
  const values = Object.values(states);
  // Mở từ bookmarklet: luôn tự đóng (lỗi đã báo trên Getfly); mở thẳng thì chỉ tự đóng khi lưu được hết.
  const allSaved = !!finished && (!!opener || values.every((s) => s.saved));
  useEffect(() => {
    if (!finished || !allSaved) return;
    setCountdown(opener ? 3 : 5);
    const t = setInterval(() => setCountdown((n) => {
      if (n === null) return n;
      if (n <= 1) { window.close(); return 0; }
      return n - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [finished, allSaved]);

  const count = (k: ItemState['status']) => values.filter((s) => s.status === k && !s.saveError).length;
  const rejected = values.filter((s) => s.status !== 'error' && s.saveError).length;
  // Mở từ bookmarklet: chỉ là cầu nối — một dòng trạng thái, giao diện thật ở khung nổi trên Getfly.
  if (opener) {
    const line = list.error ? `Lỗi: ${(list.error as Error).message}`
      : finished ? `Xong${countdown !== null ? ` · đóng sau ${countdown}s` : ''}`
        : values.length ? `Đang chạy ${values.length}/${items.length}…`
          : 'Đang kết nối Getfly…';
    return (
      <div className="flex min-h-dvh items-center justify-between gap-3 px-4 text-[13px]">
        <span className={cx('flex min-w-0 items-center gap-2', list.error ? 'text-danger' : 'text-ink-2')}>
          {!finished && !list.error && <CircleNotch className="shrink-0 animate-spin" size={14} />}
          <span className="truncate">{line}</span>
        </span>
        <button type="button" className="shrink-0 text-[12px] font-semibold text-muted hover:text-ink" onClick={() => window.close()}>Đóng</button>
      </div>
    );
  }
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 px-4 py-5 text-[14px]">
      <header className="flex items-center gap-3">
        <LogoTile className="h-10 w-10 rounded-full" logoClassName="h-7 w-7" />
        <h1 className="text-[17px] font-bold">Hoàn thành + 5★ trên Getfly</h1>
      </header>

      {list.isPending || status.isPending ? (
        <p className="flex items-center gap-2 text-muted"><CircleNotch className="animate-spin" size={16} /> Đang lấy danh sách…</p>
      ) : list.error ? (
        <p className="rounded-[18px] bg-danger-soft px-4 py-3 text-danger">{(list.error as Error).message}</p>
      ) : (
        <>
          {!opener && (
            <p className="text-[12px] text-muted">Mở bằng nút ✓ Getfly trên Getfly.</p>
          )}
          <p>
            <b>{items.length}</b> việc chờ
            {values.length > 0 && <span className="text-muted"> · xong {count('done')} · sẵn {count('already')} · lỗi {count('error')}{rejected ? ` · ${rejected} chưa hoàn thành trên Getfly` : ''}</span>}
          </p>
          <ul className="space-y-1.5">
            {items.map((it) => {
              const s = states[it.getflyId];
              return (
                <li key={`${it.projectId}:${it.getflyId}`} className={cx('rounded-[16px] px-3.5 py-2', s?.status === 'error' || s?.saveError ? 'bg-danger-soft' : 'bg-fill')}>
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      {!s ? <span className="inline-block h-4 w-4 rounded-full border border-line" />
                        : s.status === 'error' ? <WarningCircle size={16} className="text-danger" />
                          : <CheckCircle size={16} weight="fill" className={s.saved ? 'text-ok' : 'text-muted'} />}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {it.name}
                      <span className="block text-[12px] text-muted">{it.projectName} · {it.getflyCode || it.getflyId}{s?.status === 'already' ? ' · sẵn' : ''}{s && s.status !== 'error' && !s.saved && !s.saveError ? ' · đang ghi nhận…' : ''}</span>
                      {(s?.error || s?.saveError) && <span className="block text-[12px] text-danger">{s.saveError ?? s.error}</span>}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {finished && (
            <div className="sticky bottom-3 rounded-[20px] bg-card p-4 shadow-[var(--shadow-xs)]">
              <p className="mb-3 font-semibold">
                {finished.cancelled ? 'Đã dừng' : 'Xong'}: {count('done')} xong · {count('already')} sẵn · {count('error')} lỗi{rejected ? ` · ${rejected} chưa hoàn thành trên Getfly` : ''}
                {countdown !== null && <span className="font-normal text-muted"> · đóng sau {countdown}s</span>}
              </p>
              <Button block onClick={() => window.close()}>Đóng</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
