// The chatbox loader (served by http.mjs as widget.js, called with its client's config): a bubble and a
// panel holding Deep Chat (C.deepChat), wired to this limb. The server's log is the one source of
// truth: on open the panel shows GET messages, then follows GET events; Deep Chat keeps no browser copy.
function egptChat(C, base) {
  base = base || document.currentScript.src.replace(/widget\.js(?:[?#].*)?$/, '');
  if (!document.body) { document.addEventListener('DOMContentLoaded', function () { egptChat(C, base); }); return; }
  var S = C.strings;
  var KEY = 'egpt-chat:' + C.client;
  var token = null, chat = null, sig = null, es = null, since = 0, starting = false, wantFocus = false, inflight = 0, held = [];
  var at = {};   // message id → { i: its index in chat.getMessages(), text }
  var store = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  try { token = localStorage.getItem(KEY); } catch (e) { token = null; }

  var css = '.egc{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:15px/1.4 system-ui,sans-serif}'
    + '.egc-bubble{width:56px;height:56px;border-radius:50%;border:0;background:#1f6feb;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}'
    + '.egc-panel{position:absolute;right:0;bottom:68px;width:360px;height:520px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#f6f8fa;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden}'
    + '.egc-panel[hidden]{display:none}'
    + '.egc-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1f6feb;color:#fff;font-weight:600}'
    + '.egc-head span{flex:1}'
    + '.egc-x,.egc-end{background:none;border:0;color:#fff;font-size:22px;cursor:pointer}'
    + '.egc-end{font-size:19px;margin-right:6px}'
    + '.egc-ask{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#fff8c5;font-size:13px}'
    + '.egc-ask[hidden]{display:none}'
    + '.egc-ask span{flex:1}'
    + '.egc-ask button{border:1px solid #d0d7de;border-radius:6px;padding:4px 10px;background:#fff;cursor:pointer;font:inherit}'
    + '.egc-ask .egc-yes{background:#b42318;border-color:#b42318;color:#fff}'
    + '.egc-body{flex:1;min-height:0}'
    + '.egc-err{padding:12px;color:#b42318;font-size:13px}'
    + '@media (max-width:480px){.egc-panel{position:fixed;inset:0;width:auto;height:auto;max-height:none;border-radius:0}'
    + '.egc-panel:not([hidden])~.egc-bubble{display:none}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'egc';
  root.innerHTML = '<div class="egc-panel" role="dialog" hidden><div class="egc-head"><span></span><button type="button" class="egc-end">↺</button><button type="button" class="egc-x">×</button></div>'
    + '<div class="egc-ask" hidden><span></span><button type="button" class="egc-yes"></button><button type="button" class="egc-no"></button></div>'
    + '<div class="egc-err" hidden></div><div class="egc-body"></div></div>'
    + '<button type="button" class="egc-bubble">💬</button>';
  var q = function (sel) { return root.querySelector(sel); };
  var panel = q('.egc-panel'), err = q('.egc-err'), body = q('.egc-body'), ask = q('.egc-ask');
  q('.egc-head span').textContent = S.title;
  q('.egc-end').title = S.end;
  q('.egc-end').setAttribute('aria-label', S.end);
  q('.egc-ask span').textContent = S.end_confirm;
  q('.egc-yes').textContent = S.end_yes;
  q('.egc-no').textContent = S.cancel;
  q('.egc-x').setAttribute('aria-label', S.close);
  q('.egc-bubble').setAttribute('aria-label', S.open);
  document.body.appendChild(root);

  // Deep Chat's markdown: links only to http(s)/mailto/tel, and bare URLs become links (it has no linkify).
  var links = function (md) {
    md.core.ruler.push('egpt_links', function (state) {
      state.tokens.forEach(function (b) {
        if (b.type !== 'inline') return;
        var out = [], depth = 0;
        b.children.forEach(function (t) {
          if (t.type === 'link_open') { depth++; if (!/^(https?:|mailto:|tel:)/i.test(t.href)) t.href = '#'; }
          if (t.type === 'link_close') depth--;
          if (t.type !== 'text' || depth) return out.push(t);
          t.content.split(/(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)'"])/).forEach(function (part, k) {
            if (k % 2) out.push({ type: 'link_open', href: part, level: t.level }, { type: 'text', content: part, level: t.level + 1 }, { type: 'link_close', level: t.level });
            else if (part) out.push({ type: 'text', content: part, level: t.level });
          });
        });
        b.children = out;
      });
    });
  };
  (window.remarkable_plugins = window.remarkable_plugins || []).push({ plugin: links });

  var lib = null;
  var loadLib = function () {
    return lib = lib || new Promise(function (ok, no) {
      if (window.customElements.get('deep-chat')) return ok();
      var s = document.createElement('script');
      s.type = 'module';
      s.src = C.deepChat.url;
      s.integrity = C.deepChat.integrity;
      s.crossOrigin = 'anonymous';
      s.onload = ok;
      s.onerror = function () { lib = null; s.remove(); no(); };
      document.head.appendChild(s);
    });
  };
  var fetchLog = function () {
    if (!token) return Promise.resolve([]);
    return fetch(base + 'messages?session=' + encodeURIComponent(token)).then(function (r) {
      if (r.status === 404) { token = null; store(KEY, null); return { seq: 0, messages: [] }; }
      return r.ok ? r.json() : Promise.reject(r.status);
    }).then(function (j) { since = j.seq; return j.messages; });
  };

  var role = function (m) { return m.from === 'visitor' ? 'user' : 'ai'; };
  // A frame: a new message is added, a known one edited or removed in place. The visitor's own lines
  // are already on screen (Deep Chat put them there), so while a POST is out their frames wait for its id.
  var show = function (m) {
    if (m.seq > since) since = m.seq;
    var k = at[m.id];
    if (k) {
      if (!m.text || m.text === k.text) return;
      k.text = m.text;
      chat.updateMessage({ text: m.text }, k.i);
      return;
    }
    if (!m.text) return;
    if (m.from === 'visitor' && inflight) { held.push(m); return; }
    chat.addMessage({ role: role(m), text: m.text });
    at[m.id] = { i: chat.getMessages().length - 1, text: m.text };
  };
  var listen = function () {
    if (es) es.close();
    es = null;
    if (!token || !chat || panel.hidden || !window.EventSource) return;
    es = new EventSource(base + 'events?session=' + encodeURIComponent(token) + '&since=' + since);
    es.onmessage = function (e) { show(JSON.parse(e.data)); };
  };
  var BACKOFF = [1000, 3000, 9000];
  var newId = function () {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  };
  // No answer or a 5xx: the same line again, with the same id (the server keeps one), after BACKOFF[n].
  var postLine = function (text, id, n) {
    return fetch(base + 'messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: token, text: text, id: id }) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }, function () { return Promise.reject(0); })
      .catch(function (status) {
        if ((status && status < 500) || n >= BACKOFF.length) return Promise.reject(status);
        return new Promise(function (ok) { setTimeout(ok, BACKOFF[n]); }).then(function () { return postLine(text, id, n + 1); });
      });
  };
  var opening = null;   // a new session's first POST: lines sent meanwhile wait for its token
  var send = function (req) {
    var text = req.messages[req.messages.length - 1].text;
    var i = chat.getMessages().length - 1;
    var id = newId();
    var go = function () { return postLine(text, id, 0); };
    inflight++;
    var done = (opening ? opening.then(go) : go())
      .then(function (j) {
        at[j.message.id] = { i: i, text: j.message.text };
        if (j.message.seq > since) since = j.message.seq;
        var renewed = j.session !== token;
        if (renewed) { token = j.session; store(KEY, token); }
        if (renewed || !es) listen();
      })
      .catch(function (status) { sig.onResponse({ error: status === 413 ? S.too_long : status === 429 ? S.too_many : S.error }); })
      .then(function () { if (!--inflight) held.splice(0).forEach(show); });
    if (!token && !opening) opening = done.then(function () { opening = null; });
  };

  // Every property is set before the element renders: a later set re-renders Deep Chat from scratch.
  var build = function (messages) {
    var hist = [];
    messages.forEach(function (m) {
      if (!m.text) return;
      at[m.id] = { i: hist.length, text: m.text };
      hist.push({ role: role(m), text: m.text });
    });
    chat = document.createElement('deep-chat');
    chat.history = hist;
    if (S.intro) chat.introMessage = { text: S.intro };
    // websocket mode: the handler runs once; input stays open while replies arrive at any time.
    chat.connect = { websocket: true, handler: function (_, signals) {
      sig = signals;
      signals.newUserMessage.listener = send;
      signals.onOpen();
      listen();
      if (wantFocus) chat.focusInput();
    } };
    // ⏳ from a sent line until the next message shows (Deep Chat drops it then, or at an error).
    chat.displayLoadingBubble = true;
    chat.requestBodyLimits = { maxMessages: 1 };
    chat.errorMessages = { displayServiceErrorMessages: true };
    chat.textInput = { characterLimit: C.maxChars, placeholder: { text: S.placeholder }, styles: { text: { fontSize: '16px' } } };
    chat.submitButtonStyles = { tooltip: { text: S.send } };
    // A fontFamily of our own also keeps Deep Chat from adding a Google Fonts link to the page.
    chat.chatStyle = { display: 'block', width: '100%', height: '100%', border: 'none', backgroundColor: '#f6f8fa', fontFamily: 'system-ui, sans-serif', fontSize: '15px' };
    chat.messageStyles = { default: {
      shared: { bubble: { maxWidth: '85%' } },
      user: { bubble: { backgroundColor: '#1f6feb', color: '#fff' } },
      ai: { bubble: { backgroundColor: '#fff', color: '#111', border: '1px solid #d0d7de' } },
    }, loading: { message: { html: '⏳' } } };
    body.appendChild(chat);
  };

  var open = function (on, focus) {
    panel.hidden = !on;
    store(KEY + ':open', on ? '1' : null);
    if (!on) { if (es) { es.close(); es = null; } return; }
    if (chat) { listen(); chat.scrollToBottom(); if (focus) chat.focusInput(); return; }
    if (starting) return;
    starting = true;
    wantFocus = !!focus;
    err.hidden = true;
    Promise.all([loadLib(), fetchLog()]).then(function (r) { build(r[1]); }, function () {
      starting = false;
      err.textContent = S.unavailable;
      err.hidden = false;
    });
  };
  // End: the same token (conversation, team topic) gets a fresh thread; the panel starts over.
  var end = function () {
    ask.hidden = true;
    fetch(base + 'end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: token }) })
      .then(function (r) {
        if (r.status === 404) { token = null; store(KEY, null); listen(); }
        else if (!r.ok) return Promise.reject(r.status);
        at = {};
        err.hidden = true;
        chat.clearMessages();
      })
      .catch(function () { err.textContent = S.error; err.hidden = false; });
  };
  q('.egc-end').onclick = function () { ask.hidden = !(ask.hidden && token && chat && !inflight); };
  q('.egc-no').onclick = function () { ask.hidden = true; };
  q('.egc-yes').onclick = end;
  q('.egc-bubble').onclick = function () { open(panel.hidden, true); };
  q('.egc-x').onclick = function () { open(false); };
  try { if (localStorage.getItem(KEY + ':open')) open(true); } catch (e) { /* private mode */ }
}
