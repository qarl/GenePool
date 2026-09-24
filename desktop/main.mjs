// GenePool desktop (Electron) MAIN process. One app, one process tree: a Chromium renderer runs the existing
// micrograph viewer (WebGL + the JS engine), and this Node 24 main process gives it REAL files + SQLite recording
// via IPC -- reusing the tested tools/events pipeline verbatim (node:sqlite). No personal browser, no separate server
// (the loopback below is internal to the app, only so the renderer's ES modules + font load exactly as in dev).
import { app, BrowserWindow, Menu, ipcMain, dialog, utilityProcess } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteSink } from '../tools/events/sqlite-sink.mjs';
import { createJsonlSink } from '../tools/events/jsonl-sink.mjs';
import { openRunReader, openRunWriter, commitParamEdit, commitImport, isWriterLive, collapseToSingleFile } from '../tools/events/run-db.mjs';
import { withKeyframe, resolveWorldConfig } from '../engine/config.js';
import { World } from '../engine/world.js';
import { poolConfig, POOL_DEFAULTS, POOL_SETTINGS } from '../engine/pool-seed.mjs';
import { createBgJobs, APP_NAME } from '../tools/scrub/gen-jobs.mjs';   // Electron-free bg-jobs machinery (extracted)

// Second instance would fork a 2nd writer on a run db + race the jobs registry -> refuse it (background makes
// reopen-while-a-job-runs normal). Must be BEFORE anything opens a db.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const checkpointClose = collapseToSingleFile;   // fold a run's WAL into a single file; declines silently on a held db

// App identity: "GenePool" (dock, About, menus, and the userData folder ~/Library/Application Support/GenePool).
// Set before any app.getPath('userData') call so runs/params/heads land under the GenePool folder. Packaging
// (productName in package.json) sets the same name for the built GenePool.app.
app.setName(APP_NAME);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');                 // repo root: serves the viewer + engine + fonts to our own renderer
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json',
  '.ttf':'font/ttf', '.woff2':'font/woff2', '.css':'text/css', '.png':'image/png', '.wasm':'application/wasm' };

// --- internal loopback static server (127.0.0.1, ephemeral port) -> ES modules/fetch work as in the browser ---
function startStaticServer(){
  return new Promise((res, rej) => {
    const srv = createServer(async (req, q) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/viewer-micrograph-gl.html';
        const fp = join(ROOT, p);
        if (!fp.startsWith(ROOT) || !existsSync(fp)) { q.writeHead(404); q.end('not found'); return; }
        q.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
        q.end(await readFile(fp));
      } catch (e) { q.writeHead(500); q.end(String(e)); }
    });
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res(srv.address().port));
  });
}

// --- recording: one .db holds the whole run (initial + periodic World.serialize() snapshots, plus the event stream);
//     a sibling .jsonl is the append-only source of truth. Both are pure observers of the engine's onEvent stream. ---
let rec = null;   // { sqlite, jsonl, snapStmt, path, events }
function recordStart({ base, seed, config, snapshot }){
  const dbPath = base.replace(/\.(db|jsonl|json)$/i, '') + '.db';
  const jsonlPath = dbPath.replace(/\.db$/, '.jsonl');
  const sqlite = createSqliteSink(dbPath);
  sqlite.db.exec('CREATE TABLE IF NOT EXISTS snapshots (tick INTEGER, json TEXT)');   // full checkpoints for instant resume
  const snapStmt = sqlite.db.prepare('INSERT INTO snapshots (tick, json) VALUES (?, ?)');
  sqlite.db.exec('CREATE TABLE IF NOT EXISTS run_meta (k TEXT PRIMARY KEY, v TEXT)');
  sqlite.db.prepare('INSERT OR REPLACE INTO run_meta (k,v) VALUES (?,?)').run('config', JSON.stringify({ seed, config }));
  const jsonl = createJsonlSink(jsonlPath, { runId: null, seed, config });
  if (snapshot){ snapStmt.run(snapshot.clock ?? 0, JSON.stringify(snapshot)); jsonl.onEvent({ type: 'snapshot', tick: snapshot.clock ?? 0, snapshot }); }
  rec = { sqlite, jsonl, snapStmt, path: dbPath, events: 0 };
  return dbPath;
}
function recordEvents(events){
  if (!rec) return;
  for (const e of events){ rec.sqlite.onEvent(e); rec.jsonl.onEvent(e); rec.events++; }
}
function recordSnapshot(snapshot){ if (rec && snapshot){ rec.snapStmt.run(snapshot.clock ?? 0, JSON.stringify(snapshot)); rec.jsonl.onEvent({ type:'snapshot', tick: snapshot.clock ?? 0, snapshot }); } }
function recordStop(){ if (!rec) return null; const { path, events } = rec; rec.jsonl.close(); rec.sqlite.close(); rec = null; return { path, events }; }

// --- scrub/playback: a per-seed run is generated by a utilityProcess (real Node, same V8 as the renderer -> D1) and
//     read back here via a read-only WAL reader, so the renderer can scrub a run WHILE it is still being generated. ---
let scrub = null;   // { seed, child, reader, dbPath, ready }
// POOL_SETTINGS (the per-pool experiment settings baked into fresh runs) now lives in engine/pool-seed.mjs, shared with
// the background/CLI generators (gen-jobs.bgSpawn) so a run is app-identical no matter who starts it.
function runsDir(){ const d = join(app.getPath('userData'), 'timelines'); mkdirSync(d, { recursive: true }); return d; }   // seed timelines (seed-N.db)
function stopGenerator(){
  if (!scrub) return;
  const dbPath = scrub.dbPath, child = scrub.child, bg = scrub.background;
  if (scrub.poll){ clearInterval(scrub.poll); scrub.poll = null; }
  try { scrub.reader?.close(); } catch { /* already closed */ }
  scrub = null;
  // Background/read-only view (no child of ours): a detached/external writer owns the db -> do NOT collapse it (its -wal
  // is live; we'd only decline anyway). Only collapse a run WE were generating, once our writer child is gone.
  if (bg || !child) return;
  const clean = () => { if (!scrub || scrub.dbPath !== dbPath) checkpointClose(dbPath); };
  try { child.once('exit', clean); child.kill(); }
  catch { clean(); }
}
// Like stopGenerator, but AWAIT the child's actual exit before resolving (I6): the commit path must not open a second
// writer on the .db while the generator still holds the WAL writer. Dedicated (not stopGenerator, which quit/select
// also call synchronously). Force-kill + timeout fallback so a wedged child can't deadlock the commit.
function stopGeneratorAndWait(){
  return new Promise((resolve) => {
    if (!scrub) return resolve();
    const s = scrub;
    try { s.reader?.close(); } catch { /* already closed */ }
    let done = false; const finish = () => { if (done) return; done = true; if (scrub === s) scrub = null; resolve(); };
    try { s.child?.once('exit', finish); s.child?.kill(); } catch { finish(); return; }
    setTimeout(() => { try { s.child?.kill(); } catch { /* gone */ } finish(); }, 3000);
  });
}
// Custom timelines (edited/imported runs) live under ~/Documents/GenePool. A run is one of two SOURCES:
//   * SEED (runs/seed-N.db, picked by number)  -- pure & reproducible; edits/imports are REFUSED (locked).
//   * TIMELINE (a .timeline file, opened/saved) -- custom; edits/imports allowed. The bottom bar shows its filename.
// The source is what makes a run pure-vs-custom; every result payload carries { seed, custom, name, key } so the
// renderer knows the mode. `key` (seed:N | tl:<path>) is the per-source playhead-memory key.
function docsDir(){ const d = join(app.getPath('documents'), 'GenePool'); mkdirSync(d, { recursive: true }); return d; }
const sourceKey = (s) => s.custom ? ('tl:' + s.dbPath) : ('seed:' + s.seed);

// Open (or start generating) a run at dbPath. meta = { seed, custom, name }. Resolves once the .db is readable (S3).
// If a BACKGROUND/external writer already owns the run (its -wal is fresh), we do NOT fork a second writer -- we open a
// read-only reader and live-scrub it, polling the frontier so the main view keeps advancing (a detached writer sends no IPC).
function startRun(dbPath, meta){
  const { seed = null, custom = false, name = null } = meta;
  const key = custom ? ('tl:' + dbPath) : ('seed:' + seed);
  const payload = (s) => ({ ok: true, seed, custom, name, key, dbPath, background: !!s.background, frontier: s.reader.frontier(), runConfig: s.reader.runConfig(), lastHead: headOf(key) });
  return new Promise((resolve) => {
    if (scrub && scrub.dbPath === dbPath && scrub.ready){ resolve(payload(scrub)); return; }
    stopGenerator();                                            // kill+respawn on source change (S5)
    // A background/external generator owns this run -> READ-ONLY view (never a second writer).
    if (existsSync(dbPath) && isWriterLive(dbPath)){
      try {
        const reader = openRunReader(dbPath);
        const s = { seed, custom, name, key, child: null, reader, dbPath, ready: true, background: true, poll: null };
        scrub = s;
        s.poll = setInterval(() => {                            // feed the main view's play-ceiling from the detached writer
          if (s !== scrub) return;
          try { const t = s.reader.frontier(); if (win && !win.isDestroyed()) win.webContents.send('scrub:frontier', { key: s.key, tick: t }); } catch { /* reader gone */ }
        }, 1500);
        resolve(payload(s));
      } catch (e){ resolve({ ok: false, error: String(e) }); }
      return;
    }
    const resume = existsSync(dbPath);                          // continue a partial run (S4); a custom timeline always exists (opened/saved) -> resume
    const child = utilityProcess.fork(join(HERE, 'generator.mjs'));
    const s = { seed, custom, name, key, child, reader: null, dbPath, ready: false };
    scrub = s;
    child.on('message', (m) => {
      if (s !== scrub) return;                                  // a newer source superseded this child
      if (m.type === 'ready'){
        try { s.reader = openRunReader(dbPath); s.ready = true; resolve(payload(s)); }
        catch (e){ resolve({ ok: false, error: String(e) }); }
      } else if (m.type === 'progress'){
        if (win && !win.isDestroyed()) win.webContents.send('scrub:frontier', { key: s.key, tick: m.tick });   // tag with the source key so the renderer drops a killed run's late frontier
      } else if (m.type === 'done'){
        if (win && !win.isDestroyed()) win.webContents.send('scrub:done', m);
      } else if (m.type === 'error' && !s.ready){ resolve({ ok: false, error: m.message }); }
    });
    child.on('exit', () => { if (s === scrub && !s.ready) resolve({ ok: false, error: 'generator exited before ready' }); });
    // UNBOUNDED generation (Karl): the utilityProcess runs one core flat-out until it's killed. A custom timeline resumes
    // its OWN stored config; POOL_SETTINGS only seeds a FRESH seed-run (a custom timeline always exists -> never fresh).
    child.postMessage({ seed: seed ?? 0, out: dbPath, opts: { resume, ticks: Infinity, settings: POOL_SETTINGS } });
  });
}
function selectSeed(seed){ const p = join(runsDir(), `seed-${seed}.db`); noteKnown(p, { kind: 'seed', name: `seed-${seed}`, seed }); return startRun(p, { seed, custom: false, name: null }); }
function openTimeline(path){ noteKnown(path, { kind: 'timeline', name: basename(path), seed: null }); return startRun(path, { seed: null, custom: true, name: basename(path) }); }
ipcMain.handle('scrub:select',    async (_e, seed) => { await loadHeads(); return selectSeed(seed >>> 0); });
// Re-open a run by its path (used after stopping a background job on the currently-viewed run -> resume it foreground).
ipcMain.handle('scrub:reopen',    async (_e, { dbPath, seed, custom, name }) => { await loadHeads(); noteKnown(dbPath, { kind: custom ? 'timeline' : 'seed', name, seed }); return startRun(dbPath, { seed: custom ? null : (seed >>> 0), custom: !!custom, name }); });
ipcMain.handle('scrub:frontier',  ()          => scrub?.reader ? scrub.reader.frontier() : -1);
ipcMain.handle('scrub:keyframe',  (_e, t)     => scrub?.reader ? scrub.reader.getKeyframe(t) : null);
ipcMain.handle('scrub:stats',     (_e, t)     => scrub?.reader ? scrub.reader.getStats(t) : null);
ipcMain.handle('scrub:popSeries', (_e, opts)  => scrub?.reader ? scrub.reader.getPopSeries(opts || {}) : []);

// ===== BACKGROUND JOBS =============================================================================================
// Opt-in per run: a DETACHED generator that survives app quit; the app monitors it read-only. The one-writer authority
// is -wal freshness (isWriterLive) -- writer-agnostic + crash-safe. bg-jobs.json is only the UI list + the pid to kill.
const sessionKnown = new Map();          // dbPath -> { kind, name, seed } : runs opened/known this session (UI list)
function noteKnown(dbPath, meta){ if (dbPath) sessionKnown.set(dbPath, meta); }
function notifyJobs(){ if (win && !win.isDestroyed()) win.webContents.send('jobs:changed'); }
// The detached-generator machinery (spawn/kill/ps-scan/registry) lives in the Electron-free tools/scrub/gen-jobs.mjs so a
// CLI (gen-ctl) drives it identically. main injects: the UI push (onChanged) and the foreground handoff (yieldForeground
// = kill OUR own generator child if it owns this db, so bgStart never forks a second writer).
const jobs = createBgJobs({
  onChanged: notifyJobs,
  yieldForeground: async (dbPath) => { if (scrub && scrub.dbPath === dbPath && scrub.child) await stopGeneratorAndWait(); },
});
// The UI list (session-known ∪ registry) stays in main -- sessionKnown is a renderer concept. Row shape unchanged.
function bgList(){
  const scan = jobs.reconcileJobs();
  const rows = new Map();
  const running = (p) => !!scan[p] || isWriterLive(p);
  const add = (p, m) => rows.set(p, { dbPath: p, kind: m.kind, name: m.name, seed: m.seed, background: !!jobs.jobs[p], running: running(p), day: jobs.dayOf(p), missing: !existsSync(p) });
  for (const [p, m] of sessionKnown) add(p, m);
  for (const [p, m] of Object.entries(jobs.jobs)) add(p, m);
  return [...rows.values()];
}
ipcMain.handle('jobs:list', () => bgList());
ipcMain.handle('jobs:diskFree', () => jobs.diskFreeGi());
ipcMain.handle('jobs:setBackground', async (_e, { dbPath, on, seed, kind, name }) => {
  noteKnown(dbPath, { kind, name, seed });
  const r = on ? await jobs.bgStart(dbPath, { seed, kind, name }) : await jobs.bgStop(dbPath);
  notifyJobs();
  return r;
});

// Parameter-timeline commit: edit one option at the playhead tick. Validate FIRST (I4), await the generator's exit
// (I6), apply the atomic edit (commitParamEdit), then re-fork the generator to resume under the new schedule. Resolves
// like scrub:select ({ok, seed, frontier, runConfig, lastHead}) so the renderer runs its selectSeed refresh.
const EDITABLE_DEFAULTS = { evolvableMutationRate: false, mutationRateGeneScale: 64, foodReseedWhenEmpty: false };
// A run is editable ONLY when it's a custom timeline. Pure seed timelines are locked (PURE_SEED -> the renderer shows
// "Save into a custom timeline before making changes"). Captures the source BEFORE stopGeneratorAndWait (which nulls scrub).
function editTarget(){
  if (!scrub || !scrub.ready) return { err: 'no active run' };
  if (scrub.background) return { err: 'BG_OWNED' };   // a background generator owns this run -> read-only (stop the job to edit)
  if (!scrub.custom) return { err: 'PURE_SEED' };
  const stored = scrub.reader.runConfig();
  if (!stored || !stored.config) return { err: 'run has no stored config' };
  return { dbPath: scrub.dbPath, meta: { seed: scrub.seed, custom: true, name: scrub.name }, runSeed: stored.seed ?? 0, config: stored.config };
}
ipcMain.handle('scrub:commit', async (_e, { field, value, tick }) => {
  tick = tick >>> 0;
  const t = editTarget(); if (t.err) return { ok: false, error: t.err };
  if (!(field in EDITABLE_DEFAULTS)) return { ok: false, error: `field not editable: ${field}` };
  const candidate = { ...t.config, [field]: withKeyframe(t.config[field], tick, value, EDITABLE_DEFAULTS[field]) };
  try { resolveWorldConfig(candidate); } catch (e) { return { ok: false, error: `invalid edit: ${e.message}` }; }
  await stopGeneratorAndWait();                                   // I6: generator must be gone before we open a writer
  try { commitParamEdit(t.dbPath, { newRunConfig: { seed: t.runSeed, config: candidate }, tick }); }
  catch (e) { return { ok: false, error: `commit failed: ${e.message}` }; }
  return await startRun(t.dbPath, t.meta);                        // re-fork resume under the edited stored config
});

// Import commit: BRANCH the timeline at the playhead -- the imported frame becomes keyframe-T, the future is invalidated,
// the generator resumes forward. Only allowed on a custom timeline (PURE_SEED otherwise). Re-validated here (defense in depth).
ipcMain.handle('scrub:commitImport', async (_e, { tick, config, data }) => {
  tick = tick >>> 0;
  const t = editTarget(); if (t.err) return { ok: false, error: t.err };
  if (!config || !data) return { ok: false, error: 'import needs { config, data }' };
  try { resolveWorldConfig(config); World.restore(config, data); } catch (e) { return { ok: false, error: `invalid import: ${e.message}` }; }
  await stopGeneratorAndWait();                                   // I6: generator gone before we open a writer
  try { commitImport(t.dbPath, { newRunConfig: { seed: t.runSeed, config }, tick, snapshot: data }); }
  catch (e) { return { ok: false, error: `import failed: ${e.message}` }; }
  return await startRun(t.dbPath, t.meta);                        // re-fork resume from the imported keyframe-T
});

// --- native application menu: a File menu owns all file ops (the bottom-bar SEED/FILE toggle is gone). Menu clicks send
//     menu:action to the renderer, which owns the live world/selection/playhead and drives the actual read/write/import.
//     "Save As" is the exception: it copies the run's .db entirely in main. ---
let exportSwimmerItem = null;   // ref so menu:selection can enable/disable it as the renderer's selection changes
function sendMenu(action){ if (win && !win.isDestroyed()) win.webContents.send('menu:action', action); }
function buildAppMenu(){
  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Timeline…', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('newTimeline') },
      { label: 'Open Timeline…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('openTimeline') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveAs') },
      { type: 'separator' },
      { label: 'Import…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
      { type: 'separator' },
      { label: 'Export Pool…', click: () => sendMenu('exportPool') },
      { id: 'exportSwimmer', label: 'Export Swimmer…', enabled: false, click: () => sendMenu('exportSwimmer') },
    ],
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    fileMenu,
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ];
  const menu = Menu.buildFromTemplate(template);
  exportSwimmerItem = menu.getMenuItemById('exportSwimmer');
  Menu.setApplicationMenu(menu);
}
ipcMain.on('menu:selection', (_e, on) => { if (exportSwimmerItem) exportSwimmerItem.enabled = !!on; });

// Save As -> write the CURRENT run to a .timeline in ~/Documents/GenePool and SWITCH INTO it (custom mode: now editable,
// bar shows the filename). The original source (a seed run, or the previous timeline) is left untouched/frozen. Renderer-
// driven (menu:'saveAs') so the renderer refreshes its bar from the returned source.
ipcMain.handle('timeline:saveAs', async () => {
  if (!scrub || !scrub.ready) return { ok: false, error: 'no active run' };
  if (scrub.background) return { ok: false, error: 'BG_OWNED' };   // a live background writer -> copying now would tear the file; stop the job first
  const src = scrub.dbPath;
  const base = (scrub.name || `seed-${scrub.seed}`).replace(/\.timeline$/i, '');
  const r = await dialog.showSaveDialog(win, { title: 'Save timeline as', defaultPath: join(docsDir(), base + '.timeline'),
    filters: [{ name: 'GenePool timeline', extensions: ['timeline'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const srcMeta = { seed: scrub?.seed ?? null, custom: scrub?.custom ?? false, name: scrub?.name ?? null };
  await stopGeneratorAndWait();                       // release the writer so the copy is consistent
  checkpointClose(src);                               // fold the source's WAL into a SINGLE file (recover-before-copy) so...
  try { await copyFile(src, r.filePath); }            // ...the copy is a clean single .db -- NOT its -wal/-shm (a copied -wal
                                                      //    would look "fresh" to isWriterLive and wrongly open the copy read-only)
  catch (e){ await startRun(src, srcMeta); return { ok: false, error: `save failed: ${e.message}` }; }
  return await openTimeline(r.filePath);              // switch into the new custom timeline (no sidecar -> editable)
});
// New -> an EMPTY custom timeline (no founders, no food) in ~/Documents/GenePool, opened editable. Compose it by
// Importing (merging) pools into it. keyframe-0 is a bare World(config) serialize -> 0 living (won't generate until
// you merge creatures in), custom -> editable.
ipcMain.handle('timeline:new', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'New timeline', defaultPath: join(docsDir(), 'untitled.timeline'),
    filters: [{ name: 'GenePool timeline', extensions: ['timeline'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    const cfg = poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS);
    const w = new World(cfg, 0);                       // empty world (no seeding) -> keyframe-0 has 0 swimbots/food
    const writer = openRunWriter(r.filePath, { seed: 0, config: cfg }, { resume: false });
    writer.writeKeyframe(0, w.serialize());
    writer.finish(); writer.close();
  } catch (e){ return { ok: false, error: `new failed: ${e.message}` }; }
  collapseToSingleFile(r.filePath);                    // fold the writer's WAL -> a clean single file (opens editable, not phantom-bg)
  return await openTimeline(r.filePath);
});
// Open Timeline -> load a .timeline file (custom mode). Validate it's a readable run before forking.
ipcMain.handle('timeline:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open timeline', defaultPath: docsDir(), properties: ['openFile'],
    filters: [{ name: 'GenePool timeline', extensions: ['timeline'] }] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false };
  const path = r.filePaths[0];
  try { openRunReader(path).close(); } catch (e){ return { ok: false, error: `not a GenePool timeline: ${e.message}` }; }
  await loadHeads();
  return await openTimeline(path);
});

// Export Swimmer / Export Pool: the renderer hands over the data (it owns the live world); main just picks a path + writes.
ipcMain.handle('pool:exportSwimmer', async (_e, obj) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export swimmer', defaultPath: 'untitled.swimmer',
    filters: [{ name: 'GenePool swimmer', extensions: ['swimmer'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  await writeFile(r.filePath, JSON.stringify(obj, null, 2));
  return { ok: true, path: r.filePath };
});
ipcMain.handle('pool:exportPool', async (_e, obj) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export pool (one frame)', defaultPath: 'untitled.pool',
    filters: [{ name: 'GenePool pool', extensions: ['pool'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  await writeFile(r.filePath, JSON.stringify(obj));
  return { ok: true, path: r.filePath };
});
// Import: pick a .pool file, then read + VALIDATE it (config resolves AND the snapshot restores) before handing it back.
ipcMain.handle('pool:importPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import pool', properties: ['openFile'],
    filters: [{ name: 'GenePool pool', extensions: ['pool'] }] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false };
  try {
    const obj = JSON.parse(await readFile(r.filePaths[0], 'utf8'));
    const config = obj.config, data = obj.data ?? obj;   // accept {config,data} (Export Pool) or a bare serialize()+config
    if (!config || !data) return { ok: false, error: 'not a pool file (missing config/data)' };
    resolveWorldConfig(config);                          // throws on a bad config
    World.restore(config, data);                         // throws if the snapshot can't be restored -> reject before touching the DB
    return { ok: true, config, data };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

let win = null;
async function createWindow(){
  const port = await startStaticServer();
  win = new BrowserWindow({
    width: 1120, height: 830, backgroundColor: '#0b0e13', title: 'GenePool',
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // surface renderer warnings/errors + a crash to the main stdout (dev diagnostics for the scrub/playback UI)
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (message && (message.includes('[fps]') || message.includes('[bench]'))) console.log(message);   // forward fps/bench readouts (real-GPU)
    else if (level >= 2) console.error(`[renderer] ${message}  (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d.reason));
  const params = new URLSearchParams();                   // dev knob: GP_BENCH=1 -> real-GPU zoom-sweep bench (forwarded [bench] log)
  if (process.env.GP_BENCH) params.set('zoombench', '1');
  const q = params.toString() ? '?' + params.toString() : '';
  win.loadURL(`http://127.0.0.1:${port}/viewer-micrograph-gl.html${q}`);
}

// --- IPC: real files + recording, all in-process ---
ipcMain.handle('pool:save', async (_e, obj) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save pool', defaultPath: 'pool.gpool.json',
    filters: [{ name: 'GenePool pool', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  await writeFile(r.filePath, JSON.stringify(obj));
  return { ok: true, path: r.filePath };
});
ipcMain.handle('pool:load', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Load pool', properties: ['openFile'],
    filters: [{ name: 'GenePool pool', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false };
  return { ok: true, data: JSON.parse(await readFile(r.filePaths[0], 'utf8')), path: r.filePaths[0] };
});
// K-panel visual constants -> a real file in userData (survives relaunch; localStorage does NOT, since the window's
// loopback origin has an ephemeral port that changes each launch).
const paramsPath = () => join(app.getPath('userData'), 'micrograph-params.json');
ipcMain.handle('params:save', async (_e, obj) => {
  try { await writeFile(paramsPath(), JSON.stringify(obj, null, 2)); return { ok: true, path: paramsPath() }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('params:load', async () => {
  try { return JSON.parse(await readFile(paramsPath(), 'utf8')); } catch { return null; }
});
// Per-SOURCE playhead memory, persisted ACROSS runs. Keyed by the source key (seed:N | tl:<path>) so both seed runs and
// custom timelines remember where you left them. Sidecar JSON in userData (NOT the .db: the flat-out generator owns the
// .db writer, and writing to a live run would contend with it -- Karl's hard rule). scrub:select/open returns lastHead.
const headsPath = () => join(app.getPath('userData'), 'scrub-heads.json');
let scrubHeads = null;
async function loadHeads(){ if (scrubHeads) return scrubHeads; try { scrubHeads = JSON.parse(await readFile(headsPath(), 'utf8')) || {}; } catch { scrubHeads = {}; } return scrubHeads; }
const headOf = (key) => (scrubHeads && scrubHeads[key]) || 0;
let _headsWriteT = null;
ipcMain.on('scrub:reportHead', async (_e, msg) => {
  if (!msg || !msg.key) return;
  const h = await loadHeads(); h[msg.key] = Math.max(0, msg.head | 0);
  clearTimeout(_headsWriteT); _headsWriteT = setTimeout(() => writeFile(headsPath(), JSON.stringify(h)).catch(() => {}), 400);   // debounce fs writes
});
// Save a recorded viewer video (WebM bytes from the renderer's MediaRecorder) to a date/time-named file in ~/Movies/GenePool.
ipcMain.handle('video:save', async (_e, { bytes, ext }) => {
  try {
    const dir = join(app.getPath('videos'), 'GenePool'); mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').replace(/\..+$/, '');   // 2026-09-07_15-30-12
    const path = join(dir, `genepool-${ts}.${ext === 'mp4' ? 'mp4' : 'webm'}`);
    await writeFile(path, Buffer.from(bytes));
    return { ok: true, path };
  } catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('pool:recordStart', async (_e, { seed, config, snapshot }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Record run to SQLite', defaultPath: 'run.db',
    filters: [{ name: 'SQLite', extensions: ['db'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const recDb = r.filePath.replace(/\.(db|jsonl|json)$/i, '') + '.db';
  if (isWriterLive(recDb)) return { ok: false, error: 'BG_OWNED' };   // don't open a 2nd writer on a run a background job owns
  const path = recordStart({ base: r.filePath, seed, config, snapshot });
  return { ok: true, path };
});
ipcMain.on('pool:record', (_e, events) => recordEvents(events));
ipcMain.handle('pool:recordSnapshot', (_e, snapshot) => { recordSnapshot(snapshot); return { ok: true }; });
ipcMain.handle('pool:recordStop', () => ({ ok: true, ...(recordStop() || {}) }));

app.whenReady().then(() => {
  jobs.loadJobs();                               // restore the background-job registry; bgList() prunes dead entries + collapses their files
  try { bgList(); } catch { /* best effort */ }
  buildAppMenu();
  createWindow();
});
app.on('second-instance', () => { if (win && !win.isDestroyed()){ if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// Aggressive sidecar cleanup on a CLEAN quit: kill the generator, AWAIT its exit, then collapse the active run to a
// single file (drop -wal/-shm) BEFORE the process dies. Without the await, quit would race the async collapse and leave
// the last seed's sidecars behind. (A crash still leaves sidecars -- that's fine per Karl; we only clean clean exits.)
let _quitting = false;
app.on('before-quit', (e) => {
  if (_quitting) return;                         // second pass -> let the quit proceed
  if (!scrub) return;                            // nothing active (idle runs already collapsed on stop)
  const dbPath = scrub.dbPath, bg = scrub.background;
  e.preventDefault();
  _quitting = true;
  // Collapse ONLY a run we were generating ourselves. A background-owned run (detached writer) keeps running past quit
  // and owns its -wal -> never touch it. Detached background jobs are intentionally left alive.
  stopGeneratorAndWait().then(() => { if (!bg && !isWriterLive(dbPath)) checkpointClose(dbPath); app.quit(); });
});
app.on('window-all-closed', () => { recordStop(); app.quit(); });   // app.quit() fires before-quit, which collapses + quits
