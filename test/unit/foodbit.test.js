'use strict';
// Unit tests for FoodBit (GenePool/simulation/FoodBit.js) -- the food the whole energy economy runs
// on. Pure/observable; RNG-using spawn is seeded via mulberry32.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, mulberry32 } = require('../helpers/boot');

const GP = loadSim();
const DEFAULT_ENERGY = 50; // DEFAULT_FOOD_BIT_ENERGY (FoodBit.js)

test('FoodBit: initialize(f) brings it alive at slot f with default energy and type 0', () => {
    const fb = new GP.FoodBit();
    assert.equal(fb.getAlive(), false, 'a fresh FoodBit is dead (index NULL) until initialized');

    fb.initialize(7);
    assert.equal(fb.getAlive(), true);
    assert.equal(fb.getIndex(), 7);
    assert.equal(fb.getEnergy(), DEFAULT_ENERGY);
    assert.equal(fb.getType(), 0);
});

test('FoodBit: kill() marks it dead (index NULL)', () => {
    const fb = new GP.FoodBit();
    fb.initialize(3);
    assert.equal(fb.getAlive(), true);
    fb.kill();
    assert.equal(fb.getAlive(), false);
    assert.equal(fb.getIndex(), GP.NULL_INDEX);
});

test('FoodBit: setType/getType', () => {
    const fb = new GP.FoodBit();
    fb.initialize(0);
    fb.setType(1);
    assert.equal(fb.getType(), 1);
    fb.setType(0);
    assert.equal(fb.getType(), 0);
});

test('FoodBit: setEnergy accepts [0,100] and rejects out-of-range (assert fires)', () => {
    const fb = new GP.FoodBit();
    fb.initialize(0);
    fb.setEnergy(0);   assert.equal(fb.getEnergy(), 0);
    fb.setEnergy(100); assert.equal(fb.getEnergy(), 100);
    fb.setEnergy(42);  assert.equal(fb.getEnergy(), 42);
    // out of range trips the sim's assert (alert -> tagged throw in the harness)
    assert.throws(() => fb.setEnergy(150), 'energy above MAX must assert');
    assert.throws(() => fb.setEnergy(-1),  'energy below MIN must assert');
});

test('FoodBit: spawnFromParent copies energy and takes the child index/type, with a finite position', () => {
    globalThis.gpRandom = mulberry32(5);
    const parent = new GP.FoodBit();
    parent.initialize(2);
    parent.setType(1);
    parent.setEnergy(37);
    const pp = new GP.Vector2D(); pp.setXY(400, 400);
    parent.setPosition(pp);

    const child = new GP.FoodBit();
    child.spawnFromParent(parent, 9, 0);

    assert.equal(child.getAlive(), true);
    assert.equal(child.getIndex(), 9, 'child takes the given child index');
    assert.equal(child.getType(), 0, 'child takes the given child type');
    assert.equal(child.getEnergy(), 37, "child inherits the parent's energy");
    // exact spawn position depends on the child's spawn radius + the SPAWN_FOOD_RANDOMLY_IN_POOL
    // flag, so we assert only that it's finite (the sim's own pool-bounds asserts enforce the rest).
    const cp = child.getPosition();
    assert.ok(Number.isFinite(cp.x) && Number.isFinite(cp.y), 'child position must be finite');
});
