'use strict';
// P1a A/B golden — freezes the OLD engine's construct+tick behavior as the bit-exact target the fresh
// engine/ must reproduce when it kills the slots (PLAN-restructure.md §17, §19). The committed fixture
// records the constructed initial state, a canonical per-tick hash for 1000 ticks, and the ABA events
// (births into an alive-then-dead id -- the exact death-node hazard P1a removes).
//
// Two layers, matching the determinism-baseline golden convention (test/sim/golden.test.js):
//   - ALWAYS-ON: fixture integrity + ABA coverage. No sim boot -- instant, portable. Proves the frozen
//     artifact is well-formed and genuinely exercises the slot-reuse hazard.
//   - GP_SLOW: regenerate live and compare. Portable scalars/ABA always; the exact per-tick hashes are
//     SINGLE-ENGINE (float last-bit + chaos), so they are asserted only when the running Node build
//     matches the one the golden was cut on -- otherwise scalars-only + warn. Regenerate deliberately:
//     node test/tools/gen-p1a-golden.js
//
// The old engine's own determinism (same seed -> identical state) is already covered by smoke.test.js;
// this file does not re-prove it. When the fresh engine exists, its A/B runs OLD-vs-NEW in one process
// (same engine), so that comparison is node-independent -- this fixture is the standalone regression guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { captureRun, hashSnapshot, SEED, TICKS, goldenPath } = require('../helpers/p1a-golden');

const GOLDEN = goldenPath();
const haveGolden = fs.existsSync(GOLDEN);
const golden = haveGolden ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : null;

test('P1a golden: the committed fixture is well-formed and covers the ABA slot-reuse hazard', () => {
    assert.ok(haveGolden, `no committed P1a golden (run test/tools/gen-p1a-golden.js) at ${GOLDEN}`);
    assert.equal(golden.seed, SEED, 'fixture seed drifted');
    assert.equal(golden.ticks, TICKS, 'fixture tick count drifted');
    assert.equal(golden.tickHashes.length, TICKS, 'tickHashes length must equal ticks');

    // finalHash is the last tick's hash by construction -- a self-consistency anchor.
    assert.equal(golden.finalHash, golden.tickHashes[TICKS - 1], 'finalHash must equal the last tick hash');
    // the committed initial snapshot must hash to the recorded initialHash.
    assert.equal(hashSnapshot(golden.initial), golden.initialHash, 'initial snapshot does not match initialHash');

    // ABA coverage: the whole point of P1a. The run MUST contain at least one birth into an
    // alive-then-dead id, or the golden proves nothing about the slot-reuse the rewrite removes.
    const aba = golden.aba;
    assert.equal(aba.events, aba.ticks.length, 'aba.events must equal aba.ticks.length');
    assert.ok(aba.events > 0, 'the golden must exercise at least one ABA (birth into a reused dead slot)');
    for (let i = 0; i < aba.ticks.length; i++) {
        assert.ok(aba.ticks[i] >= 1 && aba.ticks[i] <= TICKS, `aba tick ${aba.ticks[i]} out of range`);
        if (i > 0) assert.ok(aba.ticks[i] > aba.ticks[i - 1], 'aba.ticks must be strictly increasing');
    }
    assert.ok(aba.deaths > 0, 'the golden must exercise deaths (a precondition of slot reuse)');
    // Population identity (a real self-consistency invariant, not a tautology): every net change to the
    // living population is a birth (ABA-reuse or append) or a death.
    assert.equal(
        golden.initial.swimbots.length + aba.events + aba.appendBirths - aba.deaths,
        golden.scalars.population,
        'population identity broken: initial + births - deaths != final population',
    );

    // the injectable initial state must be a plausible constructed pool.
    assert.ok(golden.initial.swimbots.length > 0, 'initial pool must have swimbots');
    assert.ok(golden.initial.food.length > 0, 'initial pool must have food');
    assert.ok(golden.initial.config && typeof golden.initial.config.numFoodTypes === 'number', 'initial config missing');
});

const SLOW = !!process.env.GP_SLOW;
const slowSkip = !SLOW ? 'set GP_SLOW=1 to regenerate the P1a run and compare'
    : (!haveGolden ? 'no committed P1a golden (run test/tools/gen-p1a-golden.js)' : false);

test('P1a golden: a live regeneration reproduces the committed baseline', { skip: slowSkip }, () => {
    const run = captureRun(SEED, TICKS);

    // PORTABLE layer -- structural invariants true of ANY Node build's own run (not fixed values). The
    // sim is chaotic and uses sqrt/sin/cos, so exact counts and the ABA tick LIST are float-last-bit
    // sensitive across builds; only the invariants below are safe to assert cross-Node.
    assert.ok(run.aba.events > 0, 'the run must exercise at least one ABA slot-reuse');
    assert.ok(run.aba.deaths > 0, 'the run must exercise deaths');
    assert.equal(run.aba.events, run.aba.ticks.length, 'aba.events must equal aba.ticks.length');
    assert.equal(
        run.initial.swimbots.length + run.aba.events + run.aba.appendBirths - run.aba.deaths,
        run.scalars.population,
        'population identity broken in the live run',
    );

    // SINGLE-ENGINE layer: exact values (scalars, the ABA tick list, and every per-tick hash) only
    // reproduce on the Node build the golden was cut on. Assert them ONLY when the build matches; on a
    // different build, float last-bits can legitimately shift the whole chaotic trajectory.
    if (run.node === golden.node) {
        assert.deepEqual(run.scalars, golden.scalars, 'reduced scalars drifted from the P1a golden');
        assert.deepEqual(run.aba, golden.aba, 'ABA event profile drifted from the P1a golden');
        assert.equal(hashSnapshot(run.initial), golden.initialHash, 'initial state hash drifted');
        // Compare tick-by-tick and report the FIRST divergent tick (pinpoints a drift precisely).
        let firstDiff = -1;
        for (let t = 0; t < TICKS; t++) {
            if (run.tickHashes[t] !== golden.tickHashes[t]) { firstDiff = t + 1; break; }
        }
        assert.equal(firstDiff, -1, firstDiff === -1 ? '' : `state diverged from the golden at tick ${firstDiff}`);
        assert.equal(hashSnapshot(run.final), golden.finalHash, 'final state hash drifted');
    } else {
        console.warn(`P1a golden cut on Node ${golden.node}, running ${run.node} -- checked portable invariants only (exact values are single-engine)`);
    }
});
