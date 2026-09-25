'use strict';
// Writer coordination (epoch: db-heartbeat claim + fence). Proves the one-writer invariant at the primitive level:
// a second writer on a live db is refused (WRITER_LIVE), and a wrongly-reclaimed writer self-fences (FENCED) before
// committing anything under the new owner. See docs/PLAN-generator-cli.md (v4.2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const load = async () => await import('../../tools/events/run-db.mjs');
const SNAP = { clock: 0, swimbots: [], food: [] };
const tmp = () => join(mkdtempSync(join(tmpdir(), 'gp-claim-')), 'run.db');

test('a second writer on a live db is REFUSED (WRITER_LIVE), not a silent second writer', async () => {
  const { openRunWriter } = await load();
  const p = tmp();
  const a = openRunWriter(p, { seed: 1, config: { pool: { left: 0, top: 0, right: 10, bottom: 10 } } }, { resume: false });
  a.writeKeyframe(0, SNAP);   // A owns + heartbeat fresh
  assert.throws(() => openRunWriter(p, { seed: 1, config: {} }, { resume: true }), (e) => e.code === 'WRITER_LIVE', 'second open must throw WRITER_LIVE');
  a.close();
  rmSync(join(p, '..'), { recursive: true, force: true });
});

test('after the owner finishes, the db is immediately re-claimable', async () => {
  const { openRunWriter } = await load();
  const p = tmp();
  const a = openRunWriter(p, { seed: 1, config: {} }, { resume: false });
  a.writeKeyframe(0, SNAP);
  a.finish();   // clears the claim
  a.close();
  const b = openRunWriter(p, { seed: 1, config: {} }, { resume: true });   // must NOT throw
  assert.ok(b.token, 'new writer owns the db after finish()');
  b.close();
  rmSync(join(p, '..'), { recursive: true, force: true });
});

test('a reclaimed writer self-fences: its next commit throws FENCED (no two divergent writers)', async () => {
  const { openRunWriter } = await load();
  const p = tmp();
  const a = openRunWriter(p, { seed: 1, config: {} }, { resume: false });
  a.writeKeyframe(0, SNAP);
  const tokA = a.token;
  // B force-reclaims (simulates a reclaim after A was wrongly presumed stale)
  const b = openRunWriter(p, { seed: 1, config: {}, forceClaim: true }, { resume: true });
  assert.notEqual(b.token, tokA, 'reclaimer has a new token');
  // A's next commit must detect the token change and abort BEFORE writing under B's ownership
  assert.throws(() => a.writeKeyframe(1, SNAP), (e) => e.code === 'FENCED', 'reclaimed writer must throw FENCED');
  assert.throws(() => a.beat(), (e) => e.code === 'FENCED', 'reclaimed writer beat must also fence');
  b.close(); a.close();
  rmSync(join(p, '..'), { recursive: true, force: true });
});

test('readWriterInfo / clearWriterClaim: stop-path can read the pid and release ownership', async () => {
  const { openRunWriter, readWriterInfo, clearWriterClaim } = await load();
  const p = tmp();
  const a = openRunWriter(p, { seed: 1, config: {} }, { resume: false });
  a.writeKeyframe(0, SNAP);
  const info = readWriterInfo(p);
  assert.equal(info.pid, process.pid, 'records the writer pid');
  assert.ok(info.heartbeat > 0, 'has a fresh heartbeat');
  a.close();
  clearWriterClaim(p);
  assert.equal(readWriterInfo(p).heartbeat, 0, 'clearWriterClaim makes it reclaimable');
  // a fresh writer can now claim without force
  const b = openRunWriter(p, { seed: 1, config: {} }, { resume: true });
  assert.ok(b.token); b.close();
  rmSync(join(p, '..'), { recursive: true, force: true });
});
