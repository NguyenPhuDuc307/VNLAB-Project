// Mô hình bố cục "kế hoạch Gantt" dùng chung cho hai đích xuất: file Excel
// (server/xlsx.ts, exceljs) và Google Sheets (server/sheets.ts, Sheets API).
// Toạ độ 1-based (hàng, cột). Màu dạng RRGGBB. Hai đích chỉ việc vẽ, không tính gì.
// Cột tuỳ chọn (ASSIGNED TO, SUPPORT, PROGRESS, START, END, NOTE, DAYS, lưới ngày)
// do người dùng tích chọn theo dự án; No và TASK luôn có.
import { addDays, diffDays, mondayOf, today, weekday, coveredDays } from './dates.ts';

export type Fmt = 'text' | 'date' | 'ddate' | 'daynum' | 'pct' | 'num';
export type CellStyle = {
  bold?: boolean; color?: string; fill?: string; align?: 'left' | 'center' | 'right'; fmt?: Fmt;
  border?: 'box' | 'grid'; wrap?: boolean; size?: number;
};
export type Cell = { r: number; c: number; v: string | number | null; s: CellStyle };
export type Range = { r1: number; c1: number; r2: number; c2: number };
export type Layout = {
  title: string;
  cells: Cell[];
  merges: Range[];
  /** Độ rộng cột tính bằng ký tự (Excel). */
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  freeze: { rows: number; cols: number };
  /** Lưới ngày + hai luật conditional formatting (cú pháp en-US, tham chiếu ô đầu vùng); null = không xuất lưới. */
  grid: { range: Range; barFormula: string; todayFormula: string; barColor: string; todayColor: string; borderColor: string } | null;
  /** Sheet dữ liệu phẳng (luôn đủ cột, để dán ngược vào app). */
  data: { header: string[]; rows: (string | number | null)[][]; dateCols: number[]; widths: number[] };
  lastRow: number;
  lastCol: number;
};

export type LayoutGroup = { id: string; name: string };
export type LayoutTask = {
  id: string; groupId: string | null; name: string; assignee: string; support: string; progress: number;
  startDate: string | null; endDate: string | null; days: number | null; note: string;
};
export type LayoutProject = { name: string; code: string; customer: string; startDate: string | null; satWeight: number; sunWeight: number };
export type Effort = (t: LayoutTask, p: LayoutProject) => number;

/** Cột tuỳ chọn người dùng tích được. */
export type ColKey = 'assignee' | 'support' | 'progress' | 'start' | 'end' | 'note' | 'days' | 'grid';
export const ALL_COLUMNS: ColKey[] = ['assignee', 'support', 'progress', 'start', 'end', 'note', 'days', 'grid'];
export const COLUMN_LABELS: Record<ColKey, string> = {
  assignee: 'Phụ trách', support: 'Hỗ trợ', progress: 'Tiến độ', start: 'Bắt đầu', end: 'Kết thúc', note: 'Ghi chú', days: 'Ngày công', grid: 'Lưới Gantt theo ngày',
};
export const isColKey = (k: string): k is ColKey => (ALL_COLUMNS as string[]).includes(k);
/** Chuẩn hoá lựa chọn: lọc key lạ; có lưới thì bắt buộc Bắt đầu + Kết thúc. */
export function normalizeColumns(cols: readonly string[] | null | undefined): ColKey[] {
  const set = new Set((cols ?? ALL_COLUMNS).filter(isColKey));
  if (set.has('grid')) { set.add('start'); set.add('end'); }
  return ALL_COLUMNS.filter((k) => set.has(k));
}

export const COLORS = { header: '595959', group: 'D9D9D9', days: 'FFFF00', bar: '4F81BD', week: 'E7E7E7', grid: 'D9D9D9', today: 'FCE4D6', title: '595959', white: 'FFFFFF', black: '000000' };
export const FONT = 'Times New Roman';
export const HEAD_ROW = 6;

export const colName = (n: number) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
/** Số ngày kiểu Excel / Google Sheets (1899-12-30 = 0) của 'YYYY-MM-DD'. */
export const serial = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000) + 25569;

type TableKey = 'no' | 'task' | Exclude<ColKey, 'grid'>;
const TABLE: { key: TableKey; head: string; width: number }[] = [
  { key: 'no', head: 'No', width: 5 }, { key: 'task', head: 'TASK', width: 52 }, { key: 'assignee', head: 'ASSIGNED TO', width: 14 },
  { key: 'support', head: 'SUPPORT', width: 16 }, { key: 'progress', head: 'PROGRESS', width: 11 }, { key: 'start', head: 'START', width: 13 },
  { key: 'end', head: 'END', width: 13 }, { key: 'note', head: 'NOTE', width: 14 }, { key: 'days', head: 'DAYS', width: 7 },
];

export function buildPlanLayout(p: LayoutProject, owner: string, groups: LayoutGroup[], tasks: LayoutTask[], effort: Effort, columns: readonly string[] | null = null): Layout {
  const t0 = today();
  const sel = new Set(normalizeColumns(columns));
  const withGrid = sel.has('grid');
  const table = TABLE.filter((c) => c.key === 'no' || c.key === 'task' || sel.has(c.key as ColKey));
  const col = new Map<TableKey, number>(table.map((c, i) => [c.key, i + 2])); // bắt đầu từ cột B
  const lastTableCol = 1 + table.length;
  const firstDayCol = lastTableCol + 1;
  const cells: Cell[] = [];
  const merges: Range[] = [];
  const put = (r: number, c: number, v: string | number | null, s: CellStyle = {}) => { cells.push({ r, c, v, s }); };

  // ---- khoảng ngày: thứ Hai của tuần có việc sớm nhất → sau mốc muộn nhất 1 tuần, 8–52 tuần
  const starts = tasks.map((t) => t.startDate ?? t.endDate).filter((x): x is string => !!x);
  const ends = tasks.map((t) => t.endDate ?? t.startDate).filter((x): x is string => !!x);
  const anchor = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : p.startDate ?? t0;
  const gridStart = mondayOf(anchor);
  const lastMark = [...ends, t0, p.startDate ?? t0].reduce((a, b) => (a > b ? a : b));
  const weeks = Math.min(52, Math.max(8, Math.ceil((diffDays(gridStart, lastMark) + 1) / 7) + 1));
  const dayCount = withGrid ? weeks * 7 : 0;
  const lastDayCol = withGrid ? firstDayCol + dayCount - 1 : lastTableCol;

  const colWidths: Record<number, number> = { 1: 2 };
  for (const c of table) colWidths[col.get(c.key)!] = c.width;
  for (let c = firstDayCol; c <= lastDayCol; c++) colWidths[c] = 3.4;

  // ---- đầu trang: tiêu đề bên trái; khối Today / Project Start / Display Week ở 3 cột cuối của bảng
  // (bảng quá hẹp thì ghi thành dòng chữ ở cột TASK).
  put(1, 3, p.name || 'Kế hoạch triển khai', { bold: true, color: COLORS.title, size: 12 });
  put(2, 3, `Khách hàng: ${p.customer || '—'}`);
  put(3, 3, `PM: ${owner}`);
  // Khối Today / Project Start ở F..H như mẫu khi đủ cột; bảng hẹp hơn thì dồn sang trái.
  const infoLabel = Math.min(6, lastTableCol - 2);
  if (infoLabel >= 5) {
    if (p.code) put(4, 3, `Mã: ${p.code}`);
    put(2, infoLabel, 'Today', { align: 'right' });
    put(2, infoLabel + 1, serial(t0), { fmt: 'date', align: 'center', border: 'box' });
    merges.push({ r1: 2, c1: infoLabel + 1, r2: 2, c2: infoLabel + 2 });
    put(3, infoLabel, 'Project Start:', { align: 'right' });
    put(3, infoLabel + 1, serial(p.startDate ?? anchor), { fmt: 'date', align: 'center', fill: COLORS.days, border: 'box' });
    merges.push({ r1: 3, c1: infoLabel + 1, r2: 3, c2: infoLabel + 2 });
    put(4, infoLabel, 'Display Week:', { align: 'right' });
    put(4, infoLabel + 1, 1, { align: 'center', border: 'box' });
  } else {
    put(4, 3, `${p.code ? `Mã: ${p.code} · ` : ''}Today: ${t0.split('-').reverse().join('/')} · Project Start: ${(p.startDate ?? anchor).split('-').reverse().join('/')}`);
  }

  // ---- lưới tuần / ngày (hàng 4–6)
  for (let i = 0; i < dayCount; i++) {
    const d = addDays(gridStart, i);
    const c = firstDayCol + i;
    if (i % 7 === 0) {
      merges.push({ r1: 4, c1: c, r2: 4, c2: c + 6 });
      put(4, c, `${Number(d.slice(8))} thg ${Number(d.slice(5, 7))}, ${d.slice(0, 4)}`, { fill: COLORS.week, border: 'box' });
    }
    put(5, c, serial(d), { fmt: 'daynum', align: 'center', border: 'grid' });
    put(6, c, weekday(d) === 0 ? 'C' : 'T', { bold: true, color: COLORS.white, fill: COLORS.header, align: 'center', border: 'grid' });
  }

  // ---- tiêu đề bảng
  for (const c of table) put(HEAD_ROW, col.get(c.key)!, c.head, { bold: true, color: COLORS.white, fill: COLORS.header, align: 'center', border: 'box' });

  // ---- thân bảng
  const known = new Set(groups.map((g) => g.id));
  const order: { group: LayoutGroup | null; tasks: LayoutTask[] }[] = groups.map((g) => ({ group: g, tasks: tasks.filter((t) => t.groupId === g.id) }));
  const loose = tasks.filter((t) => !t.groupId || !known.has(t.groupId));
  if (loose.length) order.push({ group: null, tasks: loose });

  let r = HEAD_ROW + 2;
  const firstBodyRow = r;
  let no = 0;
  const gridRow = (row: number) => { for (let c = firstDayCol; c <= lastDayCol; c++) put(row, c, null, { border: 'grid' }); };
  const taskRow = (row: number, t?: LayoutTask) => {
    const eff = t ? effort(t, p) : 0;
    for (const c of table) {
      const k = c.key, at = col.get(k)!;
      switch (k) {
        case 'no': put(row, at, t ? ++no : null, { align: 'center', border: 'box' }); break;
        case 'task': put(row, at, t?.name ?? null, { border: 'box', wrap: true }); break;
        case 'assignee': put(row, at, t?.assignee || null, { align: 'center', border: 'box' }); break;
        case 'support': put(row, at, t?.support || null, { align: 'center', border: 'box' }); break;
        case 'progress': put(row, at, t ? t.progress / 100 : null, { fmt: 'pct', align: 'center', border: 'box' }); break;
        case 'start': put(row, at, t?.startDate ? serial(t.startDate) : null, { fmt: 'ddate', align: 'center', border: 'box' }); break;
        case 'end': put(row, at, t?.endDate ? serial(t.endDate) : null, { fmt: 'ddate', align: 'center', border: 'box' }); break;
        case 'note': put(row, at, t?.note || null, { border: 'box', wrap: true }); break;
        case 'days': put(row, at, t && eff ? eff : null, { fmt: 'num', align: 'center', fill: COLORS.days, border: 'box' }); break;
      }
    }
    gridRow(row);
  };
  const dataRows: (string | number | null)[][] = [];
  let i = 0;
  for (const g of order) {
    merges.push({ r1: r, c1: 2, r2: r, c2: 3 });
    put(r, 2, g.group ? g.group.name : 'Chưa phân nhóm', { bold: true, fill: COLORS.group, border: 'box' });
    for (let c = 4; c <= lastTableCol; c++) put(r, c, null, { fill: COLORS.group, border: 'box' });
    if (col.has('days')) {
      // Ngày có việc của nhóm (việc gối nhau chỉ tính một lần), không cộng dồn từng việc.
      const total = coveredDays(g.tasks, p.satWeight, p.sunWeight);
      put(r, col.get('days')!, total ? Math.round(total * 2) / 2 : null, { bold: true, fill: COLORS.group, align: 'center', fmt: 'num', border: 'box' });
    }
    gridRow(r);
    r++;
    for (const t of g.tasks) {
      taskRow(r++, t);
      dataRows.push([++i, g.group?.name ?? '', t.name, t.assignee, t.support, t.progress, t.startDate ? serial(t.startDate) : null, t.endDate ? serial(t.endDate) : null, t.days ?? (effort(t, p) || null), t.note]);
    }
  }
  for (let k = 0; k < 3; k++) taskRow(r++);
  const lastRow = r - 1;

  let grid: Layout['grid'] = null;
  if (withGrid) {
    const K = colName(firstDayCol), S = colName(col.get('start')!), E = colName(col.get('end')!);
    grid = {
      range: { r1: firstBodyRow, c1: firstDayCol, r2: lastRow, c2: lastDayCol },
      barFormula: `AND($${S}${firstBodyRow}<>"",$${E}${firstBodyRow}<>"",${K}$5>=$${S}${firstBodyRow},${K}$5<=$${E}${firstBodyRow},WEEKDAY(${K}$5)<>1)`,
      todayFormula: `${K}$5=TODAY()`,
      barColor: COLORS.bar, todayColor: COLORS.today, borderColor: COLORS.grid,
    };
  }
  return {
    title: p.name,
    cells,
    merges,
    colWidths,
    rowHeights: withGrid ? { 4: 18, 6: 28 } : { 6: 22 },
    freeze: { rows: HEAD_ROW, cols: withGrid ? lastTableCol : 0 },
    grid,
    data: {
      header: ['STT', 'Nhóm', 'Việc', 'Phụ trách', 'Hỗ trợ', 'Tiến độ (%)', 'Bắt đầu', 'Kết thúc', 'Ngày công', 'Ghi chú'],
      rows: dataRows, dateCols: [7, 8], widths: [5, 22, 50, 14, 16, 11, 12, 12, 10, 30],
    },
    lastRow, lastCol: lastDayCol,
  };
}
