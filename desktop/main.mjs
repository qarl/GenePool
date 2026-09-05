// GenePool desktop (Electron) MAIN process. One app, one process tree: a Chromium renderer runs the existing
// micrograph viewer (WebGL + the JS engine), and this Node 24 main process gives it REAL files + SQLite recording
// via IPC -- reusing the tested tools/events pipeline verbatim (node:sqlite). No personal browser, no separate server
// (the loopback below is internal to the app, only so the renderer's ES modules + font load exactly as in dev).
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteSink } from '../tools/events/sqlite-sink.mjs';
import { createJsonlSink } from '../tools/events/jsonl-sink.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');                 // repo root: serves the viewer + engine + fonts to our own renderer
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json',
  '.ttf':'font/ttf', '.css':'text/css', '.png':'image/png', '.wasm':'application/wasm' };

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

let win = null;
async function createWindow(){
  const port = await startStaticServer();
  win = new BrowserWindow({
    width: 1120, height: 830, backgroundColor: '#0b0e13', title: 'GenePool',
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/viewer-micrograph-gl.html`);
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
ipcMain.handle('pool:recordStart', async (_e, { seed, config, snapshot }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Record run to SQLite', defaultPath: 'run.db',
    filters: [{ name: 'SQLite', extensions: ['db'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const path = recordStart({ base: r.filePath, seed, config, snapshot });
  return { ok: true, path };
});
ipcMain.on('pool:record', (_e, events) => recordEvents(events));
ipcMain.handle('pool:recordSnapshot', (_e, snapshot) => { recordSnapshot(snapshot); return { ok: true }; });
ipcMain.handle('pool:recordStop', () => ({ ok: true, ...(recordStop() || {}) }));

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { recordStop(); app.quit(); });
