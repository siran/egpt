import { useState, useEffect, useRef, useCallback } from 'react';
import Input from './Input.jsx';
import { startTelegramBridge } from '../../../bridges/telegram.mjs';
import * as chatgpt from '../../../brains/chatgpt-cdp.mjs';
import * as claudeBrain from '../../../brains/claude-cdp.mjs';
import { listTabs } from '../tools/cdp-ext.js';

const BRAIN_TYPES = { chatgpt, claude: claudeBrain };
const CONV_ID = 'main';

let _msgIdSeq = 0;
const mkId = () => ++_msgIdSeq;

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

  const handleIncoming = useCallback((text, meta) => {
    const author = meta.username ?? meta.firstName ?? 'human';
    appendMsg(author, text);

    const m = text.match(/^@(\S+)\s+([\s\S]*)$/);
    if (!m) return;
    const [, name, prompt] = m;
    if (sessionsRef.current.has(name)) runBrain(name, prompt);
  }, [appendMsg, runBrain]);

  const handleIncomingRef = useRef(handleIncoming);
  handleIncomingRef.current = handleIncoming;

  // ── slash commands ────────────────────────────────────────────

  const handleCommand = useCallback(async (cmd) => {
    const parts = cmd.slice(1).split(/\s+/);
    const slash = '/' + parts[0];
    appendMsg('egpt', `> ${cmd}`);

    switch (slash) {
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
          const cfg = await chrome.storage.sync.get(null);
          appendMsg('egpt', JSON.stringify(cfg, null, 2));
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
      case '/clear':
        setMessages([]);
        break;
      case '/help':
        appendMsg('egpt', [
          '/attach <name> <brain> <tabId>  attach a brain session',
          '/detach <name>                  detach a session',
          '/use <name>                     switch active session',
          '/sessions                       list attached sessions',
          '/tabs                           list open Chrome tabs (id + url)',
          '/config [key [value]]           read or set config',
          '/clear                          clear the conversation',
          '',
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
      appendMsg('egpt', 'No session active. Use /attach <name> <brain> <tabId> to attach one.');
      return;
    }
    runBrain(sessionName, prompt);
  }, [activeSession, appendMsg, handleCommand, runBrain]);

  // ── Telegram bridge ───────────────────────────────────────────

  const startBridge = useCallback(async () => {
    bridgeRef.current?.stop();
    bridgeRef.current = null;
    const { telegram } = await chrome.storage.sync.get('telegram');
    if (!telegram?.bot_token) { setTgStatus('no token — /config telegram {"bot_token":"…"}'); return; }
    setTgStatus('connecting…');
    const bridge = startTelegramBridge({
      botToken: telegram.bot_token,
      allowedUsers: telegram.allowed_users ?? [],
      chatId: telegram.chat_id ?? null,
      onIncoming: (text, meta) => handleIncomingRef.current(text, meta),
      onLog: msg => setTgStatus(msg),
      onError: msg => appendMsg('egpt', `⚠ ${msg}`),
    });
    bridgeRef.current = bridge;
  }, [appendMsg]);

  // Load identity on mount; restart bridge when storage changes externally (settings page)
  useEffect(() => {
    chrome.storage.sync.get(['userName'], cfg => {
      if (cfg.userName) setUserName(cfg.userName);
    });

    const onChange = (changes, area) => {
      if (area !== 'sync') return;
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
