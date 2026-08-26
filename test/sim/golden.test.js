'use strict';
// Determinism-baseline (golden) check: re-derive the seed-42 / 2000-tick signature and compare it to
// the committed golden. Catches ANY behaviour drift (even a refactor that preserves the invariants).
//
// GATED behind GP_SLOW: the hash is SINGLE-ENGINE (float last-bit + chaos across platforms), so it
// must NOT run in the default cross-machine `node --test` suite (it would false-fail on a different
// Node build). Run it deliberately on the pinned environment: `GP_SLOW=1 node --test ...`. If it
// drifts intentionally, regen with `node test/tools/regen-golden.js` and commit (a reviewed change).
// The portable regression layer is the invariants + the self-relative determinism smoke test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { signature, SEED, TICKS, goldenPath } = require('../helpers/golden');

const SLOW = !!process.env.GP_SLOW;
const path = goldenPath();
const haveGolden = fs.existsSync(path);
const skip = !SLOW ? 'set GP_SLOW=1 to run the single-engine golden'
    : (!haveGolden ? 'no committed golden (run test/tools/regen-golden.js)' : false);

test(`golden: seed ${SEED} / ${TICKS} ticks matches the committed determinism baseline`, { skip }, () => {
    const golden = JSON.parse(fs.readFileSync(path, 'utf8'));
    const sig = signature(SEED, TICKS);
    // Integer scalars are the more portable layer -- always checked.
    assert.deepEqual(sig.scalars, golden.scalars, 'reduced scalars drifted from the golden');
    // The exact state hash is SINGLE-ENGINE, so enforce it only on the Node build the golden was cut
    // on; on a different build it can legitimately differ by float last-bits (regen there for a pin).
    if (sig.node === golden.node) {
        assert.equal(sig.hash, golden.hash, 'state hash drifted -- if intentional, regen with test/tools/regen-golden.js');
    } else {
        console.warn(`golden cut on Node ${golden.node}, running ${sig.node} -- checked scalars only (hash is single-engine)`);
    }
});
