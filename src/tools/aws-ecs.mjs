// aws-ecs.mjs — the four ECS calls the whisper-server-ecs engine needs, SigV4-signed over fetch.
// No SDK, no aws CLI: the key pair stays in this process and never reaches a child env or a log.
import { createHash, createHmac } from 'node:crypto';
import { readSecret } from '../secrets.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// AWS Signature Version 4. Returns the headers to send: the given ones plus x-amz-date and authorization.
export function signV4({ method = 'POST', url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { host: u.host, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  const canonical = [
    method, u.pathname || '/', query,
    names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), sha256Hex(body),
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

// secrets/<name>: line 1 access key id, line 2 secret. Throws a message that names the file, never its content.
export function readAwsKeyPair(home, name) {
  const s = readSecret(home, name);
  if (!s.token) throw new Error(`AWS key ${s.path} is ${s.problem}`);
  const [accessKeyId, secretAccessKey] = s.token.split(/\r?\n/).map((l) => l.trim());
  if (!accessKeyId || !secretAccessKey) throw new Error(`AWS key ${s.path} needs two lines: key id, then secret`);
  return { accessKeyId, secretAccessKey };
}

// { describeService, setDesired, runningTaskIp } for one cluster/service. `credentials` is read per call,
// so a key installed or rotated later is picked up with no restart. Errors carry the AWS error type and a
// short message with the key id redacted.
export function createEcsClient({
  region, cluster, service, credentials,
  fetch: fetchFn = globalThis.fetch, now = () => new Date(), timeoutMs = 15_000,
}) {
  const url = `https://ecs.${region}.amazonaws.com/`;

  async function call(action, payload) {
    const { accessKeyId, secretAccessKey } = credentials();
    const body = JSON.stringify(payload);
    const headers = signV4({
      url, body, region, service: 'ecs', accessKeyId, secretAccessKey, date: now(),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonEC2ContainerServiceV20141113.${action}` },
    });
    let res;
    try { res = await fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(`ECS ${action}: ${e?.name === 'TimeoutError' ? `no answer in ${timeoutMs}ms` : (e?.cause?.code ?? e?.message ?? e)}`); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const type = String(j.__type ?? '').split('#').pop() || `HTTP ${res.status}`;
      const msg = String(j.message ?? j.Message ?? '').split(accessKeyId).join('<key>').slice(0, 160);
      throw new Error(`ECS ${action}: ${type}${msg ? ` — ${msg}` : ''}`);
    }
    return j;
  }

  return {
    async describeService() {
      const j = await call('DescribeServices', { cluster, services: [service] });
      const s = j.services?.[0];
      if (!s) throw new Error(`ECS DescribeServices: ${cluster}/${service} not found (${j.failures?.[0]?.reason ?? 'no service'})`);
      return { desiredCount: s.desiredCount ?? 0, runningCount: s.runningCount ?? 0, pendingCount: s.pendingCount ?? 0 };
    },
    async setDesired(desiredCount) {
      await call('UpdateService', { cluster, service, desiredCount });
    },
    // The private IPv4 of a RUNNING task of the service (awsvpc ENI), or null.
    async runningTaskIp() {
      const l = await call('ListTasks', { cluster, serviceName: service, desiredStatus: 'RUNNING' });
      if (!l.taskArns?.length) return null;
      const d = await call('DescribeTasks', { cluster, tasks: l.taskArns });
      for (const t of d.tasks ?? []) {
        if (t.lastStatus !== 'RUNNING') continue;
        for (const a of t.attachments ?? []) {
          const ip = (a.details ?? []).find((x) => x.name === 'privateIPv4Address')?.value;
          if (ip) return ip;
        }
      }
      return null;
    },
  };
}
