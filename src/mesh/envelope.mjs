export const DEFAULT_MESH_TTL = 3;
export const DEFAULT_MESH_SEEN_TTL_MS = 5 * 60 * 1000;

export function makeMeshRequestId({ node = 'node', now = Date.now, random = Math.random } = {}) {
  const safeNode = String(node ?? 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
  const stamp = Math.max(0, Number(now()) || 0).toString(36);
  const nonce = Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * 0x100000000)
    .toString(36)
    .padStart(6, '0');
  return `mesh-${safeNode}-${stamp}-${nonce}`;
}

export function normalizeMeshTtl(value, fallback = DEFAULT_MESH_TTL) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.trunc(Number(fallback) || 0));
  return Math.max(0, Math.trunc(n));
}

export function meshRequestId(event) {
  const id = event?.request_id ?? event?.mesh?.request_id ?? null;
  return id == null ? null : String(id);
}

export function meshTtl(event, fallback = DEFAULT_MESH_TTL) {
  return normalizeMeshTtl(event?.ttl ?? event?.mesh?.ttl, fallback);
}

export function nextMeshTtl(event, fallback = DEFAULT_MESH_TTL) {
  return Math.max(0, meshTtl(event, fallback) - 1);
}

export function returnAddressForMeta(meta = {}) {
  if (meta.fromTelegram && meta.telegramChatId != null) {
    return { surface: 'telegram', chat_id: String(meta.telegramChatId) };
  }
  if (meta.fromWhatsApp && meta.waChatId != null) {
    return { surface: 'whatsapp', chat_id: String(meta.waChatId) };
  }
  return { surface: 'shell' };
}

export function buildMeshMention({
  fromNode,
  decision,
  user,
  returnTo,
  requestId,
  ttl = DEFAULT_MESH_TTL,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (!decision?.name || !decision?.node) {
    throw new Error('mesh mention requires decision.name and decision.node');
  }
  const normalizedTtl = normalizeMeshTtl(ttl);
  const id = requestId ?? makeMeshRequestId({ node: fromNode, now, random });
  const target = decision.target ?? `${decision.name}.${decision.node}`;
  const mesh = {
    v: 1,
    kind: 'request',
    request_id: id,
    target,
    from_node: fromNode ?? null,
    to_node: decision.node,
    ttl: normalizedTtl,
    return_to: returnTo ?? null,
  };
  return {
    type: 'mention',
    to_node: decision.node,
    target: decision.name,
    body: decision.body ?? '',
    user,
    request_id: id,
    ttl: normalizedTtl,
    mesh,
  };
}

export function meshReturnFields(event) {
  return {
    ...(event?.tg_chat_id != null ? { tg_chat_id: event.tg_chat_id } : {}),
    ...(event?.wa_chat_id != null ? { wa_chat_id: event.wa_chat_id } : {}),
  };
}

export function meshReplyContext(event, { fromNode } = {}) {
  const id = meshRequestId(event);
  if (!id) return meshReturnFields(event);

  const ttl = nextMeshTtl(event);
  const target = event?.mesh?.target ?? (
    event?.target && event?.to_node ? `${event.target}.${event.to_node}` : event?.target ?? null
  );
  return {
    request_id: id,
    ttl,
    mesh: {
      v: 1,
      kind: 'reply',
      request_id: id,
      target,
      from_node: fromNode ?? null,
      to_node: event?.from ?? null,
      ttl,
      return_to: event?.mesh?.return_to ?? null,
    },
    ...meshReturnFields(event),
  };
}

export function createMeshSeenCache({ ttlMs = DEFAULT_MESH_SEEN_TTL_MS, now = Date.now } = {}) {
  const seen = new Map();

  const prune = () => {
    const t = Number(now()) || 0;
    for (const [id, expires] of seen) {
      if (expires <= t) seen.delete(id);
    }
  };

  return {
    has(id) {
      if (!id) return false;
      prune();
      return seen.has(String(id));
    },
    mark(id) {
      if (!id) return false;
      prune();
      seen.set(String(id), (Number(now()) || 0) + ttlMs);
      return true;
    },
    checkAndMark(id) {
      if (!id) return false;
      if (this.has(id)) return true;
      this.mark(id);
      return false;
    },
    prune,
    size() {
      prune();
      return seen.size;
    },
  };
}
