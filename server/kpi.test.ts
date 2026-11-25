import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKpiDraft, type KpiTask } from './kpi.ts';
import { GETFLY_KPI_PATH, getflyKpiBookmarklet } from '../src/lib/getfly-kpi-bookmarklet.ts';

const groups = [{ id: 'g1', name: 'HPG - Giao hàng' }, { id: 'g2', name: 'HPG - Kho' }];
let n = 0;
const t = (groupId: string, name: string, startDate: string, endDate: string, days: number | null, extra: Partial<KpiTask> = {}): KpiTask =>
  ({ id: `t${++n}`, name, groupId, parentTaskId: null, assignee: 'Đức', startDate, endDate, days, ...extra });

test('KPI tháng 12/2026: tái tạo đúng lịch dự kiến đã tạo tay trên Getfly', () => {
  const parent = t('g1', 'Giao hàng (việc cha)', '2026-12-01', '2026-12-31', 20);
  const tasks = [
    t('g1', 'App tài xế Flutter', '2026-12-14', '2026-12-31', 15),
    t('g2', 'Xuất hàng bằng quét mã', '2026-12-14', '2026-12-19', 5.5),
    t('g1', 'Xử lý cảnh báo giao hàng', '2026-12-01', '2026-12-03', 3, { parentTaskId: parent.id }),
    t('g2', 'Cập nhật tồn Bravo', '2026-12-08', '2026-12-13', 4.5),
    t('g1', 'Xử lý giao không thành công', '2026-12-05', '2026-12-12', 6),
    t('g2', 'Xếp lót tự động', '2026-12-07', '2026-12-10', 3.5),
    parent, // có việc con -> bỏ
    t('g1', 'Việc của người khác', '2026-12-01', '2026-12-05', 4, { assignee: 'Quyết' }),
    t('g1', 'Việc tháng 11', '2026-11-02', '2026-11-20', 10),
    t('g1', 'Chưa có ngày', '', '', 2, { startDate: null, endDate: null }),
  ];
  const d = buildKpiDraft({ month: '2026-12', employeeName: 'Nguyễn Phú Đức', shortNames: ['Đức'], groups, tasks });
  assert.equal(d.name, '2026_12_PM_ Nguyễn Phú Đức');
  assert.equal(d.description, [
    '1. HPG - Giao hàng: Xử lý cảnh báo giao hàng, xử lý giao không thành công, app tài xế Flutter - 1-31/12 - 64%',
    '2. HPG - Kho: Xếp lót tự động, cập nhật tồn Bravo, xuất hàng bằng quét mã - 7-19/12 - 36%',
  ].join('\n'));
  assert.deepEqual([d.start, d.end], ['01/12/2026', '31/12/2026']);
  assert.deepEqual(d.criteria.map((c) => [c.name, c.value, c.weight]), [['Triển khai', 1, 90], ['Bám sát deadline', 0, 10], ['Báo cáo định kỳ', 0, 0]]);
  assert.equal(d.criteria[0].description, d.description);
});

test('KPI: gộp theo nhóm, cắt theo tháng, một ngày ghi gọn, giữ chữ hoa viết tắt, tổng luôn 100%', () => {
  const tasks = [
    t('g1', 'Vắt qua tháng', '2026-11-23', '2026-12-02', 10), // 10 ngày lịch, 2 ngày trong tháng 12 -> 2 công
    t('g2', 'Một ngày', '2026-12-09', '2026-12-09', 1),
    t('g2', 'Ba phần', '2026-12-10', '2026-12-12', 1),
    t('g2', 'Ba phần nữa', '2026-12-15', '2026-12-17', 1),
  ];
  const d = buildKpiDraft({ month: '2026-12', employeeName: 'Nguyễn Phú Đức', shortNames: ['Đức'], groups, tasks });
  const lines = d.description.split('\n');
  assert.deepEqual(lines, ['1. HPG - Giao hàng: Vắt qua tháng - 1-2/12 - 40%', '2. HPG - Kho: Một ngày, ba phần, ba phần nữa - 9-17/12 - 60%']);
  const one = buildKpiDraft({ month: '2026-12', employeeName: 'A', shortNames: ['Đức'], groups, tasks: [t('g2', 'Một ngày', '2026-12-09', '2026-12-09', 1), t('g2', 'GPS tracking', '2026-12-09', '2026-12-09', 1)] });
  assert.equal(one.description.split('\n')[0], '1. HPG - Kho: GPS tracking, một ngày - 9/12 - 100%');
  assert.equal(lines.map((l) => Number(/(\d+)%$/.exec(l)![1])).reduce((a, b) => a + b, 0), 100);
  const feb = buildKpiDraft({ month: '2027-02', employeeName: 'A', shortNames: [], groups, tasks: [] });
  assert.deepEqual([feb.end, feb.description, feb.name], ['28/02/2027', '', '2027_02_PM_ A']);
});

test('Bookmarklet KPI: URL javascript:, chứa trang popup và là JS hợp lệ', () => {
  const url = getflyKpiBookmarklet('https://project.vnlab.id.vn', 'https://acs.getflycrm.com');
  assert.ok(url.startsWith('javascript:'));
  const src = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(src.includes(JSON.stringify(GETFLY_KPI_PATH)));
  assert.ok(!/__(PROJECT|GETFLY|PATH)__/.test(src));
  assert.ok(!/\balert\(|\bconfirm\(/.test(src));
  for (const s of ['#/kpi/list', '#/kpi/create/list', 'Thiết lập chỉ tiêu KPI', 'Hoàn tất thiết lập', 'Next Month', '_valueTracker', '__reactProps$', 'onValueChange', 'Nhập tay trọng số rồi bấm Tiếp theo']) assert.ok(src.includes(s), s);
  assert.doesNotThrow(() => new Function(src));
});
