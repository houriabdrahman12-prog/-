'use strict';
// Reads the shipped UI dictionary (public/js/i18n.js) so the server knows every valid translation key.
// The file is our own static source; it is executed in an empty sandbox with a timeout (never user input).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let cache = null;
function defaults(root) {
  if (cache) return cache;
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/i18n.js'), 'utf8'), ctx, { timeout: 1000 });
  return (cache = ctx.window.I18N);
}
function overrides(db) {
  const out = {}; for (const r of db.prepare('SELECT key,lang,value FROM translations').all()) (out[r.key] ||= {})[r.lang] = r.value;
  return out;
}
module.exports = { defaults, overrides };
