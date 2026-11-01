// background.mjs — the background work this node is handling (operator 2026-10-18: "nodes can have
// list of bg tasks being handled"), kept in EGPT_HOME/state/background.json so a restart can see it:
//   · transcriptions: voice notes whose arrival line is recorded and whose outcome is not yet
//     (spine ingestion point → noteVoice). A restart resumes each one, or closes it with a failure.
//   · agents: the beings' background tasks, mirrored from the warm pool on the spine's tick. Never
//     re-woken after a restart (cli-host keeps them alive); the list is reconciled with what it adopted.
// The file is rewritten whole, temp + rename.
import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { dirname } from 'node:path';
import { transcribeVoiceNote, voiceTranscriptBody, voiceFailedBody } from '../incoming-media.mjs';
import { elapsed } from './sender.mjs';
import { mentionStatus } from '../auto-mode.mjs';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);   // rides the tick: never throws
const sameNote = (a, b) => a.surface === b.surface && a.chatId === b.chatId && String(a.msgId) === String(b.msgId);
const taskKey = (a) => `${a.being} ${a.chatId} ${a.taskId ?? a.description}`;

export function createBackgroundRegistry({ path, node = null, liveAgents = () => [], now = () => Date.now(), io = {}, onLog = () => {} }) {
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const rename = io.rename ?? fsRename;
  const mkdir = io.mkdir ?? fsMkdir;
  const existsSync = io.existsSync ?? fsExistsSync;
  const doc = { transcriptions: [], agents: [] };
  let previous = [];          // the last spine's pending notes, for resume()
  let reconciled = false;
  let written = null;
  let chain = Promise.resolve();
  let side = Promise.resolve();   // resumed outcomes still being delivered

  function persist() {
    chain = chain.then(async () => {
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      if (body === written) return;
      const tmp = `${path}.tmp-${process.pid}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, path);
      written = body;
    }).catch((e) => onLog(`could not write ${path}: ${e?.message ?? e}`));
    return chain;
  }

  async function load() {
    let raw;
    try { raw = await readFile(path, 'utf8'); }
    catch (e) { onLog(`no ${path} (${e?.code ?? e?.message ?? e}) — nothing to resume`); return; }
    let d;
    try { d = JSON.parse(raw); if (!d || typeof d !== 'object') throw new Error('not an object'); }
    catch (e) { onLog(`${path} unreadable (${e?.message ?? e}) — ignored`); return; }
    const ok = (x) => x && typeof x === 'object';
    previous = (Array.isArray(d.transcriptions) ? d.transcriptions : []).filter((t) => ok(t) && ok(t.from));
    doc.transcriptions = [...previous];
    doc.agents = (Array.isArray(d.agents) ? d.agents : []).filter(ok);
    written = raw;
  }

  // The spine's ingestion point: a recorded arrival is pending, its outcome settles it.
  function noteVoice(ev) {
    if (ev?.voiceLine === 'arrival' && ev.raw?.voicePath) {
      const { voicePath, voiceMedia = null, voiceListening = false, ...from } = ev.raw;
      const note = { surface: ev.surface, chatId: ev.chatId, chatName: ev.chatName ?? null, msgId: ev.msgId, sender: ev.senderName ?? null, file: voicePath, arrivedAt: iso(ev.ts ?? now()), node, media: voiceMedia, listening: voiceListening === true, from };
      doc.transcriptions = [...doc.transcriptions.filter((t) => !sameNote(t, note)), note];
      persist();
    } else if (ev?.voiceLine === 'outcome') settle(ev);
  }
  function settle(n) {
    const left = doc.transcriptions.filter((t) => !sameNote(t, n));
    if (left.length === doc.transcriptions.length) return;
    doc.transcriptions = left;
    persist();
  }

  // After a restart: each note the last spine left pending ends as a live one would — through the same
  // transcription service when this node can still decode it (else "(voice note not transcribed: restart)"),
  // its audio saved first (saveAudio: the bridge's onMedia meta, caption = transcription), its outcome
  // dispatched with the bridge's mention read (it was in flight, not old: backlog only if its arrival was),
  // then the stale 🎧 taken off (unlisten, best-effort, never awaited) — only where one could be up (`listening`).
  async function resume({ transcribe, audioCfg = {}, wake = null, deliver, saveAudio = null, unlisten = null }) {
    const notes = previous;
    previous = [];
    for (const n of notes) {
      const where = `#${n.msgId} in ${n.chatName ?? n.chatId}`;
      const ours = n.node === node;
      let body;
      if (!ours || !n.file || !existsSync(n.file)) {
        onLog(`${where}: ${!ours ? `node ${n.node}'s decode, not this node's` : `audio ${n.file ?? '(none)'} is gone`} — closed with a failure line`);
        body = voiceFailedBody('restart');
      } else {
        const meta = {};
        const text = await transcribeVoiceNote({ localPath: n.file, audioCfg, transcribe, onLog: (m) => onLog(`${where}: ${m}`), meta });
        body = text ? voiceTranscriptBody(text, { durationSec: meta.durationSec }) : voiceFailedBody(meta.error ?? 'no transcript');
        onLog(`${where}: resumed after the restart — ${text ? 'transcribed' : 'no transcript'}`);
        if (n.media && saveAudio) {
          try { await saveAudio({ ...n.media, caption: text || null }, n.from); }
          catch (e) { onLog(`${where}: audio not saved — ${e?.message ?? e}`); }
        }
      }
      const heard = wake ? mentionStatus(body, wake.wakeWords, { addressWithoutAt: wake.addressWithoutAt, voiceWake: wake.voiceWakeWords }) : {};
      const delivered = Promise.resolve()
        .then(() => deliver(body, { ...n.from, voiceLine: 'outcome', isTranscriptFromVoice: true, ...heard }))
        .catch((e) => onLog(`${where}: outcome not delivered — ${e?.message ?? e}`))
        .finally(() => settle(n));
      side = Promise.all([side, delivered]);
      if (ours && n.listening && unlisten) Promise.resolve().then(() => unlisten(n.from)).catch((e) => onLog(`${where}: 🎧 not removed — ${e?.message ?? e}`));
    }
  }

  function agentsNow() {
    return liveAgents().map((t) => ({ being: t.being, surface: t.surface ?? null, chatId: t.chatId, taskId: t.taskId ?? null, ...(t.parentTaskId ? { parentTaskId: t.parentTaskId } : {}), description: t.description, since: iso(t.since) }));
  }
  // Once cli-host has adopted what it held (or at start without it): the live list replaces the last spine's.
  function reconcile() {
    const live = agentsNow();
    const kept = new Set(live.map(taskKey));
    for (const a of doc.agents) if (!kept.has(taskKey(a))) onLog(`${a.being}/${a.chatId}: background task ${a.taskId ?? '?'} (${a.description}) did not survive the restart`);
    reconciled = true;
    doc.agents = live;
    persist();
  }
  // The spine's tick.
  function sync() {
    if (!reconciled) return;
    doc.agents = agentsNow();
    persist();
  }

  function status() {
    const t = now();
    const lines = [
      ...doc.transcriptions.map((n) => `· voice note #${n.msgId} from ${n.sender ?? '?'} in ${n.chatName ?? n.chatId} — transcribing, ${elapsed(t - Date.parse(n.arrivedAt))}`),
      ...doc.agents.map((a) => `· ${a.being} in ${a.chatId} — ${a.description}, ${elapsed(t - Date.parse(a.since))}`),
    ];
    return lines.length ? [`${node ?? 'this node'} is handling:`, ...lines].join('\n') : '';
  }

  async function flush() {
    for (let s = null; s !== side;) { s = side; await s; }
    await chain;
  }

  return { load, noteVoice, resume, reconcile, sync, status, flush };
}
