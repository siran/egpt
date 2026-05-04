// Browser stub: GramJS uses PromisedWebSockets (not TCP) when isBrowser is true.
export default {};
export const createConnection = () => { throw new Error('net not available in browser'); };
export const Socket = class {};
