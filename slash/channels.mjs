// slash/channels.mjs — list the top-N most-active WhatsApp chats with
// short message previews.
//
// /channels             top 10, 3 recent per chat
// /channels <N>         top N, 3 recent per chat
// /channels <N> <M>     top N, M recent per chat (M=0 = no preview)
//
// Data sources, in priority order:
//   1) baileys recent[] ring (per-message author + text)
//   2) WA Web DOM scrape via the CDP extension (fallback when baileys
//      hasn't synced bodies for a chat — verified empirically that
//      ~96% of groups have no recent[] on cold sync)
//
// Side-effect: caches the returned ordered list as
// waChannelsCacheRef.current so subsequent @waN tokens resolve back to
// the same indices the user just saw.

import * as cdp from '../tools/cdp.mjs';

export const meta = {
  cmd: '/channels',
  section: 'ROOM',
  surface: 'both',
  usage: '/channels [N] [messages-per-chat]',
  desc:
    'list the top-N most-active WA chats numbered as @waN, with M recent ' +
    'message lines per chat (default 10 3). shell uses baileys; extension ' +
    'scrapes WA Web. /channels then @wa<N> <body> to send. Pinned chats (📌) ' +
    'float to the top.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef, waChannelsCacheRef
  //   setBusy(bool), setBusyLabel(text|null)
  const { sysOut, waBridgeRef, waChannelsCacheRef, setBusy, setBusyLabel } = ctx;

  // WA Web DOM scrape — fallback for chats baileys has no recent[] for.
  // Same scrape the extension content script uses, lifted into one
  // Runtime.evaluate via CDP.
  async function scrapeWaWebPreviews() {
    const previews = new Map();
    try {
      const tabs = await cdp.listTabs(/web\.whatsapp\.com/);
      const waTab = tabs[0];
      if (!waTab) return previews;
      const scrape = `({id:'wa', text: JSON.stringify((() => {
        const panel = document.querySelector('[aria-label="Chat list" i]') ||
                      document.querySelector('[role="grid"][aria-label*="Chat" i]');
        if (!panel) return [];
        const rows = panel.querySelectorAll('[role="listitem"], div[role="row"]');
        const out = [];
        for (const row of rows) {
          const titleEl = row.querySelector('span[dir="auto"][title]') ||
                          row.querySelector('span[dir="auto"]');
          const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
          if (!name) continue;
          const fullText = row.innerText || '';
          const preview = fullText
            .split('\\n')
            .map(s => s.trim())
            .filter(line => line && line !== name && !/^\\d+ unread/i.test(line))
            .join(' ')
            .slice(0, 200);
          out.push({ name, preview });
          if (out.length >= 50) break;
        }
        return out;
      })())})`;
      const json = await cdp.peekTab(waTab.id, scrape);
      const arr = JSON.parse(json || '[]');
      for (const r of arr) {
        if (r?.name && r.preview) previews.set(r.name, r.preview);
      }
    } catch (_) { /* WA Web tab not reachable; baileys-only output */ }
    return previews;
  }

  const wa = waBridgeRef.current;
  if (!wa) {
    sysOut('!! /channels: whatsapp bridge not running — /whatsapp pair to start');
    return true;
  }
  if (typeof wa.listChats !== 'function') {
    sysOut('!! /channels: this whatsapp bridge build does not expose listChats — update bridges/whatsapp.mjs');
    return true;
  }
  const tokens = arg.trim().split(/\s+/).filter(t => /^\d+$/.test(t)).map(t => parseInt(t, 10));
  const limit           = tokens[0] && tokens[0] > 0 ? tokens[0] : 10;
  const messagesPerChat = tokens[1] != null ? Math.max(0, tokens[1]) : 3;

  // Block input while we prefetch + list + scrape — otherwise the
  // prompt comes back before the list and the user types against
  // stale @waN indices. Spinner label tells them what they're
  // waiting on instead of the default 'thinking…'.
  setBusyLabel('building channel list…');
  setBusy(true);
  try {
    // Prefetch deeper history for top-N chats that have an anchor.
    // Anchored chats fetch ~M older messages each via
    // sock.fetchMessageHistory; the returned messages arrive through
    // messaging-history.set asynchronously. Wait briefly for those to
    // settle, then render.
    if (typeof wa.prefetchHistoryForTopChats === 'function' && messagesPerChat > 0) {
      const want = Math.max(messagesPerChat, 5);
      try {
        const r = await wa.prefetchHistoryForTopChats({ chatLimit: limit, perChat: want });
        if (r?.requested > 0) {
          // 1.5s settles a single round-trip empirically; slow networks
          // can just /channels again to pick up later arrivals.
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (_) { /* fall through; render what we have */ }
    }
    const chats = await wa.listChats({ limit, messagesPerChat });
    if (!chats.length) {
      sysOut('/channels: no chats found (baileys not synced yet — give it a moment after /whatsapp start, or just wait for the first message)');
      return true;
    }
    // Parallel WA Web scrape — used only as a fallback for chats where
    // baileys recent[] is empty.
    const webPreviews = messagesPerChat > 0
      ? await scrapeWaWebPreviews()
      : new Map();
    // Cache the listing so @waN refers back to the same index the
    // user just saw. Reset on each /channels.
    waChannelsCacheRef.current = chats;

    const ageLabel = (ts) => {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60)    return `${s}s ago`;
      if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    // Try to match WA Web's chat-list names to baileys's chat names.
    // Strip trailing "(You)" we added for self-DMs since WA Web's
    // row doesn't carry it.
    const lookupWebPreview = (name) => {
      if (!name) return null;
      const stripped = name.replace(/\s+\(You\)\s*$/, '').trim();
      return webPreviews.get(name) ?? webPreviews.get(stripped) ?? null;
    };

    const blocks = chats.map((c, i) => {
      const tag = c.isGroup ? '[group]' : '[1:1]';
      const age = c.lastActivityTs > 0
        ? ageLabel(c.lastActivityTs)
        : (c.creationTs > 0 ? `dormant, created ${ageLabel(c.creationTs)}` : 'dormant');
      // 📌 marker for pinned chats — set by either WA's phone-side
      // pin or eGPT's pin layer. listChats already floats them to
      // the top; the marker just makes the priority visible.
      const pin = (c.pinned || c.egptPinned) ? '📌 ' : '   ';
      const header = `  ${pin}@wa${i + 1}  ${tag.padEnd(7)} ${c.name}  (${age})`;
      if (!messagesPerChat) return header;
      if (Array.isArray(c.recent) && c.recent.length) {
        const previewLines = c.recent.map(r => {
          const speaker = r.author ?? '?';
          const oneLine = (r.text ?? '').replace(/\s+/g, ' ').trim();
          const trimmed = oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
          return `      [${speaker}] ${trimmed}`;
        });
        return [header, ...previewLines].join('\n');
      }
      // Fallback: WA Web's single-line chat-list preview. Marked
      // [last] so the user knows it's a one-line summary, not the
      // per-message breakdown baileys would give.
      const webPrev = lookupWebPreview(c.name);
      if (webPrev) {
        const trimmed = webPrev.length > 120 ? webPrev.slice(0, 119) + '…' : webPrev;
        return `${header}\n      [last via WA Web] ${trimmed}`;
      }
      return header;
    });
    sysOut(
      `chats (top ${chats.length}, baileys, most-active first):\n${blocks.join('\n')}\n\nuse @wa<N> <message> to send to one of these.`,
      { _themed: true },
    );
  } catch (e) {
    sysOut(`!! /channels: ${e.message}`);
  } finally {
    setBusy(false);
    setBusyLabel(null);
  }
  return true;
}
