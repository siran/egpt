// slash/who.mjs — a WhatsApp contact card.
//
// /who @waN          a chat from the last /channels listing
// /who <jid>         e.g. 16468217865@s.whatsapp.net or 34…@lid
// /who <number>      a phone number (+1 646 821 7865, dashes/spaces ok)
// /who <name>        case-insensitive match against known chat names
//
// Shows the cheap stored fields (name / pushname / business name / lid /
// phone) plus the on-demand baileys lookups (device list, about/status,
// profile picture, business profile). Each lookup is best-effort — a slow or
// privacy-blocked field is just omitted.

export const meta = {
  cmd: '/who',
  section: 'ROOM',
  surface: 'both',
  usage: '/who <@waN | jid | number | name>',
  desc:
    'WhatsApp contact card: name/pushname, phone↔lid, device list (phone/Beeper/' +
    'web), about, and business profile. Resolve a chat by @waN (after /channels), ' +
    'a jid, a phone number, or a name.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed: sysOut, waBridgeRef, waChannelsCacheRef, setBusy, setBusyLabel
  const { sysOut, waBridgeRef, waChannelsCacheRef, setBusy, setBusyLabel } = ctx;
  const wa = waBridgeRef?.current;
  if (!wa || typeof wa.contactInfo !== 'function') {
    sysOut('!! /who: whatsapp bridge not running (or this build lacks contactInfo) — /whatsapp pair to start');
    return true;
  }
  const ref = (arg ?? '').trim();
  if (!ref) { sysOut('usage: /who <@waN | jid | number | name>   (run /channels first to use @waN)'); return true; }

  // Resolve the reference to a jid.
  let jid = null;
  const waM = ref.match(/^@wa(\d+)$/i);
  if (waM) {
    const idx = parseInt(waM[1], 10) - 1;
    jid = waChannelsCacheRef?.current?.[idx]?.jid ?? null;
    if (!jid) { sysOut(`!! /who: @wa${idx + 1} isn't in the last /channels listing — run /channels first`); return true; }
  } else if (ref.includes('@')) {
    jid = ref;                                   // raw jid (…@s.whatsapp.net / …@lid / …@g.us)
  } else if (/^\+?[\d\s().-]{5,}$/.test(ref)) {
    jid = `${ref.replace(/[^\d]/g, '')}@s.whatsapp.net`;   // phone number
  } else {
    // Name match against known chats (exact first, then substring).
    try {
      const chats = await wa.listChats({ limit: 1000, messagesPerChat: 0 });
      const lc = ref.toLowerCase();
      const hit = chats.find(c => (c.name || '').toLowerCase() === lc)
               || chats.find(c => (c.name || '').toLowerCase().includes(lc));
      jid = hit?.jid ?? null;
    } catch { /* fall through to the error below */ }
    if (!jid) { sysOut(`!! /who: no chat matching "${ref}" — try @waN (after /channels), a jid, or a phone number`); return true; }
  }

  setBusyLabel('looking up contact…');
  setBusy(true);
  try {
    const info = await wa.contactInfo(jid);
    if (!info) { sysOut(`!! /who: no info for ${jid}`); return true; }
    const title = info.name || info.verifiedName || info.notify || info.pn || info.jid;
    const lines = [`👤 ${title}`];
    if (info.notify && info.notify !== title)             lines.push(`   pushname: ${info.notify}`);
    if (info.verifiedName && info.verifiedName !== title) lines.push(`   business name: ${info.verifiedName}`);
    if (info.pn)  lines.push(`   phone: ${info.pn}`);
    if (info.lid) lines.push(`   lid:   ${info.lid}`);
    if (Array.isArray(info.devices) && info.devices.length) {
      // device 0 = primary (phone); higher ids = companion devices (Beeper/web/desktop).
      lines.push(`   devices: ${info.devices.join(', ')}  (${info.devices.length} — 0=phone, others=linked)`);
    }
    if (info.status) lines.push(`   about: ${String(info.status).replace(/\s+/g, ' ').slice(0, 160)}`);
    if (info.business) {
      const b = info.business;
      const tail = [b.category, b.email, Array.isArray(b.website) ? b.website.join(' ') : b.website, b.address]
        .filter(Boolean).join(' · ');
      const body = [b.description, tail].filter(Boolean).join(' — ').slice(0, 240);
      lines.push(`   business: ${body || '(business account)'}`);
    }
    if (info.imgUrl) lines.push(`   avatar: ${info.imgUrl}`);
    sysOut(lines.join('\n'), { _themed: true });
  } catch (e) {
    sysOut(`!! /who: ${e.message}`);
  } finally {
    setBusy(false);
    setBusyLabel(null);
  }
  return true;
}
