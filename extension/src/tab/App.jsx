import { useState, useEffect, useRef, useCallback } from 'react';
import Input from './Input.jsx';
import { startTelegramBridge } from '../../../bridges/telegram.mjs';
import * as chatgptCdp from '../../../brains/chatgpt-cdp.mjs';
import * as claudeCdp from '../../../brains/claude-cdp.mjs';
import { listTabs } from '../tools/cdp-ext.js';
import * as bus from '../../../tools/bus.mjs';
import { parseInput, helpText, COMMAND_SET, commandSetFor } from '../../../interpreter.mjs';

// Identifier this extension instance uses on the bus. UUID-ish so
// reloads don't collide.
const BUS_NODE_ID = `ext-${Math.random().toString(36).slice(2, 10)}`;

// Use the same brain names as the shell so /help and /open/@-mentions
// match across surfaces. Aliases let the user type the short form too.
const BRAINS = {
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
};
const BRAIN_ALIASES = { chatgpt: 'chatgpt-cdp', claude: 'claude-cdp' };
const canonicalBrain = (n) => BRAIN_ALIASES[n] ?? n;

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
  const [activeSession, setActiveSession] = useState(null);
  const [tgStatus, setTgStatus] = useState('not connected');
  const [userName, setUserName] = useState('human');
  // Whether THIS extension currently owns Telegram polling. /telegram <node>
  // hands off; bus event 'telegram-handoff' may start/stop us.
  const [tgPolling, setTgPolling] = useState(false);
  // Bumped when peer state changes so /sessions re-renders.
  const [peersRev, setPeersRev] = useState(0);

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

  const appendMsg = useCallback((author, text, opts = {}) => {
    const id = mkId();
    setMessages(prev => [...prev, { id, author, text, streaming: opts.streaming ?? false }]);
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

  // ── brain submission ──────────────────────────────────────────

  const runBrain = useCallback(async (sessionName, prompt) => {
    const session = sessionsRef.current.get(sessionName);
    if (!session) { appendMsg('egpt', `No session "${sessionName}" attached.`); return; }

    const msgId = appendMsg(sessionName, '⌛ thinking…', { streaming: true });
    const tgStream = bridgeRef.current?.startStreamMessage?.(`${sessionName}\n⌛ thinking…`);

    try {
      const finalText = await session.brain.stream(
        { message: prompt },
        partial => {
          updateMsg(msgId, partial, true);
          tgStream?.update(`${sessionName}\n${partial}`);
        },
        { targetId: session.targetId },
      );
      updateMsg(msgId, finalText, false);
      tgStream?.finish(`${sessionName}\n${finalText}`);
    } catch (e) {
      const err = `error: ${e.message}`;
      updateMsg(msgId, err, false);
      bridgeRef.current?.send(`${sessionName}: ${err}`);
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

    if (parsed.type === 'command') {
      // Route slash commands (e.g. /telegram extension) through the command
      // handler so Telegram users can drive the room from off-LAN. Resolved
      // via ref because handleCommand is declared later in the file.
      handleCommandRef.current?.(trimmed);
      return;
    }
    if (parsed.type === 'mention') {
      const name = parsed.target;
      const prompt = parsed.body || trimmed;
      if (sessionsRef.current.has(name)) {
        runBrain(name, prompt);
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

    if (canMirror && activeSession) {
      runBrain(activeSession, text);
    }
  }, [appendMsg, runBrain, activeSession]);

  const handleIncomingRef = useRef(handleIncoming);
  handleIncomingRef.current = handleIncoming;

  // ── slash commands ────────────────────────────────────────────

  const handleCommand = useCallback(async (cmd) => {
    const parts = cmd.slice(1).split(/\s+/);
    const slash = '/' + parts[0];
    appendMsg('egpt', `> ${cmd}`);

    if (COMMAND_SET.has(slash) && !EXT_COMMAND_SET.has(slash)) {
      appendMsg('egpt', `!! ${slash} is a shell-only command; not available in the extension`);
      return;
    }

    switch (slash) {
      case '/open': {
        // /open <brainType> [name]
        // Opens a fresh tab to the brain's homeUrl and registers it as a
        // new session. Mirrors the shell's /open semantics.
        const [rawType, customName] = parts.slice(1);
        if (!rawType) {
          appendMsg('egpt', `Usage: /open <brain> [name]\nBrains: ${Object.keys(BRAINS).join('  ')}`);
          return;
        }
        const brainType = canonicalBrain(rawType);
        const brain = BRAINS[brainType];
        if (!brain || !brain.homeUrl) {
          appendMsg('egpt', `Unknown brain type "${rawType}". Available: ${Object.keys(BRAINS).join('  ')}`);
          return;
        }
        const name = customName || nextSessionName(brainType);
        if (sessionsRef.current.has(name)) {
          appendMsg('egpt', `Session "${name}" already exists.`);
          return;
        }
        appendMsg('egpt', `Opening ${brain.homeUrl}…`);
        try {
          const tab = await chrome.tabs.create({ url: brain.homeUrl, active: false });
          appendMsg('egpt', `Waiting for tab ${tab.id} to load…`);
          await waitForTabLoad(tab.id);
          sessionsRef.current.set(name, { brain, targetId: tab.id });
          syncSessionsList();
          if (!activeSession) setActiveSession(name);
          appendMsg('egpt', `Ready: ${name} → ${brainType} (tab ${tab.id})`);
        } catch (e) {
          appendMsg('egpt', `/open failed: ${e.message}`);
        }
        break;
      }
      case '/attach': {
        // /attach                              rescan tabs, attach any matching
        // /attach <brainType> [name] [tabSpec] explicit attach to existing tab
        const args = parts.slice(1);
        if (args.length === 0) {
          // Rescan: attach every chatgpt/claude tab that isn't already a session
          const tabs = await listTabs();
          const additions = [];
          for (const tab of tabs) {
            const matchedType = Object.keys(BRAINS).find(k => BRAINS[k].urlMatch?.test(tab.url));
            if (!matchedType) continue;
            const taken = [...sessionsRef.current.values()].some(s => s.targetId === tab.id);
            if (taken) continue;
            const name = nextSessionName(matchedType);
            sessionsRef.current.set(name, { brain: BRAINS[matchedType], targetId: tab.id });
            additions.push(`${name} (${matchedType})`);
          }
          if (!additions.length) appendMsg('egpt', 'No new tabs to attach.');
          else {
            syncSessionsList();
            if (!activeSession) setActiveSession([...sessionsRef.current.keys()][0]);
            appendMsg('egpt', `Attached: ${additions.join(', ')}`);
          }
          return;
        }
        const [rawType, customName, ...tabSpecParts] = args;
        const brainType = canonicalBrain(rawType);
        const brain = BRAINS[brainType];
        if (!brain) {
          appendMsg('egpt', `Unknown brain type "${rawType}". Available: ${Object.keys(BRAINS).join('  ')}`);
          return;
        }
        const tabSpec = tabSpecParts.join(' ').trim();
        let targetId = null;
        if (tabSpec) {
          targetId = await resolveTabSpec(tabSpec, brain);
          if (!targetId) {
            appendMsg('egpt', `Could not resolve "${tabSpec}" to a tab. /tabs to list.`);
            return;
          }
        } else {
          const tabs = (await listTabs()).filter(t => brain.urlMatch?.test(t.url));
          if (tabs.length === 0) {
            appendMsg('egpt', `No open ${brainType} tabs. /open ${brainType} to create one.`);
            return;
          }
          if (tabs.length > 1) {
            const lst = tabs.map(t => `  ${t.id}  ${(t.title ?? '').slice(0, 50)}`).join('\n');
            appendMsg('egpt', `Multiple ${brainType} tabs open. Specify tab ID:\n${lst}`);
            return;
          }
          targetId = tabs[0].id;
        }
        const name = customName || nextSessionName(brainType);
        if (sessionsRef.current.has(name)) {
          appendMsg('egpt', `Session "${name}" already exists.`);
          return;
        }
        sessionsRef.current.set(name, { brain, targetId });
        syncSessionsList();
        if (!activeSession) setActiveSession(name);
        appendMsg('egpt', `Attached ${name} → ${brainType} (tab ${targetId})`);
        break;
      }
      case '/detach': {
        const name = parts[1];
        if (!name) { appendMsg('egpt', 'Usage: /detach <name>'); return; }
        sessionsRef.current.delete(name);
        syncSessionsList();
        if (activeSession === name) setActiveSession(null);
        appendMsg('egpt', `Detached ${name}`);
        break;
      }
      case '/use': {
        const name = parts[1];
        if (!sessionsRef.current.has(name)) {
          appendMsg('egpt', `Session "${name}" not attached.`);
        } else {
          setActiveSession(name);
          appendMsg('egpt', `Active session → ${name}`);
        }
        break;
      }
      case '/sessions': {
        const list = [...sessionsRef.current.entries()];
        const localBlock = list.length === 0
          ? '(no local sessions)'
          : list.map(([n, s]) => `  ${n}  ${s.brain.name}  tab:${s.targetId}`).join('\n');
        const peerLines = [];
        for (const [nodeId, peer] of peerNodesRef.current) {
          const head = `~ ${nodeId}  (${peer.role ?? 'node'})${peer.polling ? '  [polling]' : ''}`;
          peerLines.push(head);
          for (const sess of peer.sessions ?? []) {
            peerLines.push(`    ${(sess.name ?? '?').padEnd(14)}${sess.brain ?? '?'}`);
          }
        }
        const peerBlock = peerLines.length
          ? `\n\n── peers (zombie sessions) ───────────────────\n${peerLines.join('\n')}`
          : '';
        appendMsg('egpt', localBlock + peerBlock);
        break;
      }
      case '/tabs': {
        const tabs = await listTabs();
        if (tabs.length === 0) { appendMsg('egpt', 'No open tabs found.'); return; }
        appendMsg('egpt', tabs.map(t => `  ${t.id}  ${t.url.slice(0, 70)}`).join('\n'));
        break;
      }
      case '/config': {
        const [key, ...valParts] = parts.slice(1);
        if (!key) {
          const sync = await chrome.storage.sync.get(null);
          const local = await chrome.storage.local.get(null);
          appendMsg('egpt', JSON.stringify({ sync, local }, null, 2));
          return;
        }
        const raw = valParts.join(' ');
        let val = raw;
        try { val = JSON.parse(raw); } catch {}
        await chrome.storage.sync.set({ [key]: val });
        appendMsg('egpt', `Set ${key} = ${JSON.stringify(val)}`);
        if (key === 'telegram') startBridge();
        break;
      }
      case '/telegram': {
        const target = parts[1];
        // No-arg: report polling state of this node + peers from the bus.
        if (!target) {
          const me = `  ${BUS_NODE_ID}  (this extension)  ${tgPolling ? 'polling' : 'idle'}`;
          const peerLines = [];
          for (const [nodeId, peer] of peerNodesRef.current) {
            peerLines.push(`  ${nodeId}  (${peer.role ?? '?'})  ${peer.polling ? 'polling' : 'idle'}`);
          }
          appendMsg('egpt',
            `telegram polling status:\n${me}` +
            (peerLines.length ? '\n' + peerLines.join('\n') : '\n  (no peers on bus)') +
            `\n\n/telegram <node>     hand polling to that node` +
            `\n/telegram disconnect  stop polling on this node`);
          return;
        }
        if (target === 'disconnect') {
          if (tgPolling) { stopBridge(); appendMsg('egpt', 'telegram: disconnected'); }
          else appendMsg('egpt', 'telegram: not polling on this extension');
          return;
        }
        const tid = busTargetIdRef.current;
        if (!tid) { appendMsg('egpt', '!! bus not joined — handoff requires bus'); return; }
        const to = target.replace(/^@/, '');
        if (to === BUS_NODE_ID || to === 'extension') {
          await startBridge();
          return;
        }
        const peer = peerNodesRef.current.get(to);
        if (!peer) {
          const candidates = [...peerNodesRef.current.entries()].filter(([_, p]) => p.role === to);
          if (candidates.length === 1) {
            const [nodeId] = candidates[0];
            if (tgPolling) stopBridge();
            await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
              ts: Date.now(), to: nodeId });
            appendMsg('egpt', `telegram: handoff posted to ${nodeId}`);
            return;
          }
          if (candidates.length > 1) {
            appendMsg('egpt', `!! ambiguous role "${to}"; pick one of: ${candidates.map(([n]) => n).join(', ')}`);
            return;
          }
          appendMsg('egpt', `!! no peer "${to}" on bus — /telegram with no arg lists peers`);
          return;
        }
        if (tgPolling) stopBridge();
        await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
          ts: Date.now(), to });
        appendMsg('egpt', `telegram: handoff posted to ${to}`);
        break;
      }
      case '/clear':
        setMessages([]);
        break;
      case '/help':
        appendMsg('egpt', helpText(Object.keys(BRAINS)));
        break;
      default:
        appendMsg('egpt', `!! unknown command: ${slash}`);
    }
  }, [activeSession, appendMsg]);

  handleCommandRef.current = handleCommand;

  // ── submit handler ────────────────────────────────────────────

  const handleSubmit = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const parsed = parseInput(trimmed);

    if (parsed.type === 'command') { handleCommand(trimmed); return; }

    appendMsg(userName, trimmed);

    let sessionName, prompt;
    if (parsed.type === 'mention') {
      sessionName = parsed.target;
      prompt = parsed.body || trimmed;
      if (!sessionsRef.current.has(sessionName)) {
        // Local doesn't have it. Try peers — maybe another node owns it.
        const peerMatches = [];
        for (const [nodeId, peer] of peerNodesRef.current) {
          if (peer.sessions?.some(s => s.name === sessionName)) peerMatches.push(nodeId);
        }
        if (peerMatches.length === 1) {
          const tid = busTargetIdRef.current;
          if (!tid) { appendMsg('egpt', `!! bus not joined — can't forward @${sessionName}`); return; }
          try {
            await bus.postEvent(tid, {
              type: 'mention', from: BUS_NODE_ID, ts: Date.now(),
              target: sessionName, to_node: peerMatches[0], body: prompt, user: userName,
            });
            appendMsg('egpt', `@${sessionName} -> ${peerMatches[0]} via bus`);
          } catch (e) {
            appendMsg('egpt', `!! forward failed: ${e.message}`);
          }
          return;
        }
        if (peerMatches.length > 1) {
          appendMsg('egpt', `!! @${sessionName} is ambiguous across peers: ${peerMatches.join(', ')}`);
          return;
        }
        appendMsg('egpt', `!! unknown session "@${sessionName}" — /sessions to list, /open <brain> [name] to add`);
        return;
      }
    } else {
      sessionName = activeSession;
      prompt = trimmed;
    }

    if (!sessionName) {
      appendMsg('egpt', 'No session active. Use /open chatgpt-cdp to open one.');
      return;
    }
    runBrain(sessionName, prompt);
  }, [activeSession, appendMsg, handleCommand, runBrain, userName]);

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
      nodeName:     'extension',
      allowedUsers: telegram.allowed_users ?? [],
      chatId:       telegram.chat_id ?? null,
      onIncoming:   (text, meta) => handleIncomingRef.current(text, meta),
      onLog:        msg => setTgStatus(msg),
      onError:      msg => appendMsg('egpt', `⚠ ${msg}`),
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
    chrome.storage.sync.get(['userName'], cfg => {
      if (cfg.userName) setUserName(cfg.userName);
    });

    const onChange = (changes) => {
      if (changes.userName) setUserName(changes.userName.newValue ?? 'human');
      if (changes.telegram) startBridge();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [startBridge]);

  useEffect(() => {
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
    let cancelled = false;
    (async () => {
      try {
        const located = await bus.findOrOpenBusTab();
        if (cancelled || !located) return;
        busTargetIdRef.current = located.targetId;
        const sub = await bus.subscribeBusEvents(located.targetId, (ev) => {
          if (cancelled) return;
          handleBusEventRef.current?.(ev);
        });
        busSubRef.current = sub;
        // Initial announce. Peers pong back so we discover them too.
        const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
          name: n, brain: s.brain.name,
        }));
        await bus.postEvent(located.targetId, {
          type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'extension',
          sessions: sessionsList, polling: false,
        });
        appendMsg('egpt', located.opened ? 'bus tab opened' : 'bus tab attached');
      } catch (e) {
        appendMsg('egpt', `bus: not joined (${e.message})`);
      }
    })();
    return () => {
      cancelled = true;
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
  }, [appendMsg]);

  // Bus dispatcher — refreshed each render so it always sees current state.
  handleBusEventRef.current = async (ev) => {
    if (ev.from === BUS_NODE_ID) return;
    const log = (m) => appendMsg('egpt', m);
    const post = async (event) => {
      const tid = busTargetIdRef.current;
      if (!tid) return;
      try { await bus.postEvent(tid, { ts: Date.now(), from: BUS_NODE_ID, ...event }); } catch (_) {}
    };
    switch (ev.type) {
      case 'node-online': {
        peerNodesRef.current.set(ev.from, {
          role: ev.role, sessions: ev.sessions ?? [],
          polling: !!ev.polling, lastSeen: ev.ts ?? Date.now(),
        });
        setPeersRev(r => r + 1);
        log(`bus: peer online ${ev.from}${ev.role ? ` (${ev.role})` : ''}${ev.polling ? ' [polling]' : ''}`);
        if (!ev.pong) {
          const sessionsList = [...sessionsRef.current.entries()].map(([n, s]) => ({
            name: n, brain: s.brain.name,
          }));
          await post({ type: 'node-online', role: 'extension', pong: true,
            sessions: sessionsList, polling: tgPolling });
        }
        return;
      }
      case 'node-offline': {
        peerNodesRef.current.delete(ev.from);
        setPeersRev(r => r + 1);
        log(`bus: peer offline ${ev.from}`);
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
        if (peer) { peer.polling = !!ev.polling; peer.lastSeen = ev.ts ?? Date.now(); }
        setPeersRev(r => r + 1);
        return;
      }
      case 'mention': {
        if (ev.to_node !== BUS_NODE_ID) return;
        if (!sessionsRef.current.has(ev.target)) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: `no session "${ev.target}" in extension` });
          return;
        }
        log(`bus: running ${ev.target} for ${ev.from}${ev.user ? ` (${ev.user})` : ''}`);
        const session = sessionsRef.current.get(ev.target);
        try {
          const finalText = await session.brain.stream(
            { message: `[${ev.user ?? 'remote'}]: ${ev.body}` },
            () => {}, { targetId: session.targetId },
          );
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, body: finalText ?? '' });
        } catch (e) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: e.message });
        }
        return;
      }
      case 'mention-reply': {
        if (ev.to_node !== BUS_NODE_ID) return;
        const author = ev.target ?? ev.from;
        if (ev.error) log(`!! ${author}: ${ev.error}`);
        else appendMsg(author, ev.body ?? '(empty)');
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
    author === userName ? 'you' : author === 'egpt' ? 'egpt' : 'brain';

  return (
    <div id="egpt-app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div className="status-bar">
        <span className="status-brand">egpt</span>
        <span className="status-sessions">
          {sessionsList.length === 0
            ? 'no sessions'
            : sessionsList.map(s => s.name).join('  ')}
          {activeSession ? ` › ${activeSession}` : ''}
        </span>
        <span className="status-tg">{tgStatus}</span>
      </div>

      <div className="conversation" ref={convRef}>
        {messages.map(m => (
          <div key={m.id} className="msg">
            <span className={`msg-author ${authorClass(m.author)}`}>{m.author}</span>
            <div className={`msg-body${m.streaming ? ' streaming' : ''}`}>{m.text}</div>
          </div>
        ))}
      </div>

      <div className="input-area">
        <Input onSubmit={handleSubmit} activeSession={activeSession} />
      </div>
    </div>
  );
}
