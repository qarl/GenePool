'use strict';
// Bug M-clock (docs/BUGS-original-genepool.md): when a pool is (re)started or loaded, the founding
// swimbots are recorded in the family tree with `addNode( ..., _clock, ... )` BEFORE _clock is reset
// to 0. Since _clock still holds the previous run's tick count, every founder is stamped with a stale
// "future" birthTime instead of 0. The intent is clearly a fresh clock (both paths do `_clock = 0`
// right afterwards). Fix: stamp the founder addNode() calls with a literal 0 in both startSimulation()
// and setPoolData(), leaving the `_clock = 0` resets exactly where they are -- this changes only the
// founder birthTime and never perturbs `_clock`'s value elsewhere in those functions (e.g. during
// moveFoodBitsFromObstacle). Runtime births keep using the live _clock. (Elapsed clock is
// intentionally NOT persisted across a load -- a loaded pool starts its clock at 0.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

function founderBirthTimes(gp, GP) {
    const ft = gp.getFamilyTree();
    const times = [];
    for (let n = 0; n < ft.getNumNodes(); n++) {
        if (ft.getNodeParent1PoolIndex(n) === GP.NULL_INDEX &&
            ft.getNodeParent2PoolIndex(n) === GP.NULL_INDEX) {
            times.push(ft.getNodeBirthTime(n));
        }
    }
    return times;
}

test('M-clock: setPoolData stamps loaded founders with birthTime 0, not the stale clock', () => {
    const GP = loadSim();

    const gp = boot(42);
    step(gp, 300);
    const snap = JSON.parse(JSON.stringify(gp.getPoolData()));

    // Target instance with an ADVANCED clock, so a stale stamp would be non-zero.
    const gp2 = boot(7);
    step(gp2, 300);
    assert.ok(gp2.getTimeStep() > 0, 'precondition: target clock advanced before load');

    gp2.setPoolData(snap); // resets the family tree, then re-adds the loaded swimbots as founders

    const times = founderBirthTimes(gp2, GP);
    assert.ok(times.length > 0, 'expected founder nodes after load');
    for (const t of times) {
        assert.equal(t, 0, `loaded founder birthTime should be 0, got stale ${t}`);
    }
});

test('M-clock: restarting the sim stamps founders with birthTime 0, not the stale clock', () => {
    const GP = loadSim();

    const gp = boot(42);
    step(gp, 300);
    assert.ok(gp.getTimeStep() > 0, 'precondition: clock advanced before restart');

    gp.startSimulation(GP.SimulationStartMode.RANDOM); // re-founds the pool

    const times = founderBirthTimes(gp, GP);
    assert.ok(times.length > 0, 'expected founder nodes after restart');
    for (const t of times) {
        assert.equal(t, 0, `restarted founder birthTime should be 0, got stale ${t}`);
    }
});
