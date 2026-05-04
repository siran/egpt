// Browser stub for util — GramJS only uses util.inspect.
export function inspect(v, opts) {
  try { return JSON.stringify(v, null, opts?.depth != null ? 2 : undefined); }
  catch { return String(v); }
}
export const promisify = fn => (...args) =>
  new Promise((res, rej) => fn(...args, (e, v) => e ? rej(e) : res(v)));
export default { inspect, promisify };
