'use strict';
// Swimbot death paths, each ISOLATED via a constructed single-swimbot pool (setPoolData), so the
// cause of death is unambiguous:
//   - OLD AGE: one swimbot at age == maximumLifeSpan with high energy, food present -> one step ages
//     it past the threshold and it dies of old age (not starvation -- energy stays high).
//   - STARVATION: one young swimbot whose energy is below a single drain tick, with NO food -> one
//     update drains it to <= 0 and it dies of starvation (not old age -- age stays far below
//     maximumLifeSpan). (Energy drains very slowly -- CONTINUAL_ENERGY_DRAIN is 0.0001 -- so we start
//     just above zero to trigger the path deterministically rather than waiting thousands of ticks.)
// These exercise Swimbot.updateBodyParts (old-age die, ~:178) and updatePhysics (starvation die,
// ~:906) -- paths a default 40000-lifespan, food-rich run rarely reaches.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step, loadSim } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

const GP = loadSim();
const clone = (o) => JSON.parse(JSON.stringify(o));

test('Swimbot: old-age death fires when age exceeds maximumLifeSpan (isolated from starvation)', () => {
    const gp = boot(42);
    gp.setMaximumSwimbotAge(5000);

    const snap = clone(gp.getPoolData());
    const one = { ...snap.swimbotArray[0], age: 5000, energy: 100 }; // at the threshold, well-fed
    gp.setPoolData({ ...snap, numSwimbots: 1, swimbotArray: [one] });
    assert.equal(gp.getNumSwimbots(), 1, 'pool holds the single test swimbot');

    const deadBefore = gp.getNumDeadSwimbots();
    step(gp, 1); // age 5000 -> 5001 > 5000 -> old-age death
    checkInvariants(gp, GP);

    assert.equal(gp.getNumSwimbots(), 0, 'the swimbot should have died of old age');
    assert.equal(gp.getNumDeadSwimbots() - deadBefore, 1, 'exactly one death recorded');
});

test('Swimbot: starvation death fires when energy runs out (isolated from old age)', () => {
    const gp = boot(42); // default maximumLifeSpan 40000 -> no old-age death in range

    const snap = clone(gp.getPoolData());
    const one = { ...snap.swimbotArray[0], age: 100, energy: 0.00005 }; // young, energy < one drain tick
    // remove all food so it CANNOT refuel -> the only possible death is starvation
    gp.setPoolData({ ...snap, numSwimbots: 1, swimbotArray: [one], numFoodBits: 0, foodBitArray: [] });
    assert.equal(gp.getNumSwimbots(), 1);

    const deadBefore = gp.getNumDeadSwimbots();
    let died = false;
    for (let t = 0; t < 10 && !died; t++) {
        step(gp, 1);
        checkInvariants(gp, GP);
        if (gp.getNumSwimbots() === 0) died = true;
    }
    assert.ok(died, 'the swimbot should have starved to death with no food');
    assert.equal(gp.getNumDeadSwimbots() - deadBefore, 1, 'exactly one death recorded');
});
