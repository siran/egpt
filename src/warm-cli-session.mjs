// warm-cli-session.mjs — a resident, WARM Claude Code CLI session (Unit 4).
//
// ONE long-lived `claude --print --input-format stream-json --output-format
// stream-json [--resume <id>]` process that answers each streamed user message
// as a turn. Verified 2026-06-13: turn 2 is ~2× faster than the cold turn 1 —
// the process + model context stay warm between turns. This is the CLI analog of
// the retired in-process SDK warm session: the engine stays the CLI (I11), only
// the process is kept RESIDENT instead of re-spawned per turn.
//
// Interface = what `src/warm-sessions.mjs` (createWarmPool) expects of a session:
//   turn(message, onUpdate) -> { text, sessionId }  ·  inject(message) -> bool  ·  close()
// The pool owns lazy-warm, idle-evict (the residency/reap policy), LRU, and
// per-key serialization, so this primitive only manages ONE process running ONE
// turn at a time.
//
// `inject` — AMENDED 2026-08-30, and the history is kept because it was half right.
// This header used to say: "No `inject` is exported — the pool then serializes follow-ups
// (stream-json treats each user message as a separate query, not a mid-turn weave)." The
// operator MEASURED that claim against the real `claude --input-format stream-json` CLI on
// 2026-08-30, writing a SECOND user line to a live process's stdin while turn 1 was still
// generating. Two distinct behaviors, and the difference is the whole feature:
//
//   - PURE TEXT generation (no tool calls): the mid-flight line is NOT absorbed. Turn 1
//     finishes its ORIGINAL task, then a second `init` appears on the SAME session and a
//     second `result` answers the new message. Two replies, nothing lost. The old comment
//     described exactly this case, and for this case it still holds.
//   - AGENTIC turn (a Read loop): the line written right after the 2nd `tool_use` IS
//     absorbed into the running turn. ONE result, answering the NEW instruction, having
//     abandoned 4 of its 6 planned Reads — and the process then sat open 143 more seconds
//     with no second result. That silence is what proves absorption rather than a
//     fast-queued second query.
//
// So the CLI supports steering NATIVELY, at a tool boundary — which is where an agentic
// turn spends its time and where a human's follow-up ("actually, do X instead") is worth
// anything at all. `inject` is that primitive; WHEN it may be used is a policy decision
// made far above it (conversation_defaults.allow_new_input → spine → warm pool `steer`).
//
// …AND WHAT IT RETURNS IS NOW EVIDENCE, NOT A SUCCESSFUL WRITE (operator 2026-09-09, after the
// live fault in `Joyce Vicente-2606301852`: four messages steered, a 👀 on each, no reply ever;
// the sandboxed claude.exe measured afterwards with NO CHILDREN and ~350s of CPU over 21 hours,
// i.e. idle). `proc.stdin.write` on a LIVE process's pipe succeeds whether or not anything on
// the other end ever reads it, so the old `return true` meant SENT and was read one layer up as
// RECEIVED. Operator: "nothing in eGPT can be allowed to lie".
//
// THE SIGNAL, MEASURED 2026-09-09 against the real CLI on this box. `--replay-user-messages`
// ("Re-emit user messages from stdin back on stdout for acknowledgment", stream-json only) makes
// the CLI echo each user line it takes as
//     {"type":"user","message":{…},"isReplay":true,"session_id":…,"uuid":…}
// AT THE MOMENT OF INGESTION, not when the bytes are read. Both halves of the 2026-08-30
// behaviour were re-measured through it, and the 3-second gap between them is what proves which
// moment it marks:
//   - AGENTIC turn, line written while tool_use #2 was still streaming: the replay came back
//     29ms later, sequenced right after that call's tool_result — absorbed into the LIVE turn.
//   - PURE-TEXT turn, line written 2423ms into the generation: the replay came back at 5485ms,
//     AFTER turn 1's own result (4923ms) and after a second `init` — a separate turn, not a weave.
// With the flag OFF the injected text appears NOWHERE in stdout (0 hits across a full 258-event
// agentic run), which is why the flag is not optional here: without it there is no ack at all.
//
// `inject` therefore returns `false` (nothing was handed over) or `{ ack }`, where `ack` is a
// promise that settles from CLI EVENTS ONLY — never a clock: `{ok:true}` on that replay, and
// `{ok:false, reason}` when the turn ends, fails, the process exits or the session closes with
// the line still un-ingested. A steer that is never ingested therefore ends as a stated refusal
// rather than as silence.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs } from './claude-args.mjs';

// THE stream-json wire format for ONE user message, in one place. turn() and inject()
// write byte-identical lines to the same stdin — the CLI cannot tell them apart, and the
// measurement above says it must not: a steered line IS an ordinary user message, the only
// difference being that nobody is waiting on a `result` of its own.
function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] } }) + '\n';
}

// MSYS2/Cygwin "/c/Users/.." → "C:/Users/.." for Node spawn cwd on Windows.
function normalizeCwd(p) {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// ── tool_use summaries ──────────────────────────────────────────────────────
//
// The 2026-08-29 shape was a BARE `Bash()` stub. Operator 2026-08-30 refined it:
// "tool-calls as stubs, it is ok, i'd like to see a bit more of the command being
// executed, not so much as the result that can be too much... reveal a bit more on
// what inside the parenthesis of 'Bash()'". So the parens now carry a SHORT summary
// of the call's `input` — never its result. (The result needs no guard: a tool_result
// arrives on a separate `user`-role event and onStdout never routes those here. Keep
// it that way.)
//
// ONE headline field per tool: the single argument that says what the call DOES. A
// list per tool (not a bare string) only so a renamed-but-equivalent field can alias
// — e.g. NotebookEdit's `notebook_path`. Unknown/MCP tools fall through to a generic
// scan below.
const TOOL_HEADLINE_FIELDS = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['file_path', 'notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description'],
  Agent: ['description'],
};

// A field only qualifies for the UNKNOWN-tool scan if it is already compact. The point
// is to skip payload blobs (a Write `content`, a prompt) and land on the identifying
// argument, so the bar is ~3× the render budget — loose enough that a long real path
// or pattern still wins, tight enough that a file body never does. A KNOWN tool's
// headline field is exempt: a 4KB heredoc `command` is still the right thing to show,
// truncated.
const UNKNOWN_FIELD_MAX = 200;

// How many unreadable stdout lines one session reports before it stops (see onStdout). Small:
// these should never happen, and if they start happening the first few say everything.
const UNREADABLE_LOG_CAP = 5;

// 60 chars. The rendered text is a WhatsApp reply, and an agentic turn emits DOZENS of
// tool calls — the budget is paid once per call, so it is a signpost ("which file? which
// host?"), not a payload. 60 keeps `Bash(<60>)` inside ~70 columns, about one wrapped
// line in a phone bubble, and comfortably fits a repo-relative path or a `curl` up to
// its URL. The ellipsis is INSIDE the budget so the rendered field is never > 60.
const SUMMARY_MAX = 60;

// SECRET REDACTION. This is posted into a chat, so a naive `Bash(command)` render would
// publish the operator's real credentials: `curl -u <user>:<password>` against the radio
// station, the Beeper API token, the egpt-relay password, speaker creds. Applied to EVERY
// headline value (a WebFetch url can carry inline creds too), and BEFORE truncation — so
// truncation is never the only thing hiding a secret, and a redacted long command is
// still cut at a sane place. Patterns run in order; each replaces only the SECRET span so
// the shape of the command survives (`curl -u ***  https://...` still reads as a curl).
// Deliberately biased toward over-redaction: a stub that says `***` too often costs
// nothing, a stub that leaks once cannot be unposted.
const SECRET_PATTERNS = [
  // https://user:pass@host → https://***@host. Requires the ':' so a bare `ssh://an@dolly`
  // (a username, not a credential) still renders.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]*@/gi, '$1***@'],
  // curl basic auth, spaced or '=': `-u user:pass`, `--user user:pass`, `--user=user:pass`.
  [/(^|\s)(-u|--user)(?:\s+|=)(?:'[^']*'|"[^"]*"|\S+)/g, '$1$2 ***'],
  // …and curl's glued form `-umy:pass`. Only when the value has curl's user:pass colon,
  // so an unrelated `-utf8`-ish flag is left alone.
  [/(^|\s)(-u)[^\s:'"]+:[^\s'"]*/g, '$1$2 ***'],
  // `Authorization: Bearer <x>` (also Basic/Token/Digest, also with no scheme word). Stops
  // at a quote so the enclosing `-H "..."` keeps its closing quote.
  [/(authorization\s*:\s*)((?:bearer|basic|token|digest)\s+)?[^\s'"]+/gi, '$1$2***'],
  // A bare `Bearer <token>` outside an Authorization header. Length-gated so ordinary prose
  // ("bearer of bad news") in a Task `description` is not mangled.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // `--password x` / `--token x` / `--api-key=x` / `--secret x` (also single-dash).
  [/(^|\s)(--?(?:password|passwd|pwd|pass|token|api[-_]?key|apikey|secret|credential)s?)(?:\s+|=)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1$2 ***'],
  // key=value in a query string OR an env assignment. The leading `[\w.-]*` is what makes
  // `EGPT_RELAY_PASSWORD=hunter2` match at all (no word boundary before `PASSWORD`); the
  // quoted alternatives come first so `SPEAKER_SECRET='s3 cr3t'` is taken WHOLE (the bare
  // form stops at '&' so the rest of a query string survives).
  [/([\w.-]*(?:password|passwd|pwd|token|api[-_]?key|apikey|secret))\s*=\s*(?:'[^']*'|"[^"]*"|[^\s&'"]+)/gi, '$1=***'],
  // Self-identifying key shapes that can appear as a bare argument with no flag or key to
  // anchor on: `sk-…` / `sk-ant-…`, GitHub PATs, and JWTs (a Beeper token is a JWT).
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9._-]{8,})/g, '***'],
];

export function redactSecrets(s) {
  let out = String(s ?? '');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// The pure renderer, exported so the mapping/redaction/truncation rules are testable
// without driving a fake CLI. Returns `Name(<short summary>)`, or exactly today's
// `Name()` when nothing usable is in `input`.
export function renderToolUse(block) {
  const name = typeof block?.name === 'string' ? block.name : '';
  if (!name) return '';
  const input = block?.input;
  let raw = null;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const f of TOOL_HEADLINE_FIELDS[name] ?? []) {
      if (typeof input[f] === 'string' && input[f].trim()) { raw = input[f]; break; }
    }
    // Unknown tool (or a known one missing its headline field): first compact string.
    if (raw === null) {
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.trim() && v.length <= UNKNOWN_FIELD_MAX) { raw = v; break; }
      }
    }
  }
  if (raw === null) return `${name}()`;
  // Collapse first (a heredoc or a backslash-continued command must stay ONE line, and it
  // also lets every pattern above be a single-line regex), then redact, then truncate.
  let s = raw.replace(/\s+/g, ' ').trim();
  s = redactSecrets(s);
  if (s.length > SUMMARY_MAX) s = s.slice(0, SUMMARY_MAX - 1) + '…';
  return s ? `${name}(${s})` : `${name}()`;
}

// verboseThinking rendering (operator 2026-08-29, wren's "see your full chain of thought"
// request over WhatsApp: "tool use can be only like Bash()"). One assistant event's content
// blocks -> pushed onto pending.verboseBlocks, arrival order preserved across the WHOLE turn
// (every assistant event, not just one — a ccode turn is agentic: reason -> tool_use ->
// tool_result -> reason again -> ... -> final text, each step its own `assistant` event).
// text/thinking render verbatim; tool_use renders via renderToolUse above — a stub whose
// parens carry a redacted, truncated summary of the INPUT (operator 2026-08-30), never the
// result. A tool_result arrives on a separate `user`-role event, which onStdout never routes
// here, so it never appears regardless. Only called when verboseThinking is on — the default
// OFF path never calls this.
function pushVerboseBlocks(pending, content) {
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string' && c.text) pending.verboseBlocks.push(c.text);
    else if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking) pending.verboseBlocks.push(c.thinking);
    else if (c?.type === 'tool_use' && typeof c.name === 'string' && c.name) pending.verboseBlocks.push(renderToolUse(c));
  }
}

// Resolve the claude binary to a FULL path. A Windows SERVICE inherits a minimal
// PATH (not the login PATH), and — verified the hard way (operator 2026-06-14:
// DOLLY's Don ENOENT survived an `egpt-spine.mjs` PATH prepend) — mutating
// `process.env.PATH` at runtime does NOT reliably reach libuv's spawn path-search
// on Windows. So don't rely on PATH: prefer an explicit override
// (config `bin` / `EGPT_CLAUDE_BIN`), else the known per-user install
// (`~/.local/bin/claude[.exe]`, where the installer puts it), else fall back to
// bare `claude` (PATH) for setups that do have it.
function resolveClaudeBin(explicit) {
  const override = explicit || process.env.EGPT_CLAUDE_BIN;
  if (override) return override;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const local = join(homedir(), '.local', 'bin', exe);
  try { if (existsSync(local)) return local; } catch { /* fall through to PATH */ }
  return 'claude';
}

export function createWarmCliSession(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const _spawn = options.spawn || nodeSpawn;   // injectable for tests
  // Opt-in, default off (operator 2026-08-29 ruling): when on, the turn's resolved `text` is
  // the full verbose transcript (thinking verbatim + tool-name stubs) instead of the CLI's own
  // clean `ev.result`. Wired the same way as cwd/model/effort — see brainpool.mjs baseOpts.
  const verboseThinking = options.verboseThinking === true;
  let proc = null;
  let stdoutBuf = '';
  let unreadable = 0;               // stdout lines this session could not parse (see onStdout)
  let stderrBuf = '';
  let sessionId = options.sessionId ?? null;
  let pending = null;   // { resolve, reject, onUpdate, acc, settled }
  let closed = false;

  function spawnProc() {
    // Reuse the tested confinement/model/effort/--resume arg-builder, then add
    // the streaming INPUT format so one process answers many turns. buildClaudeArgs
    // already supplies BASE_ARGS (--print --output-format stream-json --verbose
    // --include-partial-messages), the sandbox flags, --model/--effort, and
    // --resume <sessionId> when set.
    // --replay-user-messages: the injection ACKNOWLEDGEMENT (see the header measurement). It is
    // paired with --input-format stream-json because that is the only mode it works in, and it
    // is unconditional because without it `inject` has no evidence to return. Additive to the
    // OUTPUT stream only — it adds `user`/isReplay events, which onStdout routes to the ack
    // below and nothing else reads, so every existing turn parses byte-identically.
    const args = ['--input-format', 'stream-json', '--replay-user-messages', ...buildClaudeArgs(options)];
    const cwd = normalizeCwd(options.cwd);
    // A non-existent cwd makes Node's spawn fail with a MISLEADING `spawn <bin>
    // ENOENT` — it names the binary, not the missing dir (operator 2026-06-14:
    // DOLLY's Don had a YAML-mangled cwd `C:Usersansrcegpt` and it cost hours of
    // chasing PATH/binary ghosts). Check it up front and fail with the real reason.
    // (The '!!' prefix is added by the caller's catch, so this routes through the
    // bridge failure-notice path rather than leaking as the sibling's reply.)
    if (cwd && !existsSync(cwd)) {
      throw new Error(`warm-cli: cwd does not exist: ${cwd} — check the being's config 'cwd' (a double-quoted backslash YAML path gets mangled; use forward slashes)`);
    }
    const bin = resolveClaudeBin(options.bin);
    onLog(`warm-cli: spawn ${bin} ${args.join(' ')}`);
    proc = _spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd ? { cwd } : {}) });
    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on('data', onStdout);
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (d) => { stderrBuf = (stderrBuf + d).slice(-2000); });
    proc.on('close', onClose);
    proc.on('error', (err) => failPending(err));
  }

  function onStdout(chunk) {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      // A LINE THIS SESSION CANNOT READ IS AN EVENT IT HAS LOST, AND IT SAYS SO (operator
      // 2026-09-09, "no error is swallowed silently"). This `continue` used to be silent, and
      // it sits on the ONLY path a turn has to finish: the turn's own `result` arrives as one
      // of these lines, and if the line is unreadable it is dropped here, `pending` is never
      // settled, the pool's `busy` stays true forever and the conversation wedges with the CLI
      // alive and idle — which is exactly the state the Joyce session was measured in. Whether
      // that is what happened there cannot be known now; what can be fixed is that it would
      // have left no trace at all. Capped, because a stdout that has started emitting garbage
      // must not also flood the log.
      try { ev = JSON.parse(t); } catch {
        if (unreadable < UNREADABLE_LOG_CAP) {
          unreadable++;
          // Through redactSecrets, the SAME pass the tool_use stubs use, and for the same
          // reason: a broken line is still raw stdout, and a truncated `Bash` tool_use input
          // can carry `curl -u user:pass`. Redact BEFORE truncating, as renderToolUse does.
          onLog(`warm-cli: DISCARDED an unreadable stdout line (${t.length} chars, starts ${JSON.stringify(redactSecrets(t).slice(0, 120))})${unreadable === UNREADABLE_LOG_CAP ? ' — further ones on this session are not logged' : ''}`);
        }
        continue;
      }
      // Capture the (possibly freshly-minted) session id, first-wins.
      if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
      // THE INJECTION ACK (operator 2026-09-09 — see the header measurement). `isReplay` marks
      // the CLI echoing back a user line it has just TAKEN, which is the only thing in this
      // stream that says the model got a steered message; the write itself says nothing.
      //
      // The turn's OWN opening line is replayed too, and it is consumed first so it can never
      // ack anything: without that, a steer whose text happens to equal the opener's ("ok",
      // "👍" — not exotic in a chat) would be acknowledged by an event that predates it.
      // A tool_result also arrives as a `user` event, and carries no `isReplay`, so it is not
      // seen here — same as before.
      if (ev.type === 'user' && ev.isReplay === true && pending) {
        const echoed = (Array.isArray(ev.message?.content) ? ev.message.content : [])
          .filter((c) => c?.type === 'text').map((c) => c.text).join('');
        if (!pending.openerReplayed && echoed === pending.openerText) pending.openerReplayed = true;
        else {
          const rec = pending.injections.find((r) => !r.done && r.text === echoed);
          if (rec) { rec.done = true; rec.settle({ ok: true }); }
        }
      }
      // verboseThinking: tap EVERY assistant event's content blocks, independent of the
      // existing (unchanged, below) `!pending.acc` first-wins fallback — additive only, a
      // no-op when the option is off. See pushVerboseBlocks above.
      if (verboseThinking && ev.type === 'assistant' && ev.message?.content && pending) {
        pushVerboseBlocks(pending, ev.message.content);
        // Progressive preview, mirroring pending.acc's onUpdate below: grow the WhatsApp
        // placeholder message-by-message instead of delivering the whole transcript once,
        // at `result`. The final `result`-event resolution below is unchanged/authoritative.
        try { pending.onUpdate?.(pending.verboseBlocks.join('\n\n')); } catch { /* caller's onUpdate */ }
      }
      // A MESSAGE BOUNDARY IS INFORMATION (operator 2026-09-01, live TWICE that morning in the
      // SPOILER chat). An agentic turn is MANY assistant messages (reason -> tool_use ->
      // tool_result -> reason -> ...) and `pending.acc += d.text` ran them together with NOTHING
      // between, so the humans read "...a simple affirmation doesn't need a reply from me./react
      // #563 🤝": the model HAD put its limb on its own line, the accumulator welded it onto the
      // previous message's full stop, and the line-anchored parse (reply-actions.mjs) could not
      // see the action at all. 51df9d8 taught THAT parser to read a '/' glued to sentence-ending
      // punctuation as a lost newline; this restores the newline at the seam where it is actually
      // lost, so the repair becomes a backstop instead of the only defence — and so a boundary
      // that lands anywhere (mid-sentence, after a comma, before ordinary prose) is carried too.
      //
      // ONE '\n', and only BETWEEN two runs of text:
      //   - acc still only ever APPENDS, so the record (spine.mjs onPartial -> transcript.logStream
      //     -> streamIncrement) reconstructs unchanged — the 2026-08-27 ruling's "every character
      //     present, in order, exactly once" holds, the separator simply being one of them now.
      //   - a BOOLEAN, not a counter: several tool_use-only messages between two reasons yield ONE
      //     break, not one per call.
      //   - consumed only by a delta that actually CARRIES text, so a '\n' is never written with
      //     nothing behind it; and skipped while acc is empty, so the turn's FIRST message gains no
      //     leading separator and a single-message turn stays byte-identical to before.
      //   - set on the `assistant` event without caring whether the CLI emits it before or after
      //     that message's own deltas — either ordering leaves exactly one pending break per
      //     message transition, which is why this is keyed on the event the module already trusts
      //     (see pushVerboseBlocks) rather than on a `message_start` nothing here has ever seen.
      // verboseThinking is untouched: it builds its text from verboseBlocks and its onUpdate is
      // fed by that branch alone, so acc's separator never reaches it.
      if (ev.type === 'assistant' && ev.message?.content && pending) pending.msgBreak = true;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const d = ev.event.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && pending) {
          if (d.text && pending.msgBreak) { if (pending.acc) pending.acc += '\n'; pending.msgBreak = false; }
          pending.acc += d.text;
          if (!verboseThinking) { try { pending.onUpdate?.(pending.acc); } catch { /* caller's onUpdate */ } }
        }
      } else if (ev.type === 'assistant' && ev.message?.content && pending && !pending.acc) {
        const text = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (text) { pending.acc = text; if (!verboseThinking) { try { pending.onUpdate?.(pending.acc); } catch { /* */ } } }
      } else if (ev.type === 'result') {
        if (ev.subtype === 'success') {
          // verboseThinking ON: the accumulated verbose buffer wins over ev.result. OFF
          // (default): exactly today's precedence — ev.result, else the streamed pending.acc.
          const text = verboseThinking
            ? (pending?.verboseBlocks ?? []).join('\n\n')
            : (typeof ev.result === 'string' ? ev.result : (pending?.acc ?? ''));
          resolvePending(text);
        } else {
          const detail = stderrBuf.trim() ? ` — ${stderrBuf.trim().slice(-300)}` : '';
          failPending(new Error(`claude: ${ev.subtype}${detail}`));
        }
      }
    }
  }

  // Tell every injection still waiting on this turn what became of it. Called from EVERY way a
  // turn can end, so a steered line is never left with nobody ever answering for it — that
  // silence is precisely what the Joyce incident was made of.
  function settleInjections(p, reason) {
    for (const rec of p?.injections ?? []) {
      if (rec.done) continue;
      rec.done = true;
      rec.settle({ ok: false, reason });
    }
  }

  function resolvePending(text) {
    if (!pending || pending.settled) return;
    pending.settled = true;
    const p = pending; pending = null;
    settleInjections(p, 'the turn ended before the CLI ingested it');
    p.resolve({ text, sessionId });
  }
  function failPending(err) {
    if (pending && !pending.settled) {
      pending.settled = true;
      const p = pending; pending = null;
      settleInjections(p, `the turn failed before the CLI ingested it: ${err?.message ?? err}`);
      p.reject(err);
    }
  }
  function onClose(code) {
    proc = null;
    if (pending && !pending.settled) {
      const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(-300)}` : '';
      failPending(new Error(`claude exited ${code} mid-turn${detail}`));
    }
  }

  return {
    async turn(message, onUpdate = () => {}) {
      if (closed) throw new Error('warm-cli: session closed');
      if (pending) throw new Error('warm-cli: a turn is already in flight (the pool must serialize per key)');
      if (!proc) spawnProc();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, onUpdate, acc: '', msgBreak: false, verboseBlocks: [], settled: false, openerText: String(message ?? ''), openerReplayed: false, injections: [] };
        try { proc.stdin.write(userLine(message)); } catch (e) { failPending(e); }
      });
    },
    // STEER the turn that is ALREADY streaming (operator 2026-08-30 — see the measurement
    // in the header). One user line to the SAME stdin, and deliberately NO new `pending`:
    // the in-flight turn's single `result` carries the combined reply, so a second pending
    // would be a promise nothing could ever settle (that is precisely the 143-second
    // silence the measurement recorded). The caller therefore gets NO reply of its own —
    // the spine's steer path opens no placeholder for exactly this reason.
    //
    // NEVER THROWS, and `false` is the honest, safe answer to "was anything handed over at
    // all?": no turn in flight (no pending), no process yet, the session already closed, or
    // the write itself failed. Every caller treats false as "nothing happened at all" and
    // falls back to queueing an ordinary turn.
    //
    // ANYTHING ELSE IS `{ ack }`, AND `{ ack }` IS NOT A CLAIM (operator 2026-09-09). It says
    // only that the bytes are on their way; `ack` is the promise that later says whether the
    // MODEL took them, settled by CLI events alone — the `isReplay` echo above for `{ok:true}`,
    // and the turn's own end / failure / exit / close for `{ok:false, reason}`. There is
    // deliberately no timer: a session that neither ingests nor ends is wedged, and the
    // absence of a 👀 in the chat is the report of that, not a made-up verdict.
    inject(message) {
      if (closed || !proc || !pending) return false;
      const text = String(message ?? '');
      let settle;
      const ack = new Promise((r) => { settle = r; });
      const rec = { text, settle, done: false };
      pending.injections.push(rec);
      try { proc.stdin.write(userLine(text)); }
      catch { rec.done = true; return false; }        // nobody holds `ack` — nothing to settle
      return { ack };
    },
    close() {
      closed = true;
      settleInjections(pending, 'the session was closed before the CLI ingested it');
      try { proc?.stdin?.end(); } catch { /* already closing */ }
      try { proc?.kill?.(); } catch { /* */ }
      proc = null;
    },
    get sessionId() { return sessionId; },
  };
}
