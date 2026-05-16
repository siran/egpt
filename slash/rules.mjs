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

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   append(author, body)        — write to room md
  //   setItems(updater)           — append to in-memory items
  //   computeBrainTurn(name, q)   — run a one-shot turn against a brain
  //   sysOut(text)                — operator-visible status line
  const { append, setItems, computeBrainTurn, sysOut } = ctx;

  const recipient = arg.trim().match(/^@(\S+)$/)?.[1] ?? null;
  const rules = await loadRules();
  const finalRules = recipient ? `(for @${recipient})\n\n${rules}` : rules;

  // (1) shell-side emit (transcript + items-mirror to bridges).
  await append('system', finalRules);
  setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: finalRules }]);

  // (2) inject into @e session so the persona learns the rules
  //     once and remembers them via session memory. Fire-and-forget:
  //     we don't surface e's reply (likely '...' per the rules) — the
  //     value is the session-history side-effect, not the response.
  if (typeof computeBrainTurn === 'function') {
    computeBrainTurn('e', `[Operator injecting rules — please read and remember]\n\n${rules}`)
      .then(() => sysOut?.('/rules: injected into @e session'))
      .catch(e => sysOut?.(`!! /rules: @e injection failed: ${e?.message ?? e}`));
  }

  return true;
}
