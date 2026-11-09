import { ALL_COLUMNS, COLUMN_LABELS, normalizeColumns, type ColKey } from '../../server/plan-layout.ts';
import { cx } from './ui';

export type { ColKey };
export { ALL_COLUMNS, normalizeColumns };

/** Tích chọn cột xuất Excel / đồng bộ Google Sheets. No và Việc luôn có; bật lưới Gantt thì Bắt đầu / Kết thúc bắt buộc. */
export function ColumnPicker({ value, onChange, disabled }: { value: ColKey[]; onChange: (v: ColKey[]) => void; disabled?: boolean }) {
  const set = new Set(value);
  const grid = set.has('grid');
  const toggle = (k: ColKey) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k); else next.add(k);
    onChange(normalizeColumns([...next]));
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="inline-flex h-7 items-center rounded-lg bg-fill px-2 text-[12px] font-semibold text-muted">No · Việc</span>
      {ALL_COLUMNS.map((k) => {
        const locked = grid && (k === 'start' || k === 'end');
        const on = set.has(k);
        return (
          <button
            key={k}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={disabled || locked}
            onClick={() => toggle(k)}
            title={locked ? 'Lưới Gantt cần ngày bắt đầu / kết thúc' : undefined}
            className={cx('inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[12px] font-semibold transition disabled:opacity-60', on ? 'border-primary/40 bg-primary-soft text-primary' : 'border-line bg-card text-ink-2 hover:bg-fill')}
          >
            <span className={cx('inline-block h-3 w-3 rounded-[3px] border', on ? 'border-primary bg-primary' : 'border-line')} />
            {COLUMN_LABELS[k]}
          </button>
        );
      })}
    </div>
  );
}
