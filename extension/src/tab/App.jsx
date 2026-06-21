import { useState, useEffect, useRef, useCallback } from 'react';
import Input from './Input.jsx';
import { startTelegramBridge } from '../../../src/bridges/telegram.mjs';
import * as sessionCommands from '../commands/session-commands.js';
import * as miscCommands from '../commands/misc-commands.js';
import { generateKey as generateBusKey } from '../../../src/tools/bus-sign.mjs';
import * as chatgptCdp from '../../../config/brains/chatgpt-cdp.mjs';
import * as claudeCdp from '../../../config/brains/claude-cdp.mjs';
import { listTabs } from '../../../src/tools/cdp.mjs';
import * as bus from '../../../src/tools/bus.mjs';
import { parseInput, helpText, COMMAND_SET, commandSetFor } from '../../../src/interpreter.mjs';
import { resolveRoute, planMirrors } from '../../../src/room.mjs';

// Identifier this extension instance uses on the bus. Default is
// chrome-XXXX (random); user can set chrome.storage.sync.node_name to
// something like 'chr1' or 'home' to override. We read storage on mount
// and update BUS_NODE_ID before posting node-online — the bus useEffect
// is gated on nodeNameReady to make sure the announce uses the chosen
// name, not the default.
//
// Same room, same names mean same names on the bus — collision is the
// user's responsibility.
const DEFAULT_BUS_NODE_ID = `chrome-${Math.random().toString(36).slice(2, 6)}`;
let BUS_NODE_ID = DEFAULT_BUS_NODE_ID;
let SURFACE_TAG = BUS_NODE_ID;

// Use the same brain names as the shell so /help and /open/@-mentions
// match across surfaces. Aliases let the user type the short form too.
const BRAINS = {
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
};
const BRAIN_ALIASES = {
  chatgpt: 'chatgpt-cdp',
  claude: 'claude-cdp',
  ccode: 'claude-code',
};
const canonicalBrain = (n) => BRAIN_ALIASES[n] ?? n;
const brainForName = (n) => BRAINS[canonicalBrain(n)] ?? null;
// Brains the shell hosts but the extension can't (local subprocesses).
// /attach and /open with one of these get forwarded to a shell peer
// instead of erroring out locally — same room, the operation just runs
// on the surface that can carry it.
const SHELL_ONLY_BRAINS = new Set(['codex', 'claude-code']);

const BRAIN_PREFIX = {
  'chatgpt-cdp': 'cgpt',
  'claude-cdp':  'claude',
};

const EXT_COMMAND_SET = commandSetFor('extension');

let _msgIdSeq = 0;
const mkId = () => ++_msgIdSeq;

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('tab load timeout (30s)'));
    }, 30_000);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(deadline);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Race: tab may already be complete by the time we attach the listener
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === 'complete') {
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [sessionsList, setSessionsList] = useState([]);
  // activeSessions: brains that plain-text input routes to (no @-mention
  // needed). Set with /use a or /use a,b,c. Cleared with /use clear.
  const [activeSessions, setActiveSessions] = useState([]);
  const [tgStatus, setTgStatus] = useState('not connected');
  // 'attached' = green dot (content script in WA Web tab is connected);
  // 'detached' = red dot (no WA tab, or it was closed); 'unknown' before
  // the bridge has reported state. Surfaced in the status bar.
  const [userName, setUserName] = useState('human');
  // Whether THIS extension currently owns Telegram polling. /telegram <node>
  // hands off; bus event 'telegram-handoff' may start/stop us.
  const [tgPolling, setTgPolling] = useState(false);
  // Bumped when peer state changes so /sessions re-renders.
  const [peersRev, setPeersRev] = useState(0);
  // True once chrome.storage.sync has been read. The bus useEffect waits
  // on this so the node-online announce uses the user-configured name
  // (if any) rather than the random default.
  const [nodeNameReady, setNodeNameReady] = useState(false);

  const sessionsRef = useRef(new Map());   // name → { brain, targetId }
  const bridgeRef   = useRef(null);
  const convRef     = useRef(null);
  // Peer nodes seen on the bus. nodeId -> { role, sessions, polling, lastSeen }.
  const peerNodesRef = useRef(new Map());
  // Bus event dispatcher — refreshed each render so it has current closures.
  const handleBusEventRef = useRef(null);
  const busTargetIdRef = useRef(null);
  const busSubRef = useRef(null);
  // Forward-reference to handleCommand (declared later) so handleIncoming can
  // route /telegram from Telegram clients without a temporal dead zone.
  const handleCommandRef = useRef(null);

  // ── helpers ──────────────────────────────────────────────────

  // Output sink for bridge-originated dispatch. When set (by handleSubmit
  // wrapping a fromBridge call), 'egpt' system messages (command output,
  // errors, hints) ALSO get pushed to the originating bridge so the user
  // sees them on the surface they typed from. Cleared after dispatch
  // completes. Same pattern the shell uses via outputSinkRef.
  const currentOutputSinkRef = useRef(null);

  const appendMsg = useCallback((author, text, opts = {}) => {
    const id = mkId();
    setMessages(prev => [...prev, { id, author, text, streaming: opts.streaming ?? false }]);
    // Sink mirrors the message to the originating bridge (e.g. back to
    // the Telegram chat that sent the dispatch) so command output and
    // dispatch errors land where the user typed from. Internal system
    // logs (chat-id captured, etc.) opt OUT via {noMirror:true} so a
    // concurrent bridge event during a dispatch doesn't leak into the chat.
    if (currentOutputSinkRef.current && author === 'egpt' && !opts.noMirror) {
      try { currentOutputSinkRef.current(text); } catch (_) {}
    }
    return id;
  }, []);

  const updateMsg = useCallback((id, text, streaming = false) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, text, streaming } : m));
  }, []);

  const syncSessionsList = () =>
    setSessionsList([...sessionsRef.current.entries()].map(([name, s]) => ({
      name, brainType: s.brain.name, targetId: s.targetId,
    })));

  const nextSessionName = (brainType) => {
    const prefix = BRAIN_PREFIX[brainType] ?? brainType;
    for (let i = 1; i <= 99; i++) {
      const name = `${prefix}${i}`;
      if (!sessionsRef.current.has(name)) return name;
    }
    return `${prefix}${Date.now()}`;
  };

  // Resolve a tab spec (Chrome tab ID, URL substring, or title prefix) to
  // a Chrome tab ID. Mirrors the shell's tabSpec resolution.
  const resolveTabSpec = async (spec, brain = null) => {
    const norm = String(spec ?? '').trim();
    if (!norm) return null;
    const tabs = await listTabs();
    const asInt = Number.parseInt(norm, 10);
    if (Number.isFinite(asInt) && tabs.some(t => t.id === asInt)) return asInt;
    let m = tabs.find(t => t.url === norm);
    if (m) return m.id;
    m = tabs.find(t => t.url.includes(norm));
    if (m) return m.id;
    m = tabs.find(t => (t.title ?? '').toLowerCase().startsWith(norm.toLowerCase()));
    if (m) return m.id;
    if (brain?.urlMatch) {
      const candidates = tabs.filter(t => brain.urlMatch.test(t.url));
      if (candidates.length === 1) return candidates[0].id;
    }
    return null;
  };

  // ── '@e' dedicated thread ─────────────────────────────────────
  //
  // The persona has its own conversation thread, persisted across
  // extension loads. Storage shape:
  //   chrome.storage.local.egpt_thread = { brain_type: 'chatgpt-cdp',
  //                                        url: 'https://chatgpt.com/c/<uuid>' }
  //
  // ensureEThread guarantees sessionsRef has an 'e' entry pointing at
  // a tab serving the saved URL. Order:
  //   - if 'e' is already registered with a live tab → done.
  //   - if a saved URL exists and a tab matches → register.
  //   - else open a new chatgpt-cdp tab and register.
  //
  // persistEThreadUrl saves whatever URL the 'e' tab is currently on
  // (post-dispatch ChatGPT navigates to /c/<uuid>).

  const E_BRAIN_DEFAULT = 'chatgpt-cdp';

  // Last message we observed on any monitored surface — used by
  // /mirror to forward 'whatever was just said' to a target. Updated
  // on every WA incoming, regardless of whether dispatch fired.
  // Shape: { sender, text, source, chatId?, ts }.

  const ensureEThread = useCallback(async () => {
    const existing = sessionsRef.current.get('e');
    if (existing) {
      // Confirm the bound tab is still alive.
      try {
        const tabs = await listTabs();
        if (tabs.some(t => t.id === existing.targetId)) return;
      } catch (_) {}
    }

    let saved = null;
    try {
      const got = await chrome.storage.local.get('egpt_thread');
      saved = got?.egpt_thread ?? null;
    } catch (_) {}

    const brainType = saved?.brain_type || E_BRAIN_DEFAULT;
    const brain = BRAINS[brainType];
    if (!brain) throw new Error(`unknown brain type "${brainType}" for @e`);

    // Saved URL → try to find an existing tab.
    if (saved?.url) {
      try {
        const tabs = await listTabs();
        const m = tabs.find(t => t.url === saved.url || t.url.startsWith(saved.url));
        if (m) {
          sessionsRef.current.set('e', { brain, targetId: m.id });
          syncSessionsList();
          return;
        }
      } catch (_) {}
    }

    // No live tab. Open a new one — to the saved URL if present
    // (resumes the existing chatgpt thread), otherwise to the
    // brain's homeUrl (fresh thread; URL will be saved post-dispatch).
    // Open in a DETACHED window so the brain has its own visible
    // space (user preference: easier to keep visible without
    // interfering with their main browser window). focused:false
    // so opening doesn't steal user focus from whatever they're
    // doing. Falls back to plain tabs.create if windows.create
    // throws (e.g. limited windowing context).
    const openUrl = saved?.url || brain.homeUrl;
    appendMsg('egpt', `@e: opening ${saved?.url ? 'saved thread' : 'new thread'} (${brainType})…`, { noMirror: true });
    const beforeIds = new Set((await listTabs(brain.urlMatch)).map(t => t.id));
    let tab = null;
    try {
      const win = await chrome.windows.create({ url: openUrl, focused: false, type: 'normal' });
      tab = win?.tabs?.[0] ?? null;
    } catch (_) {}
    if (!tab) {
      tab = await chrome.tabs.create({ url: openUrl, active: false });
    }
    await waitForTabLoad(tab.id);
    let cdpId = null;
    for (let i = 0; i < 10; i++) {
      const after = await listTabs(brain.urlMatch);
      const newOne = after.find(t => !beforeIds.has(t.id));
      if (newOne) { cdpId = newOne.id; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!cdpId) throw new Error('@e: opened tab but couldn\'t locate its CDP target');
    sessionsRef.current.set('e', { brain, targetId: cdpId });
    syncSessionsList();
  }, [appendMsg]);

  const persistEThreadUrl = useCallback(async () => {
    const e = sessionsRef.current.get('e');
    if (!e) return;
    try {
      const tabs = await listTabs();
      const liveTab = tabs.find(t => t.id === e.targetId);
      if (!liveTab?.url) return;
      const brainType = e.brain.name || E_BRAIN_DEFAULT;
      await chrome.storage.local.set({
        egpt_thread: { brain_type: brainType, url: liveTab.url },
      });
    } catch (_) { /* non-fatal */ }
  }, []);

  // Restore 'e' session on startup if a saved URL matches an open tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const got = await chrome.storage.local.get('egpt_thread');
        const saved = got?.egpt_thread;
        if (!saved?.url || cancelled) return;
        const brain = BRAINS[saved.brain_type || E_BRAIN_DEFAULT];
        if (!brain) return;
        const tabs = await listTabs();
        const m = tabs.find(t => t.url === saved.url || t.url.startsWith(saved.url));
        if (m && !cancelled) {
          sessionsRef.current.set('e', { brain, targetId: m.id });
          syncSessionsList();
          appendMsg('egpt', `@e: restored thread (tab ${m.id.slice(0, 8)}…)`, { noMirror: true });
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [appendMsg]);

  // ── brain submission ──────────────────────────────────────────

  // Telegram bridge sends with parse_mode: 'HTML', so any text we hand it
  // must be HTML-safe. Brain replies can contain raw < > & — escape them.
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const runBrain = useCallback(async (sessionName, prompt, { tgChatId, sender, replyTo } = {}) => {
    const session = sessionsRef.current.get(sessionName);
    if (!session) { appendMsg('egpt', `No session "${sessionName}" attached.`); return null; }

    // Tag the prompt with [YYYY-MM-DD HH:MM <sender>]: so the brain
    // can follow multi-user conversations AND temporal cadence (was
    // this 2 minutes ago or 2 hours ago — answers like "today", "just
    // now", "yesterday" become possible). Skip the prefix for empty
    // prompts and when the caller didn't supply a sender (legacy
    // callers — local typing without attribution context).
    const stampNow = (() => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    })();
    const taggedPrompt = (sender && prompt) ? `[${stampNow} ${sender}]: ${prompt}` : prompt;

    const msgId = appendMsg(sessionName, '⌛ thinking…', { streaming: true });
    const tgPrefix = `<b>${escapeHtml(sessionName)}@${SURFACE_TAG}</b>`;
    const tgStream = bridgeRef.current?.startStreamMessage?.(`${tgPrefix}\n⌛ thinking…`, { chatId: tgChatId });

    try {
      const finalText = await session.brain.stream(
        { message: taggedPrompt },
        partial => {
          updateMsg(msgId, partial, true);
          tgStream?.update(`${tgPrefix}\n${escapeHtml(partial)}`);
        },
        { targetId: session.targetId },
      );
      updateMsg(msgId, finalText, false);
      tgStream?.finish(`${tgPrefix}\n${escapeHtml(finalText)}`);
      return finalText ?? '';
    } catch (e) {
      const err = `error: ${e.message}`;
      updateMsg(msgId, err, false);
      bridgeRef.current?.send(`${tgPrefix}\n${escapeHtml(err)}`, { chatId: tgChatId });
      return null;
    }
  }, [appendMsg, updateMsg]);

  // ── incoming Telegram messages ────────────────────────────────

  const handleIncoming = useCallback(async (text, meta) => {
    const author = meta.username ? `@${meta.username}` : (meta.firstName ?? 'human');
    appendMsg(author, text);

    const trimmed = text.trim();
    const parsed = parseInput(trimmed);
    const isCommand = parsed.type === 'command' || parsed.type === 'mention';

    if (isCommand && !meta.authorized) {
      bridgeRef.current?.send(
        `${author} (${meta.userId}) is not authorized to emit commands or mentions`
      );
      return;
    }

    // Replicate every Telegram message to peers — every message in the
    // room is part of the room. via:'telegram[chatId]' tags the surface
    // of origin so peers see where it came from, not the node carrying
    // the bot. Slash commands stay local (operator tooling).
    {
      const tid = busTargetIdRef.current;
      const isSlashCommand = trimmed.startsWith('/');
      if (tid && !isSlashCommand) {
        // client: 'tg' here because this is the extension forwarding a
        // Telegram-originated message. Peers render 'handle@tg' rather
        // than the longer 'telegram[chatId]'.
        bus.postEvent(tid, {
          type: 'room-utterance', from: BUS_NODE_ID, ts: Date.now(),
          role: 'chrome', user: author, body: trimmed,
          client: 'tg',
          via: `telegram[${meta.chatId ?? '?'}]`,
        }).catch(() => {});
      }
    }

    if (parsed.type === 'command') {
      // Route slash commands (e.g. /telegram extension) through the command
      // handler so Telegram users can drive the room from off-LAN. Resolved
      // via ref because handleCommand is declared later in the file.
      //
      // Set the output sink so anything the command writes via
      // appendMsg('egpt', …) — help text, /config readouts, errors,
      // hints — mirrors back to the originating Telegram chat. Without
      // this the user saw their slash command in TG with no reply, even
      // though the extension UI rendered the response. Symmetric to the
      // wa-cdp sink wired in handleSubmit.
      const sinkPrev = currentOutputSinkRef.current;
      currentOutputSinkRef.current = (out) => {
        try { bridgeRef.current?.send(out, { chatId: meta.chatId }); } catch (_) {}
      };
      try { await handleCommandRef.current?.(trimmed); }
      finally { currentOutputSinkRef.current = sinkPrev; }
      return;
    }
    if (parsed.type === 'mention') {
      const name = parsed.target;
      const prompt = parsed.body || trimmed;
      if (sessionsRef.current.has(name)) {
        runBrain(name, prompt, { tgChatId: meta.chatId });
      } else {
        // Try peer routing.
        const peerMatches = [];
        for (const [nodeId, peer] of peerNodesRef.current) {
          if (peer.sessions?.some(s => s.name === name)) peerMatches.push(nodeId);
        }
        if (peerMatches.length === 1) {
          const tid = busTargetIdRef.current;
          if (tid) {
            try {
              await bus.postEvent(tid, {
                type: 'mention', from: BUS_NODE_ID, ts: Date.now(),
                target: name, to_node: peerMatches[0], body: prompt, user: author,
                ...(meta.chatId ? { tg_chat_id: meta.chatId } : {}),
              });
            } catch (_) {}
          }
        }
      }
      return;
    }

    // Plain message — check mirror setting
    const { telegram } = await chrome.storage.sync.get('telegram');
    const mirror = telegram?.mirror ?? 'none';
    const canMirror =
      mirror === 'all' ||
      (mirror === 'allowed' && meta.authorized);

    if (canMirror && activeSessions.length > 0) {
      for (const name of activeSessions) {
        runBrain(name, text, { tgChatId: meta.chatId });
      }
    }
  }, [appendMsg, runBrain, activeSessions]);

  const handleIncomingRef = useRef(handleIncoming);
  handleIncomingRef.current = handleIncoming;

  // ── slash commands ────────────────────────────────────────────

  const handleCommand = useCallback(async (cmd) => {
    const parts = cmd.slice(1).split(/\s+/);
    const slash = '/' + parts[0];
    appendMsg('egpt', `> ${cmd}`);

    // Forward `cmd` verbatim to a shell peer over the bus. Used both for
    // commands the extension doesn't implement at all and for /attach or
    // /open against a brain the extension can't host.
    const forwardToShell = async () => {
      const shellPeer = [...peerNodesRef.current.entries()]
        .find(([_, p]) => p.role === 'shell');
      if (!shellPeer) {
        appendMsg('egpt', `!! no shell node on the bus to run ${slash} — start an egpt shell on this LAN`);
        return;
      }
      const [shellNodeId] = shellPeer;
      const tid = busTargetIdRef.current;
      if (!tid) {
        appendMsg('egpt', `!! bus not joined — can't forward ${slash}`);
        return;
      }
      try {
        await bus.postEvent(tid, {
          type: 'command', from: BUS_NODE_ID, ts: Date.now(),
          to_node: shellNodeId, cmd, user: userName,
        });
        appendMsg('egpt', `${slash} -> ${shellNodeId} via bus`);
      } catch (e) {
        appendMsg('egpt', `!! forward failed: ${e.message}`);
      }
    };

    // Commands belong to the room, not the platform. If a known command
    // isn't implemented locally, forward it to a shell peer.
    if (COMMAND_SET.has(slash) && !EXT_COMMAND_SET.has(slash)) {
      await forwardToShell();
      return;
    }

    // /attach <brain> and /open <brain> against a shell-only brain (codex,
    // claude-code) — the extension can host CDP brains only, so the user's
    // intent here is unambiguous: run it where it can run.
    if ((slash === '/attach' || slash === '/open') && parts[1]) {
      const brainType = canonicalBrain(parts[1]);
      if (SHELL_ONLY_BRAINS.has(brainType)) {
        await forwardToShell();
        return;
      }
    }

    // Every locally-implemented slash command is now an entry in a
    // dispatch table that calls the pure handler from the extracted
    // commands/* modules. The React layer's only job here is to
    // assemble a `ctx` that wires pure deps to the live refs / chrome
    // APIs. Any handler can be exercised in isolation in tests by
    // passing a mock ctx — see tests/{wa,session,misc}-commands.test.mjs.
    const rest = parts.slice(1).join(' ');
    const log    = (text) => appendMsg('egpt', text);
    const error  = (text) => appendMsg('egpt', `!! ${text}`);
    const baseCtx = {
      log, error,
      getSessions: () => sessionsRef.current,
      setSession:  (name, value) => {
        if (value == null) sessionsRef.current.delete(name);
        else sessionsRef.current.set(name, value);
      },
      syncSessionsList,
      getActiveSessions: () => activeSessions,
      setActiveSessions: (arr) => setActiveSessions(arr),
      getPeerNodes: () => peerNodesRef.current,
    };
    const sessionCtx = {
      ...baseCtx,
      brains: BRAINS,
      canonicalBrain,
      nextSessionName,
      listTabs,
      createTab: (opts) => chrome.tabs.create(opts),
      waitForTabLoad,
      resolveTabSpec,
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    };
    const configCtx = {
      log,
      storageSync:  chrome.storage.sync,
      storageLocal: chrome.storage.local,
      onTelegramConfigChange: () => startBridge(),
    };
    const tgCtx = {
      log, error,
      storageSync:  chrome.storage.sync,
      getNodeId:    () => BUS_NODE_ID,
      getTgPolling: () => tgPolling,
      startBridge:  () => startBridge(),
      stopBridge:   () => stopBridge(),
      getPeerNodes: () => peerNodesRef.current,
      busTargetId:  () => busTargetIdRef.current,
      postBusEvent: (tid, ev) => bus.postEvent(tid, ev),
    };
    const uiCtx = {
      log,
      clearMessages: () => setMessages([]),
      getBrainNames: () => Object.keys(BRAINS),
      formatHelp:    (names) => helpText(names),
    };
    const busKeyCtx = {
      log, error,
      storageLocal: chrome.storage.local,
      generateKey:  generateBusKey,
    };

    switch (slash) {
      // session-management
      case '/use':       await sessionCommands.use(rest, sessionCtx); break;
      case '/sessions':  await sessionCommands.sessions(rest, sessionCtx); break;
      case '/detach':    await sessionCommands.detach(rest, sessionCtx); break;
      case '/tabs':      await sessionCommands.tabs(rest, sessionCtx); break;
      case '/open':      await sessionCommands.open(rest, sessionCtx); break;
      case '/attach':    await sessionCommands.attach(rest, sessionCtx); break;
      // misc
      case '/config':    await miscCommands.config(rest, configCtx); break;
      case '/telegram':  await miscCommands.telegram(rest, tgCtx); break;
      case '/clear':     await miscCommands.clear(rest, uiCtx); break;
      case '/help':      await miscCommands.help(rest, uiCtx); break;
      case '/bus-key':   await miscCommands.busKey(rest, busKeyCtx); break;
      default:
        error(`unknown command: ${slash}`);
    }
  }, [activeSessions, appendMsg, userName, runBrain, ensureEThread, persistEThreadUrl, syncSessionsList, tgPolling]);

  handleCommandRef.current = handleCommand;

  // ── submit handler ────────────────────────────────────────────

  const handleSubmit = useCallback(async (text, opts = {}) => {
    // fromBridge: this input came from a bridge (e.g. WA content
    // script) and was already published to the bus by that bridge.
    // Skip our own bus post and bridge-mirror to avoid echoing the
    // user's own typed input back at them.
    // sender: used by runBrain to prefix the prompt as '[sender]: ...'
    // so brains can follow multi-user attribution. For local typing,
    // sender defaults to userName at dispatch sites.
    const { fromBridge = null } = opts;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Mirror to peer surfaces so the room shows what's happening
    // regardless of which surface someone is looking at. Pure
    // visibility — peers render the line and do NOT re-route.
    //
    // Slash commands skip the bus (operator tooling, channel-
    // specific). Otherwise peers would mirror them to telegram / WA
    // as conversational noise.
    if (!fromBridge) {
      const tid = busTargetIdRef.current;
      const isSlashCommand = trimmed.startsWith('/');
      if (tid && !isSlashCommand) {
        bus.postEvent(tid, {
          type: 'room-utterance', from: BUS_NODE_ID, ts: Date.now(),
          role: 'chrome', user: userName, body: trimmed,
          client: 'ext',
        }).catch(() => {});
      }
    }

    const parsed = parseInput(trimmed);

    // Pure routing decision via the shared room nucleus. Same module the
    // shell uses, so command/mention/peer-forward/broadcast/error semantics
    // can't drift between surfaces.
    const sessionsView = new Map(
      [...sessionsRef.current.entries()].map(([n, s]) => [n, { brainName: s.brain.name }]),
    );
    const peerSessionsView = new Map(
      [...peerNodesRef.current.entries()].map(([id, p]) => [id, p.sessions ?? []]),
    );
    const decision = resolveRoute(parsed, trimmed, {
      sessions: sessionsView,
      peerSessions: peerSessionsView,
      brainForName,
      canonicalBrainName: canonicalBrain,
      activeSessions,
    });

    // Set the output sink so 'egpt' messages (commands, errors, hints)
    // mirror back to the originating bridge for the duration of this
    // dispatch. Try/finally guarantees the sink clears even on throw.
    const sinkPrev = currentOutputSinkRef.current;
    try {
      if (decision.kind === 'command') { await handleCommand(trimmed); return; }

    // Local echo of the user's own typed input. When fromBridge, the
    // originating bridge already appended the message with its own
    // author tag, so skip the second append here.
    if (!fromBridge) {
      appendMsg(userName, trimmed);
    }

    if (decision.kind === 'error') { appendMsg('egpt', `!! ${decision.message}`); return; }
    if (decision.kind === 'empty') {
      // No local sessions. Peers may still be in the room — the
      // room-utterance posted at the top already mirrored what was
      // typed. No nag: silent return.
      return;
    }
    if (decision.kind === 'idle') {
      // Plain text but no /use'd sessions. Bridge-originated input
      // gets no hint — same logic as 'empty' above.
      if (!fromBridge) {
        const names = [...sessionsRef.current.keys()].slice(0, 3).join(', ') || '(none)';
        appendMsg('egpt', `message stayed in the room — no active brain. Address one with @<name> (e.g. ${names}), or /use <name> (single) or /use a,b,c (multi-AI) for plain-text routing.`);
      }
      return;
    }
    if (decision.kind === 'persona') {
      // @egpt resolution order:
      //   1. shell peer on bus → forward mention; shell runs its
      //      configured default_brain (claude-code / codex).
      //   2. no shell → use the dedicated 'e' session, bound to a
      //      specific chatgpt.com /c/<uuid> conversation URL saved
      //      in chrome.storage.local. Auto-open on first use; on
      //      subsequent uses the same thread is resumed for true
      //      conversational continuity.
      const shellPeer = [...peerNodesRef.current.entries()]
        .find(([_, p]) => p.role === 'shell');

      if (shellPeer) {
        const [shellNodeId] = shellPeer;
        const tid = busTargetIdRef.current;
        if (!tid) { appendMsg('egpt', `!! bus not joined — can't forward @egpt`); return; }
        try {
          await bus.postEvent(tid, {
            type: 'mention', from: BUS_NODE_ID, ts: Date.now(),
            target: 'egpt', to_node: shellNodeId,
            body: decision.body, user: userName,
          });
          appendMsg('egpt', `@egpt -> ${shellNodeId} via bus`);
        } catch (e) {
          appendMsg('egpt', `!! @egpt forward failed: ${e.message}`);
        }
        return;
      }

      // Local fallback — ensure the 'e' session exists and dispatch.
      // Sender comes from opts.sender if provided (bridge dispatch),
      // else from the local userName (extension typing). replyTo
      // routes the WA mirror back to the originating chat instead
      // of the configured chat_name.
      try {
        await ensureEThread();
        await runBrain('e', decision.body, {
          sender:  opts.sender   ?? userName,
          replyTo: opts.fromChat ?? null,
        });
        await persistEThreadUrl();
      } catch (e) {
        appendMsg('egpt', `!! @egpt failed: ${e.message}`);
      }
      return;
    }
    if (decision.kind === 'peer-mention') {
      const tid = busTargetIdRef.current;
      if (!tid) { appendMsg('egpt', `!! bus not joined — can't forward @${decision.target}`); return; }
      try {
        await bus.postEvent(tid, {
          type: 'mention', from: BUS_NODE_ID, ts: Date.now(),
          target: decision.target, to_node: decision.toNode,
          body: decision.body, user: userName,
        });
        appendMsg('egpt', `@${decision.target} -> ${decision.toNode} via bus`);
      } catch (e) {
        appendMsg('egpt', `!! forward failed: ${e.message}`);
      }
      return;
    }
    if (decision.kind === 'auto-open') {
      // The extension only carries CDP brains; auto-open is for local
      // operators (codex, claude-code) which live in the shell. If we ever
      // see this here, the user wants a brain this surface can't host.
      appendMsg('egpt', `!! @${decision.originalToken} needs a shell node — /open ${decision.brainName} on the shell, or address an existing tab here`);
      return;
    }

    // decision.kind === 'turn' — broadcast or single recipient.
    const recipients = decision.recipients;
    if (decision.broadcast) {
      appendMsg('egpt', `broadcasting to ${recipients.length} session(s): ${recipients.join(', ')}`);
    }
    const replies = [];
    for (const recipient of recipients) {
      const reply = await runBrain(recipient, decision.payload, {
        sender:  opts.sender   ?? userName,
        replyTo: opts.fromChat ?? null,
      });
      if (reply !== null && reply !== undefined) {
        replies.push({ author: recipient, text: reply });
        // Broadcast brain reply to peers — the room is noisy by design.
        const tid = busTargetIdRef.current;
        if (tid) {
          bus.postEvent(tid, {
            type: 'room-reply', from: BUS_NODE_ID, ts: Date.now(),
            role: 'chrome', session: recipient, body: reply,
          }).catch(() => {});
        }
      }
    }

    // Phase B — one-hop CDP-to-CDP mirroring. planMirrors decides which
    // (recipient, message) pairs need a mirror push.
    const mirrorSessions = new Map(
      [...sessionsRef.current.entries()].map(([n, s]) => [n, { brainName: s.brain.name }]),
    );
    const mirrorPlan = planMirrors(replies, recipients, mirrorSessions, brainForName);
    if (mirrorPlan.length > 0) {
      appendMsg('egpt', `mirroring ${mirrorPlan.length} reply/replies to other CDP brains…`);
      for (const { to, message } of mirrorPlan) {
        await runBrain(to, message);
      }
    }
    } finally {
      // Restore the prior sink (usually null) so post-dispatch
      // appendMsg('egpt', ...) calls (e.g. unrelated bus events) don't
      // accidentally route to the bridge of a stale prior dispatch.
      currentOutputSinkRef.current = sinkPrev;
    }
  }, [appendMsg, handleCommand, runBrain, userName]);

  // Stable ref so cross-render callers can route input through the latest
  // handleSubmit without re-creating the bridge wiring on every dep change.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // ── Telegram bridge ───────────────────────────────────────────

  const startBridge = useCallback(async () => {
    bridgeRef.current?.stop();
    bridgeRef.current = null;
    const { telegram } = await chrome.storage.sync.get('telegram');
    if (!telegram?.bot_token) {
      setTgStatus('no bot token — add one in Settings');
      setTgPolling(false);
      return false;
    }
    const bridge = startTelegramBridge({
      botToken:     telegram.bot_token,
      nodeName:     'chrome',
      allowedUsers: telegram.allowed_users ?? [],
      chatId:       telegram.chat_id ?? null,
      onIncoming:   (text, meta) => handleIncomingRef.current(text, meta),
      onLog:        msg => setTgStatus(msg),
      onError:      msg => appendMsg('egpt', `⚠ ${msg}`),
      onYield:      () => {
        // Another node holds the polling slot. Drop our bridge state;
        // the dispatcher's auto-claim will retry when the holder
        // releases (peer node-offline or telegram-status:false).
        bridgeRef.current = null;
        setTgPolling(false);
        setTgStatus('yielded — another node is polling');
        appendMsg('egpt', `telegram: yielded — another node holds the polling slot. Will auto-resume when they release; /telegram ${BUS_NODE_ID} to force-reclaim.`);
      },
      onChatId: async (id) => {
        // First captured chat — persist to chrome.storage.sync so
        // future runs know the outbound target.
        try {
          const { telegram = {} } = await chrome.storage.sync.get('telegram');
          if (telegram.chat_id === id) return;
          await chrome.storage.sync.set({
            telegram: { ...telegram, chat_id: id },
          });
          appendMsg('egpt', `telegram: outbound chat ${id} captured and saved`, { noMirror: true });
        } catch (e) {
          appendMsg('egpt', `!! telegram: could not persist chat_id (${e.message})`, { noMirror: true });
        }
      },
    });
    bridgeRef.current = bridge;
    setTgPolling(true);
    return true;
  }, [appendMsg]);

  const stopBridge = useCallback(() => {
    if (!bridgeRef.current) return false;
    bridgeRef.current.stop();
    bridgeRef.current = null;
    setTgPolling(false);
    setTgStatus('disconnected');
    return true;
  }, []);

  // Load identity on mount; restart bridge when storage changes externally (settings page)
  useEffect(() => {
    chrome.storage.sync.get(['userName', 'node_name'], cfg => {
      if (cfg.userName) setUserName(cfg.userName);
      if (cfg.node_name) {
        BUS_NODE_ID = cfg.node_name;
        SURFACE_TAG = cfg.node_name;
      }
      setNodeNameReady(true);
    });

    const onChange = async (changes) => {
      if (changes.userName) setUserName(changes.userName.newValue ?? 'human');
      if (changes.telegram) startBridge();
      if (changes.node_name) {
        // Live rename: drop old node-offline, swap BUS_NODE_ID +
        // SURFACE_TAG, re-announce node-online. Past rendered rows keep
        // their original tag; new ones get the new tag.
        const newName = changes.node_name.newValue;
        const oldName = BUS_NODE_ID;
        if (newName && newName !== oldName) {
          const tid = busTargetIdRef.current;
          if (tid) {
            try { await bus.postEvent(tid, { type: 'node-offline', from: oldName, ts: Date.now() }); } catch (_) {}
          }
          BUS_NODE_ID = newName;
          SURFACE_TAG = newName;
          if (tid) {
            const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
              name: n, brain: s.brain.name,
            }));
            try {
              await bus.postEvent(tid, {
                type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'chrome',
                sessions: sessionsList, polling: tgPolling,
              });
            } catch (_) {}
          }
        }
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [startBridge]);

  useEffect(() => {
    // Shell-priority policy: if a shell peer is already on the bus
    // when the extension boots, don't start polling — the shell is
    // the natural Telegram owner (it also runs WA, brains, file
    // logging). When the shell later goes offline, the bus-event
    // auto-claim logic will pick this up. When no shell is around,
    // the extension polls opportunistically and yields the moment
    // a shell announces (see node-online handler above).
    const shellOnBus = [...peerNodesRef.current.values()].some(p => p.role === 'shell');
    if (shellOnBus) {
      setTgStatus('idle — shell peer holds telegram');
      return () => bridgeRef.current?.stop();
    }
    startBridge();
    return () => bridgeRef.current?.stop();
  }, [startBridge]);

  // ── CDP control-plane bus ─────────────────────────────────────
  // The extension and the egpt shell coordinate via a tab in the brain
  // Chrome that serves bus.html. node-online announces presence; mention
  // forwards `@<remote-session>` to the owning node; telegram-handoff
  // transfers polling. Long content (brain replies, files) does NOT travel
  // here — only short control events.
  useEffect(() => {
    if (!nodeNameReady) return;  // wait for node_name from storage before announcing
    let cancelled = false;
    let lastErrorMsg = null;

    const tryConnect = async () => {
      if (cancelled || busSubRef.current) return;
      try {
        // bus-ext.js (chrome.debugger adapter) already opens the
        // extension's bundled bus.html via chrome.runtime.getURL.
        // chrome.debugger.attach is the privileged API that lets us
        // CDP-attach to chrome-extension://<id>/bus.html — raw WS
        // upgrades to those URLs are rejected by Chrome, which is why
        // we route extension-side CDP through chrome.debugger
        // instead of the unified WebSocket path the shell uses.
        const located = await bus.findOrOpenBusTab();
        if (cancelled || !located) return;
        busTargetIdRef.current = located.targetId;
        const sub = await bus.subscribeBusEvents(located.targetId, (ev) => {
          if (cancelled) return;
          handleBusEventRef.current?.(ev);
        });
        if (cancelled) { sub.stop?.(); return; }
        busSubRef.current = sub;
        // Initial announce. Peers pong back so we discover them too.
        const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
          name: n, brain: s.brain.name,
        }));
        await bus.postEvent(located.targetId, {
          type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'chrome',
          sessions: sessionsList, polling: false,
        });
        // Broadcast the @e thread the extension is currently bound to,
        // so a peer shell can adopt the same conversation. Shape:
        //   { brain_type, url } — both required. brain_type is one of
        //   'chatgpt-cdp' / 'claude-cdp'. The shell side's
        //   persona-state.setBrain consumes this directly.
        try {
          const got = await chrome.storage.local.get('egpt_thread');
          const saved = got?.egpt_thread ?? null;
          if (saved && saved.url && saved.brain_type) {
            await bus.postEvent(located.targetId, {
              type: 'egpt-thread', from: BUS_NODE_ID, ts: Date.now(),
              brain_type: saved.brain_type, url: saved.url,
            });
          }
        } catch (_) {}
        appendMsg('egpt', located.opened ? 'bus tab opened' : 'bus tab attached', { noMirror: true });
        lastErrorMsg = null;
      } catch (e) {
        // Surface the failure once per error message — we retry on a
        // 5s interval, so without dedup the UI would fill with the
        // same 'bus: not joined' line every tick when the shell /
        // proxy is down. Reset on success or on a different error.
        if (e.message !== lastErrorMsg) {
          lastErrorMsg = e.message;
          appendMsg('egpt', `bus: not joined (${e.message}). Will retry every 5s — start the egpt shell to bring the proxy up.`);
        }
      }
    };

    tryConnect();
    // Poll every 5s until busSubRef is set. Cheap (one /json/version
    // when reachable; one fetch+immediate-failure when not). Auto-
    // recovers if the shell starts after the extension tab opened.
    const pollHandle = setInterval(tryConnect, 5000);
    return () => {
      cancelled = true;
      clearInterval(pollHandle);
      const tid = busTargetIdRef.current;
      const sub = busSubRef.current;
      busTargetIdRef.current = null;
      busSubRef.current = null;
      (async () => {
        if (tid) {
          try { await bus.postEvent(tid, { type: 'node-offline', from: BUS_NODE_ID }); } catch (_) {}
        }
        sub?.stop?.();
      })();
    };
  }, [appendMsg, nodeNameReady]);

  // Bus dispatcher — refreshed each render so it always sees current state.
  handleBusEventRef.current = async (ev) => {
    if (ev.from === BUS_NODE_ID) return;
    const log = (m) => appendMsg('egpt', m);
    const post = async (event) => {
      const tid = busTargetIdRef.current;
      if (!tid) return;
      try { await bus.postEvent(tid, { ts: Date.now(), from: BUS_NODE_ID, ...event }); } catch (_) {}
    };
    // Bus-flood notices come from bus-ext.js (not from any peer) when
    // a flood of identical messages is detected. Render as plain egpt
    // system messages so the user knows what got swallowed. The
    // detector never lets a single flood event through, so these are
    // the ONLY visible record of the flood — by design, per user:
    // 'just say the number, if user is interested they can reload'.
    if (ev.type === 'bus-flood-start') {
      appendMsg('egpt', ev.body, { noMirror: true });
      return;
    }
    if (ev.type === 'bus-flood-end') {
      appendMsg(
        'egpt',
        `${ev.body}. /reload bus to recover them from the bus tab.`,
        { noMirror: true },
      );
      return;
    }
    switch (ev.type) {
      case 'node-online': {
        peerNodesRef.current.set(ev.from, {
          role: ev.role, sessions: ev.sessions ?? [],
          polling: !!ev.polling, lastSeen: ev.ts ?? Date.now(),
        });
        setPeersRev(r => r + 1);
        if (!ev._replayed) {
          log(`bus: peer online ${ev.from}${ev.role ? ` (${ev.role})` : ''}${ev.polling ? ' [polling]' : ''}`);
        }
        // Telegram yield: when a shell joins the bus, hand TG polling
        // over. The shell is the canonical compute home for bridges;
        // the extension only holds the slot opportunistically while no
        // shell is around. stopBridge() flips tgPolling false; the
        // telegram-status broadcast effect then notifies the shell,
        // which auto-claims on the next tick.
        if (ev.role === 'shell' && bridgeRef.current && !ev._replayed) {
          appendMsg('egpt', `telegram: yielding to shell ${ev.from}`);
          stopBridge();
        }
        // Skip pong on replayed events — peers already heard our live
        // announce when we joined; this would be bus noise.
        if (!ev.pong && !ev._replayed) {
          const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
            name: n, brain: s.brain.name,
          }));
          await post({ type: 'node-online', role: 'chrome', pong: true,
            sessions: sessionsList, polling: tgPolling });
        }
        return;
      }
      case 'node-offline': {
        const wasPolling = !!peerNodesRef.current.get(ev.from)?.polling;
        peerNodesRef.current.delete(ev.from);
        setPeersRev(r => r + 1);
        log(`bus: peer offline ${ev.from}`);
        // Polling slot opened — try to claim if we have a bot token
        // configured but aren't currently bridged.
        if (wasPolling && !bridgeRef.current) {
          const delay = 500 + Math.random() * 1500;
          setTimeout(() => { if (!bridgeRef.current) startBridge(); }, delay);
        }
        return;
      }
      case 'sessions-update': {
        const peer = peerNodesRef.current.get(ev.from);
        if (peer) { peer.sessions = ev.sessions ?? []; peer.lastSeen = ev.ts ?? Date.now(); }
        setPeersRev(r => r + 1);
        return;
      }
      case 'telegram-status': {
        const peer = peerNodesRef.current.get(ev.from);
        const wasPolling = !!peer?.polling;
        if (peer) { peer.polling = !!ev.polling; peer.lastSeen = ev.ts ?? Date.now(); }
        setPeersRev(r => r + 1);
        // Peer voluntarily released. Same auto-claim as node-offline.
        if (wasPolling && !ev.polling && !bridgeRef.current) {
          const delay = 500 + Math.random() * 1500;
          setTimeout(() => { if (!bridgeRef.current) startBridge(); }, delay);
        }
        return;
      }
      case 'mention': {
        if (ev.to_node !== BUS_NODE_ID) return;
        if (!sessionsRef.current.has(ev.target)) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: `no session "${ev.target}" in extension`,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          return;
        }
        log(`bus: running ${ev.target} for ${ev.from}${ev.user ? ` (${ev.user})` : ''}`);
        const session = sessionsRef.current.get(ev.target);
        try {
          const finalText = await session.brain.stream(
            { message: `[${ev.user ?? 'remote'}]: ${ev.body}` },
            () => {}, { targetId: session.targetId },
          );
          // Directed reply to the asker. Echo tg_chat_id so the asker
          // routes back to the originating Telegram chat.
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, body: finalText ?? '',
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          // Room-visible echo so every peer sees it. The asker gets
          // both this and the directed mention-reply above; we don't
          // filter — rooms are noisy by design.
          if (finalText !== null && finalText !== undefined) {
            await post({ type: 'room-reply', role: 'chrome',
              session: ev.target, body: finalText });
          }
        } catch (e) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: e.message,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
        }
        return;
      }
      case 'mention-reply': {
        if (ev.to_node !== BUS_NODE_ID) return;
        const target = ev.target ?? ev.from;
        // ev.from carries the peer's BUS_NODE_ID (auto-gen 'shell-13232'
        // or user-named 'home') — use it directly as the surface tag.
        const author = `${target}@${ev.from ?? 'unknown'}`;
        if (ev.error) {
          log(`!! ${author}: ${ev.error}`);
          if (ev.tg_chat_id && bridgeRef.current) {
            bridgeRef.current.send(`!! ${escapeHtml(`${author}: ${ev.error}`)}`,
              { chatId: ev.tg_chat_id });
          }
        } else {
          appendMsg(author, ev.body ?? '(empty)');
          // tg_chat_id means the original request came from a Telegram
          // chat; route the reply back there directly.
          if (ev.tg_chat_id && bridgeRef.current) {
            bridgeRef.current.send(`<b>${escapeHtml(author)}</b>\n${escapeHtml(ev.body ?? '')}`,
              { chatId: ev.tg_chat_id });
          }
        }
        return;
      }
      case 'room-utterance': {
        // Faithful echo of what a user typed on another surface.
        // Tag: handle@client[.node]. ev.client carries the client_name
        // (post-Phase 1); fall back to deriving from ev.via for older
        // peers (telegram[chat]/whatsapp[chat] -> 'tg'/'wa').
        const fallbackClient =
          ev.via?.startsWith?.('telegram') ? 'tg'
          : ev.via?.startsWith?.('whatsapp') ? 'wa'
          : null;
        const client = ev.client ?? fallbackClient;
        const handle = String(ev.user ?? 'human').replace(/^@/, '');
        const node = ev.from;
        const tag = client
          ? (node && node !== BUS_NODE_ID ? `${handle}@${client}.${node}` : `${handle}@${client}`)
          : `${handle}@${node ?? 'unknown'}`;
        appendMsg(tag, ev.body ?? '');
        // Mirror to telegram if THIS node owns the polling slot AND the
        // event didn't originate from telegram itself (no echo loop).
        // Other origins — whatsapp, shell, extension brain — should
        // surface in the TG bot view as part of the play-script.
        const fromTelegram = String(ev.via ?? '').startsWith('telegram');
        if (bridgeRef.current && !fromTelegram) {
          bridgeRef.current.send(
            `<b>${escapeHtml(tag)}</b>\n${escapeHtml(ev.body ?? '')}`
          );
        }
        return;
      }
      case 'room-reply': {
        // Brain or persona reply from a peer. Render with
        // session@node tag. Don't filter by asker — rooms are noisy
        // by design. Same telegram-origin skip as room-utterance: if
        // the reply was already direct-sent to a TG chat (via tagged
        // 'telegram[chat]'), don't echo it back through this bridge.
        const tag = `${ev.session ?? '?'}@${ev.from ?? 'unknown'}`;
        appendMsg(tag, ev.body ?? '');
        const fromTelegram = String(ev.via ?? '').startsWith('telegram');
        if (bridgeRef.current && !fromTelegram) {
          bridgeRef.current.send(
            `<b>${escapeHtml(tag)}</b>\n${escapeHtml(ev.body ?? '')}`
          );
        }
        return;
      }
      case 'telegram-handoff': {
        if (ev.to !== BUS_NODE_ID) {
          if (tgPolling) stopBridge();
          return;
        }
        log(`bus: handoff request from ${ev.from} — starting bridge`);
        const ok = await startBridge();
        if (!ok) log('!! could not start bridge — check bot token in Settings');
        return;
      }
      default:
        log(`bus: ${ev.type} from ${ev.from ?? '?'}`);
    }
  };

  // Broadcast our local sessions to the bus on change.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
      name: n, brain: s.brain.name,
    }));
    bus.postEvent(tid, {
      type: 'sessions-update', from: BUS_NODE_ID, ts: Date.now(),
      sessions: sessionsList,
    }).catch(() => {});
  }, [sessionsList]);

  // Broadcast our polling state on change.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    bus.postEvent(tid, {
      type: 'telegram-status', from: BUS_NODE_ID, ts: Date.now(),
      polling: tgPolling,
    }).catch(() => {});
  }, [tgPolling]);

  // ── auto-scroll ───────────────────────────────────────────────

  useEffect(() => {
    if (convRef.current) convRef.current.scrollTop = convRef.current.scrollHeight;
  }, [messages]);

  // ── render ────────────────────────────────────────────────────

  const authorClass = (author) =>
    author === userName ? 'you'
      : author === 'egpt' ? 'egpt' : 'brain';

  return (
    <div id="egpt-app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div className="status-bar">
        <span className="status-brand">egpt</span>
        <span className="status-sessions">
          {sessionsList.length === 0
            ? 'no sessions'
            : sessionsList.map(s => activeSessions.includes(s.name) ? `*${s.name}` : s.name).join('  ')}
        </span>
        <span className="status-tg">{tgStatus}</span>
      </div>

      <div className="conversation" ref={convRef}>
        {messages.map(m => {
          // Always show @whereami so it's clear which surface uttered the
          // line. Peer-rendered authors already include '@<peer-id>';
          // bare local authors get our SURFACE_TAG appended.
          const displayAuthor = m.author.includes('@') ? m.author : `${m.author}@${SURFACE_TAG}`;
          return (
          <div key={m.id} className="msg">
            <span className={`msg-author ${authorClass(m.author)}`}>{displayAuthor}</span>
            <div className={`msg-body${m.streaming ? ' streaming' : ''}`}>{m.text}</div>
          </div>);
        })}
      </div>

      <div className="input-area">
        <Input onSubmit={handleSubmit} activeSessions={activeSessions} />
      </div>
    </div>
  );
}
