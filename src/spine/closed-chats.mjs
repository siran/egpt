// closed-chats.mjs — config.yaml `closed_chats: { <surface>: { <chat id>: { message? } } }` (operator
// 2026-10-25). No being answers there: closedChat is gating.resolveMode's top rung. The message, if
// any, is said there once (announce) and again to an addressed human line at most once a day (remind).
// Marker: that chat's own conversations.yaml entry, `closed: { notice: <message hash>, at: <last said> }`.
import { createHash } from 'node:crypto';
import { mutateState } from '../conversations-state.mjs';
import { makeSerialByKey } from '../serial-by-key.mjs';

export const REMIND_EVERY_MS = 24 * 3600_000;
const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// That chat's closed_chats entry ({} when it carries nothing), or null when the chat is open.
export function closedChat(config, surface, chatId) {
  const chats = config?.closed_chats?.[surface];
  const id = String(chatId ?? '');
  if (!isMap(chats) || !id || !Object.hasOwn(chats, id)) return null;
  return isMap(chats[id]) ? chats[id] : {};
}

const messageOf = (closed) => (typeof closed?.message === 'string' ? closed.message.trim() : '');
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// say(chatId, text) → delivered?  (boot: sayOnce, the node's one placement)
export function createClosedChats({ getConfig, loadState, writeState, say, now = () => Date.now(), onLog = () => {} }) {
  const serial = makeSerialByKey();
  const ownEntry = (state, surface, chatId) => (isMap(state?.contacts?.[surface]?.[chatId]) ? state.contacts[surface][chatId] : null);
  const mark = (surface, chatId, fields) => mutateState(writeState, async () => {
    const state = await loadState();
    const own = ownEntry(state, surface, chatId);
    if (!own) return;
    const bucket = state.contacts[surface];
    await writeState({ ...state, contacts: { ...state.contacts, [surface]: { ...bucket, [chatId]: { ...own, closed: { ...own.closed, ...fields } } } } });
  });

  // Once per chat and message, and only for a chat with an entry (where the marker lives).
  const post = (surface, chatId, due) => serial(`${surface}/${chatId}`, async () => {
    const text = messageOf(closedChat(getConfig(), surface, chatId));
    if (!text) return;
    const own = ownEntry(await loadState(), surface, chatId);
    if (!own) { onLog(`${surface}/${chatId}: not in conversations.yaml — its message is not posted`); return; }
    const fields = due(own.closed ?? {}, hashOf(text));
    if (!fields) return;
    if (!(await say(chatId, text))) { onLog(`${surface}/${chatId}: message not delivered — not marked, so it is tried again`); return; }
    await mark(surface, chatId, { ...fields, at: new Date(now()).toISOString() });
    onLog(`${surface}/${chatId}: message posted (${fields.notice ? 'notice' : 'reminder'})`);
  });

  // Boot and every live config swap: each closed chat whose message is not the one already noticed.
  async function announce() {
    for (const [surface, chats] of Object.entries(getConfig()?.closed_chats ?? {})) {
      if (!isMap(chats)) continue;
      for (const chatId of Object.keys(chats)) await post(surface, chatId, (m, notice) => (m.notice === notice ? null : { notice }));
    }
  }

  // An addressed human line in a closed chat (spine classify): the message, unless said there within a day.
  const remind = (ev) => post(ev.surface, ev.chatId, (m) => (now() - Date.parse(m.at ?? '') < REMIND_EVERY_MS ? null : {}));

  return { announce, remind };
}
