// Shim: replace node-localstorage with browser's native localStorage.
// GramJS's StoreSession uses this; we use StringSession instead, but the
// import is still pulled in via sessions/index.js re-exports.
export const LocalStorage = window.localStorage.constructor;
export default { LocalStorage };
