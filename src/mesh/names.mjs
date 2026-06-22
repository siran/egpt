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

// Classify a sibling registry entry by HOW it is reached:
//   { to: "being.node" } → relay   (re-resolves + forwards to another being.node)
//   { node: "X" }        → remote  (a real being living at node X)
//   else                 → local   (run on this node)
export function meshSiblingKind(entry) {
  if (entry && typeof entry === 'object') {
    if (entry.to) return 'relay';
    if (entry.node) return 'remote';
  }
  return 'local';
}

function siblingEntries(siblings) {
  if (!siblings) return [];
  if (siblings instanceof Map) return [...siblings.entries()];
  if (Array.isArray(siblings)) return siblings.map((s) => (Array.isArray(s) ? s : [s?.name, s]));
  if (typeof siblings === 'object') return Object.entries(siblings);
  return [];
}

// Find a registry entry by canonical name OR alias → { name, entry } | null.
function findSibling(siblings, name) {
  const want = normalizeMeshPart(name);
  if (!want) return null;
  for (const [n, entry] of siblingEntries(siblings)) {
    if (normalizeMeshPart(n) === want) return { name: want, entry };
    for (const a of (entry?.aliases ?? [])) if (normalizeMeshPart(a) === want) return { name: normalizeMeshPart(n), entry };
  }
  return null;
}

// Resolve an @mention against the ONE per-node registry (EGPT_CONFIG.siblings) —
// each entry local | remote(node) | relay(to). `mesh.nodes.<node>.routes` is the
// SEPARATE transport layer (how to reach a node), not part of this registry.
export function resolveMeshAddress(token, { localNode, siblings = {} } = {}) {
  const addr = parseMeshAddress(token);
  if (!addr) return { kind: 'invalid', token: String(token ?? '') };
  const node = normalizeMeshPart(localNode);
  const found = findSibling(siblings, addr.name);

  // Fully-qualified @being.node — explicit destination.
  if (addr.qualified) {
    const base = { name: addr.name, qualified: true, node: addr.node, fqid: addr.fqid };
    if (node && sameMeshNode(addr.node, node)) {
      return (found && meshSiblingKind(found.entry) === 'local')
        ? { kind: 'local', ...base }
        : { kind: 'missing', ...base };
    }
    return { kind: 'foreign', ...base };
  }

  // Bare @being — resolved by the single registry entry.
  if (!found) return { kind: 'missing', name: addr.name, qualified: false, node: node ?? null, fqid: null };
  const kind = meshSiblingKind(found.entry);
  if (kind === 'local') return { kind: 'local', name: found.name, qualified: false, node };
  if (kind === 'remote') {
    const rn = normalizeMeshPart(found.entry.node);
    return { kind: 'foreign', name: found.name, qualified: false, node: rn, fqid: `${found.name}.${rn}` };
  }
  // relay → re-resolves to entry.to ("being.node")
  const t = parseMeshAddress(found.entry.to);
  if (!t || !t.node) return { kind: 'missing', name: found.name, qualified: false, node: node ?? null, fqid: null };
  return { kind: 'relay', name: found.name, qualified: false, target: t.fqid, being: t.name, node: t.node };
}
