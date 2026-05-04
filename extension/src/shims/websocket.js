// Shim: redirect GramJS's `websocket` package to the browser's native WebSocket.
// GramJS uses `new w3cwebsocket(url, "binary")` — the native WebSocket API is w3c-compatible.
export const w3cwebsocket = WebSocket;
export default { w3cwebsocket: WebSocket };
