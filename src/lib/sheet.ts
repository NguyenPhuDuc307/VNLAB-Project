import type { TaskInput } from './api.ts';
import { parseDate } from './dates.ts';

export type Parsed = { groups: { name: string | null; tasks: TaskInput[] }[]; skipped: number };

const HEAD: Record<string, RegExp> = {
  no: /^(no|#|stt|số)$/i,
  name: /^(task|việc|công việc|tên việc|hạng mục|nội dung)$/i,
  assignee: /^(assigned( to)?|phụ trách|người làm|owner)$/i,
  support: /^(support|hỗ trợ)$/i,
  progress: /^(progress|tiến độ|%|hoàn thành)$/i,
  start: /^(start|bắt đầu|ngày bắt đầu|from)$/i,
  end: /^(end|kết thúc|ngày kết thúc|to|deadline|hạn)$/i,
  days: /^(days|ngày|ngày công|số ngày|effort)$/i,
  note: /^(note|ghi chú)$/i,
};
const DEFAULT_ORDER = ['no', 'name', 'assignee', 'support', 'progress', 'start', 'end', 'task', 'days'];

function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  // CSV đơn giản có ngoặc kép.
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (s: string | undefined) => {
  if (!s) return null;
  const n = Number(s.replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};

/** Dán từ Excel/Google Sheets: dòng có số thứ tự = việc; dòng chỉ có tên (không số, không ngày) = nhóm. */
export function parseSheet(text: string): Parsed {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const groups: Parsed['groups'] = [];
  let skipped = 0;
  let cols: string[] = DEFAULT_ORDER;
  let current: Parsed['groups'][number] | null = null;
  for (const line of lines) {
    const cells = splitLine(line);
    // Dòng tiêu đề: ≥ 3 ô khớp tên cột quen thuộc → lấy làm bản đồ cột.
    const matched = cells.map((c) => Object.keys(HEAD).find((k) => HEAD[k].test(c.trim())) ?? '');
    if (matched.filter(Boolean).length >= 3) { cols = matched; continue; }
    const get = (k: string) => { const i = cols.indexOf(k); return i >= 0 ? cells[i] ?? '' : ''; };
    const no = get('no');
    let name = get('name');
    // Tên nhóm thường nằm ở cột STT khi dán từ bảng tính (tên nhóm nằm ở ô cột No);
    // không có cột tên thì lấy ô văn bản đầu tiên không phải số.
    if (!name) name = cells.find((c) => c && !/^\d+([.,]\d+)?%?$/.test(c)) ?? '';
    if (!name) { skipped++; continue; }
    const start = parseDate(get('start')), end = parseDate(get('end'));
    const isTask = /^\d+$/.test(no.trim()) || start || end || get('progress') || get('assignee');
    if (!isTask) {
      current = { name: name.trim(), tasks: [] };
      groups.push(current);
      continue;
    }
    if (!current) { current = { name: null, tasks: [] }; groups.push(current); }
    const progress = num(get('progress'));
    current.tasks.push({
      name: name.trim(),
      assignee: get('assignee'),
      support: get('support'),
      progress: progress == null ? 0 : Math.max(0, Math.min(100, Math.round(progress <= 1 && /[.,]/.test(get('progress')) && !get('progress').includes('%') ? progress * 100 : progress))),
      startDate: start, endDate: end && start && end < start ? start : end,
      days: num(get('days')),
      note: get('note'),
    });
  }
  return { groups: groups.filter((g) => g.name || g.tasks.length), skipped };
}
