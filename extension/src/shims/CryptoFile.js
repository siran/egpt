// Shim: replace GramJS's Node crypto wrapper with its own browser-compatible
// crypto/crypto.js, which uses Web Crypto API (SubtleCrypto + getRandomValues).
// Only randomBytes, createHash, pbkdf2Sync are used from CryptoFile in GramJS.
import { randomBytes, createHash, pbkdf2Sync } from 'telegram/crypto/crypto.js';
export { randomBytes, createHash, pbkdf2Sync };
export default { randomBytes, createHash, pbkdf2Sync };
