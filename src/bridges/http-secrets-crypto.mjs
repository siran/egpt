// http-secrets-crypto.mjs — the secrets page's lock, run IN THE BROWSER (the password never leaves it).
// The server serves this very file to the page (http-secrets.mjs) and stores only what encrypt returns:
//   enc:v1:<b64 salt>:<b64 iv>:<b64 ciphertext>
// PBKDF2-SHA256 (600000 iterations, random 16-byte salt) → AES-256-GCM (random 12-byte iv).
const PREFIX = 'enc:v1:', ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;
const b64 = (bytes) => {   // in chunks: spreading 64 KB of arguments overflows JavaScriptCore's limit
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyOf(password, salt) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const isEncrypted = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

export async function encryptValue(password, value) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, await keyOf(password, salt), new TextEncoder().encode(value));
  return `${PREFIX}${b64(salt)}:${b64(iv)}:${b64(new Uint8Array(data))}`;
}

// The plain value, or throws: a wrong password fails GCM's check (error.name 'OperationError').
export async function decryptValue(password, stored) {
  const [salt, iv, data] = stored.slice(PREFIX.length).split(':').map(unb64);
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, await keyOf(password, salt), data);
  return new TextDecoder().decode(plain);
}
