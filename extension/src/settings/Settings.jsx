import { useState, useEffect } from 'react';
import { generateKey as generateBusKey } from '../../../tools/bus-sign.mjs';

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
  // Bus key lives in chrome.storage.LOCAL (not sync) so it doesn't
  // replicate across devices on its own — pairing is a deliberate
  // copy-paste step. Managed independently of the Save button below.
  const [busKey,    setBusKey]    = useState('');
  const [busStatus, setBusStatus] = useState(null);

  useEffect(() => {
    chrome.storage.sync.get(['userName', 'theme', 'telegram'], cfg => {
      if (cfg.userName)                  setHandle(cfg.userName);
      if (cfg.theme)                     setTheme(cfg.theme);
      if (cfg.telegram?.bot_token)       setBotToken(cfg.telegram.bot_token);
      if (cfg.telegram?.chat_id)         setChatId(String(cfg.telegram.chat_id));
      if (cfg.telegram?.mirror)          setMirror(cfg.telegram.mirror);
      if (cfg.telegram?.allowed_users?.length)
        setAllowedUsers(cfg.telegram.allowed_users.join(', '));
    });
    chrome.storage.local.get('bus_key', cfg => {
      if (typeof cfg.bus_key === 'string') setBusKey(cfg.bus_key);
    });
    // Stay in sync if /bus-key (slash command) or another tab edits it
    const listener = (changes, area) => {
      if (area !== 'local' || !changes.bus_key) return;
      const v = changes.bus_key.newValue;
      setBusKey(typeof v === 'string' ? v : '');
    };
    try { chrome.storage.onChanged.addListener(listener); } catch (_) {}
    return () => { try { chrome.storage.onChanged.removeListener(listener); } catch (_) {} };
  }, []);

  async function busKeyAction(action) {
    try {
      if (action === 'gen') {
        const k = await generateBusKey();
        await chrome.storage.local.set({ bus_key: k });
        setBusKey(k);
        setBusStatus('generated');
      } else if (action === 'save') {
        const k = busKey.trim();
        if (!k) { await chrome.storage.local.remove('bus_key'); setBusKey(''); setBusStatus('cleared'); }
        else { await chrome.storage.local.set({ bus_key: k }); setBusKey(k); setBusStatus('saved'); }
      } else if (action === 'clear') {
        await chrome.storage.local.remove('bus_key');
        setBusKey('');
        setBusStatus('cleared');
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(busKey);
        setBusStatus('copied');
      }
      setTimeout(() => setBusStatus(null), 2000);
    } catch (e) {
      setBusStatus(`error: ${e.message}`);
    }
  }

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
        <p className="hint">
          Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> to
          get a token. Add the bot to any groups you want to mirror to.
        </p>
        <Field label="Bot token" hint="From @BotFather. Looks like 123456:ABCdef…">
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
          hint="Optional. Outgoing messages go here before the first incoming. Auto-detected otherwise."
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

      <section>
        <h2>Bus security</h2>
        <p className="hint">
          When set, every event posted to the bus is HMAC-signed with this key,
          and incoming events without a matching signature are dropped. Stops
          forged commands from any other extension or process that gains access
          to the CDP port. Stored in <code>chrome.storage.local</code> (never
          synced across devices). Empty = signing off, all events accepted.
        </p>
        <Field
          label="Bus signing key"
          hint="Paste the same value into your egpt-shell config (env var EGPT_BUS_KEY) so both halves verify each other."
        >
          <input
            value={busKey}
            onChange={e => setBusKey(e.target.value)}
            type="text"
            placeholder="(none — signing off)"
            spellCheck={false}
            autoComplete="off"
            style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}
          />
        </Field>
        <div className="actions" style={{ gap: 8, display: 'flex', flexWrap: 'wrap' }}>
          <button onClick={() => busKeyAction('gen')}>Generate</button>
          <button onClick={() => busKeyAction('save')}>Save</button>
          <button onClick={() => busKeyAction('copy')} disabled={!busKey}>Copy</button>
          <button onClick={() => busKeyAction('clear')} disabled={!busKey}>Clear</button>
          {busStatus && (
            <span className="hint" style={{ alignSelf: 'center' }}>
              {busStatus === 'generated' && '✓ new key generated + stored'}
              {busStatus === 'saved'     && '✓ saved'}
              {busStatus === 'cleared'   && '✓ cleared (signing off)'}
              {busStatus === 'copied'    && '✓ copied to clipboard'}
              {busStatus?.startsWith('error') && busStatus}
            </span>
          )}
        </div>
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
