// transcript-meta.mjs — YAML front matter for a conversation's transcript.md.
//
// Each transcript opens with a front-matter block identifying WHO the transcript
// is with, the resumable thread, the persona on it, and operator notes. The
// block is written once at creation (dispatch.mjs) and is the stable container
// the future "collector" enriches (network / phone / type / participants come
// from the limb's chat metadata once that's plumbed — see GENOME §5).
//
// Pure + dependency-free: `renderFrontMatter` builds the block, `stripFrontMatter`
// removes it before a reader parses turns (so the @l transcript-tail doesn't feed
// `name:`/`---` lines to the model as conversation). Locked by transcript-meta.test.mjs.

// Field order is intentional (identity → routing → notes); empty values are
// omitted EXCEPT `notes`, which always renders as an editable slot.
const ORDER = [
  'name',          // contact name, or the group's name
  'phone',         // individual only (collector-filled)
  'network',       // WhatsApp / Telegram / … (collector-filled)
  'account',       // accountID (collector-filled)
  'chat_id',       // the surface chat id
  'surface',       // entry-point node: wa | tg | kg | chrome
  'slug',          // path-valid conversation slug
  'type',          // individual | group (collector-filled)
  'participants',  // groups: the roster (collector-filled)
  'thread_id',     // egpt resumable thread id (distinct from chat_id)
  'persona',       // the being on this thread (e / system-e / wren / …), or null
  'notes',         // operator free-text
];

function _val(v) {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`;
  return String(v);
}

/**
 * Render a YAML front-matter block (with a trailing blank line). Omits empty
 * fields; always emits a `notes:` slot. Unknown keys (not in ORDER) are appended
 * after the known ones, in insertion order.
 */
export function renderFrontMatter(fields = {}) {
  const out = ['---'];
  const seen = new Set();
  const emit = (k) => {
    const v = fields[k];
    seen.add(k);
    if (k === 'notes') { out.push(`notes:${v ? ' ' + _val(v) : ''}`); return; }
    if (v === undefined || v === null || v === '') return;
    out.push(`${k}: ${_val(v)}`);
  };
  for (const k of ORDER) emit(k);
  for (const k of Object.keys(fields)) if (!seen.has(k)) {
    const v = fields[k];
    if (v === undefined || v === null || v === '') continue;
    out.push(`${k}: ${_val(v)}`);
  }
  out.push('---');
  return out.join('\n') + '\n\n';
}

/**
 * Remove a leading `---\n … \n---` front-matter block (and the blank lines after
 * it) so a reader sees only conversation turns. No block → text unchanged.
 */
export function stripFrontMatter(text) {
  const s = String(text ?? '');
  if (!s.startsWith('---\n') && s !== '---') return s;
  const end = s.indexOf('\n---', 3);          // closing fence
  if (end === -1) return s;                    // unterminated → leave as-is
  let rest = s.slice(end + 4);                 // past the closing '---'
  rest = rest.replace(/^[^\n]*\n/, '');        // drop the remainder of the fence line
  return rest.replace(/^\n+/, '');             // drop blank lines after the block
}
