'use strict';
// Bugs M-lossy + M-foodinit (docs/BUGS-original-genepool.md): a save->load round-trip loses data.
//   - getPoolData() never serialized per-food-bit TYPE, so a 2-type SPECIES pool reloads as all
//     type-0 food. (Food ENERGY is uniform in this sim and already round-trips via the foodBitEnergy
//     tweaker, which setPoolData re-applies to every bit -- so it is NOT stored per-bit.)
//   - The global maximumLifeSpan (old-age death threshold, Swimbot.js:176) was dropped, so a loaded
//     pool reverts to the 40000 default and its swimbots live far longer than a pool tuned lower.
//   - numFoodTypes was dropped, so a 2-type pool reloads as 1-type (changes eating rules and the
//     getNumFoodBits* accounting).
//   - (M-foodinit) setPoolData() called FoodBit.initialize() with NO argument, leaving _index=undefined
//     on every loaded food bit. This rides in the same fix (initialize(id)); it has no clean public
//     symptom on its own (eating kills food by object reference, regeneration uses slot indices), so
//     it is covered structurally here rather than by a dedicated assertion.
// Fix: serialize food type + maximumLifeSpan + numFoodTypes in getPoolData(); restore them in
// setPoolData(); pass the slot id to initialize(id). getNumFoodTypes() is added so numFoodTypes is
// observable through the public API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot } = require('../helpers/boot');

test('M-lossy: per-food-bit type survives save->load (SPECIES stays 2-type, not all type-0)', () => {
    const GP = loadSim();
    const gp = boot(42, GP.SimulationStartMode.SPECIES); // numFoodTypes=2, mixed food types

    const snap = gp.getPoolData();
    // precondition: a genuine 2-type pool with serialized type
    assert.ok(snap.foodBitArray.some((f) => f.type === 1), 'getPoolData must serialize food type (expected some type-1 food in SPECIES)');
    assert.ok(snap.foodBitArray.some((f) => f.type === 0), 'expected some type-0 food in SPECIES');

    const gp2 = boot(7); // fresh RANDOM (1-type) instance
    gp2.setPoolData(JSON.parse(JSON.stringify(snap)));
    const snap2 = gp2.getPoolData();

    const byId = new Map(snap2.foodBitArray.map((f) => [f.id, f]));
    for (const f of snap.foodBitArray) {
        const t = byId.get(f.id);
        assert.ok(t, `food ${f.id} missing after load`);
        assert.equal(t.type, f.type, `food ${f.id} type not preserved`);
    }
});

test('M-lossy: maximumLifeSpan (old-age threshold) survives save->load, not reverted to 40000', () => {
    const gp = boot(42);
    gp.setMaximumSwimbotAge(20000); // non-default (default is MAX_MAXIMUM_AGE = 40000)
    const snap = gp.getPoolData();
    assert.equal(snap.maximumLifeSpan, 20000, 'getPoolData must serialize maximumLifeSpan');

    const gp2 = boot(7);
    assert.equal(gp2.getMaximumSwimbotAge(), 40000, 'sanity: a fresh pool defaults to 40000');
    gp2.setPoolData(JSON.parse(JSON.stringify(snap)));
    assert.equal(gp2.getMaximumSwimbotAge(), 20000, 'maximumLifeSpan must be restored on load');
});

test('M-lossy: numFoodTypes survives save->load', () => {
    const GP = loadSim();
    const gp = boot(42, GP.SimulationStartMode.SPECIES); // numFoodTypes=2
    const snap = gp.getPoolData();
    assert.equal(snap.numFoodTypes, 2, 'getPoolData must serialize numFoodTypes');

    const gp2 = boot(7); // fresh RANDOM => numFoodTypes=1
    assert.equal(gp2.getNumFoodTypes(), 1, 'sanity: a fresh RANDOM pool is 1-type');
    gp2.setPoolData(JSON.parse(JSON.stringify(snap)));
    assert.equal(gp2.getNumFoodTypes(), 2, 'numFoodTypes must be restored on load');
});
