// Minimal assert shim.
function assert(value, message) {
  if (!value) throw new Error(message || 'Assertion failed');
}
assert.equal = (a, b, msg) => { if (a != b) throw new Error(msg || `${a} != ${b}`); };
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); };
assert.ok = assert;
export default assert;
