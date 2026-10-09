'use strict';
// npm run backup  -> data/backups/<timestamp>/{store.db, uploads/, manifest.json}
// Uses SQLite's online backup API (consistent snapshot even while the server is running).
// Old backups are NEVER deleted unless BACKUP_KEEP=<N> is set. If BACKUP_MIRROR_DIR is set the backup is also copied there
// (use a different disk / mounted storage). Admin can also download any backup as one .tar.gz to keep it off-server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const NAME_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

async function runBackup(config) {
  if (config.dbPath === ':memory:') throw new Error('Cannot back up an in-memory database');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(config.backupDir, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const src = new DatabaseSync(config.dbPath);
  try { await backup(src, path.join(dir, 'store.db')); } finally { src.close(); }
  let files = 0;
  if (fs.existsSync(config.uploadDir)) { fs.cpSync(config.uploadDir, path.join(dir, 'uploads'), { recursive: true }); files = fs.readdirSync(path.join(dir, 'uploads')).length; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'store.db'))).digest('hex');
  const check = new DatabaseSync(path.join(dir, 'store.db'));
  const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check; check.close();
  if (integrity !== 'ok') throw new Error('Backup failed integrity check: ' + integrity);
  const manifest = { name: stamp, created_at: new Date().toISOString(), db_sha256: sha, upload_files: files, integrity };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  let mirrored = false;
  if (config.backupMirrorDir) { fs.mkdirSync(config.backupMirrorDir, { recursive: true, mode: 0o700 }); fs.cpSync(dir, path.join(config.backupMirrorDir, stamp), { recursive: true }); mirrored = true; }
  const removed = [];
  if (config.backupKeep > 0) { // retention is opt-in
    const all = listBackups(config).map((b) => b.name).sort();
    for (const old of all.slice(0, Math.max(0, all.length - config.backupKeep))) { fs.rmSync(path.join(config.backupDir, old), { recursive: true, force: true }); removed.push(old); }
  }
  return { dir, name: stamp, files, sha, removed, mirrored };
}
function listBackups(config) {
  try {
    return fs.readdirSync(config.backupDir).filter((d) => NAME_RE.test(d) && fs.existsSync(path.join(config.backupDir, d, 'manifest.json'))).sort().reverse().map((d) => {
      const m = JSON.parse(fs.readFileSync(path.join(config.backupDir, d, 'manifest.json'), 'utf8'));
      return { name: d, created_at: m.created_at, upload_files: m.upload_files, db_bytes: fs.statSync(path.join(config.backupDir, d, 'store.db')).size, integrity: m.integrity };
    });
  } catch { return []; }
}
module.exports = { runBackup, listBackups, NAME_RE };

if (require.main === module) {
  runBackup(require('../server/config')).then((r) => console.log(`Backup OK: ${r.dir} (${r.files} images)${r.mirrored ? '; mirrored' : ''}${r.removed.length ? `; removed ${r.removed.length} old` : ''}`))
    .catch((e) => { console.error('Backup failed:', e.message); process.exit(1); });
}
