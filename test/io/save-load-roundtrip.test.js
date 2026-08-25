'use strict';
// Save/load contract: getPoolData() -> setPoolData() -> getPoolData() must round-trip every emitted
// field (a load with no stepping in between reproduces the snapshot exactly). This pins the whole
// serialization surface the competition's pool upload/download will depend on -- broader than the
// per-bug tests (M-scores/M-lossy/M-clock), which each pin one field. Loading into a DIFFERENT-seed
// instance proves the reloaded state comes from the data, not residual state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step } = require('../helpers/boot');

const clone = (o) => JSON.parse(JSON.stringify(o));

test('save/load: a full getPoolData round-trips field-for-field (no stepping between)', () => {
    const gp = boot(42);
    step(gp, 1500); // a lived-in pool: deaths AND births (nonzero numOffspring), varied energy/age

    const snap1 = clone(gp.getPoolData());

    const gp2 = boot(7);              // different seed / fresh instance
    gp2.setPoolData(clone(snap1));
    const snap2 = clone(gp2.getPoolData());

    // _clock is intentionally reset to 0 on load (see M-clock), and camera is restored verbatim by
    // setPoolData, so getPoolData()==getPoolData() should hold across EVERY emitted field here.
    assert.deepEqual(snap2, snap1);
});

test('save/load: reloading is idempotent (load the same snapshot twice -> identical)', () => {
    const gp = boot(123);
    step(gp, 150);
    const snap = clone(gp.getPoolData());

    const a = boot(1); a.setPoolData(clone(snap));
    const b = boot(2); b.setPoolData(clone(snap));
    assert.deepEqual(clone(a.getPoolData()), clone(b.getPoolData()));
});
