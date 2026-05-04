import { useState, useEffect, useRef, useCallback } from 'react';
import Input from './Input.jsx';
import { startTelegramBridge } from '../../../bridges/telegram.mjs';
import * as chatgpt from '../../../brains/chatgpt-cdp.mjs';
import * as claudeBrain from '../../../brains/claude-cdp.mjs';
import { listTabs } from '../tools/cdp-ext.js';

const BRAIN_TYPES = { chatgpt, claude: claudeBrain };

const BRAIN_URLS = {
  chatgpt: 'https://chatgpt.com',
  claude:  'https://claude.ai',
};

const BRAIN_PREFIX = {
  chatgpt: 'cgpt',
  claude:  'claude',
};

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

  const sessionsRef = useRef(new Map());   // name → { brain, targetId }
  const bridgeRef   = useRef(null);
  const convRef     = useRef(null);

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

    const isCommand = text.trimStart().startsWith('/') || /^@\S+/.test(text.trimStart());

    if (isCommand && !meta.authorized) {
      bridgeRef.current?.send(
        `${author} (${meta.userId}) is not authorized to emit commands or mentions`
      );
      return;
    }

    if (isCommand) {
      const m = text.match(/^@(\S+)\s+([\s\S]*)$/);
      if (m) {
        const [, name, prompt] = m;
        if (sessionsRef.current.has(name)) runBrain(name, prompt);
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

    switch (slash) {
      case '/brain': {
        const [brainType, customName] = parts.slice(1);
        if (!brainType) {
          appendMsg('egpt', `Usage: /brain <type> [name]\nTypes: ${Object.keys(BRAIN_URLS).join('  ')}`);
          return;
        }
        const brain = BRAIN_TYPES[brainType];
        const url   = BRAIN_URLS[brainType];
        if (!brain || !url) {
          appendMsg('egpt', `Unknown brain type "${brainType}". Available: ${Object.keys(BRAIN_URLS).join('  ')}`);
          return;
        }
        const name = customName || nextSessionName(brainType);
        appendMsg('egpt', `Opening ${url}…`);
        try {
          const tab = await chrome.tabs.create({ url, active: false });
          appendMsg('egpt', `Waiting for tab ${tab.id} to load…`);
          await waitForTabLoad(tab.id);
          sessionsRef.current.set(name, { brain, targetId: tab.id });
          syncSessionsList();
          if (!activeSession) setActiveSession(name);
          appendMsg('egpt', `Ready: ${name} → ${brainType} (tab ${tab.id})`);
        } catch (e) {
          appendMsg('egpt', `/brain failed: ${e.message}`);
        }
        break;
      }
      case '/attach': {
        const [name, brainType, targetIdStr] = parts.slice(1);
        if (!name || !brainType || !targetIdStr) {
          appendMsg('egpt', 'Usage: /attach <name> <brainType> <tabId>\nBrain types: chatgpt  claude');
          return;
        }
        const brain = BRAIN_TYPES[brainType];
        if (!brain) {
          appendMsg('egpt', `Unknown brain type "${brainType}". Available: ${Object.keys(BRAIN_TYPES).join('  ')}`);
          return;
        }
        const targetId = parseInt(targetIdStr, 10);
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
        if (list.length === 0) { appendMsg('egpt', 'No sessions attached.'); return; }
        appendMsg('egpt', list.map(([n, s]) => `  ${n}  ${s.brain.name}  tab:${s.targetId}`).join('\n'));
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
        if (!target) {
          appendMsg('egpt', 'Usage: /telegram disconnect | /telegram @nodeName [ttl:T]');
          return;
        }
        const ttlArg = parts.find(p => p.startsWith('ttl:'));
        const ttl    = ttlArg ? parseInt(ttlArg.slice(4), 10) : null;
        if (target === 'disconnect') {
          bridgeRef.current?.stop();
          bridgeRef.current = null;
          setTgStatus('disconnected');
          appendMsg('egpt', 'telegram: disconnected');
        } else {
          const node = target.replace(/^@/, '');
          appendMsg('egpt', `telegram: handing off to ${node}${ttl ? ` (ttl ${ttl}s)` : ''}`);
          bridgeRef.current?.stop();
          bridgeRef.current = null;
          setTgStatus(`handed off to ${node}`);
          if (ttl) setTimeout(() => startBridge(), ttl * 1000);
        }
        break;
      }
      case '/clear':
        setMessages([]);
        break;
      case '/help':
        appendMsg('egpt', [
          '/brain <type> [name]            open a brain tab and attach it',
          '/attach <name> <brain> <tabId>  attach an existing tab as a brain',
          '/detach <name>                  detach a session',
          '/use <name>                     switch active session',
          '/sessions                       list attached sessions',
          '/tabs                           list open Chrome tabs (id + url)',
          '/config [key [value]]           read or set config',
          '/telegram disconnect            stop Telegram polling',
          '/telegram @node [ttl:T]         hand off polling to another node',
          '/clear                          clear the conversation',
          '',
          'Brain types: chatgpt  claude',
          'Enter to send   Shift+Enter for newline',
          'Prefix with @name to route to a specific session',
        ].join('\n'));
        break;
      default:
        appendMsg('egpt', `Unknown command: ${slash}. Type /help for commands.`);
    }
  }, [activeSession, appendMsg]);

  // ── submit handler ────────────────────────────────────────────

  const handleSubmit = useCallback((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) { handleCommand(trimmed); return; }

    appendMsg(userName, trimmed);

    const m = trimmed.match(/^@(\S+)\s+([\s\S]*)$/);
    const sessionName = m ? m[1] : activeSession;
    const prompt = m ? m[2] : trimmed;

    if (!sessionName) {
      appendMsg('egpt', 'No session active. Use /brain chatgpt to open one.');
      return;
    }
    runBrain(sessionName, prompt);
  }, [activeSession, appendMsg, handleCommand, runBrain]);

  // ── Telegram bridge ───────────────────────────────────────────

  const startBridge = useCallback(async () => {
    bridgeRef.current?.stop();
    bridgeRef.current = null;
    const { telegram } = await chrome.storage.sync.get('telegram');
    if (!telegram?.bot_token) {
      setTgStatus('no bot token — add one in Settings');
      return;
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
  }, [appendMsg]);

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
