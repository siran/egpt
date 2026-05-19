// slash/rules.mjs — emit room etiquette + inject into @e's session.
//
// Rule text: read from ~/.egpt/rules.md if it exists (operator-editable
// per-deployment). Falls back to the inline DEFAULT_RULES below when
// the file is missing, so a fresh install still works.
//
// Two side-effects:
//   1. Append the rules to the room md + items (existing shell-side
//      delivery — visible in transcript, mirrored to bridges via the
//      items-mirror effect).
//   2. Inject the rules INTO the @e default-brain session via
//      ctx.computeBrainTurn('e', rules) so e learns the conventions
//      and remembers them across future turns (auto_e_chats arrivals,
//      direct @e mentions, etc.). e replies once (likely '...' per
//      the rules); the reply is discarded — we only care that e
//      reads the rules into its session jsonl. From then on it's in
//      e's persistent context — no need to re-inject every turn.
//
// Usage:
//   /rules                  emit + inject for everyone
//   /rules @<who>           emit prefixed "(for @<who>)" + inject
//
// The recipient @-prefix is decorative; per-bridge mention encoding
// is a separate piece of work.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const meta = {
  cmd: '/rules',
  section: 'ROOM',
  surface: 'shell',
  usage: '/rules [@<who>]',
  desc: 'emit room etiquette + inject into @e session',
};

const RULES_PATH = join(homedir(), '.egpt', 'rules.md');

const DEFAULT_RULES = `RULES:

If you are reading this it means you are a member of this WhatsApp group.

You are prompted with every message in the group; reply only when relevant for you to reply. If nothing to say, your polite silence is "..." (literal three dots — the system reads that as silence and won't post it).

You are free to talk, say, opine about anything said in this group unprompted.

Messages are formatted like:

[Name@surface (timestamp)]: message text.

Happy chatting!`;

async function loadRules() {
  try { return (await readFile(RULES_PATH, 'utf8')).trim(); }
  catch { return DEFAULT_RULES; }
}

export async function run({ arg, meta, ctx }) {
  // ctx keys consumed:
  //   append(author, body)              — write to room md
  //   setItems(updater)                 — append to in-memory items
  //   computeBrainTurn(name, q)         — run a one-shot turn against a brain
  //   sysOut(text)                      — operator-visible status line
  //   buildWaSurfaceTag(chatId)         — '<slug>.<jid-num>.wa' formatter
  //   formatAutoDispatchLine({...})     — '[Name@surface (HH:MM)]: body' formatter
  //   EGPT_CONFIG                       — read auto_e_chats[0] as fallback target
  const { append, setItems, computeBrainTurn, sysOut,
          buildWaSurfaceTag, formatAutoDispatchLine, EGPT_CONFIG } = ctx;

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  // Forms:
  //   /rules                  recipient=null, jid from meta / first auto_e_chats
  //   /rules @<who>           decorative recipient prefix
  //   /rules <jid>            explicit JID target
  //   /rules @<who> <jid>     both
  let recipient = null;
  let explicitJid = null;
  for (const t of tokens) {
    if (t.startsWith('@')) recipient = t.slice(1);
    else if (t.includes('@g.us') || t.includes('@s.whatsapp.net') || t.includes('@lid')) explicitJid = t;
  }

  const rules = await loadRules();
  const finalRules = recipient ? `(for @${recipient})\n\n${rules}` : rules;

  // (1) shell-side emit (transcript + items-mirror to bridges).
  await append('system', finalRules);
  setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: finalRules }]);

  // (2) inject into @e session as a natural chat message from a
  //     special "Group SysAdmin" sender, formatted exactly like an
  //     auto_e_chats arrival so e treats it as in-character
  //     conversation rather than an out-of-band instruction. e
  //     remembers via session memory — no per-turn rules prefix
  //     needed afterwards.
  if (typeof computeBrainTurn === 'function') {
    const autoChats = Array.isArray(EGPT_CONFIG?.whatsapp?.auto_e_chats)
      ? EGPT_CONFIG.whatsapp.auto_e_chats : [];
    const targetJid = explicitJid ?? meta?.waChatId ?? autoChats[0] ?? null;
    if (!targetJid) {
      sysOut?.('/rules: no target chat — pass a JID or add one to whatsapp.auto_e_chats');
      return true;
    }
    const surface = buildWaSurfaceTag?.(targetJid) ?? 'wa';
    const injectLine = formatAutoDispatchLine?.({
      senderName: 'Group SysAdmin',
      body: rules,
      ts: Date.now(),
      surface,
    }) ?? `[Group SysAdmin@${surface}]: ${rules}`;
    computeBrainTurn('e', injectLine)
      .then(async (reply) => {
        sysOut?.(`/rules: injected into @e session (as Group SysAdmin@${surface})`);
        // Operator (2026-05-19): "replies should be sent to
        // originating chat." When the slash came from a chat (WA
        // self-DM, a group, etc.), surface @e's ack to that chat
        // via a wa-send outbox event so the human sees confirmation.
        // Silence-protocol replies are skipped — nothing to surface.
        const replyText = String(reply ?? '').trim();
        if (!replyText || replyText === '...' || replyText === '…') return;
        const originJid = meta?.waChatId;
        if (!originJid) return;
        try {
          const fsmod   = await import('node:fs/promises');
          const pathmod = await import('node:path');
          const osmod   = await import('node:os');
          const id  = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ev  = { type: 'wa-send', from: 'e', ts: Date.now(), jid: originJid, body: replyText };
          await fsmod.writeFile(
            pathmod.join(osmod.homedir(), '.egpt', 'outbox', id + '.json'),
            JSON.stringify(ev),
          );
        } catch (e) {
          sysOut?.(`!! /rules: failed to relay @e's ack to ${originJid}: ${e?.message ?? e}`);
        }
      })
      .catch(e => sysOut?.(`!! /rules: @e injection failed: ${e?.message ?? e}`));
  }

  return true;
}
