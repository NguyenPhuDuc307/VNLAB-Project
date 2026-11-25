// Bookmarklet "✓ Hoàn thành Getfly": API v3 của Getfly không đổi được trạng thái việc, nên người dùng bấm nút dấu trang
// này khi đang mở tab Getfly đã đăng nhập; nó tự bấm "Hoàn thành" + chấm 5 sao trên giao diện web Getfly (Vue SPA).
//
// Luồng (không lưu thông tin đăng nhập Getfly, không cần CORS):
//   1. Bookmarklet (trên Getfly) mở cửa sổ <Project>/getfly-hoan-thanh — cùng origin với Project nên dùng phiên đăng nhập sẵn có.
//   2. Cửa sổ đó lấy GET /api/getfly/pending-done rồi postMessage({ type: 'vnlab-getfly-done-list', items }) về opener (chỉ origin Getfly).
//   3. Bookmarklet hỏi xác nhận bằng khung nổi (không dùng alert/confirm), rồi làm lần lượt từng việc:
//        location.hash = '#/tasks/?task_id=<id>' -> chờ .modal-content có tên việc -> nút ở .modal-footer "Đang tiến hành"
//        -> bấm, chọn mục "Hoàn thành" (Getfly gọi v5/projects/change_task_step) -> chờ nút đổi thành "Hoàn thành"
//        -> bấm sao thứ 5 (.fa-star, sao đã tô có class color-orange). Nút vốn là "Hoàn thành" thì bỏ qua (không chấm sao).
//      Sau mỗi việc gửi { type: 'vnlab-getfly-done-result', getflyId, ok, already, error } cho cửa sổ Project,
//      cửa sổ đó gọi POST /api/getfly/mark-done để ghi nhận. Cuối cùng gửi { type: 'vnlab-getfly-done-finished' }.
// Cách bấm đã kiểm chứng tay trên acs.getflycrm.com ngày 25/11/2026 (21 việc). Getfly đổi giao diện thì sửa các selector dưới đây.

export const GETFLY_DONE_PATH = '/getfly-hoan-thanh';
export const MSG_LIST = 'vnlab-getfly-done-list';
export const MSG_RESULT = 'vnlab-getfly-done-result';
export const MSG_FINISHED = 'vnlab-getfly-done-finished';

/** Mã nguồn bookmarklet (dễ đọc). __PROJECT__ / __GETFLY__ được thay bằng origin thật trong getflyBookmarklet(). */
export const BOOKMARKLET_SOURCE = String.raw`(function () {
  var P = __PROJECT__, G = __GETFLY__, PATH = __PATH__;
  var BOX = 'vnlab-getfly-done';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var arr = function (list) { return Array.prototype.slice.call(list); };

  /* Khung nổi góc phải dưới thay cho alert / confirm. */
  function show(html, buttons) {
    var d = document.getElementById(BOX);
    if (!d) {
      d = document.createElement('div');
      d.id = BOX;
      d.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:#fff;color:#1d1d1f;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:14px 16px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:left';
      document.body.appendChild(d);
    }
    d.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:6px">VNLab · Hoàn thành Getfly</div>' + html;
    if (buttons && buttons.length) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
      buttons.forEach(function (b) {
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = b[0];
        x.style.cssText = 'border:0;border-radius:999px;padding:7px 16px;font:inherit;font-weight:600;cursor:pointer;' + (b[2] ? 'background:#0a7cff;color:#fff' : 'background:#ececf0;color:#333');
        x.onclick = b[1];
        row.appendChild(x);
      });
      d.appendChild(row);
    }
  }
  function hide() { var d = document.getElementById(BOX); if (d) d.remove(); window.__vnlabGetflyDone = false; }

  if (location.origin !== G) { show('<p>Hãy bấm nút này khi đang mở Getfly (' + esc(G) + ').</p>', [['Đóng', hide]]); return; }
  if (window.__vnlabGetflyDone) return;
  window.__vnlabGetflyDone = true;

  async function poll(fn, ms) {
    var end = Date.now() + (ms || 15000);
    while (Date.now() < end) {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  var pop = window.open(P + PATH, 'vnlab-getfly-done', 'width=480,height=680');
  if (!pop) { show('<p>Trình duyệt đã chặn cửa sổ bật lên. Cho phép cửa sổ bật lên ở Getfly rồi bấm lại.</p>', [['Đóng', hide]]); return; }
  var items = null, cancelled = false, running = false;
  var send = function (msg) { try { pop.postMessage(msg, P); } catch (e) { /* cửa sổ đã đóng */ } };
  function stop() {
    cancelled = true;
    window.removeEventListener('message', onMsg);
    clearTimeout(timer);
    if (!running) { send({ type: 'vnlab-getfly-done-finished', cancelled: true }); hide(); }
  }
  function onMsg(e) {
    if (e.origin !== P || e.source !== pop || !e.data || e.data.type !== 'vnlab-getfly-done-list' || items) return;
    items = (e.data.items || []).filter(function (it) { return it && it.getflyId; });
    clearTimeout(timer);
    window.removeEventListener('message', onMsg);
    ask();
  }
  window.addEventListener('message', onMsg);
  var timer = setTimeout(function () {
    if (items) return;
    window.removeEventListener('message', onMsg);
    show('<p>Quá 60 giây chưa nhận được danh sách từ VNLab Project. Đăng nhập ở cửa sổ vừa mở rồi bấm lại nút này.</p>', [['Đóng', hide]]);
  }, 60000);
  show('<p>Đang lấy danh sách việc đã xong từ VNLab Project… Nếu cửa sổ mới hỏi đăng nhập, hãy đăng nhập.</p>', [['Huỷ', stop]]);

  function ask() {
    if (!items.length) {
      send({ type: 'vnlab-getfly-done-finished' });
      show('<p>Không có việc nào cần đánh dấu — mọi việc xong 100% đã được đánh dấu trên Getfly.</p>', [['Đóng', hide]]);
      return;
    }
    var preview = items.slice(0, 25).map(function (it) {
      return '<li>' + esc(it.name) + ' <span style="color:#888">· ' + esc(it.getflyCode || it.getflyId) + '</span></li>';
    }).join('') + (items.length > 25 ? '<li style="color:#888">… và ' + (items.length - 25) + ' việc nữa</li>' : '');
    show('<p>Sẽ đánh dấu <b>' + items.length + ' việc</b> hoàn thành + 5 sao trên Getfly:</p><ul style="margin:6px 0 0 18px;padding:0">' + preview + '</ul>',
      [['Huỷ', stop], ['Bắt đầu', run, true]]);
  }

  function findModal(it) {
    var name = norm(it.name);
    return arr(document.querySelectorAll('.modal-content')).filter(function (m) {
      return norm(m.textContent.slice(0, 300)).indexOf(name) >= 0;
    }).pop() || null;
  }
  function statusButton(modal) {
    return arr(modal.querySelectorAll('.modal-footer button')).filter(function (b) {
      var t = b.textContent.trim();
      return t === 'Đang tiến hành' || t === 'Hoàn thành';
    })[0] || null;
  }
  function closeModal() {
    var m = arr(document.querySelectorAll('.modal-content')).pop();
    var x = m && (m.querySelector('.modal-header .close, [data-dismiss="modal"], .modal-header button[aria-label="Close"], button.close'));
    if (x) x.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  }

  async function markOne(it) {
    location.hash = '#/tasks/?task_id=' + it.getflyId;
    var modal = await poll(function () { return findModal(it); }, 15000);
    if (!modal) return { ok: false, error: 'Không mở được việc trên Getfly (không thấy hộp việc có tên này)' };
    var btn = await poll(function () { return statusButton(modal); }, 8000);
    if (!btn) return { ok: false, error: 'Không thấy nút trạng thái "Đang tiến hành" / "Hoàn thành"' };
    if (btn.textContent.trim() === 'Hoàn thành') return { ok: true, already: true };
    btn.click();
    await sleep(400);
    var entry = await poll(function () {
      var c = arr(modal.querySelectorAll('.modal-footer a, .modal-footer li, .modal-footer .dropdown-item')).filter(function (a) { return a.textContent.trim() === 'Hoàn thành'; });
      /* li bọc a: bấm phần tử sâu nhất. */
      return c.filter(function (a) { return !c.some(function (b) { return b !== a && a.contains(b); }); })[0];
    }, 3000);
    if (!entry) return { ok: false, error: 'Không thấy mục "Hoàn thành" trong danh sách trạng thái' };
    entry.click();
    var done = await poll(function () {
      var m = document.contains(modal) ? modal : findModal(it);
      var b = m && statusButton(m);
      return b && b.textContent.trim() === 'Hoàn thành' ? m : null;
    }, 10000);
    if (!done) return { ok: false, error: 'Getfly chưa chuyển sang "Hoàn thành" sau 10 giây' };
    modal = done;
    var stars = await poll(function () {
      var m = document.contains(modal) ? modal : findModal(it);
      var s = m ? m.querySelectorAll('.modal-footer .fa-star') : [];
      return s.length >= 5 ? s : null;
    }, 5000);
    if (!stars) return { ok: true, error: 'Đã hoàn thành nhưng không thấy ô chấm sao' };
    stars[4].click();
    var rated = await poll(function () {
      var m = document.contains(modal) ? modal : findModal(it);
      var s = m ? arr(m.querySelectorAll('.modal-footer .fa-star')) : [];
      return s.length >= 5 && s.slice(0, 5).every(function (x) { return x.classList.contains('color-orange'); });
    }, 5000);
    return rated ? { ok: true } : { ok: true, error: 'Đã hoàn thành nhưng chưa chấm được 5 sao' };
  }

  async function run() {
    if (running) return;
    running = true;
    var ok = 0, already = 0, failed = [], notes = [];
    for (var i = 0; i < items.length && !cancelled; i++) {
      var it = items[i];
      show('<p>Đang làm việc ' + (i + 1) + '/' + items.length + ': <b>' + esc(it.name) + '</b></p><p style="color:#888">Xong ' + ok + ' · đã hoàn thành sẵn ' + already + ' · lỗi ' + failed.length + '</p>', [['Dừng', function () { cancelled = true; }]]);
      var r;
      try { r = await markOne(it); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (r.ok && r.already) already++; else if (r.ok) ok++; else failed.push(it.name + ': ' + r.error);
      if (r.ok && r.error) notes.push(it.name + ': ' + r.error);
      send({ type: 'vnlab-getfly-done-result', getflyId: it.getflyId, ok: !!r.ok, already: !!r.already, error: r.error || null });
      closeModal();
      await poll(function () { return !findModal(it); }, 3000);
    }
    closeModal();
    location.hash = '#/tasks';
    send({ type: 'vnlab-getfly-done-finished', cancelled: cancelled });
    var lost = pop.closed ? '<p style="color:#c00">Cửa sổ VNLab Project đã bị đóng nên chưa ghi nhận hết. Lần sau bấm lại, việc đã xong sẽ được bỏ qua.</p>' : '';
    var list = failed.concat(notes).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    show('<p>' + (cancelled ? 'Đã dừng. ' : 'Xong. ') + 'Đánh dấu ' + ok + ' việc, ' + already + ' việc đã hoàn thành sẵn, ' + failed.length + ' lỗi.</p>' + lost + (list ? '<ul style="margin:6px 0 0 18px;padding:0;color:#a00">' + list + '</ul>' : ''), [['Đóng', hide]]);
    running = false;
    window.__vnlabGetflyDone = false;
  }
})();`;

/** Thu gọn nhẹ: bỏ thụt đầu dòng và dòng trống (mã nguồn dùng dấu ; đầy đủ, chú thích chỉ dạng khối). */
const minify = (src: string) => src.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

/** URL `javascript:` để kéo lên thanh dấu trang. projectOrigin = origin của VNLab Project, getflyOrigin = origin trang web Getfly. */
export function getflyBookmarklet(projectOrigin: string, getflyOrigin: string) {
  const src = BOOKMARKLET_SOURCE
    .replace('__PROJECT__', JSON.stringify(projectOrigin))
    .replace('__GETFLY__', JSON.stringify(getflyOrigin))
    .replace('__PATH__', JSON.stringify(GETFLY_DONE_PATH));
  return `javascript:${encodeURIComponent(minify(src))}`;
}
