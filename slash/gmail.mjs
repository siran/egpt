// slash/gmail.mjs - Gmail limb status and manual poll.

export const meta = {
  cmd: '/gmail',
  section: 'MISC',
  surface: 'shell',
  usage: '/gmail [status|poll]',
  desc: 'inspect the Gmail limb and trigger a manual poll',
};

export async function run({ arg, ctx }) {
  const { sysOut, gmailBridgeRef, EGPT_CONFIG } = ctx;
  const sub = arg.trim().split(/\s+/).filter(Boolean)[0] ?? 'status';
  const bridge = gmailBridgeRef?.current ?? null;

  if (sub === 'status') {
    if (!EGPT_CONFIG.gmail?.enabled) {
      sysOut('gmail: disabled. Set gmail.enabled true plus OAuth client_id, client_secret, refresh_token.');
      return true;
    }
    if (!bridge) {
      sysOut('gmail: enabled in config but bridge is not running. Check logs for missing credentials or OAuth errors.');
      return true;
    }
    const s = bridge.status();
    sysOut(
      `gmail: running\n` +
      `  query: ${s.query}\n` +
      `  poll: ${Math.round(s.pollMs / 1000)}s${s.inFlight ? ' (in flight)' : ''}\n` +
      `  propose_response: ${s.proposeResponse ? 'on' : 'off'}\n` +
      `  create_drafts: ${s.createDrafts ? 'on' : 'off'}\n` +
      `  seen: ${s.seenCount}\n` +
      `  last poll: ${s.lastPollAt ?? '(not yet)'}`
    );
    return true;
  }

  if (sub === 'poll') {
    if (!bridge) {
      sysOut('gmail: bridge is not running');
      return true;
    }
    try {
      const r = await bridge.pollNow();
      sysOut(`gmail: poll complete (${r.processed ?? 0} new, ${r.important ?? 0} important${r.skipped ? ', skipped' : ''})`);
    } catch (e) {
      sysOut(`!! gmail poll: ${e?.message ?? e}`);
    }
    return true;
  }

  sysOut('!! /gmail [status|poll]');
  return true;
}
