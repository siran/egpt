// Minimal path shim for browser. GramJS uses path.join and path.resolve.
export const sep = '/';
export const join = (...parts) => parts.join('/').replace(/\/+/g, '/');
export const resolve = (...parts) => join(...parts);
export const basename = (p, ext) => {
  const b = p.split('/').pop() ?? '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '.';
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export default { sep, join, resolve, basename, dirname, extname };
