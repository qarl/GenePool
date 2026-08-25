'use strict';
// Bug M-scores (docs/BUGS-original-genepool.md): getPoolData() drops each swimbot's cumulative
// _numOffspring and _numFoodBitsEaten, and setPoolData() (via create()) resets them to 0. So a
// save -> load round-trip ZEROES the per-swimbot scoreboard. If the competition scores pools by
// offspring / food eaten, uploading + reloading a pool wipes exactly the numbers that decide the
// winner. Fix: serialize both counters in getPoolData() and restore them in setPoolData().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step } = require('../helpers/boot');

test('M-scores: per-swimbot offspring/food-eaten counts survive a save -> load round-trip', () => {
    const gp = boot(42);
    step(gp, 1500); // long enough that swimbots have eaten and reproduced

    const snap = gp.getPoolData();

    // Precondition: the live pool actually has non-zero scores to lose.
    assert.ok(snap.swimbotArray.some((s) => s.numFoodBitsEaten > 0),
        'getPoolData must serialize numFoodBitsEaten (expected some swimbot to have eaten)');
    assert.ok(snap.swimbotArray.some((s) => s.numOffspring > 0),
        'getPoolData must serialize numOffspring (expected some swimbot to have offspring)');

    // Round-trip into a fresh instance (different seed => proves the values come from the data,
    // not from re-simulation).
    const snapCopy = JSON.parse(JSON.stringify(snap));
    const gp2 = boot(7);
    gp2.setPoolData(snapCopy);
    const snap2 = gp2.getPoolData();

    const byId = new Map(snap2.swimbotArray.map((s) => [s.id, s]));
    for (const s of snap.swimbotArray) {
        const t = byId.get(s.id);
        assert.ok(t, `swimbot ${s.id} missing after load`);
        assert.equal(t.numOffspring, s.numOffspring, `numOffspring drifted for swimbot ${s.id}`);
        assert.equal(t.numFoodBitsEaten, s.numFoodBitsEaten, `numFoodBitsEaten drifted for swimbot ${s.id}`);
    }
});
