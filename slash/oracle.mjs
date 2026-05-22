// slash/oracle.mjs — summon a mystical Genie/Oracle in a WA chat.
//
// The animation storyboard + onReply/onBusy logic lives in
// tools/genie.mjs so the same summon path is reachable from
// '@?' inside a WA chat (bridge-side trigger) and from this
// slash command (operator-side trigger). This file is just the
// argument parser + access gate.

import { summonGenie } from '../src/tools/genie.mjs';

export const meta = {
  cmd: '/oracle',
  section: 'ROOM',
  surface: 'shell',
  usage: '/oracle @waN [--keep [N]] | /oracle stop [@waN] | /oracle list',
  desc:
    'summon a mystical Genie in a WA chat. The genie emerges from a ' +
    'bottle and accepts replies as questions, routed through a brain ' +
    '(default @e). Default 1 wish. --keep makes it 3 wishes (genie ' +
    'default); --keep N for custom. Each answered question ticks N ' +
    'down; on 0 the genie waves goodbye and vanishes. /oracle stop ' +
    'retires early. Multiple genies run in parallel across chats. ' +
    'Q+A flows into the shell so the operator can follow along.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef          — WA bridge (exposes startOracle, stopOracle, listOracles, replyTo, editMessage)
  //   waChannelsCacheRef   — @waN → chat object
  //   computeBrainTurn(routedTo, question) → answer text (compute-only)
  //   sessions             — validate non-persona brain exists
  //   EGPT_CONFIG          — oracle.brain + oracle.busy_behavior + oracle.frame_ms
  const { sysOut, waBridgeRef, waChannelsCacheRef, computeBrainTurn, sessions, EGPT_CONFIG } = ctx;

  const wa = waBridgeRef?.current;
  if (!wa?.startOracle) {
    sysOut('!! /oracle: whatsapp bridge not running');
    return true;
  }

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0];

  if (sub === 'stop') {
    const targetTok = tokens[1];
    if (!targetTok) {
      const n = await wa.stopAllOracles();
      sysOut(n ? `🧞 retired ${n} genie${n === 1 ? '' : 's'}` : '🧞 no genies in flight');
      return true;
    }
    const m = targetTok.match(/^@wa(\d+)$/i);
    if (!m) { sysOut(`!! /oracle stop: "${targetTok}" isn't @waN`); return true; }
    const chat = waChannelsCacheRef?.current?.[parseInt(m[1], 10) - 1];
    if (!chat) { sysOut(`!! /oracle stop: no chat at ${targetTok}`); return true; }
    const stopped = await wa.stopOracle(chat.jid);
    sysOut(stopped ? `🧞 retired genie in "${chat.name}"` : `🧞 no genie in "${chat.name}"`);
    return true;
  }

  if (sub === 'list' || !sub) {
    const list = wa.listOracles?.() ?? [];
    if (!list.length) {
      sysOut('🧞 no genies in flight. summon one with /oracle @waN');
      return true;
    }
    const lines = list.map((o, i) => `  ${i + 1}. "${o.name ?? o.chatId}"  (${o.state})`);
    sysOut(`🧞 ${list.length} genie${list.length === 1 ? '' : 's'} in flight:\n${lines.join('\n')}`);
    return true;
  }

  // Summon: /oracle @waN [--keep [N]]
  const m = sub.match(/^@wa(\d+)$/i);
  if (!m) {
    sysOut(`!! /oracle: usage: ${meta.usage}`);
    return true;
  }
  const idx = parseInt(m[1], 10) - 1;
  const chat = waChannelsCacheRef?.current?.[idx];
  if (!chat) {
    sysOut(`!! /oracle: no chat at ${sub} — /recap or /channels first to populate indices`);
    return true;
  }
  // --keep [N]: --keep alone → 3 wishes (genie default), --keep 5
  // → 5 wishes. Plain /oracle → 1 wish (one-shot). Cap at 12 to
  // keep things sane.
  const keepIdx = tokens.findIndex(t => t === '--keep' || t === '--multi');
  let questionsLeft = 1;
  if (keepIdx >= 0) {
    const argN = tokens[keepIdx + 1];
    const parsed = argN && /^\d+$/.test(argN) ? parseInt(argN, 10) : null;
    questionsLeft = Math.max(1, Math.min(12, parsed ?? 3));
  }

  const brainName = EGPT_CONFIG?.oracle?.brain ?? 'e';
  const isPersona = (brainName === 'e' || brainName === 'egpt');
  if (!isPersona && !sessions[brainName]) {
    sysOut(`!! /oracle: brain "${brainName}" not in current room. /attach it first, or set oracle.brain to "e" for the default persona.`);
    return true;
  }
  const busyBehavior = EGPT_CONFIG?.oracle?.busy_behavior ?? 'polite';
  const frameMs = Number(EGPT_CONFIG?.oracle?.frame_ms) || 3000;

  const handle = await summonGenie({
    wa,
    chatId: chat.jid,
    chatName: chat.name,
    questionsLeft,
    brainName,
    computeBrainTurn,
    sysOut,
    busyBehavior,
    frameMs,
  });
  if (!handle) {
    sysOut(`!! /oracle: bridge returned no handle — initial send may have failed`);
    return true;
  }
  const wishWord = questionsLeft === 1 ? 'wish' : 'wishes';
  sysOut(`🧞 genie summoned in @wa${m[1]} "${chat.name}"  (brain: @${brainName}, ${questionsLeft} ${wishWord}, busy: ${busyBehavior})`);
  return true;
}
