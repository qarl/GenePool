'use strict';
// Proves the two invariants added to helpers/invariants.js actually FIRE on a violation (the existing
// run tests already show they hold on valid state). Each test: confirm checkInvariants passes on a
// clean pool, inject one specific corruption, then assert checkInvariants throws with the right message.
//   - food type must be 0 or 1
//   - a family-tree node's birthTime must be within [0, now] (no birth stamped in the future)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

const GP = loadSim();
const clone = (o) => JSON.parse(JSON.stringify(o));

test('invariant: a food bit with a type outside {0,1} is caught', () => {
    const gp = boot(42);
    step(gp, 50);
    checkInvariants(gp, GP); // clean

    const snap = clone(gp.getPoolData());
    // NB: boot(42) uses default numFoodTypes==1, so getNumFoodBits() counts all alive food regardless
    // of type -> the food-COUNT invariant stays balanced and the type check (not the count) is what
    // fires. (Keep this pool 1-type; a 2-type pool would shift the counts and could preempt.)
    snap.foodBitArray[0].type = 5; // FoodBit.setType has no live range assert, so this survives the load
    gp.setPoolData(snap);
    assert.equal(gp.getPoolData().foodBitArray[0].type, 5, 'the bad type must actually be loaded');

    assert.throws(() => checkInvariants(gp, GP), /type invalid/, 'an out-of-range food type must trip the invariant');
});

test('invariant: a family node born in the future is caught', () => {
    const gp = boot(42);
    step(gp, 50);
    checkInvariants(gp, GP); // clean

    const ft = gp.getFamilyTree();
    const now = gp.getTimeStep();
    ft.addNode(0, GP.NULL_INDEX, GP.NULL_INDEX, now + 100000, new Array(GP.NUM_GENES).fill(0)); // future birth

    assert.throws(() => checkInvariants(gp, GP), /birthTime .* not in/, 'a future birthTime must trip the invariant');
});
