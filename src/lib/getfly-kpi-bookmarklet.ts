// Bookmarklet "✓ KPI": tạo KPI tháng của chính mình trên Getfly (web Vue SPA) theo mẫu KPI tháng 11/2026.
// Luồng giống "✓ Getfly" (getfly-bookmarklet.ts): mở cửa sổ <Project>/getfly-kpi -> người dùng xem / sửa bản nháp
// (GET /api/getfly/kpi-draft) -> bấm Gửi -> postMessage({ type: 'vnlab-getfly-kpi-draft', draft }) về tab Getfly
// -> khung nổi xác nhận "Tạo" / "Huỷ" -> tự bấm trên Getfly:
//   #/kpi/list (dừng nếu đã có KPI cùng tên) -> #/kpi/create/list: "Tên KPI (*)" -> "Tiếp theo"
//   -> "+ Thêm chỉ tiêu" ×3 (modal "Thiết lập chỉ tiêu KPI", radio thứ 2 "Chỉ tiêu tự nhập", tên, mô tả, "Thêm mới")
//   -> Giá trị / Đơn vị / Trọng số từng dòng (kiểm tổng "100%") -> "Tiếp theo"
//   -> ngày hiệu lực (vue-datepicker: nút aria-label "Choose …, ngày D tháng M năm Y", "Next Month" / "Previous Month")
//   -> "+" cạnh "Danh sách nhân viên áp dụng (*)" -> modal "Người liên quan": gõ tên, tích, "Thêm mới", đóng -> "Tiếp theo"
//   -> "Hoàn tất thiết lập" -> kiểm lại ở #/kpi/list.
// Đã làm tay thành công 25/11/2026 (KPI 2026_12). Ô số của Getfly không nhận gán value trực tiếp: nhập bằng
// execCommand('insertText') (sự kiện input thật), không được thì $emit('input') qua instance Vue.

export const GETFLY_KPI_PATH = '/getfly-kpi';
export const MSG_KPI_DRAFT = 'vnlab-getfly-kpi-draft';
export const MSG_KPI_STEP = 'vnlab-getfly-kpi-step';
export const MSG_KPI_RESULT = 'vnlab-getfly-kpi-result';

export const KPI_BOOKMARKLET_SOURCE = String.raw`(function () {
  var P = __PROJECT__, G = __GETFLY__, PATH = __PATH__;
  var BOX = 'vnlab-getfly-kpi';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var arr = function (list) { return Array.prototype.slice.call(list); };
  var vis = function (el) { return !!el && el.isConnected && el.getClientRects().length > 0; };

  function show(html, buttons) {
    var d = document.getElementById(BOX);
    if (!d) {
      d = document.createElement('div');
      d.id = BOX;
      d.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:340px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:#fff;color:#1d1d1f;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:12px 14px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:left';
      document.body.appendChild(d);
    }
    d.innerHTML = '<div style="font-weight:700;margin-bottom:4px">✓ KPI</div>' + html;
    if (buttons && buttons.length) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px';
      buttons.forEach(function (b) {
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = b[0];
        x.style.cssText = 'border:0;border-radius:999px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;' + (b[2] ? 'background:#0a7cff;color:#fff' : 'background:#ececf0;color:#333');
        x.onclick = b[1];
        row.appendChild(x);
      });
      d.appendChild(row);
    }
  }
  function hide() { var d = document.getElementById(BOX); if (d) d.remove(); window.__vnlabGetflyKpi = false; }

  if (location.origin !== G) { show('Chỉ chạy trên Getfly (' + esc(G) + ').', [['Đóng', hide]]); return; }
  if (window.__vnlabGetflyKpi) return;
  window.__vnlabGetflyKpi = true;

  async function poll(fn, ms) {
    var end = Date.now() + (ms || 10000);
    while (Date.now() < end) {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(250);
    }
    return null;
  }
  /* Lỗi có tên bước để báo rõ dừng ở đâu. */
  function Fail(step, msg) { this.step = step; this.message = msg; }
  async function need(step, what, fn, ms) { var v = await poll(fn, ms); if (!v) throw new Fail(step, 'Không thấy ' + what); return v; }

  /* Phần tử hiện có chữ đúng bằng text (bỏ khoảng trắng thừa), ưu tiên phần tử sâu nhất. */
  function byText(text, root, sel) {
    var c = arr((root || document).querySelectorAll(sel || 'button, a, [role=button], label, span, li, div, h1, h2, h3, h4, h5, p, td, th')).filter(function (el) { return vis(el) && norm(el.textContent) === text; });
    return c.filter(function (a) { return !c.some(function (b) { return b !== a && a.contains(b); }); })[0] || null;
  }
  function startsText(text, root) {
    var c = arr((root || document).querySelectorAll('label, span, div, p, td, th, h4, h5, strong, b')).filter(function (el) { return vis(el) && norm(el.textContent).indexOf(text) === 0 && el.textContent.length < text.length + 40; });
    return c.filter(function (a) { return !c.some(function (b) { return b !== a && a.contains(b); }); })[0] || null;
  }
  function btn(text, root) { return byText(text, root, 'button, a, [role=button]') || byText(text, root); }
  var textInputs = function (root) { return arr(root.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=file]), textarea')).filter(vis); };
  /* Ô nhập gần nhãn: đi lên tổ tiên của nhãn tới khi gặp ô nhập. */
  function inputNear(label, pick) {
    for (var el = label; el && el !== document.body; el = el.parentElement) {
      var ins = textInputs(el).filter(function (i) { return i.tagName !== 'TEXTAREA'; });
      if (ins.length) return pick ? pick(ins) : ins[0];
    }
    return null;
  }
  function modalWith(text) {
    var m = arr(document.querySelectorAll('.modal-content, .modal, [role=dialog]')).filter(function (x) { return vis(x) && x.textContent.indexOf(text) >= 0; });
    return m.filter(function (a) { return !m.some(function (b) { return b !== a && a.contains(b); }); }).pop() || null;
  }

  /* Gõ như người: chọn hết rồi insertText (sinh sự kiện input thật); không ăn thì gán + phát sự kiện; cuối cùng $emit Vue. */
  async function typeInto(el, value) {
    value = String(value);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.select) el.select();
    document.execCommand('selectAll', false);
    var ok = document.execCommand('insertText', false, value);
    if (!ok || el.value !== value) {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    el.blur();
    el.dispatchEvent(new Event('blur'));
    await sleep(150);
  }
  function vueEmit(el, value) {
    for (var n = el, k = 0; n && k < 4; n = n.parentElement, k++) {
      var vm = n.__vue__;
      if (vm && vm.$emit) { vm.$emit('input', value); vm.$emit('change', value); return true; }
    }
    return false;
  }

  var pop = window.open(P + PATH, 'vnlab-getfly-kpi', 'width=560,height=760');
  if (!pop) { show('Trình duyệt chặn cửa sổ bật lên — cho phép rồi bấm lại.', [['Đóng', hide]]); return; }
  var send = function (msg) { try { pop.postMessage(msg, P); } catch (e) { /* đã đóng */ } };
  var draft = null;
  function onMsg(e) {
    if (e.origin !== P || e.source !== pop || !e.data || e.data.type !== 'vnlab-getfly-kpi-draft' || draft) return;
    draft = e.data.draft;
    window.removeEventListener('message', onMsg);
    ask();
  }
  window.addEventListener('message', onMsg);
  show('Chọn tháng ở cửa sổ VNLab rồi bấm Gửi.', [['Huỷ', function () { window.removeEventListener('message', onMsg); hide(); }]]);

  function ask() {
    var c = draft.criteria.map(function (x) { return '<li>' + esc(x.name) + ' · ' + x.value + ' · ' + x.weight + '%</li>'; }).join('');
    show('<b>' + esc(draft.name) + '</b><br><span style="color:#888">' + esc(draft.start) + ' – ' + esc(draft.end) + ' · ' + esc(draft.employeeName) + '</span><ul style="margin:6px 0 0 18px;padding:0">' + c + '</ul>',
      [['Huỷ', function () { send({ type: 'vnlab-getfly-kpi-result', ok: false, cancelled: true }); hide(); }], ['Tạo', run, true]]);
  }
  function step(n, label) { show('Bước ' + n + '/6: ' + esc(label) + '…'); send({ type: 'vnlab-getfly-kpi-step', step: n, label: label }); }

  async function pickDate(stepNo, labelText, ddmmyyyy) {
    var p = ddmmyyyy.split('/'), d = Number(p[0]), m = Number(p[1]), y = Number(p[2]);
    var label = await need(stepNo, 'nhãn "' + labelText + '"', function () { return startsText(labelText); });
    var input = await need(stepNo, 'ô ngày "' + labelText + '"', function () { return inputNear(label); });
    if (input.value === ddmmyyyy) return;
    input.scrollIntoView({ block: 'center' });
    input.click();
    input.focus();
    await sleep(300);
    var key = 'ngày ' + d + ' tháng ' + m + ' năm ' + y;
    var day = function () { return arr(document.querySelectorAll('[aria-label]')).filter(function (b) { var a = b.getAttribute('aria-label'); return vis(b) && a.indexOf('Choose') === 0 && a.slice(-key.length) === key; })[0]; };
    var nav = function (dir) { var b = arr(document.querySelectorAll('[aria-label="' + dir + '"]')).filter(vis)[0]; if (b) b.click(); return !!b; };
    for (var k = 0; k < 14 && !day(); k++) { if (!nav('Next Month')) break; await sleep(200); }
    for (var j = 0; j < 30 && !day(); j++) { if (!nav('Previous Month')) break; await sleep(200); }
    var b = day();
    if (b) b.click();
    else await typeInto(input, ddmmyyyy);
    await need(stepNo, 'ngày ' + ddmmyyyy + ' trong ô "' + labelText + '"', function () { return input.value === ddmmyyyy; }, 3000);
    document.body.click();
  }

  async function run() {
    var cur = 0;
    try {
      cur = 1; step(1, 'Kiểm tra danh sách KPI');
      location.hash = '#/kpi/list';
      await need(1, 'trang "Danh Sách KPI"', function () { return document.body.innerText.indexOf('Danh Sách KPI') >= 0 || document.body.innerText.indexOf('Danh sách KPI') >= 0; }, 15000);
      await sleep(1500);
      if (document.body.innerText.indexOf(draft.name) >= 0) throw new Fail(1, 'Đã có KPI "' + draft.name + '"');

      cur = 2; step(2, 'Tên KPI');
      location.hash = '#/kpi/create/list';
      var nameLabel = await need(2, 'ô "Tên KPI (*)"', function () { return startsText('Tên KPI'); }, 15000);
      var nameInput = await need(2, 'ô nhập tên KPI', function () { return inputNear(nameLabel); });
      await typeInto(nameInput, draft.name);
      if (nameInput.value !== draft.name) throw new Fail(2, 'Không nhập được tên KPI');
      (await need(2, 'nút "Tiếp theo"', function () { return btn('Tiếp theo'); })).click();

      cur = 3; step(3, 'Chỉ tiêu');
      for (var i = 0; i < draft.criteria.length; i++) {
        var c = draft.criteria[i];
        var add = await need(3, '"+ Thêm chỉ tiêu"', function () { return btn('+ Thêm chỉ tiêu') || btn('Thêm chỉ tiêu'); }, 10000);
        add.click();
        var modal = await need(3, 'hộp "Thiết lập chỉ tiêu KPI"', function () { return modalWith('Thiết lập chỉ tiêu KPI'); });
        var radios = arr(modal.querySelectorAll('input[type=radio]'));
        if (radios.length < 2) throw new Fail(3, 'Không thấy lựa chọn "Chỉ tiêu tự nhập"');
        radios[1].click();
        await sleep(400);
        var nameIn = await need(3, 'ô tên chỉ tiêu', function () { return textInputs(modal).filter(function (x) { return x.tagName === 'INPUT'; })[0]; });
        await typeInto(nameIn, c.name);
        if (c.description) {
          var ta = await need(3, 'ô mô tả chỉ tiêu', function () { return arr(modal.querySelectorAll('textarea')).filter(vis)[0]; });
          await typeInto(ta, c.description);
        }
        (await need(3, 'nút "Thêm mới"', function () { return btn('Thêm mới', modal); })).click();
        await need(3, 'hộp chỉ tiêu đóng lại', function () { return !vis(modal) && !modalWith('Thiết lập chỉ tiêu KPI'); }, 6000);
      }
      for (var r = 0; r < draft.criteria.length; r++) {
        var cr = draft.criteria[r];
        var row = await need(3, 'dòng chỉ tiêu "' + cr.name + '"', function () {
          var c2 = arr(document.querySelectorAll('tr, li, .row, div')).filter(function (el) {
            return vis(el) && el.textContent.indexOf(cr.name) >= 0 && textInputs(el).filter(function (x) { return x.tagName === 'INPUT'; }).length >= 3;
          });
          return c2.filter(function (a) { return !c2.some(function (b) { return b !== a && a.contains(b); }); })[0];
        });
        var ins = textInputs(row).filter(function (x) { return x.tagName === 'INPUT'; });
        var vals = [cr.value, cr.unit, cr.weight];
        for (var k = 0; k < 3; k++) {
          if (vals[k] === '' || vals[k] == null) continue;
          await typeInto(ins[k], vals[k]);
          if (ins[k].value !== String(vals[k])) vueEmit(ins[k], vals[k]);
        }
      }
      var total = function () {
        return arr(document.querySelectorAll('th, td, div, span, label')).some(function (el) { return vis(el) && /Trọng số/.test(el.textContent) && /\b100\s*%/.test(el.textContent) && el.textContent.length < 80; });
      };
      if (!(await poll(total, 3000))) {
        /* Thử lại bằng $emit Vue cho trọng số. */
        for (var r2 = 0; r2 < draft.criteria.length; r2++) {
          var row2 = arr(document.querySelectorAll('tr, li, .row, div')).filter(function (el) { return vis(el) && el.textContent.indexOf(draft.criteria[r2].name) >= 0 && textInputs(el).length >= 3; }).pop();
          if (row2) vueEmit(textInputs(row2).filter(function (x) { return x.tagName === 'INPUT'; })[2], draft.criteria[r2].weight);
        }
        if (!(await poll(total, 3000))) throw new Fail(3, 'Tổng trọng số chưa thành 100% — nhập tay rồi bấm Tiếp theo');
      }
      (await need(3, 'nút "Tiếp theo"', function () { return btn('Tiếp theo'); })).click();

      cur = 4; step(4, 'Ngày hiệu lực');
      await need(4, 'bước "Áp dụng"', function () { return startsText('Ngày có hiệu lực'); }, 10000);
      await pickDate(4, 'Ngày có hiệu lực', draft.start);
      await pickDate(4, 'Ngày hết hiệu lực', draft.end);

      cur = 5; step(5, 'Nhân viên áp dụng');
      var empLabel = await need(5, 'nhãn "Danh sách nhân viên áp dụng"', function () { return startsText('Danh sách nhân viên áp dụng'); });
      var plus = await need(5, 'nút "+" thêm nhân viên', function () {
        for (var el = empLabel; el && el !== document.body; el = el.parentElement) {
          var b = arr(el.querySelectorAll('button, a, i, span')).filter(function (x) { return vis(x) && (norm(x.textContent) === '+' || /\bfa-plus\b|\bplus\b/.test(x.className && x.className.baseVal !== undefined ? x.className.baseVal : x.className)); })[0];
          if (b) return b.closest('button, a') || b;
        }
        return null;
      });
      plus.click();
      var pm = await need(5, 'hộp "Người liên quan"', function () { return modalWith('Người liên quan'); });
      var search = await need(5, 'ô tìm "Người tham gia"', function () { return textInputs(pm).filter(function (x) { return x.tagName === 'INPUT'; })[0]; });
      search.click();
      search.focus();
      document.execCommand('insertText', false, draft.employeeName);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      var opt = await need(5, 'người dùng "' + draft.employeeName + '" trong danh sách', function () {
        var o = arr(pm.querySelectorAll('li, label, .option, [role=option], .multiselect__option, .vs__dropdown-option, div, span')).filter(function (x) { return vis(x) && norm(x.textContent).indexOf(draft.employeeName) >= 0 && x.textContent.length < draft.employeeName.length + 60; });
        return o.filter(function (a) { return !o.some(function (b) { return b !== a && a.contains(b); }); })[0];
      }, 8000);
      var box = (opt.closest('li, label, [role=option]') || opt.parentElement || opt).querySelector('input[type=checkbox]');
      if (box && !box.checked) box.click(); else if (!box) opt.click();
      await sleep(400);
      (await need(5, 'nút "Thêm mới" trong "Người liên quan"', function () { return btn('Thêm mới', pm); })).click();
      await sleep(600);
      if (vis(pm)) { var x = pm.querySelector('.close, [data-dismiss="modal"], button[aria-label="Close"]'); if (x) x.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); }
      await need(5, 'nhân viên "' + draft.employeeName + '" trong danh sách áp dụng', function () {
        for (var el = empLabel; el && el !== document.body; el = el.parentElement) if (el.querySelector('table, tbody, ul') && el.textContent.indexOf(draft.employeeName) >= 0) return true;
        return false;
      }, 5000);
      (await need(5, 'nút "Tiếp theo"', function () { return btn('Tiếp theo'); })).click();

      cur = 6; step(6, 'Hoàn tất');
      var fin = await need(6, 'nút "Hoàn tất thiết lập"', function () { return btn('Hoàn tất thiết lập'); }, 10000);
      fin.scrollIntoView({ block: 'center' });
      fin.click();
      await sleep(2000);
      location.hash = '#/kpi/list';
      await need(6, 'KPI mới trong danh sách', function () { return document.body.innerText.indexOf(draft.name) >= 0; }, 15000);
      send({ type: 'vnlab-getfly-kpi-result', ok: true, name: draft.name });
      show('Đã tạo <b>' + esc(draft.name) + '</b>.', [['Đóng', hide]]);
    } catch (e) {
      var st = e instanceof Fail ? e.step : cur;
      var msg = (e && e.message) || String(e);
      send({ type: 'vnlab-getfly-kpi-result', ok: false, step: st, error: msg });
      show('<span style="color:#c00">Dừng ở bước ' + st + ': ' + esc(msg) + '</span>', [['Đóng', hide]]);
    }
  }
})();`;

const minify = (src: string) => src.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

/** URL `javascript:` của nút "✓ KPI". */
export function getflyKpiBookmarklet(projectOrigin: string, getflyOrigin: string) {
  const src = KPI_BOOKMARKLET_SOURCE
    .replace('__PROJECT__', JSON.stringify(projectOrigin))
    .replace('__GETFLY__', JSON.stringify(getflyOrigin))
    .replace('__PATH__', JSON.stringify(GETFLY_KPI_PATH));
  return `javascript:${encodeURIComponent(minify(src))}`;
}
