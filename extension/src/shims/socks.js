// Stub: SOCKS5 proxy support not needed in browser context.
export default {};
export const SocksClient = class {
  static createConnection() { throw new Error('SOCKS not available in browser'); }
};
