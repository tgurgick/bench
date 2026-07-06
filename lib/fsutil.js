// bench/lib/fsutil.js — tiny filesystem helpers + the path-traversal guard.
//
// Vendored from throughline's lib/workspace.js so the bench stands alone.
// `safePath` is the one security-critical piece: every read/write of a
// caller-supplied relative path goes through it so nothing can escape the
// bench root via `../`.

'use strict';

const fs = require('fs');
const path = require('path');

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// Resolve `rel` under `baseDir`, refusing anything that escapes the base.
// Returns the absolute path, or null if `rel` would resolve outside baseDir
// (e.g. `../../etc/passwd`). The base itself resolves to the base.
function safePath(baseDir, rel) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

module.exports = { safeRead, isDir, safePath };
