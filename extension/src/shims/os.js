// Browser stub for os module — GramJS only uses type() and release() for device strings.
export const type = () => 'Browser';
export const release = () => '1.0';
export const hostname = () => 'localhost';
export const platform = () => 'browser';
export default { type, release, hostname, platform };
