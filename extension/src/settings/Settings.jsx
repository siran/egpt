import { useState, useEffect } from 'react';

const THEMES = [
  'catppuccin', 'default', 'dracula', 'ember',
  'gruvbox', 'midnight', 'monokai', 'nord', 'ocean', 'tokyo-night',
];

export default function Settings() {
  const [handle,       setHandle]       = useState('human');
  const [theme,        setTheme]        = useState('catppuccin');
  const [botToken,     setBotToken]     = useState('');
  const [chatId,       setChatId]       = useState('');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [mirror,       setMirror]       = useState('none');
  const [status,       setStatus]       = useState(null); // 'saved' | 'error:<msg>'

  useEffect(() => {
    chrome.storage.sync.get(['userName', 'theme', 'telegram'], cfg => {
      if (cfg.userName)              setHandle(cfg.userName);
      if (cfg.theme)                 setTheme(cfg.theme);
      if (cfg.telegram?.bot_token)   setBotToken(cfg.telegram.bot_token);
      if (cfg.telegram?.chat_id)     setChatId(String(cfg.telegram.chat_id));
      if (cfg.telegram?.mirror)      setMirror(cfg.telegram.mirror);
      if (cfg.telegram?.allowed_users?.length)
        setAllowedUsers(cfg.telegram.allowed_users.join(', '));
    });
  }, []);

  async function save() {
    try {
      const update = {
        userName: handle.trim() || 'human',
        theme,
      };

      if (botToken.trim()) {
        const telegram = { bot_token: botToken.trim() };
        if (chatId.trim()) {
          const n = Number(chatId.trim());
          telegram.chat_id = isNaN(n) ? chatId.trim() : n;
        }
        if (allowedUsers.trim()) {
          telegram.allowed_users = allowedUsers
            .split(',')
            .map(s => { const n = Number(s.trim()); return isNaN(n) ? s.trim() : n; })
            .filter(Boolean);
        }
        telegram.mirror = mirror;
        update.telegram = telegram;
      } else {
        // Clear telegram if token removed
        update.telegram = null;
      }

      await chrome.storage.sync.set(update);
      setStatus('saved');
      setTimeout(() => setStatus(null), 2500);
    } catch (e) {
      setStatus(`error: ${e.message}`);
    }
  }

  const isError = status?.startsWith('error');

  return (
    <div className="settings">
      <header>
        <span className="brand">egpt</span>
        <span className="page-title">settings</span>
      </header>

      <section>
        <h2>Identity</h2>
        <Field label="Handle name" hint="Your display name in conversations.">
          <input
            value={handle}
            onChange={e => setHandle(e.target.value)}
            placeholder="human"
          />
        </Field>
        <Field label="Theme">
          <select value={theme} onChange={e => setTheme(e.target.value)}>
            {THEMES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="hint">Takes effect on next egpt tab open.</span>
        </Field>
      </section>

      <section>
        <h2>Telegram</h2>
        <Field label="Bot token" hint="From @BotFather. Use the same token as the shell so they share the same room.">
          <input
            value={botToken}
            onChange={e => setBotToken(e.target.value)}
            type="password"
            placeholder="123456:ABCdef…"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Chat ID"
          hint="Optional. Outgoing messages go here before the first incoming message. Auto-detected otherwise."
        >
          <input
            value={chatId}
            onChange={e => setChatId(e.target.value)}
            placeholder="-100123456789"
          />
        </Field>
        <Field
          label="Allowed user IDs"
          hint="Comma-separated Telegram numeric user IDs who may issue /commands and @mentions. Empty = nobody authorized (secure default)."
        >
          <input
            value={allowedUsers}
            onChange={e => setAllowedUsers(e.target.value)}
            placeholder="123456789, 987654321"
          />
        </Field>
        <Field
          label="Mirror plain messages to brain"
          hint="When a plain message (no @mention or /command) arrives, forward it to the active session."
        >
          <select value={mirror} onChange={e => setMirror(e.target.value)}>
            <option value="none">None — @mentions and /commands only</option>
            <option value="allowed">Allowed users only</option>
            <option value="all">Everyone</option>
          </select>
        </Field>
      </section>

      <div className="actions">
        <button className={`save-btn${isError ? ' error' : ''}`} onClick={save}>
          {status === 'saved' ? '✓ saved' : isError ? status : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
