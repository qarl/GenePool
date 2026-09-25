'use strict';
// gen-ctl -- cross-platform (Windows/Linux/macOS) command-line control for background run generators. Shares the app's
// machinery so the CLI and the Jobs window never step on each other: the one-writer authority is the atomic db-heartbeat
// claim in run_meta (run-db.mjs) -- NO `ps`/`wmic` (Karl: "'ps' is a no-go"). See docs/PLAN-generator-cli.md (v4.2).
//
//   node tools/scrub/gen-ctl.mjs start <seed|path|dir>   # flat-out, unbounded; a dir starts ALL its timelines in PARALLEL
//   node tools/scrub/gen-ctl.mjs stop  <seed|path|all>
//   node tools/scrub/gen-ctl.mjs list  [--json]          # read-only; reports frontier + days for automation
//   node tools/scrub/gen-ctl.mjs restart <seed|path>
//
// The generator itself NEVER caps/throttles (flat-out is a hard rule). To "run until a level then stop", script it:
//   gen-ctl list --json  ->  your logic  ->  gen-ctl stop <name>.   (Windows: use tools/scrub/gen-ctl.cmd.)

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { openRunReader, isWriterLive, collapseToSingleFile, clearWriterClaim, readWriterInfo, WRITER_STALE_MS } from '../events/run-db.mjs';
import { createBgJobs, jobsDir } from './gen-jobs.mjs';

const TICKS_PER_DAY = 5184000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timelinesDir = () => { const d = join(jobsDir(), 'timelines'); mkdirSync(d, { recursive: true }); return d; };
// Best-effort custom-timeline dir. NOTE: on Windows "Documents" is a Known Folder that may be redirected (OneDrive); this
// homedir()/Documents guess can miss those -- custom-timeline discovery is then app-only. Seed runs (timelinesDir) are exact.
const docsGpDir = () => join(process.env.HOME || process.env.USERPROFILE || '', 'Documents', 'GenePool');
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isRunFile = (f) => /\.(db|timeline)$/i.test(f);
const seedOf = (p) => { const m = basename(p).match(/seed-(\d+)\.(db|timeline)$/i); return m ? parseInt(m[1], 10) : 0; };
const nameOf = (p) => basename(p).replace(/\.(db|timeline)$/i, '');
const kindOf = (p) => (/\.timeline$/i.test(p) ? 'timeline' : 'seed');

// Resolve a target arg -> a list of absolute db paths. Integer N -> <timelines>/seed-N.db; a dir -> every run file in it;
// otherwise a literal path (created fresh by the generator if absent).
function resolveTargets(arg) {
  if (/^\d+$/.test(arg)) return [join(timelinesDir(), `seed-${arg}.db`)];
  const p = isAbsolute(arg) ? arg : resolve(arg);
  if (isDir(p)) return readdirSync(p).filter(isRunFile).map((f) => join(p, f)).sort();
  return [p];
}

function frontierOf(dbPath) {
  try { const r = openRunReader(dbPath); const f = r.frontier(); r.close(); return f; } catch { return null; }
}

// Discover every known run: the seed timelines dir + the custom-timeline dir (best-effort). Read-only.
function discover() {
  const seen = new Set(); const out = [];
  for (const dir of [timelinesDir(), docsGpDir()]) {
    let files = []; try { files = readdirSync(dir).filter(isRunFile).map((f) => join(dir, f)); } catch { /* dir absent */ }
    for (const p of files) { if (seen.has(p)) continue; seen.add(p); out.push(p); }
  }
  return out.sort();
}

function rowFor(dbPath) {
  const running = isWriterLive(dbPath);
  const frontier = frontierOf(dbPath);
  const days = frontier == null ? null : frontier / TICKS_PER_DAY;
  return { name: nameOf(dbPath), path: dbPath, running, frontier, days };
}

async function cmdStart(arg) {
  if (!arg) return usage('start needs a <seed|path|dir>');
  const targets = resolveTargets(arg);
  if (!targets.length) { console.log('no timelines to start.'); return 0; }
  const jobs = createBgJobs(); jobs.loadJobs();
  // PARALLEL (Karl): fire every generator at once -- each is a detached flat-out process, so they run on all cores.
  const results = await Promise.all(targets.map(async (db) => {
    if (isWriterLive(db)) { const info = readWriterInfo(db); return { db, status: `already running (pid ${info.pid || '?'})` }; }
    await jobs.bgStart(db, { seed: seedOf(db), kind: kindOf(db), name: nameOf(db) });   // detached bgSpawn + registry
    return { db, status: 'started' };
  }));
  for (const r of results) console.log(`${r.status === 'started' ? '▶' : '•'} ${nameOf(r.db)} — ${r.status}`);
  return 0;
}

async function stopOne(db) {
  if (!existsSync(db)) return { db, status: 'no such run' };
  if (!isWriterLive(db)) { collapseToSingleFile(db); return { db, status: 'not running' }; }
  // Advancement check (v4.2): sample the heartbeat twice; kill ONLY if it's genuinely advancing. A frozen-fresh heartbeat
  // = a writer that crashed within WRITER_STALE_MS (pid maybe reused) -> do NOT kill (avoids a pid-reuse mis-kill).
  const a = readWriterInfo(db);
  await sleep(1200);
  const b = readWriterInfo(db);
  if (b.heartbeat > a.heartbeat && a.pid) {
    try { process.kill(a.pid); } catch { /* gone */ }
    for (let i = 0; i < 80 && isWriterLive(db); i++) { if (i === 20) { try { process.kill(a.pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  }
  clearWriterClaim(db);            // release ownership so a restart isn't refused for WRITER_STALE_MS
  collapseToSingleFile(db);        // fold the WAL -> single file at rest
  return { db, status: 'stopped' };
}

async function cmdStop(arg) {
  if (!arg) return usage('stop needs a <seed|path|all>');
  const targets = arg === 'all' ? discover() : resolveTargets(arg);
  if (!targets.length) { console.log('nothing to stop.'); return 0; }
  const results = await Promise.all(targets.map(stopOne));   // parallel: the 1.2s advancement sample overlaps
  for (const r of results) console.log(`■ ${nameOf(r.db)} — ${r.status}`);
  return 0;
}

function cmdList(json) {
  const rows = discover().map(rowFor);
  if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { console.log('(no timelines)'); return 0; }
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  console.log(`${'NAME'.padEnd(w)}  RUN  ${'DAYS'.padStart(8)}  FRONTIER`);
  for (const r of rows) {
    const days = r.days == null ? '   ?' : r.days.toFixed(2);
    const fr = r.frontier == null ? '?' : r.frontier.toLocaleString();
    console.log(`${r.name.padEnd(w)}  ${r.running ? ' ● ' : ' · '}  ${days.padStart(8)}  ${fr}`);
  }
  return 0;
}

async function cmdRestart(arg) {
  if (!arg) return usage('restart needs a <seed|path>');
  await cmdStop(arg);
  await sleep(300);
  return cmdStart(arg);
}

function usage(msg) {
  if (msg) console.error(`gen-ctl: ${msg}`);
  console.error('usage: gen-ctl <start|stop|list|restart> ...\n' +
    '  start <seed|path|dir>   flat-out generator(s); a dir starts all its timelines in parallel\n' +
    '  stop  <seed|path|all>   stop + fold to a single file\n' +
    '  list  [--json]          report each timeline: running, days, frontier (read-only)\n' +
    '  restart <seed|path>');
  return 2;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  const arg = rest.find((a) => !a.startsWith('--'));
  switch (cmd) {
    case 'start':   return cmdStart(arg);
    case 'stop':    return cmdStop(arg);
    case 'list':    return cmdList(json);
    case 'restart': return cmdRestart(arg);
    default:        return usage(cmd ? `unknown command: ${cmd}` : null);
  }
}

main().then((code) => process.exit(code || 0)).catch((e) => { console.error('gen-ctl error:', e.message); process.exit(1); });
