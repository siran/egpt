// Inspect WA Web state to verify the titlesEqual fix and title scraping.
// Read-only — no Input.* events, no message sends.
import { peekTab, listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const waTab = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!waTab) { console.error('no WA Web tab'); process.exit(1); }
console.log('WA tab:', waTab.id, waTab.title);

const probe = `({id:'p',text: JSON.stringify((() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);
  const stripBadge = (s) => firstLine(s).replace(/\\s*\\([^()]*\\)\\s*$/, '').trim();
  const looksLikeJid = (v) => typeof v === 'string'
    && /^[\\w\\d-]+@[\\w.]+$/.test(v)
    && !/^[A-F0-9]{16,}$/i.test(v);
  const headerOf = () => {
    const h =
      document.querySelector('header [data-testid="conversation-info-header"]') ||
      document.querySelector('header span[dir="auto"][title]') ||
      document.querySelector('header span[dir="auto"]');
    return firstLine(h?.getAttribute?.('title') || h?.innerText || '');
  };
  const panel =
    document.querySelector('[aria-label="Chat list" i]') ||
    document.querySelector('[role="grid"][aria-label*="Chat" i]');
  const rows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]') : [];
  const list = [];
  for (const row of rows) {
    const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
    const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    if (!name) continue;
    let jid = null;
    const idCandidates = [...row.querySelectorAll('[data-id], [data-jid]'), row.parentElement].filter(Boolean);
    for (const el of idCandidates) {
      const v = el.getAttribute?.('data-id') || el.getAttribute?.('data-jid');
      if (looksLikeJid(v)) { jid = v; break; }
    }
    const unread = !!(row.querySelector('span[aria-label*="unread" i]') || row.querySelector('[data-icon="unread-count"]'));
    list.push({ name, jid, unread, stripped: stripBadge(name) });
    if (list.length >= 12) break;
  }
  const activeTitle = headerOf();
  const composer = document.querySelector('div[contenteditable="true"][data-tab="10"]')
                || document.querySelector('footer div[contenteditable="true"]')
                || document.querySelector('div[contenteditable="true"][role="textbox"]');
  return {
    activeTitle,
    activeStripped: stripBadge(activeTitle),
    panelFound: !!panel,
    rowsScraped: list.length,
    composerPresent: !!composer,
    composerHasFocus: composer ? document.activeElement === composer : false,
    composerLen: composer ? (composer.innerText || '').length : 0,
    list,
  };
})(), null, 2)})`;

const text = await peekTab(waTab.id, probe);
console.log(text);
