'use strict';
// The one-writer authority for background jobs is -wal FRESHNESS (isWriterLive), which is WRITER-AGNOSTIC: it detects a
// live writer whether it's the app, a detached background generator, or an external CLI generator, and is crash-safe (a
// dead writer's -wal goes stale). This is the guard the app consults before opening any writable connection on a run.
// Plus collapseToSingleFile folds a dead writer's WAL back to one file, losslessly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, existsSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const load = async () => import('../../tools/events/run-db.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), 'gp-bgguard-'));
const RUNGEN = join(__dirname, '../../tools/scrub/run-gen.mjs');

test('isWriterLive: none/stale = false, fresh = true', async () => {
  const { isWriterLive } = await load();
  const dir = tmp(); const p = join(dir, 'x.db');
  writeFileSync(p, 'db');
  assert.equal(isWriterLive(p), false, 'no -wal -> not live');
  writeFileSync(p + '-wal', 'wal');
  assert.equal(isWriterLive(p, 4000), true, 'fresh -wal -> live');
  await sleep(200);
  assert.equal(isWriterLive(p, 100), false, '-wal older than staleMs -> not live');
});

test('EXTERNAL live generator is detected, then collapses losslessly after it dies', async () => {
  const { isWriterLive, collapseToSingleFile, openRunReader } = await load();
  const dir = tmp(); const p = join(dir, 'ext.db');
  // an out-of-band generator == exactly a detached background job / external CLI writer the app did NOT spawn
  const child = spawn(process.execPath, [RUNGEN, '--seed', '7', '--out', p, '--ticks', 'Infinity', '--keyframe', '500'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(p + '-wal'); i++) await sleep(100);
    await sleep(600);
    assert.ok(existsSync(p + '-wal'), 'generator created a -wal');
    assert.equal(isWriterLive(p, 4000), true, 'live external writer detected by the app-side guard');
    const r0 = openRunReader(p); const f0 = r0.frontier(); r0.close();
    assert.ok(f0 >= 0, 'read-only reader sees the external writer (WAL cross-process)');

    child.kill('SIGKILL');
    for (let i = 0; i < 60 && isWriterLive(p, 300); i++) await sleep(100);
    assert.equal(isWriterLive(p, 300), false, 'dead writer -> stale -wal -> not live (guard now allows the app to own it)');

    assert.equal(collapseToSingleFile(p), true, 'collapse runs (no live writer)');
    assert.ok(!existsSync(p + '-wal') && !existsSync(p + '-shm'), 'sidecars removed -> single file');
    const r1 = openRunReader(p); const f1 = r1.frontier(); r1.close();
    assert.ok(f1 >= f0, 'frontier preserved through the collapse (lossless)');
  } finally { try { child.kill('SIGKILL'); } catch {} }
});

test('collapseToSingleFile refuses (returns false-ish safely) while a writer is live', async () => {
  const { isWriterLive, collapseToSingleFile, openRunReader } = await load();
  const dir = tmp(); const p = join(dir, 'live.db');
  const child = spawn(process.execPath, [RUNGEN, '--seed', '3', '--out', p, '--ticks', 'Infinity', '--keyframe', '500'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(p + '-wal'); i++) await sleep(100);
    await sleep(600);
    assert.equal(isWriterLive(p, 4000), true);
    // collapsing a live db must NOT corrupt it: journal_mode=DELETE declines with another connection open; data stays readable
    collapseToSingleFile(p);
    const r = openRunReader(p); const f = r.frontier(); r.close();
    assert.ok(f >= 0, 'db still readable after a collapse attempt on a live writer');
  } finally { try { child.kill('SIGKILL'); } catch {} }
});
