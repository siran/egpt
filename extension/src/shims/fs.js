// Stub: fs not available in browser. GramJS marks "fs": false in browser field;
// this catches any remaining imports from transitive deps like node-localstorage.
export default {};
export const readFileSync = () => { throw new Error('fs not available in browser'); };
export const writeFileSync = () => { throw new Error('fs not available in browser'); };
export const existsSync = () => false;
export const mkdirSync = () => {};
