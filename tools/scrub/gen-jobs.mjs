'use strict';
// Electron-FREE background-jobs machinery, extracted verbatim (behavior-preserving) from desktop/main.mjs so BOTH the
// desktop app AND a standalone CLI (gen-ctl, commit 3) drive generators through the same code and never step on each other.
//
// A background job is a DETACHED generator (child_process.spawn, NOT utilityProcess -- Electron doesn't kill it on quit)
// that outlives the app. The registry (bg-jobs.json) is only the UI list + the pid to kill; the ACTUAL authority is a ps
// scan of live run-gen.mjs processes (writer-agnostic orphan recovery), with -wal freshness (isWriterLive) as the
// "may I open a writer" guard. The Electron/UI couplings are INJECTED (onChanged, yieldForeground) -- this module imports
// nothing from 'electron'.
//
// NOTE: this is COMMIT 1 (mechanical extraction). Coordination is still ps-scan + isWriterLive, identical to today. The
// cross-platform db-heartbeat claim/fence (which replaces the ps scan) is COMMIT 2 -- see docs/PLAN-generator-cli.md v4.2.

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { openRunReader, isWriterLive, collapseToSingleFile } from '../events/run-db.mjs';
import { POOL_SETTINGS } from '../../engine/pool-seed.mjs';

// Shared so the app's app.setName(APP_NAME) and this module's userData resolution CANNOT drift into two registries.
export const APP_NAME = 'GenePool';
// Resolve run-gen.mjs from THIS file's location -- correct whether loaded app-packaged (asar:false) or as a repo CLI,
// and no ROOT param to get wrong. The ps-scan regex anchors on the "run-gen.mjs ... --out" substring regardless.
const RUNGEN = fileURLToPath(new URL('./run-gen.mjs', import.meta.url));

// The userData dir WITHOUT electron, matching Electron's app.getPath('userData') per-OS, so the CLI and the app share ONE
// bg-jobs.json namespace. GENEPOOL_USERDATA overrides (headless / CI / tests). (Windows: %APPDATA% = Roaming, NOT Local.)
export function jobsDir() {
  if (process.env.GENEPOOL_USERDATA) return process.env.GENEPOOL_USERDATA;
  const home = homedir();
  switch (platform()) {
    case 'darwin': return join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':  return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_NAME);
    default:       return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), APP_NAME);
  }
}

// Factory: the app injects onChanged (UI refresh push) + yieldForeground (hand off if the app is the foreground writer).
// The CLI passes neither (defaults: no-op). All jobs state (bgJobs) is process-local; bg-jobs.json is the cross-process
// channel and self-heals from the ps scan.
export function createBgJobs({ onChanged = () => {}, yieldForeground = async () => {} } = {}) {
  const checkpointClose = collapseToSingleFile;   // fold a run's WAL into a single file; declines silently on a held db
  const jobsPath = () => join(jobsDir(), 'bg-jobs.json');
  let bgJobs = {};                                 // dbPath -> { pid, kind, name, seed, startedAt }
  function loadJobs() { try { bgJobs = JSON.parse(readFileSync(jobsPath(), 'utf8')) || {}; } catch { bgJobs = {}; } }
  async function persistJobs() { try { const t = jobsPath() + '.tmp'; writeFileSync(t, JSON.stringify(bgJobs)); await rename(t, jobsPath()); } catch { /* best effort */ } }
  function dayOf(dbPath) { try { const r = openRunReader(dbPath); const f = r.frontier(); r.close(); return f / 5184000; } catch { return null; } }
  function diskFreeGi() { try { const s = statfsSync(jobsDir()); return (s.bavail * s.bsize) / 2 ** 30; } catch { return null; } }

  // Spawn a DETACHED generator that outlives the app. A co-spawned macOS `caffeinate -w <pid>` holds a power assertion for
  // the child's lifetime so a flat-out job doesn't freeze on idle-sleep. --seed is mandatory even for timelines (run-gen
  // hard-exits without it); --resume ignores it on an existing db.
  function bgSpawn(dbPath, { seed }) {
    const args = [RUNGEN, '--seed', String(seed ?? 0), '--out', dbPath, '--resume', '--ticks', 'Infinity', '--settings', JSON.stringify(POOL_SETTINGS)];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.on('error', () => { /* spawn failed -> don't crash the parent */ });
    child.unref();
    // Keep-awake is best-effort and OPTIONAL (jobs still run without it, they may just pause on sleep). macOS: caffeinate.
    // Linux/Windows: no-op for now (systemd-inhibit / SetThreadExecutionState later). MUST attach an 'error' listener --
    // a missing binary emits an ASYNC 'error' event that would otherwise become an uncaughtException and crash the process.
    if (platform() === 'darwin') {
      try { const c = spawn('caffeinate', ['-s', '-w', String(child.pid)], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch { /* best effort */ }
    }
    child.on('exit', () => setTimeout(() => {   // in-session extinction/exit -> collapse + drop + tell the UI
      if (!isWriterLive(dbPath)) { checkpointClose(dbPath); if (bgJobs[dbPath]) { delete bgJobs[dbPath]; persistJobs(); } onChanged(); }
    }, 500));
    return child.pid;
  }

  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const baseName = (p) => basename(p).replace(/\.(db|timeline)$/i, '');
  function scanGenerators() {   // { dbPath -> pid } for every live run-gen.mjs process (ours + external)
    const out = {};
    try {
      for (const line of execSync('ps -Awwo pid=,command=', { encoding: 'utf8' }).split('\n')) {
        const m = line.match(/run-gen\.mjs.*?--out\s+(.+?)(?:\s+--|\s*$)/);   // path may contain spaces ("Application Support") -> capture up to the next --flag
        if (m) { const pid = parseInt(line.trim(), 10); if (pid) out[m[1]] = pid; }
      }
    } catch { /* ps unavailable */ }
    return out;
  }
  function reconcileJobs() {   // sync the registry to reality: adopt live generators, drop+collapse ended ones
    const scan = scanGenerators();
    for (const [p, pid] of Object.entries(scan)) if (!bgJobs[p]) {   // adopt an untracked live generator (orphan recovery / external CLI)
      const kind = p.endsWith('.timeline') ? 'timeline' : 'seed';
      const seed = kind === 'seed' ? parseInt((p.match(/seed-(\d+)\.db$/) || [])[1] || '0', 10) : null;
      bgJobs[p] = { pid, kind, name: baseName(p), seed, startedAt: Date.now() };
    }
    for (const p of Object.keys(bgJobs)) {
      if (scan[p]) { bgJobs[p].pid = scan[p]; continue; }             // still running -> refresh pid
      if (bgJobs[p].pid && pidAlive(bgJobs[p].pid)) continue;         // just spawned, ps not caught it yet -> keep (grace)
      if (existsSync(p)) checkpointClose(p);                          // truly ended -> collapse + drop
      delete bgJobs[p];
    }
    persistJobs();
    return scan;
  }
  async function bgStart(dbPath, meta) {
    await yieldForeground(dbPath);                                    // hand off if the app is the foreground writer of this db
    if (isWriterLive(dbPath) || scanGenerators()[dbPath]) {           // already owned (external/already background) -> adopt, no 2nd writer
      reconcileJobs();
      if (!bgJobs[dbPath]) { bgJobs[dbPath] = { pid: scanGenerators()[dbPath] || null, ...meta, startedAt: Date.now() }; await persistJobs(); }
      return { ok: true };
    }
    const pid = bgSpawn(dbPath, meta);
    bgJobs[dbPath] = { pid, ...meta, startedAt: Date.now() };
    await persistJobs();
    return { ok: true };
  }
  async function bgStop(dbPath) {
    const kill = (sig) => { const pids = new Set(); if (bgJobs[dbPath]?.pid) pids.add(bgJobs[dbPath].pid); const s = scanGenerators()[dbPath]; if (s) pids.add(s); for (const pid of pids) { try { process.kill(pid, sig); } catch { /* gone */ } } };
    kill();                                                           // SIGTERM whatever's writing this db (recorded pid + any live scan pid)
    for (let i = 0; i < 40 && (scanGenerators()[dbPath] || isWriterLive(dbPath)); i++) { if (i === 10) kill('SIGKILL'); await new Promise(r => setTimeout(r, 150)); }
    delete bgJobs[dbPath]; await persistJobs();
    for (let i = 0; i < 20 && isWriterLive(dbPath); i++) await new Promise(r => setTimeout(r, 150));   // let fds release before collapse
    checkpointClose(dbPath);
    onChanged();
    return { ok: true };
  }

  return {
    loadJobs, reconcileJobs, scanGenerators, bgStart, bgStop, dayOf, diskFreeGi, jobsPath,
    get jobs() { return bgJobs; },   // read-only view for bgList (the UI list stays in main)
  };
}
