const PART_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function normalizeMeshPart(value) {
  const raw = String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
  return raw || null;
}

export function parseMeshAddress(value) {
  const raw = normalizeMeshPart(value);
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length === 1) {
    const [name] = parts;
    if (!PART_RE.test(name)) return null;
    return { qualified: false, name, node: null, fqid: null, raw };
  }

  if (parts.length === 2) {
    const [name, node] = parts;
    if (!PART_RE.test(name) || !PART_RE.test(node)) return null;
    return { qualified: true, name, node, fqid: `${name}.${node}`, raw };
  }

  return null;
}

export function sameMeshNode(a, b) {
  const aa = normalizeMeshPart(a);
  const bb = normalizeMeshPart(b);
  return !!aa && !!bb && aa === bb;
}

function addName(out, value) {
  const name = normalizeMeshPart(value);
  if (name) out.add(name);
}

function addAliases(out, entry) {
  if (!entry || typeof entry !== 'object') return;
  for (const alias of entry.aliases ?? []) addName(out, alias);
}

export function meshNamesFromSiblings(siblings) {
  const out = new Set();
  if (!siblings) return out;

  const entries = siblings instanceof Map
    ? siblings.entries()
    : Array.isArray(siblings)
      ? siblings
      : Object.entries(siblings);

  for (const [name, entry] of entries) {
    addName(out, name);
    addAliases(out, entry);
  }
  return out;
}

function normalizeNameSet(input) {
  if (!input) return new Set();
  if (input instanceof Set) return new Set([...input].map(normalizeMeshPart).filter(Boolean));
  if (input instanceof Map) return meshNamesFromSiblings(input);
  if (Array.isArray(input)) {
    const out = new Set();
    for (const item of input) {
      if (Array.isArray(item)) {
        addName(out, item[0]);
        addAliases(out, item[1]);
      } else if (item && typeof item === 'object' && 'name' in item) {
        addName(out, item.name);
        addAliases(out, item);
      } else {
        addName(out, item);
      }
    }
    return out;
  }
  if (typeof input === 'object') return meshNamesFromSiblings(input);
  return new Set([normalizeMeshPart(input)].filter(Boolean));
}

function peerEntries(peerNodes) {
  if (!peerNodes) return [];
  if (peerNodes instanceof Map) return [...peerNodes.entries()];
  if (Array.isArray(peerNodes)) return peerNodes;
  if (typeof peerNodes === 'object') return Object.entries(peerNodes);
  return [];
}

function namesFromPeerValue(value) {
  if (!value) return new Set();
  if (Array.isArray(value)) return normalizeNameSet(value);
  if (value instanceof Map) return meshNamesFromSiblings(value);
  if (typeof value === 'object') {
    if (value.beings) return normalizeNameSet(value.beings);
    if (value.siblings) return meshNamesFromSiblings(value.siblings);
    if (value.names) return normalizeNameSet(value.names);
    if (value.sessions) return normalizeNameSet(value.sessions);
    return meshNamesFromSiblings(value);
  }
  return normalizeNameSet(value);
}

export function resolveMeshAddress(token, { localNode, localNames = [], peerNodes = {} } = {}) {
  const addr = parseMeshAddress(token);
  if (!addr) return { kind: 'invalid', token: String(token ?? '') };

  const node = normalizeMeshPart(localNode);
  const localSet = normalizeNameSet(localNames);
  const base = { name: addr.name, qualified: addr.qualified };

  if (addr.qualified) {
    const fq = { ...base, node: addr.node, fqid: addr.fqid };
    if (node && sameMeshNode(addr.node, node)) {
      return localSet.has(addr.name)
        ? { kind: 'local', ...fq }
        : { kind: 'missing', ...fq };
    }
    return { kind: 'foreign', ...fq };
  }

  const candidates = [];
  if (localSet.has(addr.name)) candidates.push({ kind: 'local', name: addr.name, node });

  for (const [peerNode, value] of peerEntries(peerNodes)) {
    const peer = normalizeMeshPart(peerNode);
    if (!peer || (node && peer === node)) continue;
    if (namesFromPeerValue(value).has(addr.name)) {
      candidates.push({ kind: 'foreign', name: addr.name, node: peer, fqid: `${addr.name}.${peer}` });
    }
  }

  if (candidates.length === 1) {
    return { ...candidates[0], qualified: false };
  }
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      name: addr.name,
      qualified: false,
      candidates: candidates.map(c => c.fqid ?? c.name),
    };
  }
  return { kind: 'missing', ...base, node: node ?? null, fqid: null };
}
