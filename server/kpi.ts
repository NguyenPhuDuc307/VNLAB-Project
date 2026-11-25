// Bản nháp KPI tháng trên Getfly (bookmarklet "✓ KPI", src/lib/getfly-kpi-bookmarklet.ts) — chép mẫu KPI tháng 11/2026:
// 3 chỉ tiêu tự nhập "Triển khai" (giá trị 1, trọng số 90, mô tả = các dòng lịch dự kiến theo nhóm), "Bám sát deadline" (0 / 10),
// "Báo cáo định kỳ" (0 / 0); hiệu lực từ ngày 1 tới ngày cuối tháng; tên "YYYY_MM_PM_ <họ tên>".
// Lịch dự kiến: việc lá (không có việc con) giao cho người dùng, có ngày chồng lên tháng; cắt theo tháng;
// mỗi nhóm việc một dòng; tỉ trọng nhóm = Σ ngày công × phần ngày nằm trong tháng, làm tròn rồi bù vào nhóm lớn nhất cho đủ 100%.
import { dayNumber, workDays } from './dates.ts';

export type KpiCriterion = { name: string; description: string; value: number; unit: string; weight: number };
export type KpiDraft = { name: string; month: string; description: string; criteria: KpiCriterion[]; start: string; end: string; employeeName: string; lines: number };
export type KpiTask = {
  id: string; name: string; groupId: string | null; parentTaskId: string | null; assignee: string;
  startDate: string | null; endDate: string | null; days: number | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function buildKpiDraft(o: {
  month: string; employeeName: string; shortNames: string[];
  groups: { id: string; name: string }[]; tasks: KpiTask[]; satWeight?: number; sunWeight?: number;
}): KpiDraft {
  const [y, m] = o.month.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`, last = `${y}-${pad(m)}-${pad(lastDay(y, m))}`;
  const who = new Set([...o.shortNames, o.employeeName].map((s) => s.trim().toLowerCase()).filter(Boolean));
  const parents = new Set(o.tasks.map((t) => t.parentTaskId).filter(Boolean));
  const group = new Map(o.groups.map((g) => [g.id, g.name]));
  const rows = o.tasks.flatMap((t) => {
    const s = t.startDate ?? t.endDate, e = t.endDate ?? t.startDate;
    if (!s || !e || parents.has(t.id)) return [];
    if (!t.assignee.split(',').some((a) => who.has(a.trim().toLowerCase()))) return [];
    const cs = s > first ? s : first, ce = e < last ? e : last;
    if (cs > ce) return [];
    const total = t.days ?? workDays(s, e, o.satWeight ?? 0.5, o.sunWeight ?? 0);
    const share = total * (dayNumber(ce) - dayNumber(cs) + 1) / (dayNumber(e) - dayNumber(s) + 1);
    return [{ t, cs, ce, share }];
  }).sort((a, b) => a.cs.localeCompare(b.cs) || a.ce.localeCompare(b.ce) || a.t.name.localeCompare(b.t.name, 'vi'));
  // Mỗi nhóm một dòng (theo mẫu KPI tháng 11): tên các việc theo thứ tự bắt đầu, khoảng ngày từ đầu sớm nhất tới cuối muộn nhất.
  type Line = { label: string; names: string[]; cs: string; ce: string; share: number };
  const byGroup = new Map<string, Line>();
  for (const r of rows) {
    const key = r.t.groupId ?? '';
    const cur = byGroup.get(key);
    if (!cur) byGroup.set(key, { label: (r.t.groupId && group.get(r.t.groupId)) || '', names: [r.t.name], cs: r.cs, ce: r.ce, share: r.share });
    else { cur.names.push(r.t.name); if (r.cs < cur.cs) cur.cs = r.cs; if (r.ce > cur.ce) cur.ce = r.ce; cur.share += r.share; }
  }
  const lines0 = [...byGroup.values()].sort((a, b) => a.cs.localeCompare(b.cs) || b.share - a.share);
  const sum = lines0.reduce((n, r) => n + r.share, 0);
  const pct = lines0.map((r) => (sum ? Math.round((r.share / sum) * 100) : 0));
  if (lines0.length && sum) {
    const big = lines0.reduce((bi, r, i) => (r.share > lines0[bi].share ? i : bi), 0);
    pct[big] += 100 - pct.reduce((a, b) => a + b, 0);
  }
  // Tên thứ 2 trở đi viết thường chữ đầu nếu chữ kế tiếp là chữ thường ("App tài xế" -> "app tài xế"; "GPS…" giữ nguyên).
  const lowerFirst = (n: string) => (n.length > 1 && n[1] !== n[1].toUpperCase() ? n[0].toLowerCase() + n.slice(1) : n);
  const lines = lines0.map((r, i) => {
    const d1 = Number(r.cs.slice(8)), d2 = Number(r.ce.slice(8));
    const names = r.names.map((n, k) => (k ? lowerFirst(n) : n)).join(', ');
    return `${i + 1}. ${r.label ? `${r.label}: ` : ''}${names} - ${d1 === d2 ? d1 : `${d1}-${d2}`}/${m} - ${pct[i]}%`;
  });
  const description = lines.join('\n');
  return {
    name: `${y}_${pad(m)}_PM_ ${o.employeeName}`, month: o.month, description, lines: lines.length,
    criteria: [
      { name: 'Triển khai', description, value: 1, unit: '', weight: 90 },
      { name: 'Bám sát deadline', description: '', value: 0, unit: '', weight: 10 },
      { name: 'Báo cáo định kỳ', description: '', value: 0, unit: '', weight: 0 },
    ],
    start: `01/${pad(m)}/${y}`, end: `${pad(lastDay(y, m))}/${pad(m)}/${y}`, employeeName: o.employeeName,
  };
}
