'use strict';
// Characterization tests for the extracted, Electron-free background-jobs machinery (tools/scrub/gen-jobs.mjs). This
// logic had ZERO direct coverage while it lived in desktop/main.mjs; these lock the behavior the extraction must preserve:
// per-OS userData resolution (+ the GENEPOOL_USERDATA override), the ps-scan parsing a SPACED --out path, and
// reconcileJobs adopting a live untracked generator + pruning a dead one. Still ps-scan based (commit 1); the db-heartbeat
// coordination is commit 2. (ps-dependent tests skip on win32.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, existsSync } = require('node:fs');
const { tmpdir, platform } = require('node:os');
const { join } = require('node:path');

// Isolate the registry: every createBgJobs writes bg-jobs.json under GENEPOOL_USERDATA, not the real userData dir.
const USERDATA = mkdtempSync(join(tmpdir(), 'gp-jobs-ud-'));
process.env.GENEPOOL_USERDATA = USERDATA;

const load = async () => import('../../tools/scrub/gen-jobs.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), 'gp-jobs-'));
const RUNGEN = join(__dirname, '../../tools/scrub/run-gen.mjs');
const isWin = platform() === 'win32';

test('jobsDir(): GENEPOOL_USERDATA override wins; else per-OS default', async () => {
  const { jobsDir, APP_NAME } = await load();
  assert.equal(APP_NAME, 'GenePool');
  assert.equal(jobsDir(), USERDATA, 'env override is honored verbatim');

  // clear the override to observe the per-OS default, then restore it
  delete process.env.GENEPOOL_USERDATA;
  try {
    const d = jobsDir();
    if (platform() === 'darwin') assert.ok(d.endsWith(join('Library', 'Application Support', 'GenePool')), `darwin path: ${d}`);
    else if (platform() === 'win32') assert.ok(d.endsWith(join('Roaming', 'GenePool')) || d.endsWith(join('AppData', 'Roaming', 'GenePool')), `win path: ${d}`);
    else assert.ok(d.endsWith(join('.config', 'GenePool')) || d.includes('GenePool'), `linux path: ${d}`);
  } finally { process.env.GENEPOOL_USERDATA = USERDATA; }
});

test('scanGenerators() parses a --out path that contains SPACES', { skip: isWin ? 'ps is unix-only' : false }, async () => {
  const { createBgJobs } = await load();
  const jobs = createBgJobs();
  const dir = mkdtempSync(join(tmpdir(), 'gp jobs space-'));   // dir name has a space
  const p = join(dir, 'seed-7.db');                            // -> the --out arg contains a space
  const child = spawn(process.execPath, [RUNGEN, '--seed', '7', '--out', p, '--ticks', 'Infinity', '--keyframe', '500'], { stdio: 'ignore' });
  try {
    let scan = {};
    for (let i = 0; i < 100 && !scan[p]; i++) { await sleep(100); scan = jobs.scanGenerators(); }
    assert.ok(scan[p], `scan found the spaced --out path (got keys: ${Object.keys(scan).join(' | ')})`);
    assert.equal(scan[p], child.pid, 'scan maps the spaced path to the generator pid');
  } finally { try { child.kill('SIGKILL'); } catch {} }
});

test('reconcileJobs() adopts a live untracked generator', { skip: isWin ? 'ps is unix-only' : false }, async () => {
  const { createBgJobs } = await load();
  const jobs = createBgJobs();
  const dir = tmp(); const p = join(dir, 'seed-3.db');
  const child = spawn(process.execPath, [RUNGEN, '--seed', '3', '--out', p, '--ticks', 'Infinity', '--keyframe', '500'], { stdio: 'ignore' });
  try {
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) { await sleep(100); jobs.reconcileJobs(); seen = !!jobs.jobs[p]; }
    assert.ok(jobs.jobs[p], 'an untracked live generator is adopted into the registry');
    assert.equal(jobs.jobs[p].kind, 'seed');
    assert.equal(jobs.jobs[p].seed, 3, 'seed parsed from the path');
  } finally { try { child.kill('SIGKILL'); } catch {} }
});

test('reconcileJobs() prunes a dead entry (dead pid, no live scan, missing file)', async () => {
  const { createBgJobs } = await load();
  const jobs = createBgJobs();
  // a definitely-dead pid: spawn a trivial node, await its exit, reuse its (now-dead) pid.
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  const gonePath = join(tmp(), 'seed-99.db');   // does not exist -> prune skips checkpointClose, just deletes
  jobs.jobs[gonePath] = { pid: dead.pid, kind: 'seed', name: 'seed-99', seed: 99, startedAt: Date.now() };
  assert.ok(jobs.jobs[gonePath], 'seeded a dead entry');
  jobs.reconcileJobs();
  assert.ok(!jobs.jobs[gonePath], 'a dead, unscanned, missing-file entry is pruned');
});
