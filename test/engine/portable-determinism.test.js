'use strict';
// Cross-ENGINE / cross-ARCH determinism guard (epoch pmath-1). The canonical run's checkpoint hashes are frozen
// here; because the engine now uses only portable ops (pmath), EVERY JS engine and CPU must reproduce them. CI
// runs this file under multiple Node majors AND the app's Electron (the V8 line that once diverged) -- each
// recomputes these hashes and must match. That matrix is what makes engine-independence a TESTED invariant, not
// a hope. If these change intentionally (a new epoch), bump them in the same reviewed commit. See
// docs/PLAN-engine-portable-math.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Committed golden vector: sha256(field-walk of world.serialize()) at ticks 100/1000/4000, seed 7.
const GOLDEN = { 100: 'a663a0feb101c127', 1000: '4d0842eaba32661f', 4000: '39536da707e5b132' };

test('canonical run reproduces the committed cross-engine hash vector', async () => {
  const { canonicalHashes } = await import('./canonical-run.mjs');
  const h = canonicalHashes();
  for (const cp of Object.keys(GOLDEN)) {
    assert.equal(h[cp], GOLDEN[cp], `checkpoint t=${cp} diverged (engine v8=${process.versions.v8}) -- if intentional this is an epoch bump`);
  }
});

test('pmath is active (not passthrough) in this run', () => {
  assert.ok(!process.env.GENEPOOL_PMATH_PASSTHROUGH, 'the golden is the pmath (portable) baseline; do not run the determinism guard under passthrough');
});
