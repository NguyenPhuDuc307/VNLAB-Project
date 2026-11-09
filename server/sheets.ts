// Đồng bộ kế hoạch dự án sang Google Sheets (một chiều, app -> sheet): vẽ bố cục
// server/plan-layout.ts bằng Sheets API batchUpdate vào tab PLAN và tab "Dữ liệu"
// của spreadsheet người dùng liên kết; các tab khác giữ nguyên. Có thể tự đồng
// bộ sau mỗi thay đổi (gộp 30 giây).
import { sql } from './db.ts';
import * as D from './data.ts';
import { gfetch, GoogleError, SHEETS_API, serviceAccountEmail } from './google.ts';
import { buildPlanLayout, FONT, type Cell, type Layout, type Range } from './plan-layout.ts';

export const SHEET_URL = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** Lấy id spreadsheet từ link (…/spreadsheets/d/<id>/…) hoặc chính id. */
export function parseSheetId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- Sheets API: dựng request

type Color = { red: number; green: number; blue: number };
const rgb = (hex: string): Color => ({ red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
const NUMFMT: Record<string, { type: string; pattern: string }> = {
  date: { type: 'DATE', pattern: 'd/m/yyyy' }, ddate: { type: 'DATE', pattern: 'd-mmm-yy' }, daynum: { type: 'DATE', pattern: 'd' },
  pct: { type: 'PERCENT', pattern: '0%' }, num: { type: 'NUMBER', pattern: '0.#' },
};
const gridRange = (sheetId: number, r: Range) => ({ sheetId, startRowIndex: r.r1 - 1, endRowIndex: r.r2, startColumnIndex: r.c1 - 1, endColumnIndex: r.c2 });
const border = (hex: string) => ({ style: 'SOLID', color: rgb(hex) });

function cellData(cell: Cell, layout: Layout) {
  const s = cell.s;
  const fmt: Record<string, unknown> = {
    textFormat: { fontFamily: FONT, fontSize: s.size ?? 11, bold: !!s.bold, ...(s.color ? { foregroundColor: rgb(s.color) } : {}) },
    horizontalAlignment: (s.align ?? 'left').toUpperCase(),
    verticalAlignment: 'MIDDLE',
    wrapStrategy: s.wrap ? 'WRAP' : 'OVERFLOW_CELL',
  };
  if (s.fill) fmt.backgroundColor = rgb(s.fill);
  if (s.fmt && NUMFMT[s.fmt]) fmt.numberFormat = NUMFMT[s.fmt];
  if (s.border) {
    const b = border(s.border === 'grid' ? 'D9D9D9' : '000000');
    fmt.borders = { top: b, bottom: b, left: b, right: b };
  }
  const value = cell.v === null ? undefined : typeof cell.v === 'number' ? { numberValue: cell.v } : { stringValue: cell.v };
  return { ...(value ? { userEnteredValue: value } : {}), userEnteredFormat: fmt };
}

/**
 * Công thức trong Sheets API được phân tích theo LOCALE của spreadsheet: locale dùng dấu
 * phẩy thập phân (vi_VN, de_DE, fr_FR…) ngăn cách đối số bằng `;`. Công thức của ta không
 * có chuỗi chứa dấu phẩy nên đổi thẳng `,` -> `;` là đủ.
 */
export function formulaFor(locale: string | undefined, formula: string) {
  let comma = false;
  try { comma = new Intl.NumberFormat((locale ?? 'en_US').replace('_', '-')).format(1.5).includes(','); } catch { comma = false; }
  return comma ? formula.replace(/,/g, ';') : formula;
}

/** Request vẽ cả tab PLAN: ghi theo từng hàng (ô trống trong hàng vẫn được xoá định dạng cũ). */
function planRequests(sheetId: number, layout: Layout, existingRules: number, locale: string | undefined) {
  const reqs: unknown[] = [];
  // Dọn: bỏ merge, xoá giá trị + định dạng, xoá conditional formatting cũ, đủ kích thước lưới.
  reqs.push({ unmergeCells: { range: { sheetId } } });
  reqs.push({ updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } });
  for (let i = 0; i < existingRules; i++) reqs.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(layout.lastRow + 5, 40), columnCount: layout.lastCol + 2, frozenRowCount: layout.freeze.rows, frozenColumnCount: layout.freeze.cols } }, fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)' } });
  // Ô theo hàng.
  const byRow = new Map<number, Cell[]>();
  for (const c of layout.cells) byRow.set(c.r, [...(byRow.get(c.r) ?? []), c]);
  for (const [r, cells] of byRow) {
    const cols = cells.map((c) => c.c);
    const c1 = Math.min(...cols), c2 = Math.max(...cols);
    const values = Array.from({ length: c2 - c1 + 1 }, (_, i) => {
      const cell = cells.find((x) => x.c === c1 + i);
      return cell ? cellData(cell, layout) : {};
    });
    reqs.push({ updateCells: { range: gridRange(sheetId, { r1: r, c1, r2: r, c2 }), rows: [{ values }], fields: 'userEnteredValue,userEnteredFormat' } });
  }
  for (const m of layout.merges) reqs.push({ mergeCells: { range: gridRange(sheetId, m), mergeType: 'MERGE_ALL' } });
  for (const [c, w] of Object.entries(layout.colWidths)) {
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: Number(c) - 1, endIndex: Number(c) }, properties: { pixelSize: Math.round(w * 7 + 5) }, fields: 'pixelSize' } });
  }
  for (const [r, h] of Object.entries(layout.rowHeights)) {
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: Number(r) - 1, endIndex: Number(r) }, properties: { pixelSize: Math.round(h * 1.33) }, fields: 'pixelSize' } });
  }
  const g = layout.grid;
  if (g) {
    reqs.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [gridRange(sheetId, g.range)], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${formulaFor(locale, g.todayFormula)}` }] }, format: { backgroundColor: rgb(g.todayColor) } } } } });
    reqs.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [gridRange(sheetId, g.range)], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${formulaFor(locale, g.barFormula)}` }] }, format: { backgroundColor: rgb(g.barColor) } } } } });
  }
  return reqs;
}

function dataRequests(sheetId: number, layout: Layout) {
  const d = layout.data;
  const rows = [
    { values: d.header.map((h) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { fontFamily: FONT, bold: true } } })) },
    ...d.rows.map((row) => ({
      values: row.map((v, i) => ({
        ...(v === null ? {} : { userEnteredValue: typeof v === 'number' ? { numberValue: v } : { stringValue: v } }),
        userEnteredFormat: { textFormat: { fontFamily: FONT }, ...(d.dateCols.includes(i + 1) ? { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } : {}) },
      })),
    })),
  ];
  return [
    { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(rows.length + 5, 30), columnCount: d.header.length, frozenRowCount: 1 } }, fields: 'gridProperties(rowCount,columnCount,frozenRowCount)' } },
    { updateCells: { range: gridRange(sheetId, { r1: 1, c1: 1, r2: rows.length, c2: d.header.length }), rows, fields: 'userEnteredValue,userEnteredFormat' } },
    ...d.widths.map((w, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: Math.round(w * 7 + 5) }, fields: 'pixelSize' } })),
  ];
}

// ---------------------------------------------------------------- gọi Google

type SheetProps = { sheetId: number; title: string };
type Spreadsheet = { spreadsheetUrl?: string; properties?: { locale?: string }; sheets?: { properties: SheetProps; conditionalFormats?: unknown[] }[] };

async function ensureTabs(spreadsheetId: string, titles: string[]) {
  const ss = await gfetch<Spreadsheet>(`${SHEETS_API()}/spreadsheets/${spreadsheetId}?fields=spreadsheetUrl,properties.locale,sheets(properties(sheetId,title),conditionalFormats)`);
  const have = new Map((ss.sheets ?? []).map((s) => [s.properties.title, { id: s.properties.sheetId, cf: s.conditionalFormats?.length ?? 0 }]));
  const missing = titles.filter((t) => !have.has(t));
  if (missing.length) {
    const r = await gfetch<{ replies: { addSheet?: { properties: SheetProps } }[] }>(`${SHEETS_API()}/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST', body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
    for (const rep of r.replies) if (rep.addSheet) have.set(rep.addSheet.properties.title, { id: rep.addSheet.properties.sheetId, cf: 0 });
  }
  return { tabs: have, url: ss.spreadsheetUrl ?? SHEET_URL(spreadsheetId), locale: ss.properties?.locale };
}

/** Vẽ bố cục vào spreadsheet (tab PLAN + Dữ liệu). */
export async function writeLayout(spreadsheetId: string, layout: Layout) {
  const { tabs, url, locale } = await ensureTabs(spreadsheetId, ['PLAN', 'Dữ liệu']);
  const plan = tabs.get('PLAN')!, data = tabs.get('Dữ liệu')!;
  await gfetch(`${SHEETS_API()}/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ requests: [...planRequests(plan.id, layout, plan.cf, locale), ...dataRequests(data.id, layout)] }),
  });
  return url;
}

// Lưu ý: Google không cấp dung lượng Drive cho service account (quota 0) nên KHÔNG tạo
// spreadsheet bằng service account được — người dùng tự tạo sheet rồi Share Editor cho nó.

// ---------------------------------------------------------------- đồng bộ dự án

export type SyncResult = { url: string; syncedAt: string };

/** Đồng bộ một dự án đã liên kết sheet. Ghi kết quả / lỗi vào bảng projects. */
export async function syncProject(projectId: string): Promise<SyncResult> {
  const [p] = await sql<D.ProjectRow[]>`select * from projects where id = ${projectId}`;
  if (!p) throw new GoogleError(404, 'Không tìm thấy dự án');
  if (!p.sheetId) throw new GoogleError(400, 'Dự án chưa liên kết Google Sheet');
  const [owner] = await sql<{ name: string; email: string }[]>`select name, email from users where id = ${p.ownerId}`;
  const bundle = await D.projectBundle(projectId);
  const layout = buildPlanLayout(p, owner?.name || owner?.email || '', bundle.groups, bundle.tasks, D.effortOf, p.exportColumns);
  try {
    const url = await writeLayout(p.sheetId, layout);
    const [row] = await sql<{ sheetSyncedAt: Date }[]>`update projects set sheet_synced_at = now(), sheet_error = null where id = ${projectId} returning sheet_synced_at`;
    return { url, syncedAt: new Date(row.sheetSyncedAt).toISOString() };
  } catch (err) {
    const msg = err instanceof GoogleError ? err.message : `Lỗi đồng bộ: ${(err as Error).message}`;
    await sql`update projects set sheet_error = ${msg} where id = ${projectId}`;
    throw err instanceof GoogleError ? err : new GoogleError(502, msg);
  }
}

// Tự đồng bộ: mọi lệnh ghi đều gọi D.touch(projectId) -> sự kiện 'changed'; gộp 30 giây.
const AUTO_DELAY_MS = Number(process.env.PROJECT_SHEET_AUTO_DELAY_MS ?? 30_000);
const timers = new Map<string, NodeJS.Timeout>();
export function startAutoSync() {
  D.projectEvents.on('changed', (projectId: string) => {
    if (timers.has(projectId)) return;
    timers.set(projectId, setTimeout(async () => {
      timers.delete(projectId);
      try {
        const [p] = await sql<{ sheetId: string | null; sheetAuto: boolean }[]>`select sheet_id, sheet_auto from projects where id = ${projectId}`;
        if (p?.sheetId && p.sheetAuto) await syncProject(projectId);
      } catch (err) {
        console.warn(`[sheets] tự đồng bộ ${projectId} lỗi:`, (err as Error).message);
      }
    }, AUTO_DELAY_MS));
  });
}

export const sheetStatus = () => ({ configured: !!serviceAccountEmail(), email: serviceAccountEmail() });
