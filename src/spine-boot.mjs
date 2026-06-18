import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BOOT_ALERT_JID = '34836563681438@lid';

export function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function shallowDeepMerge(base, override) {
  if (!isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}

export function applyLocalConfigOverlaySync(base, localConfigPath, io = {}) {
  const read = io.readFileSync ?? readFileSync;
  try {
    const local = JSON.parse(read(localConfigPath, 'utf8'));
    return { config: shallowDeepMerge(base, local), error: null };
  } catch (e) {
    if (e?.code === 'ENOENT') return { config: base, error: null };
    return { config: base, error: e };
  }
}

export function missingWhatsappConfigKeys(config) {
  const wa = config?.whatsapp;
  const missing = [];
  if (!wa || typeof wa !== 'object') return ['whatsapp (whole section)'];
  if (!wa.chat_id) missing.push('whatsapp.chat_id');
  if (!Array.isArray(wa.allowed_users)) missing.push('whatsapp.allowed_users');
  if (!Array.isArray(wa.auto_e_chats)) missing.push('whatsapp.auto_e_chats');
  return missing;
}

export function configLoadFailureConsoleMessage(error) {
  const detail = error?.stack ?? error?.message ?? error;
  return `!! egpt boot: readConfigSync FAILED — ${detail}\n!! EGPT_CONFIG will be empty; auto_e_chats / allowed_users / chat_id undefined → every chat will observe-only-SKIP and every brain outbound send will BLOCK.`;
}

export function configLoadFailureAlertBody(error) {
  const detail = String(error?.message ?? error).slice(0, 200);
  return `⚠ egpt boot warning: config load FAILED — ${detail}. Bridge running with empty config; every chat is observe-only. Restart after fixing.`;
}

export function writeConfigLoadFailureAlertSync({
  egptHome,
  jid = DEFAULT_BOOT_ALERT_JID,
  now = Date.now,
  write = writeFileSync,
  error,
} = {}) {
  const ts = now();
  const id = `${ts}-bootfail`;
  const event = {
    type: 'wa-send',
    from: 'system',
    ts,
    jid,
    body: configLoadFailureAlertBody(error),
  };
  write(join(egptHome, 'outbox', `${id}.json`), JSON.stringify(event));
  return { id, event };
}
