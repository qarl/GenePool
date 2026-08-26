'use strict';
// The two-food-type economy (numFoodTypes==2, SPECIES mode). Exercises the food regeneration's
// per-type balancing logic (GenePool.js updateFood, ~1610-1665) that a default 1-type run never
// touches: neither type may exceed MAX_FOODBITS_PER_TYPE (1000), both types must persist (regen keeps
// at least some of each), and the per-type counts must sum to the total. Also contrasts the default
// 1-type economy. getNumFoodBits() is the type-0 count and getNumFoodBits1() the type-1 count when
// numFoodTypes==2 (getNumFoodBits() counts ALL alive food when numFoodTypes==1).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

const GP = loadSim();
const MAX_PER_TYPE = 1000; // Parameters.js MAX_FOODBITS_PER_TYPE

test('SPECIES: balanced 2-type food economy holds over a run (cap respected, both types persist)', () => {
    const gp = boot(42, GP.SimulationStartMode.SPECIES);
    assert.equal(gp.getNumFoodTypes(), 2, 'SPECIES runs with 2 food types');

    for (let t = 0; t < 300; t++) {
        step(gp, 1);
        const t0 = gp.getNumFoodBits();   // type-0 count
        const t1 = gp.getNumFoodBits1();  // type-1 count
        const total = gp.getPoolData().foodBitArray.length;
        // cap is structurally guaranteed: a dead slot means total <= 1999, so only one type can sit
        // at 1000, and regen redirects new bits away from a maxed type -> neither can exceed 1000.
        assert.ok(t0 <= MAX_PER_TYPE && t1 <= MAX_PER_TYPE, `per-type cap exceeded at tick ${t}: t0=${t0} t1=${t1}`);
        // "both persist" holds for this deterministic seed-42 run (margin observed >=927); it is NOT
        // structural -- regen only recovers a depleted type one bit per period -- so keep the fixed seed.
        assert.ok(t0 > 0 && t1 > 0, `both food types must persist at tick ${t}: t0=${t0} t1=${t1}`);
        assert.equal(t0 + t1, total, `type-0 + type-1 must equal total alive food at tick ${t}`);
    }
});

test('RANDOM (default): 1-type food economy -- no type-1 food, getNumFoodBits counts all', () => {
    const gp = boot(42); // RANDOM
    assert.equal(gp.getNumFoodTypes(), 1, 'RANDOM runs with 1 food type');
    step(gp, 50);
    assert.equal(gp.getNumFoodBits1(), 0, 'no type-1 food when numFoodTypes==1');
    assert.equal(gp.getNumFoodBits(), gp.getPoolData().foodBitArray.length,
        'with 1 food type, getNumFoodBits() counts every alive food bit');
});
