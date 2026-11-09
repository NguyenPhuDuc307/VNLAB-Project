// Ngày dạng 'YYYY-MM-DD', tính theo giờ Việt Nam — dùng chung cho server và test.

const pad = (n: number) => String(n).padStart(2, '0');

/** Hôm nay theo múi giờ Việt Nam, bất kể TZ của máy chạy. */
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Ngày -> số ngày kể từ epoch (UTC), để cộng trừ không lệch múi giờ. */
export const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export function fromDayNumber(n: number): string {
  const t = new Date(n * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const addDays = (d: string, n: number) => fromDayNumber(dayNumber(d) + n);
export const diffDays = (a: string, b: string) => dayNumber(b) - dayNumber(a);
/** Thứ hai của tuần chứa ngày d. */
export const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

/** 0 = Chủ nhật … 6 = Thứ bảy. */
export const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/**
 * Ngày công trong khoảng [start, end] (kể cả hai đầu): T2–T6 = 1, T7 và CN
 * theo trọng số của dự án (mặc định T7 = 0.5, CN = 0).
 */
export function workDays(start: string, end: string, satWeight = 0.5, sunWeight = 0): number {
  let a = dayNumber(start);
  const b = dayNumber(end);
  if (b < a) return 0;
  let total = 0;
  for (; a <= b; a++) {
    const wd = ((a % 7) + 7 + 4) % 7; // epoch (1/1/1970) là thứ năm
    total += wd === 0 ? sunWeight : wd === 6 ? satWeight : 1;
  }
  return Math.round(total * 2) / 2;
}

/**
 * Ngày công của cả nhóm: gộp các khoảng ngày của việc rồi tính ngày công trên phần hợp,
 * nên việc chạy song song (gối nhau) không bị cộng trùng. Việc thiếu ngày không tính.
 */
export function coveredDays(spans: { startDate: string | null; endDate: string | null }[], satWeight = 0.5, sunWeight = 0): number {
  const ranges = spans
    .filter((s) => s.startDate || s.endDate)
    .map((s) => [dayNumber(s.startDate ?? s.endDate!), dayNumber(s.endDate ?? s.startDate!)] as [number, number])
    .filter(([a, b]) => b >= a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (cur && r[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], r[1]);
    else {
      if (cur) total += workDays(fromDayNumber(cur[0]), fromDayNumber(cur[1]), satWeight, sunWeight);
      cur = [r[0], r[1]];
    }
  }
  if (cur) total += workDays(fromDayNumber(cur[0]), fromDayNumber(cur[1]), satWeight, sunWeight);
  return Math.round(total * 2) / 2;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Hiểu ngày gõ/dán từ bảng tính hoặc AI gửi: 2026-11-02, 02/11/2026, 2/11/26,
 * 2-Nov-26, 2-thg 11-26, "2 thg 11, 2026". Năm hai chữ số coi là 20xx. Không hiểu → null.
 */
export function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) return build(year(m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,4})\.?[\s-]+(\d{2,4})$/);
  if (m && MONTHS[m[2]]) return build(year(m[3]), MONTHS[m[2]], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]+(?:thg|tháng|th)\.?\s*(\d{1,2})[\s-]+(\d{2,4})$/);
  if (m) return build(year(m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
  if (m) return build(Number(today().slice(0, 4)), +m[2], +m[1]);
  return null;
}
const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
function build(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const s = `${y}-${pad(mo)}-${pad(d)}`;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).getUTCDate() !== d ? null : s;
}
