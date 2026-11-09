// Vẽ bố cục kế hoạch (server/plan-layout.ts) ra file Excel bằng exceljs. Thanh
// Gantt và cột hôm nay là conditional formatting nên sửa ngày trong Excel /
// Google Sheets là thanh tự chạy theo.
import ExcelJS from 'exceljs';
import { colName, FONT, type Layout } from './plan-layout.ts';

const argb = (hex: string) => `FF${hex}`;
const fill = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } });
const thin = (hex: string): Partial<ExcelJS.Border> => ({ style: 'thin', color: { argb: argb(hex) } });
const box = (hex: string): Partial<ExcelJS.Borders> => ({ top: thin(hex), left: thin(hex), bottom: thin(hex), right: thin(hex) });
const FMT: Record<string, string> = { date: 'd/m/yyyy', ddate: 'd-mmm-yy', daynum: 'd', pct: '0%', num: '0.#' };
/** Số ngày Excel -> Date UTC để exceljs ghi đúng (exceljs coi Date là UTC). */
const fromSerial = (n: number) => new Date((n - 25569) * 86_400_000);

export async function renderXlsx(layout: Layout): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VNLab Project';
  wb.created = new Date();
  const ws = wb.addWorksheet('PLAN', {
    views: [{ state: 'frozen', xSplit: layout.freeze.cols, ySplit: layout.freeze.rows, topLeftCell: `${colName(layout.freeze.cols + 1)}${layout.freeze.rows + 1}` }],
    properties: { defaultRowHeight: 15 },
  });
  for (const [c, w] of Object.entries(layout.colWidths)) ws.getColumn(Number(c)).width = w;
  for (const [r, h] of Object.entries(layout.rowHeights)) ws.getRow(Number(r)).height = h;
  for (const cell of layout.cells) {
    const x = ws.getCell(cell.r, cell.c);
    const s = cell.s;
    if (cell.v !== null) x.value = s.fmt === 'date' || s.fmt === 'ddate' || s.fmt === 'daynum' ? fromSerial(cell.v as number) : cell.v;
    x.font = { name: FONT, size: s.size ?? 11, bold: !!s.bold, color: s.color ? { argb: argb(s.color) } : undefined };
    if (s.fill) x.fill = fill(s.fill);
    x.alignment = { horizontal: s.align ?? 'left', vertical: 'middle', wrapText: !!s.wrap };
    if (s.fmt && FMT[s.fmt]) x.numFmt = FMT[s.fmt];
    if (s.border) x.border = box(s.border === 'grid' ? 'D9D9D9' : '000000');
  }
  for (const m of layout.merges) ws.mergeCells(m.r1, m.c1, m.r2, m.c2);
  const g = layout.grid;
  if (g) ws.addConditionalFormatting({
    ref: `${colName(g.range.c1)}${g.range.r1}:${colName(g.range.c2)}${g.range.r2}`,
    rules: [
      { type: 'expression', priority: 1, formulae: [g.barFormula], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(g.barColor) } } } },
      { type: 'expression', priority: 2, formulae: [g.todayFormula], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(g.todayColor) } } } },
    ],
  });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  const data = wb.addWorksheet('Dữ liệu', { views: [{ state: 'frozen', ySplit: 1 }] });
  data.columns = layout.data.header.map((h, i) => ({ header: h, width: layout.data.widths[i] }));
  data.getRow(1).font = { name: FONT, size: 11, bold: true };
  for (const row of layout.data.rows) {
    const r = data.addRow(row.map((v, i) => (v !== null && layout.data.dateCols.includes(i + 1) ? fromSerial(v as number) : v)));
    r.font = { name: FONT, size: 11 };
    for (const c of layout.data.dateCols) r.getCell(c).numFmt = 'yyyy-mm-dd';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
