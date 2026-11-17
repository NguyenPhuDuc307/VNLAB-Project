// Vẽ bố cục kế hoạch (server/plan-layout.ts) ra file Excel bằng exceljs (chỉ sheet PLAN).
// Thanh Gantt và cột hôm nay là conditional formatting nên sửa ngày trong Excel /
// Google Sheets là thanh tự chạy theo. Thanh còn được tô sẵn bằng màu cố định cho
// app không chạy conditional formatting (Numbers, xem nhanh trên Mac / điện thoại);
// trong Excel một luật phủ trắng ô tô sẵn khi ngày đã sửa không còn nằm trong thanh.
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
    x.alignment = { horizontal: s.align ?? 'left', vertical: 'middle', wrapText: !!s.wrap, ...(s.indent ? { indent: s.indent * 2 } : {}) };
    if (s.fmt && FMT[s.fmt]) x.numFmt = FMT[s.fmt];
    if (s.border) x.border = box(s.border === 'grid' ? 'D9D9D9' : '000000');
  }
  for (const m of layout.merges) ws.mergeCells(m.r1, m.c1, m.r2, m.c2);
  const g = layout.grid;
  if (g) {
    // Tô sẵn thanh: hàng việc (STT là số), có đủ bắt đầu / kết thúc, ngày nằm trong khoảng, trừ Chủ nhật.
    const val = new Map(layout.cells.map((x) => [`${x.r}:${x.c}`, x.v]));
    const at = (r: number, c: number) => val.get(`${r}:${c}`);
    const S = colName(g.startCol), E = colName(g.endCol);
    for (let r = g.range.r1; r <= g.range.r2; r++) {
      const s = at(r, g.startCol), e = at(r, g.endCol);
      if (typeof at(r, 2) !== 'number' || typeof s !== 'number' || typeof e !== 'number') continue;
      let c1 = 0, c2 = 0;
      for (let c = g.range.c1; c <= g.range.c2; c++) {
        const d = at(g.dayRow, c);
        if (typeof d !== 'number' || d < s || d > e || (d - 1) % 7 === 0) continue; // serial 1 = Chủ nhật
        ws.getCell(r, c).fill = fill(g.barColor);
        c1 ||= c; c2 = c;
      }
      if (!c1) continue;
      const K = colName(c1), D = `${K}$${g.dayRow}`;
      ws.addConditionalFormatting({
        ref: `${K}${r}:${colName(c2)}${r}`,
        rules: [{ type: 'expression', priority: 3, formulae: [`NOT(AND($${S}${r}<>"",$${E}${r}<>"",${D}>=$${S}${r},${D}<=$${E}${r},WEEKDAY(${D})<>1))`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb('FFFFFF') } } } }],
      });
    }
  }
  if (g) ws.addConditionalFormatting({
    ref: `${colName(g.range.c1)}${g.range.r1}:${colName(g.range.c2)}${g.range.r2}`,
    rules: [
      { type: 'expression', priority: 1, formulae: [g.barFormula], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(g.barColor) } } } },
      { type: 'expression', priority: 2, formulae: [g.todayFormula], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(g.todayColor) } } } },
    ],
  });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
