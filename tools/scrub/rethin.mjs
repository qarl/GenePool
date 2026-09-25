'use strict';
// Re-thin existing run DBs to a smaller keyframe budget, IN PLACE, using the ENGINE'S EXACT grid logic
// (tools/events/run-db.mjs thinIfNeeded): keep an even grid of keyframes (multiples of keyframeInterval*stride),
// ALWAYS keep tick-0 (the founding frame) and the newest, delete the rest. Then VACUUM to actually shrink the file.
// Deleting keyframes is lossless for playback: any tick is still reachable by restore-nearest-keyframe + resim.
//
//   node tools/scrub/rethin.mjs [budget=250] [db-or-dir]
//   (default dir = the app's timelines folder)
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { isWriterLive } from '../events/run-db.mjs';

const budget = Number(process.argv[2] || 250);
const appData = process.env.GENEPOOL_USERDATA || (platform() === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'GenePool')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'GenePool'));
const target = process.argv[3] || join(appData, 'timelines');

const dbs = existsSync(target) && statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => /\.(db|timeline)$/i.test(f)).map((f) => join(target, f)).sort()
  : [target];

const mb = (p) => { try { return statSync(p).size / 2 ** 20; } catch { return 0; } };

function rethin(dbPath) {
  if (isWriterLive(dbPath)) { console.log(`SKIP (live writer): ${dbPath}`); return; }
  const before = mb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  try {
    const g = (k) => { const r = db.prepare('SELECT v FROM run_meta WHERE k = ?').get(k); return r ? r.v : null; };
    const BASE = parseInt(g('keyframeInterval') || '2000', 10) || 2000;
    const maxT = db.prepare('SELECT MAX(tick) m FROM snapshots').get().m;
    const n0 = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
    if (maxT == null) { console.log(`(empty) ${dbPath}`); db.close(); return; }
    // smallest power-of-2 stride whose uniform grid over [0,maxT] fits the budget (same formula as the engine).
    let stride = 1;
    while (Math.floor(maxT / (BASE * stride)) + 2 > budget) stride *= 2;
    db.exec('BEGIN');
    try {
      // keep grid ((tick/BASE)%stride==0 -> includes tick 0) + the newest. Same DELETE as thinIfNeeded.
      db.prepare('DELETE FROM snapshots WHERE (tick / ?) % ? != 0 AND tick != ?').run(BASE, stride, maxT);
      const set = db.prepare('INSERT OR REPLACE INTO run_meta (k,v) VALUES (?,?)');
      set.run('keyframeStride', String(stride)); set.run('keyframeBudget', String(budget));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const n1 = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
    const hasZero = !!db.prepare('SELECT 1 FROM snapshots WHERE tick = 0').get();
    db.exec('VACUUM;');                       // reclaim the freed pages -> the file actually shrinks
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');   // single file at rest
    db.close();
    const after = mb(dbPath);
    console.log(`${dbPath.split('/').pop().padEnd(18)} ${n0}->${n1} kf (stride ${stride}, tick0 ${hasZero ? 'kept' : 'MISSING!'})  ${before.toFixed(0)}MB -> ${after.toFixed(0)}MB`);
  } catch (e) { try { db.close(); } catch {} console.log(`ERROR ${dbPath}: ${e.message}`); }
}

console.log(`re-thinning ${dbs.length} DB(s) to budget ${budget}...`);
for (const d of dbs) rethin(d);
console.log('done.');
