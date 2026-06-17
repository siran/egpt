// src/media-path.mjs — surface saved-media paths to a being RELATIVE to its
// conversation folder.
//
// A being's sandbox roots at its conversation dir and Reads `media/<file>` from
// there (GENOME §2.5); the absolute host path (C:\Users\…\.egpt\conversations\…)
// must NEVER reach the model or the transcript. Every saved attachment AND every
// Route-A video frame lives directly under the chat's `media/`, so the last path
// segment is the filename.
//
// Pure JS — NO node builtins — so the browser-bundled limbs (telegram.mjs) can
// import it just like the Node bridges. Separator-agnostic: a Windows backslash
// path and a POSIX path both collapse to `media/<name>`; an already-relative
// `media/<name>` is returned unchanged (idempotent).

export function relMediaPath(p) {
  return 'media/' + String(p ?? '').split(/[\\/]/).pop();
}
