// slash/config.mjs — get/set config keys in ~/.egpt/config.yaml.
//
// Three input forms:
//   /config                              list all keys with current values + descriptions
//   /config <key>                        show current value
//   /config <key> <val>                  set a top-level key
//   /config <key>.<sub> <val>            set a nested key (e.g. whatsapp.client_name moto)
//   /config <subkey> <val>  (bridge-typed) — unknown bare key from telegram/whatsapp gets
//                                            auto-scoped to that bridge's nested namespace
//
// Writes edit config.yaml IN PLACE via the yaml lib's Document API, so the
// operator's `_note` comments survive every /config write (the old config.local.json
// overlay was retired 2026-06-22 — one config file now).
//
// Side-effects on certain keys: live-applies theme / user_name /
// show_prompts / node_name (the last requires re-announcing on the
// bus so peers refresh).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as YAML from 'yaml';
import { CONFIG_SCHEMA } from '../config/config-schema.mjs';

export const meta = {
  cmd: '/config',
  section: 'MISC',
  surface: 'both',
  usage: '/config [key [val]]',
  desc: 'read or write config (~/.egpt/config.yaml; nested keys via dot notation)',
};

export async function run({ arg, meta: callMeta, ctx }) {
  // ctx keys consumed:
  //   sysOut, dp
  //   EGPT_CONFIG, CONFIG_PATH
  //   setTheme(name)                 — re-applies theme on live change
  //   setUserName(name)              — module-level let setter
  //   setShowPrompts(bool)
  //   nodeRename(newName)            — bus rename: offline+online ping
  const { sysOut, dp, EGPT_CONFIG, CONFIG_PATH,
          setTheme, setUserName, setShowPrompts, nodeRename } = ctx;

  const parts = arg.trim().split(/\s+/);
  let key = parts[0];
  const rawVal = parts.slice(1).join(' ');

  if (!key) {
    const lines = [`config  (${dp(CONFIG_PATH)}):`, ''];
    for (const [k, desc] of Object.entries(CONFIG_SCHEMA)) {
      const live = EGPT_CONFIG[k];
      const valStr = live !== undefined ? JSON.stringify(live) : '(unset)';
      lines.push(`  ${k} = ${valStr}`);
      lines.push(`    ${desc}`);
      lines.push('');
    }
    lines.push('usage:');
    lines.push('  /config <key> [val]              top-level (e.g. /config user_name An)');
    lines.push('  /config <key>.<sub> [val]        nested (e.g. /config whatsapp.mirror_headers brain_only)');
    sysOut(lines.join('\n'));
    return true;
  }

  // Bridge-context inference: bare key from whatsapp/telegram that
  // isn't a top-level slot gets auto-scoped to that bridge's namespace.
  if (!key.includes('.') && !(key in CONFIG_SCHEMA)) {
    if (callMeta?.fromWhatsApp)      key = `whatsapp.${key}`;
    else if (callMeta?.fromTelegram) key = `telegram.${key}`;
  }

  const dotIdx = key.indexOf('.');
  const topKey = dotIdx > 0 ? key.slice(0, dotIdx) : key;
  const subKey = dotIdx > 0 ? key.slice(dotIdx + 1) : null;
  if (!(topKey in CONFIG_SCHEMA)) {
    const valid = Object.keys(CONFIG_SCHEMA).join(', ');
    sysOut(`!! unknown config key: ${key}\nvalid keys: ${valid}`);
    return true;
  }

  if (!rawVal) {
    const top = EGPT_CONFIG[topKey];
    const v = subKey ? top?.[subKey] : top;
    sysOut(v !== undefined ? `${key}: ${JSON.stringify(v)}` : `${key}: (not set)`);
    return true;
  }

  let val;
  try { val = JSON.parse(rawVal); } catch { val = rawVal; }

  // Edit config.yaml IN PLACE via the Document API — preserves the _note comments
  // (a plain YAML.stringify round-trip would drop them).
  try {
    let doc;
    try { doc = YAML.parseDocument(await readFile(CONFIG_PATH, 'utf8')); }
    catch { doc = new YAML.Document({}); }
    doc.setIn(subKey ? [topKey, subKey] : [topKey], val);
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, doc.toString());
    // Mirror into in-memory EGPT_CONFIG so downstream handlers see
    // the change without a restart.
    if (subKey) {
      if (typeof EGPT_CONFIG[topKey] !== 'object' || EGPT_CONFIG[topKey] === null) {
        EGPT_CONFIG[topKey] = {};
      }
      EGPT_CONFIG[topKey][subKey] = val;
    } else {
      EGPT_CONFIG[topKey] = val;
    }
  } catch (e) { sysOut(`!! config write: ${e.message}`); return true; }

  // Live-apply for keys whose effect can't wait for a restart.
  if (topKey === 'theme' && !subKey)        setTheme(val);
  if (topKey === 'user_name' && !subKey)    setUserName(String(val));
  if (topKey === 'show_prompts' && !subKey) setShowPrompts(!!val);
  if (topKey === 'node_name' && !subKey)    await nodeRename(String(val));

  sysOut(`config: ${key} = ${JSON.stringify(val)}  →  ${dp(CONFIG_PATH)}`);
  return true;
}
