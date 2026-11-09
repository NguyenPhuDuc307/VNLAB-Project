// Ngày dạng 'YYYY-MM-DD'. Mọi phép tính đi qua số ngày UTC để không lệch múi giờ.

const pad = (n: number) => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
export function fromDayNumber(n: number): string {
  const t = new Date(n * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export const addDays = (d: string, n: number) => fromDayNumber(dayNumber(d) + n);
export const diffDays = (a: string, b: string) => dayNumber(b) - dayNumber(a);
/** 0 = CN … 6 = T7. */
export const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
/** Thứ hai của tuần chứa ngày d. */
export const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

export const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Ngày công trong [start, end]: T2–T6 = 1, T7/CN theo trọng số dự án. */
export function workDays(start: string, end: string, satWeight = 0.5, sunWeight = 0): number {
  let a = dayNumber(start);
  const b = dayNumber(end);
  if (b < a) return 0;
  let total = 0;
  for (; a <= b; a++) {
    const wd = ((a % 7) + 7 + 4) % 7;
    total += wd === 0 ? sunWeight : wd === 6 ? satWeight : 1;
  }
  return Math.round(total * 2) / 2;
}

/** 14/11/2026 */
export const fmtDate = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '—');
/** 14/11 */
export const fmtShort = (d: string | null | undefined) => (d ? `${d.slice(8)}/${d.slice(5, 7)}` : '—');
/** "14 thg 11" */
export const fmtDayMonth = (d: string) => `${Number(d.slice(8))} thg ${Number(d.slice(5, 7))}`;
export const fmtNum = (n: number | null | undefined) => (n == null ? '' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(n));

// parseDate dùng chung với server (MCP cũng hiểu các dạng ngày này).
export { parseDate, coveredDays } from '../../server/dates.ts';
