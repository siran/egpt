// whisper-server-ecs: a GPU whisper-server in an ECS service, woken per note and slept when idle.
// Fake AWS (the api object, or a fake fetch behind the real client) and a fake whisper-server over real
// HTTP, so the decode goes through the same request code whisper-server-local uses.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTranscriptionPipeline } from '../src/transcription-pipeline.mjs';
import { makeWhisperServerTranscriber } from '../src/tools/whisper-server.mjs';
import { createEcsWaker } from '../src/tools/whisper-ecs.mjs';
import { signV4, createEcsClient, readAwsKeyPair } from '../src/tools/aws-ecs.mjs';
import { createTranscription } from '../src/spine/transcription.mjs';

const settle = () => new Promise((r) => setTimeout(r, 10));

function fakeWhisperServer() {
  const s = { inferences: 0, active: 0, maxActive: 0, answering: true, bodies: [] };
  s.server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (!s.answering) { res.statusCode = 503; return res.end('loading model'); }
      return res.end('<html>whisper.cpp server</html>');
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    s.bodies.push(Buffer.concat(chunks).toString('latin1'));
    s.inferences++; s.active++; s.maxActive = Math.max(s.maxActive, s.active);
    await new Promise((r) => setTimeout(r, 5));
    s.active--;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: ' hola gpu ' }));
  });
  return s;
}

// ECS as the waker sees it: desired count, and a task that is RUNNING with an IP a few polls after desired 1.
function fakeEcs({ desired = 0, readyAfterPolls = 2, ip = '127.0.0.1' } = {}) {
  const e = { desired, calls: [], polls: 0, never: false, fail: null, gate: null, stopGate: null };
  e.count = (name) => e.calls.filter((c) => c === name).length;
  e.api = {
    describeService: async () => { e.calls.push('DescribeServices'); if (e.fail) throw new Error(e.fail); return { desiredCount: e.desired }; },
    setDesired: async (n) => { e.calls.push(`UpdateService ${n}`); if (n === 0 && e.stopGate) await e.stopGate; e.desired = n; e.polls = 0; },
    runningTaskIp: async () => {
      e.calls.push('ListTasks');
      if (e.gate) await e.gate;
      if (e.desired < 1 || e.never) return null;
      return ++e.polls >= readyAfterPolls ? ip : null;
    },
  };
  return e;
}

const gpuEngine = (port) => ({
  type: 'whisper-server-ecs', cluster: 'edw', service: 'edw-whisper', region: 'us-east-1', port,
  credentials: 'aws-whisper-waker', wake_timeout_ms: 240000, idle_stop_ms: 1200000, language: 'auto',
});
const gpuCli = (port) => ({ fallback_order: ['gpu', 'cli'], gpu: gpuEngine(port), cli: { type: 'whisper-cli', command: 'wc', model_path: 'small', language: 'es' } });

let ws, port, dir;
beforeAll(async () => {
  ws = fakeWhisperServer();
  await new Promise((r) => ws.server.listen(0, '127.0.0.1', r));
  port = ws.server.address().port;
});
afterAll(() => new Promise((r) => ws.server.close(r)));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egpt-ecs-'));
  Object.assign(ws, { inferences: 0, active: 0, maxActive: 0, answering: true, bodies: [] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let fileN = 0;
const note = (text = `note ${++fileN}`) => { const p = join(dir, `n-${fileN}-${Math.random()}.ogg`); writeFileSync(p, text); return p; };
const fakeConvert = async () => { const p = join(dir, `w-${Math.random()}.wav`); writeFileSync(p, Buffer.alloc(44 + 32000)); return p; };

function mk({ ecs, profile = gpuCli(port), api = ecs?.api, ...over } = {}) {
  let clock = 0;
  const timers = [], logs = [], transitions = [];
  const calls = { cli: 0, wakers: 0 };
  const onLog = (m) => logs.push(m);
  const pipe = buildTranscriptionPipeline({
    profile,
    now: () => clock,
    makeWhisperServerTranscriber: (o) => makeWhisperServerTranscriber({ ...o, convert: fakeConvert }),
    cli: async () => { calls.cli++; return 'CLI'; },
    transcribeViaEndpoint: async () => 'REMOTE',
    startWhisperServer: async () => ({ url: 'http://local', stop() {} }),
    residentServing: () => null,
    onTransition: (t) => transitions.push(t),
    onLog,
    makeEcsWaker: (eng) => {
      calls.wakers++;
      return createEcsWaker({
        eng, api, onLog, now: () => clock,
        sleep: async (ms) => { clock += ms; await new Promise((r) => setTimeout(r, 1)); },
        setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
        clearTimer: (t) => { t.live = false; },
      });
    },
    ...over,
  });
  const armed = () => timers.filter((t) => t.live);
  const fire = async () => { const [t] = armed(); t.live = false; t.fn(); await settle(); };
  return { pipe, logs, calls, transitions, armed, fire, advance: (ms) => { clock += ms; } };
}

describe('whisper-server-ecs — wake, decode, sleep', () => {
  it('a cold note wakes the service (desired 0→1), waits for its task, and decodes there through the shared whisper-server request', async () => {
    const ecs = fakeEcs({ readyAfterPolls: 3 });
    const { pipe, logs, calls } = mk({ ecs });
    expect(await pipe.transcribe(note(), { language: 'es' })).toBe('hola gpu');
    expect(ecs.count('UpdateService 1')).toBe(1);
    expect(ecs.desired).toBe(1);
    expect(ws.inferences).toBe(1);
    expect(ws.bodies[0]).toMatch(/name="language"\r\n\r\nauto\r\n/);   // the rung's language, not the cli's es
    expect(calls.cli).toBe(0);
    const said = logs.join('\n');
    expect(said).toMatch(/gpu "gpu" \(edw\/edw-whisper\): waking \(desired 0→1\)/);
    expect(said).toMatch(new RegExp(`ready at 127\\.0\\.0\\.1:${port} in \\d+s`));
  });

  it('notes arriving while it wakes share ONE wake, each shows 🎧 while waiting, and decode one at a time', async () => {
    const ecs = fakeEcs({ readyAfterPolls: 1 });
    let open; ecs.gate = new Promise((r) => { open = r; });
    const { pipe } = mk({ ecs });
    const ups = [];
    const hook = (i) => async () => { ups.push(i); return async () => {}; };
    const all = Promise.all([1, 2, 3].map((i) => pipe.transcribe(note(), {}, () => {}, {}, hook(i))));
    await settle(); await settle();
    expect(ups.sort()).toEqual([1, 2, 3]);                    // all three are waiting on the wake
    ecs.gate = null; open();
    expect(await all).toEqual(['hola gpu', 'hola gpu', 'hola gpu']);
    expect(ecs.count('DescribeServices')).toBe(1);
    expect(ecs.count('UpdateService 1')).toBe(1);
    expect(ecs.count('ListTasks')).toBe(1);
    expect(ws.inferences).toBe(3);
    expect(ws.maxActive).toBe(1);
  });

  it('a warm note makes no AWS call at all', async () => {
    const ecs = fakeEcs();
    const { pipe } = mk({ ecs });
    await pipe.transcribe(note());
    ecs.calls.length = 0;
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    expect(ecs.calls).toEqual([]);
    expect(ws.inferences).toBe(2);
  });

  it('a wake that times out falls to the next engine with one log line, and the reason reaches the transition', async () => {
    const ecs = fakeEcs();
    const { pipe, logs, transitions } = mk({ ecs });
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    ws.answering = false; ecs.never = true;                    // the task is gone; nothing comes up
    expect(await pipe.transcribe(note())).toBe('CLI');
    expect(logs.filter((m) => /not ready within 240s — next engine/.test(m))).toHaveLength(1);
    expect(transitions).toEqual([{ from: 'gpu', to: 'cli', recovered: false, reason: 'not ready within 240s' }]);
  });

  it('idle stop: idle_stop_ms after the last note it sets desired 0; a later note wakes it again', async () => {
    const ecs = fakeEcs();
    const { pipe, logs, armed, fire } = mk({ ecs });
    await pipe.transcribe(note());
    expect(armed().map((t) => t.ms)).toEqual([1200000]);
    await fire();
    expect(ecs.desired).toBe(0);
    expect(logs.join('\n')).toMatch(/asleep \(desired 0 after 20 min idle\)/);
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    expect(ecs.count('UpdateService 1')).toBe(2);
    expect(armed()).toHaveLength(1);                           // armed again after that note
  });

  it('a note in flight holds the idle stop off: the timer is cancelled on arrival and re-armed when it ends', async () => {
    const ecs = fakeEcs();
    const { pipe, armed } = mk({ ecs });
    await pipe.transcribe(note());
    const first = armed()[0];
    const p = pipe.transcribe(note());
    await settle();
    expect(first.live).toBe(false);
    await p;
    expect(armed()).toHaveLength(1);
    expect(armed()[0]).not.toBe(first);
  });

  it('a note arriving while the idle stop is in flight waits for it, then wakes the service again', async () => {
    const ecs = fakeEcs();
    let land; ecs.stopGate = new Promise((r) => { land = r; });
    const { pipe, fire } = mk({ ecs });
    await pipe.transcribe(note());
    await fire();                                              // UpdateService 0 sent, not answered yet
    const p = pipe.transcribe(note());
    await settle();
    land();
    expect(await p).toBe('hola gpu');
    expect(ecs.calls.slice(ecs.calls.indexOf('UpdateService 0'))).toEqual(['UpdateService 0', 'DescribeServices', 'UpdateService 1', 'ListTasks', 'ListTasks']);
    expect(ecs.desired).toBe(1);
  });

  it('boot: an awake service gets its idle stop armed; an asleep one is left alone', async () => {
    const awake = fakeEcs({ desired: 1 });
    const a = mk({ ecs: awake });
    await a.pipe.boot();
    expect(a.armed().map((t) => t.ms)).toEqual([1200000]);
    expect(a.logs.join('\n')).toMatch(/awake at boot — idle stop in 20 min/);
    await a.fire();
    expect(awake.calls).toEqual(['DescribeServices', 'UpdateService 0']);

    const asleep = fakeEcs({ desired: 0 });
    const b = mk({ ecs: asleep });
    await b.pipe.boot();
    expect(b.armed()).toEqual([]);
    expect(asleep.calls).toEqual(['DescribeServices']);
  });

  it('an AWS error falls to the next engine with one log line and no idle stop owed', async () => {
    const ecs = fakeEcs();
    ecs.fail = 'ECS DescribeServices: AccessDeniedException — not authorized';
    const { pipe, logs, armed } = mk({ ecs });
    expect(await pipe.transcribe(note())).toBe('CLI');
    expect(logs.filter((m) => m.includes('gpu "gpu"'))).toEqual(['gpu "gpu" (edw/edw-whisper): ECS DescribeServices: AccessDeniedException — not authorized — next engine; no waiting for 10 min']);
    expect(armed()).toEqual([]);
  });

  // After a failed wake, cooldown_ms (default 10 min) of quick checks: no wait, no UpdateService.
  async function failedWake() {
    const ecs = fakeEcs({ readyAfterPolls: 1 });
    ecs.never = true;
    const m = mk({ ecs });
    expect(await m.pipe.transcribe(note())).toBe('CLI');       // the wake timed out
    ecs.calls.length = 0;
    return { ecs, ...m };
  }

  it('cooldown: a note falls to the next engine at once — one quick check, no polling, no UpdateService', async () => {
    const { ecs, pipe, logs, calls } = await failedWake();
    const ups = [];
    expect(await pipe.transcribe(note(), {}, () => {}, {}, async () => { ups.push(1); return async () => {}; })).toBe('CLI');
    expect(ecs.calls).toEqual(['ListTasks']);
    expect(calls.cli).toBe(2);
    expect(ups).toEqual([1]);                                  // the 🎧 is the cli's, raised once
    expect(logs.filter((m) => /next engine/.test(m))).toHaveLength(1);   // only the failed wake logged
  });

  it('cooldown: a worker that came up meanwhile is used by the quick check', async () => {
    const { ecs, pipe, logs } = await failedWake();
    ecs.never = false;
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    expect(ecs.calls).toEqual(['ListTasks']);
    expect(logs.join('\n')).toMatch(/found during cooldown/);
    ecs.calls.length = 0;
    expect(await pipe.transcribe(note())).toBe('hola gpu');   // warm from then on
    expect(ecs.calls).toEqual([]);
  });

  it('cooldown: once it has passed, a cold note wakes normally', async () => {
    const ecs = fakeEcs();
    ecs.fail = 'ECS DescribeServices: ThrottlingException';
    const { pipe, advance } = mk({ ecs });
    expect(await pipe.transcribe(note())).toBe('CLI');
    ecs.fail = null;
    advance(599_999);
    expect(await pipe.transcribe(note())).toBe('CLI');
    expect(ecs.calls).toEqual(['DescribeServices', 'ListTasks']);
    advance(1);
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    expect(ecs.calls.slice(2)).toEqual(['DescribeServices', 'UpdateService 1', 'ListTasks', 'ListTasks']);
  });

  // REGRESSION LOCK: the other engine types never build a waker and behave as before.
  it('profiles without the ecs type never create a waker; the ecs type with no waker is skipped', async () => {
    const { pipe, calls } = mk({ profile: {
      fallback_order: ['remote', 'local', 'cli'],
      remote: { type: 'whisper-server-remote', endpoint: 'http://x', token: 'k' },
      local: { type: 'whisper-server-local', command: 'ws', model: 'm' },
      cli: { type: 'whisper-cli' },
    } });
    expect(await pipe.transcribe(note())).toBe('REMOTE');
    await pipe.boot();
    expect(calls.wakers).toBe(0);

    const logs = [];
    const bare = buildTranscriptionPipeline({ profile: gpuCli(port), cli: async () => 'CLI', residentServing: () => null, onLog: (m) => logs.push(m) });
    expect(await bare.transcribe(note())).toBe('CLI');
    expect(logs.join('\n')).toMatch(/whisper-server-ecs but this node has no ECS waker/);
  });
});

describe('whisper-server-ecs — the AWS client and its credentials', () => {
  const KEY_ID = 'AKIAEDWWAKERTESTKEY1';
  const SECRET = 'sEcReT/edw+waker/never-in-a-log-0123456789';
  const writeKey = (home, text = `${KEY_ID}\n${SECRET}\n`) => { mkdirSync(join(home, 'secrets'), { recursive: true }); writeFileSync(join(home, 'secrets', 'aws-whisper-waker'), text); };

  // An ECS JSON endpoint: answers by X-Amz-Target; `error` makes every call fail.
  function fakeAws({ error = null } = {}) {
    const f = { requests: [], desired: 0 };
    f.fetch = async (url, init) => {
      const action = init.headers['x-amz-target'].split('.').pop();
      f.requests.push({ url, action, headers: init.headers, body: init.body });
      const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/x-amz-json-1.1' } });
      if (error) return json(400, error);
      const b = JSON.parse(init.body);
      if (action === 'DescribeServices') return json(200, { services: [{ desiredCount: f.desired, runningCount: f.desired }], failures: [] });
      if (action === 'UpdateService') { f.desired = b.desiredCount; return json(200, { service: {} }); }
      if (action === 'ListTasks') return json(200, { taskArns: f.desired ? ['arn:aws:ecs:us-east-1:1:task/edw/abc'] : [] });
      if (action === 'DescribeTasks') return json(200, { tasks: [{ lastStatus: 'RUNNING', attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'subnetId', value: 'subnet-1' }, { name: 'privateIPv4Address', value: '127.0.0.1' }] }] }] });
      return json(400, { __type: 'UnknownOperationException' });
    };
    return f;
  }

  it('signs as AWS SigV4 (the published get-vanilla and IAM ListUsers vectors)', () => {
    const c = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z'), region: 'us-east-1' };
    expect(signV4({ ...c, method: 'GET', url: 'https://example.amazonaws.com/', service: 'service' }).authorization)
      .toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(signV4({ ...c, method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', service: 'iam', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } }).authorization)
      .toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('the client: the four calls, the task IP from its ENI, an error as its AWS type', async () => {
    const f = fakeAws();
    const api = createEcsClient({ region: 'us-east-1', cluster: 'edw', service: 'edw-whisper', credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }), fetch: f.fetch });
    expect(await api.describeService()).toEqual({ desiredCount: 0, runningCount: 0, pendingCount: 0 });
    expect(await api.runningTaskIp()).toBe(null);
    await api.setDesired(1);
    expect(await api.runningTaskIp()).toBe('127.0.0.1');
    expect(f.requests.map((r) => r.action)).toEqual(['DescribeServices', 'ListTasks', 'UpdateService', 'ListTasks', 'DescribeTasks']);
    expect(f.requests[0].url).toBe('https://ecs.us-east-1.amazonaws.com/');
    expect(JSON.parse(f.requests[2].body)).toEqual({ cluster: 'edw', service: 'edw-whisper', desiredCount: 1 });
    expect(JSON.parse(f.requests[1].body)).toEqual({ cluster: 'edw', serviceName: 'edw-whisper', desiredStatus: 'RUNNING' });

    const bad = createEcsClient({ region: 'us-east-1', cluster: 'edw', service: 'edw-whisper', credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }),
      fetch: fakeAws({ error: { __type: 'com.amazonaws.ecs#ServiceNotFoundException', message: 'Service not found.' } }).fetch });
    await expect(bad.setDesired(1)).rejects.toThrow('ECS UpdateService: ServiceNotFoundException — Service not found.');
  });

  it('secrets/<name> is two lines; a missing or one-line file is a clear error naming the file, not its content', () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-ecs-key-'));
    try {
      expect(() => readAwsKeyPair(home, 'aws-whisper-waker')).toThrow(/aws-whisper-waker is missing/);
      writeKey(home, `${KEY_ID}\n`);
      expect(() => readAwsKeyPair(home, 'aws-whisper-waker')).toThrow(/needs two lines/);
      writeKey(home, `${KEY_ID}\r\n${SECRET}\r\n`);
      expect(readAwsKeyPair(home, 'aws-whisper-waker')).toEqual({ accessKeyId: KEY_ID, secretAccessKey: SECRET });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('createTranscription reads the key from secrets/<credentials>; an AWS error is one line, key id redacted, secret nowhere', async () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-ecs-home-'));
    writeKey(home);
    const f = fakeAws({ error: { __type: 'com.amazon.coral.service#UnrecognizedClientException', message: `The security token included in the request is invalid: ${KEY_ID}` } });
    vi.stubGlobal('fetch', f.fetch);
    try {
      const logs = [];
      const tx = createTranscription({
        home, onLog: (m) => logs.push(m),
        getConfig: () => ({ transcription_service: { use_config: 'edw', edw: { fallback_order: ['gpu'], gpu: gpuEngine(port) } } }),
      });
      const p = join(home, 'n.ogg'); writeFileSync(p, 'a note');
      expect(await tx.transcribe(p)).toBe(null);
      const said = logs.join('\n');
      expect(logs.filter((m) => m.includes('UnrecognizedClientException'))).toHaveLength(1);
      expect(said).toContain('<key>');
      expect(said).not.toContain(KEY_ID);
      expect(said).not.toContain(SECRET);
      expect(f.requests[0].headers.authorization).toContain(`Credential=${KEY_ID}/`);   // the file's key signed it
      expect(JSON.stringify(f.requests)).not.toContain(SECRET);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a full cold wake through the real client: no log line carries the key id or the secret', async () => {
    const f = fakeAws();
    const api = createEcsClient({ region: 'us-east-1', cluster: 'edw', service: 'edw-whisper', credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }), fetch: f.fetch });
    const { pipe, logs, fire } = mk({ api });
    expect(await pipe.transcribe(note())).toBe('hola gpu');
    await fire();
    expect(f.desired).toBe(0);
    expect(logs.length).toBeGreaterThan(2);
    for (const m of logs) { expect(m).not.toContain(KEY_ID); expect(m).not.toContain(SECRET); }
    expect(JSON.stringify(f.requests)).not.toContain(SECRET);
  });

  it('a missing key file falls to the next engine with one line naming the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-ecs-nokey-'));
    try {
      const api = createEcsClient({ region: 'us-east-1', cluster: 'edw', service: 'edw-whisper', credentials: () => readAwsKeyPair(home, 'aws-whisper-waker'), fetch: async () => { throw new Error('no call expected'); } });
      const { pipe, logs } = mk({ api });
      expect(await pipe.transcribe(note())).toBe('CLI');
      expect(logs.filter((m) => /AWS key .*aws-whisper-waker is missing — next engine/.test(m))).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
