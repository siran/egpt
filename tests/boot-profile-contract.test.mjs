// boot-profile-contract.test.mjs — GUARD 1: the boot-vs-layout CONTRACT.
//
// The failure this catches: code whose path CONSTANTS disagree with the canonical
// profile layout boots "successfully" against NOTHING. On 2026-07-03 the profile was
// relayed out (config/conversations.yaml, config/identities/<name>.md flat,
// state/ingest, config/logs); pre-relayout code that still read the OLD root paths
// booted green — empty registry, old-style seeded dirs, a DEAD node — and the whole
// suite stayed green because every boot test INJECTS its paths (loadState/io/readConfig),
// so no test ever exercised the real constants against a real on-disk layout.
//
// This test closes that gap. It lays a fixture profile on disk shaped EXACTLY like the
// canonical layout (paths HARD-CODED here — they encode the SPEC, not the code's
// constants), then boots the REAL spine with NO path overrides: readConfig, conv-state
// IO, and the fs seam are all left at their defaults so the code's OWN constants
// (EGPT_HOME → CONFIG_YAML_PATH / CONV_YAML_PATH / slugDir / seed dirs / _BEEPER_LOG)
// must find the fixture. Only the transport (startBridge), the claude process
// (makeSession), and child_process.spawn are faked — the boundaries every boot test is
// allowed to fake. If a constant drifts off the layout, an assertion below goes red.
//
// MECHANISM (the import-time EGPT_HOME problem): egpt-home.mjs freezes EGPT_HOME from
// process.env ONCE at module load. So EGPT_HOME is set BEFORE any app module is
// imported, and every app module is imported DYNAMICALLY inside beforeAll (a static
// import would hoist and freeze egpt-home against the ambient env first). Vitest gives
// each test FILE its own module registry, so this file's dynamic import gets a fresh
// egpt-home reading OUR fixture — a genuine exercise of the real constants, no child
// process needed (same mechanism the existing spine-v1-boot / beeper-log-path tests use).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import * as YAML from 'yaml';

const HOME = join(os.tmpdir(), `egpt-boot-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = HOME;

// The fixture chat — keyed by chatId, mode 'on', an EXISTING thread + a frozen readonly.
// Booting must SEE this entry (empty read = red) and RESUME its thread.
const CHAT_ID = '!room:fixture.beeper.local';
const SLUG = 'fixture-2607030000';
const THREAD_ID = 'existing-thread-123';

// Canonical layout paths — HARD-CODED (the contract). NOT imported from the code.
const P = {
  config:        join(HOME, 'config', 'config.yaml'),
  conversations: join(HOME, 'config', 'conversations.yaml'),
  agentEgpt:     join(HOME, 'config', 'agents', 'egpt.yaml'),
  idSecretary:   join(HOME, 'config', 'identities', 'secretary.md'),
  room00:        join(HOME, 'config', 'skeletons', 'room', '00-identity.md'),
  room30:        join(HOME, 'config', 'skeletons', 'room', '30-pointers.md'),
  room40:        join(HOME, 'config', 'skeletons', 'room', '40-rules.md'),
  ingestDir:     join(HOME, 'state', 'ingest'),
  oldIngestDir:  join(HOME, 'ingest'),                    // the RETIRED location
  transcript:    join(HOME, 'conversations', 'whatsapp', SLUG, 'transcript.md'),
  logsDir:       join(HOME, 'config', 'logs'),
};

// fake Beeper transport (verbatim shape from spine-v1-boot): captures the host
// onIncoming so we can drive an inbound, and records stream deliveries.
function fakeStart() {
  const spy = { onIncoming: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, spy };
}
// fake claude session: RESUMES opts.sessionId when given one (so a registry-seen
// threadId flows straight back — proving it was read), else mints a fresh id.
const fakeSession = (opts) => ({
  sessionId: opts.sessionId ?? 'fresh-sess',
  async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; },
  close() {},
});
// fake spawn so a heartbeat command beat never runs a real shell.
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

let boot, slugDir, parse, createContacts, createMedia, _BEEPER_LOG, swallow, _resetSwallowForTest;
let spy, app, delivered;

beforeAll(async () => {
  // 1. Lay the fixture profile on disk in the canonical shape.
  await fs.mkdir(join(HOME, 'config', 'agents'), { recursive: true });
  await fs.mkdir(join(HOME, 'config', 'identities'), { recursive: true });
  await fs.mkdir(join(HOME, 'config', 'skeletons', 'room'), { recursive: true });
  await fs.mkdir(P.ingestDir, { recursive: true });
  await fs.mkdir(P.oldIngestDir, { recursive: true });

  const config = {
    beeper_token: 'fixture-token-unused',
    // auto_e_default 'mute' → an UNKNOWN chat (the empty-registry regression) stays
    // silent; our KNOWN chat's own mode 'on' is the only thing that can produce a reply.
    whatsapp: { chat_id: 'self@fixture', allowed_users: ['u-1'], auto_e_chats: [], auto_e_default: 'mute' },
    agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } },
  };
  await fs.writeFile(P.config, YAML.stringify(config), 'utf8');

  const conversations = {
    contacts: {
      whatsapp: {
        [CHAT_ID]: {
          slug: SLUG,
          mode: 'on',
          threadId: THREAD_ID,
          readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' },
          conversation_path: `.egpt-boot-contract/conversations/whatsapp/${SLUG}`,
          home_dir: '/c/Users/fixture',
        },
      },
    },
  };
  await fs.writeFile(P.conversations, YAML.stringify(conversations), 'utf8');
  await fs.writeFile(P.agentEgpt, 'type: ccode\nmodel: sonnet\neffort: high\n', 'utf8');
  await fs.writeFile(P.idSecretary, '# I am a secretary\n\nProfile-only preset.\n', 'utf8');
  await fs.writeFile(P.room00, '# I am eGPT\n\nfixture identity.\n', 'utf8');
  await fs.writeFile(P.room30, '# pointers\n', 'utf8');
  await fs.writeFile(P.room40, '# rules\n', 'utf8');

  // Pre-drop ingest probes: one in the CANONICAL box (must be consumed by boot's
  // immediate sweep), one in the RETIRED box (must be left untouched).
  await fs.writeFile(join(P.ingestDir, 'probe.cmd'), 'noop-probe', 'utf8');
  await fs.writeFile(join(P.oldIngestDir, 'old.cmd'), 'noop-old', 'utf8');

  // 2. Import the app modules NOW (EGPT_HOME already frozen to the fixture).
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ slugDir, parse } = await import('../conversations-state.mjs'));
  ({ createContacts } = await import('../src/spine/contacts.mjs'));
  ({ createMedia } = await import('../src/spine/media.mjs'));
  ({ _BEEPER_LOG } = await import('../src/bridges/beeper.mjs'));
  ({ swallow, _resetSwallowForTest } = await import('../src/swallow.mjs'));

  // 3. Boot the REAL spine — no readConfig / loadState / writeState / io overrides.
  const fs2 = fakeStart();
  spy = fs2.spy;
  app = await boot({
    startBridge: fs2.start,
    makeSession: fakeSession,
    ingest: true,                              // exercise seeding + the ingest watcher
    spawn: fakeSpawn,
    exit: () => {},                            // a lifecycle ingest must never kill the test
    now: () => Date.UTC(2026, 6, 3, 14, 5),
    tickMs: 0,
    log: { line: () => {} },
  });

  // 4. Drive ONE inbound through the fake bridge (no @e — an unknown chat would be mute).
  await spy.onIncoming('contract probe hello', {
    chatId: CHAT_ID, network: 'whatsapp',
    userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
  });
  delivered = spy.streams[0]?.finals?.[0] ?? null;
});

afterAll(async () => {
  try { app?.stop(); } catch {}
  delete process.env.EGPT_HOME;
  try { await fs.rm(HOME, { recursive: true, force: true }); } catch {}
});

describe('GUARD 1 — boot reads the canonical layout (real constants, hermetic fixture)', () => {
  // (a) the spine SEES the fixture registry — mode 'on' produced a reply AND the
  //     existing threadId was resumed (not a fresh kickoff). Empty read = red.
  it('(a) registry-seen: the fixture contact resolves, replies, and its thread is RESUMED', async () => {
    expect(spy.streams).toHaveLength(1);                                  // mode 'on' was read
    expect(delivered).toContain('contract probe hello');                 // the message routed through
    expect(delivered).not.toContain('Live message from the chat (envelope'); // resumed, not fresh-kickoff wrapped
    const onDisk = readFileSync(P.conversations, 'utf8');
    expect(onDisk).toContain(THREAD_ID);                                 // the existing thread survived
    expect(onDisk).not.toContain('fresh-sess');                          // no new thread minted
  });

  // (b) seeding lands FLAT at config/identities/<name>.md — never a nested
  //     identities/<name>/00-*.md dir, never the retired EGPT_HOME/identities root.
  it('(b) seeding lands flat under config/identities + config/skeletons/room', async () => {
    const flatPreset = join(HOME, 'config', 'identities', 'psychologist.md');
    expect((await fs.stat(flatPreset)).isFile()).toBe(true);             // seeded flat (secretary pre-existed)
    await expect(fs.stat(join(HOME, 'config', 'identities', 'psychologist'))).rejects.toThrow();      // NOT a dir
    await expect(fs.stat(join(HOME, 'config', 'identities', 'psychologist', '00-identity.md'))).rejects.toThrow();
    await expect(fs.stat(join(HOME, 'identities'))).rejects.toThrow();   // NOT the retired root
    expect((await fs.stat(P.room00)).isFile()).toBe(true);              // room template present
  });

  // (c) the ingest watcher consumes from state/ingest — NOT from the retired
  //     EGPT_HOME/ingest root.
  it('(c) ingest consumes from state/ingest, ignores the retired EGPT_HOME/ingest', async () => {
    await expect(fs.stat(join(P.ingestDir, 'probe.cmd'))).rejects.toThrow();   // consumed
    expect((await fs.stat(join(P.oldIngestDir, 'old.cmd'))).isFile()).toBe(true); // untouched (wrong box)
  });

  // (d) log writes land under config/logs (the NSSM-log-dir relayout half the vitests
  //     could see): the beeper log constant + a real swallow write both root there.
  it('(d) log paths root under config/logs', async () => {
    expect(_BEEPER_LOG).toBe(join(P.logsDir, 'beeper.log'));
    _resetSwallowForTest();
    swallow('boot-contract-probe', new Error('probe'));                  // a real best-effort log write
    expect((await fs.stat(join(P.logsDir, 'swallowed.log'))).isFile()).toBe(true);
  });

  // (e) the message pipeline WROTE the transcript into the fixture conversation folder
  //     (real transcript service, real slugDir path constant). Unwritten transcript = red.
  it('(e) the inbound landed in the fixture conversation transcript.md', async () => {
    const t = readFileSync(P.transcript, 'utf8');
    expect(t).toContain('contract probe hello');
    // slugDir (the shared path root) must resolve INSIDE the fixture, not some other tree.
    expect(slugDir('whatsapp', SLUG)).toBe(join(HOME, 'conversations', 'whatsapp', SLUG));
  });

  // (f) media + video-transcription destinations resolve INSIDE the fixture conversation's
  //     media/ folder (path-shape only — the frame/transcribe deps are faked, no ffmpeg/whisper).
  it('(f) media save + video sidecar destinations root under <conv>/media', async () => {
    const state = parse(readFileSync(P.conversations, 'utf8'));
    const contacts = createContacts({ loadState: async () => state, writeState: async () => {}, io: {} });
    const cap = {};
    const media = createMedia({
      contacts,
      io: {
        copyFile: async (_src, dst) => { cap.copyDest = dst; },
        mkdir: async () => {},
        appendFile: async (p) => { cap.indexPath = p; },
      },
      extractFrames: async (_v, { outDir, baseName }) => { cap.frameOutDir = outDir; return [join(outDir, `${baseName}-frame-01.jpg`)]; },
      transcribe: async (p) => { cap.transcribePath = p; return 'stub transcript'; },
    });

    const mediaDir = join(HOME, 'conversations', 'whatsapp', SLUG, 'media');
    const base = { chatID: CHAT_ID, network: 'whatsapp', senderName: 'An', ts: 1, msgId: 'x' };

    await media.save({ ...base, kind: 'image', mime: 'image/jpeg', fileName: 'pic.jpg', localPath: '/tmp/pic.jpg' });
    expect(cap.copyDest.startsWith(mediaDir)).toBe(true);                 // saved file under <conv>/media
    expect(cap.indexPath).toBe(join(mediaDir, 'index.md'));

    await media.save({ ...base, kind: 'video', mime: 'video/mp4', fileName: 'clip.mp4', localPath: '/tmp/clip.mp4' });
    expect(cap.frameOutDir).toBe(mediaDir);                              // keyframes under <conv>/media
    expect(cap.transcribePath.startsWith(mediaDir)).toBe(true);         // audio transcript sidecar under <conv>/media
  });
});
