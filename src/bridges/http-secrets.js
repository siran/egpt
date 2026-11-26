// http-secrets.js — the secrets page's script (served by http-secrets.mjs). Everything is drawn with textContent.
import { encryptValue, decryptValue, isEncrypted } from './crypto.js';
const API = '__PREFIX__/api/';
const $ = (id) => document.getElementById(id);
const secret = $('secret'), nameIn = $('name'), valueIn = $('value'), go = $('go'), msg = $('msg');
let loaded = null;    // the name the form was loaded from (a rename sends it as `from`), or null for a new one
let pending = null;   // the locked text the value field shows until the password decrypts it

const say = (text, bad = false) => { msg.textContent = text; msg.className = bad ? 'bad' : ''; };
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '?');
async function api(path, body) {
  const r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 404 && !path.startsWith('secret') ? 'the session expired: ask for a new link' : (j.error ?? `error ${r.status}`));
  return j;
}
function row(list, label, note, onclick) {
  const li = document.createElement('li'), b = document.createElement('button'), s = document.createElement('span');
  b.type = 'button'; b.textContent = label; b.onclick = onclick;
  s.className = 'muted'; s.textContent = ` ${note}`;
  li.append(b, s); list.append(li);
}
function show(stored, historic = false) {
  valueIn.value = stored;
  pending = isEncrypted(stored) ? stored : null;
  go.textContent = pending ? 'Decrypt' : 'Save';
  say(pending ? 'please input password and submit to decrypt' : historic ? 'an old value: Save makes it current again' : '');
}
function showHistory(items) {
  const ul = $('history'); ul.replaceChildren();
  if (!items.length) { ul.textContent = 'none'; return; }
  // Metadata only: an old plain value is not kept (just its fingerprint); an old locked one is, as its ciphertext.
  for (const h of items) row(ul, when(h.replaced_at), `${h.kind} · #${h.fingerprint} · written by ${h.changed_by ?? '?'} ${when(h.changed_at)} · replaced by ${h.replaced_by}`,
    () => (h.value ? show(h.value, true) : say('an old plain value is not kept: only who, when and a fingerprint')));
}
async function open(name) {
  try {
    const { secret: s, history } = await api(`secret?name=${encodeURIComponent(name)}`);
    loaded = s.name; nameIn.value = s.name; secret.value = '';
    show(s.value); showHistory(history);
  } catch (e) { say(e.message, true); }
}
async function refresh() {
  const { who, expires, secrets } = await api('list');
  $('who').textContent = `${who} · this link works until ${new Date(expires).toLocaleTimeString()}`;
  const ul = $('names'); ul.replaceChildren();
  if (!secrets.length) ul.textContent = 'none yet';
  for (const s of secrets) row(ul, s.name, `${s.locked ? 'locked' : 'plain'} · ${s.changed_by ?? '?'} ${when(s.changed_at)}`, () => open(s.name));
}
$('forget').onclick = async () => {
  if (!loaded) return say('open a secret first', true);
  try { const r = await api('purge', { name: loaded }); showHistory(r.history); say(`forgot ${r.forgotten} old entries of ${loaded}`); } catch (err) { say(err.message, true); }
};
$('end').onclick = async () => {
  try { await api('end', {}); say('session ended: the link is closed'); } catch (err) { say(err.message, true); }
};
$('fresh').onclick = () => { loaded = null; pending = null; nameIn.value = secret.value = valueIn.value = ''; go.textContent = 'Save'; $('history').replaceChildren(); say(''); };
$('form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    if (pending) {
      if (!secret.value) return say('please input password and submit to decrypt', true);
      try { show(await decryptValue(secret.value, pending)); say('decrypted here. Edit it, change the name or the password, and Save.'); }
      catch { say('wrong password', true); }
      return;
    }
    const locked = !!secret.value;
    const value = locked ? await encryptValue(secret.value, valueIn.value) : valueIn.value;
    const r = await api('save', { name: nameIn.value.trim(), from: loaded, value });
    loaded = r.secret.name;
    showHistory(r.history);
    say(`${r.action}: ${r.secret.name} (${locked ? 'locked with the password; the node cannot use it' : 'plain; the node can use it'})`);
    await refresh();
  } catch (err) { say(err.message, true); }
};
refresh().then(() => { const n = new URLSearchParams(location.search).get('name'); if (n) return open(n); }).catch((e) => say(e.message, true));
