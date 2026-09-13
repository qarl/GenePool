'use strict';
// foodReseedWhenEmpty (opt-in divergence): JJ food only buds from LIVING food, so once the pool is eaten to zero it
// stays zero forever (an absorbing state -> guaranteed swimbot extinction). With the flag on, an empty pool reseeds
// ONE bit at a random location each regen tick, so food (and the pool) can recover. Default off = JJ-identical (the
// reseed branch is only reachable at food=0, which a faithful default run's food-from-food regen never produces).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({
    ...(await import('../../engine/world.js')),
    ...(await import('../../engine/config.js')),
});

// a tiny world with NO food loaded -> the pool starts empty (food = 0), the exact absorbing state.
const emptyWorld = (World, resolveWorldConfig, extra) => new World(resolveWorldConfig({
    pool: { left: 0, top: 0, right: 1000, bottom: 1000 },
    foodRegenerationPeriod: 10, maxFood: 100, numFoodTypes: 1, ...extra,
}), 42, {});

test('config: default off + boolean validation', async () => {
    const { resolveWorldConfig } = await load();
    assert.equal(resolveWorldConfig({}).foodReseedWhenEmpty, false);
    assert.equal(resolveWorldConfig({ foodReseedWhenEmpty: true }).foodReseedWhenEmpty, true);
    assert.throws(() => resolveWorldConfig({ foodReseedWhenEmpty: 1 }), /must be a boolean/);
});

test('OFF: an empty pool stays empty forever (JJ absorbing state)', async () => {
    const { World, resolveWorldConfig } = await load();
    const w = emptyWorld(World, resolveWorldConfig);
    assert.equal(w.getLivingFoodCount(), 0, 'starts empty');
    for (let t = 0; t < 200; t++) w.tick();
    assert.equal(w.getLivingFoodCount(), 0, 'flag off: no living food to bud from -> stays 0');
});

test('ON: an empty pool reseeds and food recovers', async () => {
    const { World, resolveWorldConfig } = await load();
    const w = emptyWorld(World, resolveWorldConfig, { foodReseedWhenEmpty: true });
    assert.equal(w.getLivingFoodCount(), 0, 'starts empty');
    for (let t = 0; t < 200; t++) w.tick();
    assert.ok(w.getLivingFoodCount() > 0, 'flag on: reseeds -> food comes back from zero');
});

test('ON: deterministic (same seed+config -> identical food recovery, positions included)', async () => {
    const { World, resolveWorldConfig } = await load();
    const run = () => { const w = emptyWorld(World, resolveWorldConfig, { foodReseedWhenEmpty: true });
        for (let t = 0; t < 200; t++) w.tick();
        // compare full food state (id + position + type + energy), not just the count -- a mis-wired rng could match counts
        return JSON.stringify(w.dumpFood()); };
    const a = run(); assert.ok(JSON.parse(a).length > 0, 'food actually recovered');
    assert.equal(a, run(), 'reseed uses the food-regen stream -> byte-identical food state');
});
