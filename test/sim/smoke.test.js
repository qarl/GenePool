'use strict';
// Minimal harness smoke tests: prove we can load JJ's unmodified sim into Node,
// run it deterministically, and that its structural invariants hold over a run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step, poolDataNoCamera } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

test('loadSim loads the unmodified sim and is memoized', () => {
    const a = loadSim();
    const b = loadSim();
    assert.equal(a, b, 'loadSim should return the same memoized __GP');
    assert.equal(typeof a.GenePool, 'function');
    assert.equal(a.NUM_GENES, 256);
    assert.equal(a.MAX_SWIMBOTS, 2000);
    assert.equal(typeof a.SimulationStartMode, 'object');
});

test('boot + step 1500 ticks: invariants hold every tick, population survives', () => {
    const GP = loadSim();
    const gp = boot(42);
    const start = gp.getNumSwimbots();
    assert.ok(start > 0, 'should start with a living population');

    const TICKS = 1500;
    for (let i = 0; i < TICKS; i++) {
        gp.update();
        checkInvariants(gp, GP); // throws (stops the run) on first violation
    }
    assert.ok(gp.getNumSwimbots() > 0, `population went extinct by tick ${TICKS}`);
});

test('determinism: same seed → identical state (excluding camera); different seed differs', () => {
    // Snapshot-and-release: each GenePool retains ~680 MB, so keep only one alive at a
    // time (return the string, let the instance be collected before the next boot).
    const run = (seed) => {
        const gp = boot(seed);
        step(gp, 500);
        return JSON.stringify(poolDataNoCamera(gp));
    };
    const sa = run(42);
    const sb = run(42);
    const sc = run(43);

    assert.equal(sa, sb, 'same seed must produce byte-identical state (camera excluded)');
    assert.notEqual(sa, sc, 'different seed should produce different state');
});
