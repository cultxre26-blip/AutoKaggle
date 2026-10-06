// Consistent online backup of the SQLite database (safe while the app is running).
// Usage: node scripts/backup.js [backupDir] [keep]   (defaults: ./backups, keep 14)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const source = process.env.DATABASE_PATH || './data/pingwatch.db';
const dir = process.argv[2] || './backups';
const keep = Number(process.argv[3] || 14);

if (!existsSync(source)) {
  console.error(`database not found: ${source}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const target = join(dir, `pingwatch-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const check = new DatabaseSync(target, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
check.close();
if (!ok) {
  rmSync(target);
  console.error('backup failed integrity check');
  process.exit(1);
}
const old = readdirSync(dir).filter((f) => /^pingwatch-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(join(dir, f));
console.log(`backup written: ${target} (pruned ${old.length})`);
