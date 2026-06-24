// extension/src/commands/misc-commands.js — pure handlers for the
// remaining slash commands: /config, /clear, /help.
// Same DI pattern as session-commands.js.

// /config [key] [value]
//   no args: dump sync + local storage
//   key only: not supported in current code (falls through to set with empty val)
//   key value: chrome.storage.sync.set({ [key]: parsed-or-raw })
//
// ctx:
//   log(text)
//   storageSync   chrome.storage.sync ({ get, set })
//   storageLocal  chrome.storage.local ({ get })
export async function config(rest, ctx) {
  const { log, storageSync, storageLocal} = ctx;
  const parts = (rest ?? '').trim().split(/\s+/);
  const key = parts[0];
  const valParts = parts.slice(1);
  if (!key) {
    const sync = await storageSync.get(null);
    const local = await storageLocal.get(null);
    log(JSON.stringify({ sync, local }, null, 2));
    return;
  }
  const raw = valParts.join(' ');
  let val = raw;
  try { val = JSON.parse(raw); } catch (_) { /* keep raw string */ }
  await storageSync.set({ [key]: val });
  log(`Set ${key} = ${JSON.stringify(val)}`);
}

export async function busKey(rest, ctx) {
  const { log, error, storageLocal, generateKey } = ctx;
  const parts = (rest ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  if (!sub) {
    const got = await storageLocal.get('bus_key');
    const k = got?.bus_key;
    if (typeof k === 'string' && k.trim()) {
      log(`bus key (signing on):\n  ${k}\n\nPaste into shell as EGPT_BUS_KEY env var to pair.`);
    } else {
      log('bus key: none configured (signing off, all events accepted)');
    }
    return;
  }

  if (sub === 'gen') {
    const k = await generateKey();
    await storageLocal.set({ bus_key: k });
    log(`bus key generated + stored:\n  ${k}\n\nPaste into shell as EGPT_BUS_KEY env var to pair.`);
    return;
  }

  if (sub === 'set') {
    const k = parts.slice(1).join('').trim();
    if (!k) { error('/bus-key set <base64-key> — value required'); return; }
    await storageLocal.set({ bus_key: k });
    log('bus key set + stored. Signing on.');
    return;
  }

  if (sub === 'clear') {
    await storageLocal.remove('bus_key');
    log('bus key cleared. Signing off, all events accepted (permissive).');
    return;
  }

  error(`/bus-key: unknown subcommand "${sub}". Try /bus-key, /bus-key gen, /bus-key set <key>, /bus-key clear`);
}

// /clear — drop the visible message log.
// ctx: clearMessages()
export async function clear(_rest, ctx) {
  ctx.clearMessages();
}

// /help — print help text.
// ctx: log(text), getBrainNames() → string[], formatHelp(brains) → string
export async function help(_rest, ctx) {
  ctx.log(ctx.formatHelp(ctx.getBrainNames()));
}
