// The chatbox widget (served by http.mjs as widget.js, called with its client's config).
function egptChat(C, base) {
  base = base || document.currentScript.src.replace(/widget\.js(?:[?#].*)?$/, '');
  if (!document.body) { document.addEventListener('DOMContentLoaded', function () { egptChat(C, base); }); return; }
  var S = C.strings;
  var KEY = 'egpt-chat:' + C.client;
  var token = null, es = null, since = 0, els = {};
  var store = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  try { token = localStorage.getItem(KEY); } catch (e) { token = null; }

  var css = '.egc{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:15px/1.4 system-ui,sans-serif}'
    + '.egc-bubble{width:56px;height:56px;border-radius:50%;border:0;background:#1f6feb;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}'
    + '.egc-panel{position:absolute;right:0;bottom:68px;width:360px;height:520px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden}'
    + '.egc-panel[hidden]{display:none}'
    + '.egc-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1f6feb;color:#fff;font-weight:600}'
    + '.egc-x{background:none;border:0;color:#fff;font-size:22px;cursor:pointer}'
    + '.egc-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f8fa}'
    + '.egc-msg{max-width:85%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}'
    + '.egc-visitor{align-self:flex-end;background:#1f6feb;color:#fff}'
    + '.egc-being{align-self:flex-start;background:#fff;border:1px solid #d0d7de}'
    + '.egc-live{opacity:.75}'
    + '.egc-being a{color:#0969da}'
    + '.egc-form{display:flex;gap:6px;padding:8px;border-top:1px solid #d0d7de}'
    + '.egc-form textarea{flex:1;resize:none;border:1px solid #d0d7de;border-radius:8px;padding:8px;font:inherit}'
    + '.egc-form button{border:0;border-radius:8px;background:#1f6feb;color:#fff;padding:0 14px;cursor:pointer}'
    + '.egc-err{padding:6px 12px;color:#b42318;font-size:13px}'
    + '@media (max-width:480px){.egc-panel{position:fixed;inset:0;width:auto;height:auto;max-height:none;border-radius:0}'
    + '.egc-panel:not([hidden])~.egc-bubble{display:none}.egc-form textarea{font-size:16px}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'egc';
  root.innerHTML = '<div class="egc-panel" role="dialog" hidden><div class="egc-head"><span></span><button type="button" class="egc-x">×</button></div>'
    + '<div class="egc-log" aria-live="polite"></div><div class="egc-err" hidden></div>'
    + '<form class="egc-form"><textarea rows="2"></textarea><button type="submit"></button></form></div>'
    + '<button type="button" class="egc-bubble">💬</button>';
  var q = function (sel) { return root.querySelector(sel); };
  var panel = q('.egc-panel'), log = q('.egc-log'), err = q('.egc-err'), form = q('.egc-form'), input = q('textarea');
  q('.egc-head span').textContent = S.title;
  q('.egc-x').setAttribute('aria-label', S.close);
  q('.egc-bubble').setAttribute('aria-label', S.open);
  q('.egc-form button').textContent = S.send;
  input.placeholder = S.placeholder;
  input.maxLength = C.maxChars;
  document.body.appendChild(root);

  var fill = function (el, text) {
    el.textContent = '';
    String(text).split(/(https?:\/\/[^\s<>"]+)/).forEach(function (part, i) {
      if (i % 2) { var a = document.createElement('a'); a.href = part; a.target = '_blank'; a.rel = 'noopener'; a.textContent = part; el.appendChild(a); }
      else if (part) el.appendChild(document.createTextNode(part));
    });
  };
  var show = function (m) {
    if (m.seq > since) since = m.seq;
    var el = els[m.id];
    if (m.deleted) { if (el) { el.remove(); delete els[m.id]; } return; }
    if (!el) { el = els[m.id] = document.createElement('div'); log.appendChild(el); }
    el.className = 'egc-msg egc-' + (m.from === 'visitor' ? 'visitor' : 'being') + (m.done ? '' : ' egc-live');
    fill(el, m.text);
    log.scrollTop = log.scrollHeight;
  };
  var listen = function () {
    if (es) es.close();
    es = null;
    if (!token || !window.EventSource) return;
    es = new EventSource(base + 'events?session=' + encodeURIComponent(token) + '&since=' + since);
    es.onmessage = function (e) { show(JSON.parse(e.data)); };
  };
  var load = function () {
    if (!token) return;
    fetch(base + 'messages?session=' + encodeURIComponent(token) + '&since=' + since).then(function (r) {
      if (r.status === 404) { token = null; store(KEY, null); return null; }
      return r.ok ? r.json() : null;
    }).then(function (j) { if (j) { j.messages.forEach(show); listen(); } }).catch(function () { /* offline: the next send retries */ });
  };
  var fail = function (status) {
    err.textContent = status === 413 ? S.too_long : status === 429 ? S.too_many : S.error;
    err.hidden = false;
  };
  var send = function () {
    var text = input.value;
    if (!text.trim()) return;
    err.hidden = true;
    input.value = '';
    fetch(base + 'messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: token, text: text }) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (j) {
        var renewed = j.session !== token;
        if (renewed) { token = j.session; store(KEY, token); }
        show(j.message);
        if (renewed || !es) listen();
      })
      .catch(function (status) { input.value = text; fail(status); });
  };
  var open = function (on, focus) {
    panel.hidden = !on;
    store(KEY + ':open', on ? '1' : null);
    if (on) { load(); if (focus) input.focus(); } else if (es) { es.close(); es = null; }
  };
  q('.egc-bubble').onclick = function () { open(panel.hidden, true); };
  q('.egc-x').onclick = function () { open(false); };
  form.onsubmit = function (e) { e.preventDefault(); send(); };
  input.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  try { if (localStorage.getItem(KEY + ':open')) open(true); } catch (e) { /* private mode */ }
}
