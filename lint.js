'use strict';
// "Build" for this zero-dependency project = static verification (there is nothing to bundle).
// Fails on: syntax errors, inline handlers/eval in front-end, hard-coded secrets, SQL built with user data, missing required files.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'data' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(root);
const problems = [];
const rel = (f) => path.relative(root, f);

for (const f of files.filter((x) => x.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { problems.push(`syntax: ${rel(f)}\n${e.stderr}`); }
}
for (const f of files.filter((x) => /public[\\/].*\.(js|html)$/.test(x))) {
  const s = fs.readFileSync(f, 'utf8');
  if (/\son(click|change|submit|load|error|input|keydown)\s*=/.test(s)) problems.push(`inline event handler (breaks CSP): ${rel(f)}`);
  if (/\beval\s*\(|new Function\(|document\.write\(/.test(s)) problems.push(`eval/document.write: ${rel(f)}`);
  if (f.endsWith('.html') && /<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(s) && !/ld\+json/.test(s)) problems.push(`inline <script>: ${rel(f)}`);
}
for (const f of files.filter((x) => /(server|scripts)[\\/].*\.js$/.test(x))) {
  const s = fs.readFileSync(f, 'utf8');
  if (/(password|secret|token)\w*\s*[:=]\s*['"][A-Za-z0-9+/=_-]{12,}['"]/i.test(s.replace(/\/\/.*$/gm, ''))) problems.push(`possible hard-coded secret: ${rel(f)}`);
  // user input must never be concatenated into SQL: only whitelisted fragments (W, sql, order, fmt, NS, TZ, table, col, ...) may be interpolated
  for (const m of s.matchAll(/prepare\(`([^`]*)`/g)) for (const x of m[1].matchAll(/\$\{([^}]*)\}/g)) {
    if (!/^(W|NS|TZ|sql|order|orderBy|fmt|base|avail|sold|table|col|m\.table|path|sets|cols|w\.join\(' AND '\)|st \? 'WHERE r\.status=\?' : ''|vf\.join\(' AND '\)|vals\.map\(\(\) => '\?'\)\.join\(','\)|cols\.map\(\(\) => '\?'\)\.join\(','\)|table === .*|table\[t\.kind\]|ctx\.query\.pending.*|sl\.map\(\(\) => '\?'\)\.join\(','\)|ids\.map\(\(\) => '\?'\)\.join\(','\))$/.test(x[1].trim()) && !/^\w+$/.test(x[1].trim())) problems.push(`suspicious SQL interpolation in ${rel(f)}: \${${x[1].trim().slice(0, 60)}}`);
  }
}
for (const f of files.filter((x) => /(server|public)[\\/]/.test(rel(x)) && /\.(js|html)$/.test(x))) {
  if (['server/index.js', 'server/routes/admin.js', 'server/routes/content.js'].includes(rel(f))) continue; // these only DETECT leftover demo products
  if (/\[DEMO\]|lorem ipsum/i.test(fs.readFileSync(f, 'utf8'))) problems.push(`demo/placeholder content in production path: ${rel(f)}`);
}
for (const need of ['.env.example', '.gitignore', 'Dockerfile', 'README.md', 'scripts/backup.js', 'server/index.js']) if (!fs.existsSync(path.join(root, need))) problems.push('missing ' + need);
if (!/^\.env$/m.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'))) problems.push('.env is not in .gitignore');
if (fs.existsSync(path.join(root, '.env')) && process.env.CI) problems.push('.env must not be present in CI/build');

if (problems.length) { console.error('LINT FAILED\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`lint OK (${files.filter((x) => x.endsWith('.js')).length} JS files checked)`);
