'use strict';
// Energy-injection backstop (the reliable subset of "energy conservation"). A swimbot stops eating
// once full, so its energy is naturally bounded (~100 at default config; measured max 99.99 over
// 4000 ticks x 3 seeds). The C2 bug injected energy by orders of magnitude ("30"+"50" -> "3050").
// invariants.js enforces a generous ceiling (1000) every tick; here we (1) prove that ceiling
// can-fire on an injection, and (2) confirm energy actually stays bounded over a real run.
//
// NOTE: full per-tick energy conservation (Sigma energy changes only by meals x foodBitEnergy +/-
// births/deaths) is DEFERRED with a waiver -- it needs stable swimbot IDs and per-meal/-death event
// observation the public API doesn't give, and a loose approximation would be flaky. The ceiling
// invariant is the non-flaky, high-value part (it catches the injection class the C2 bug was in).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

const GP = loadSim();
const clone = (o) => JSON.parse(JSON.stringify(o));

test('invariant: a swimbot with injected (implausibly high) energy is caught by the ceiling', () => {
    const gp = boot(42);
    step(gp, 50);
    checkInvariants(gp, GP); // clean

    const snap = clone(gp.getPoolData());
    snap.swimbotArray[0].energy = 5000; // C2-class injection; natural max is ~100
    gp.setPoolData(snap);
    assert.equal(gp.getPoolData().swimbotArray[0].energy, 5000, 'the injected energy must actually load');

    assert.throws(() => checkInvariants(gp, GP), /exceeds the ceiling/, 'implausible energy must trip the ceiling invariant');
});

test('energy stays naturally bounded over a real 1500-tick run (no injection)', () => {
    const gp = boot(42);
    let maxEnergy = 0;
    for (let t = 0; t < 1500; t++) {
        step(gp, 1);
        for (const s of gp.getPoolData().swimbotArray) if (s.energy > maxEnergy) maxEnergy = s.energy;
    }
    assert.ok(maxEnergy > 0, 'sanity: swimbots have energy');
    // ~100 at default config; a comfortable bound below the 1000 invariant ceiling. Would fail if an
    // energy-injection bug pushed any swimbot far above its natural cap during simulation.
    assert.ok(maxEnergy < 300, `swimbot energy should stay naturally bounded, max observed ${maxEnergy}`);
});
