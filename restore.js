'use strict';
// CLI:   npm run restore -- data/backups/<timestamp>        (STOP the server first!)
// Admin: "Restore" in Admin > Backups only STAGES the restore (data/restore-pending.json); it is applied on the next start,
//        before the database is opened, so a live database file is never overwritten underneath running requests.
// In both cases the current database is first saved next to it as store.db.before-restore-<time>.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function verify(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(path.join(dir, 'store.db'))) throw new Error('Not a valid backup directory (manifest.json / store.db missing)');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'store.db'))).digest('hex');
  if (sha !== man.db_sha256) throw new Error('Backup is corrupted (checksum mismatch). Aborting.');
  return man;
}
function applyRestore(config, dir) {
  verify(dir);
  const stamp = Date.now();
  if (fs.existsSync(config.dbPath)) fs.copyFileSync(config.dbPath, `${config.dbPath}.before-restore-${stamp}`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.copyFileSync(path.join(dir, 'store.db'), config.dbPath);
  if (fs.existsSync(path.join(dir, 'uploads'))) fs.cpSync(path.join(dir, 'uploads'), config.uploadDir, { recursive: true });
}
const pendingFile = (config) => path.join(path.dirname(config.dbPath), 'restore-pending.json');
function stageRestore(config, name, by) {
  const dir = path.join(config.backupDir, name); verify(dir);
  fs.writeFileSync(pendingFile(config), JSON.stringify({ name, requested_by: by, at: new Date().toISOString() }), { mode: 0o600 });
}
/** Called once at startup BEFORE the database is opened. Returns the applied backup name or null. */
function applyPendingRestore(config, log = () => {}) {
  const f = pendingFile(config); if (!fs.existsSync(f)) return null;
  try { const p = JSON.parse(fs.readFileSync(f, 'utf8')); const dir = path.join(config.backupDir, p.name); if (path.dirname(dir) !== config.backupDir) throw new Error('bad path'); applyRestore(config, dir); log('restore_applied', { name: p.name, by: p.requested_by }); return p.name; }
  catch (e) { log('restore_failed', { err: e.message }); return null; } finally { fs.rmSync(f, { force: true }); }
}
module.exports = { verify, applyRestore, stageRestore, applyPendingRestore, pendingFile };

if (require.main === module) {
  const config = require('../server/config');
  const dir = process.argv[2] && path.resolve(process.argv[2]);
  try { applyRestore(config, dir); console.log('Restore complete. Start the server again (it will run pending migrations automatically).'); } catch (e) { console.error(e.message); process.exit(1); }
}
