'use strict';
// Guards the O(1) incremental living-counts (getLivingSwimbotCount/getLivingFoodCount) added with the
// targeted dead-list sweep. A SYSTEMATIC counter drift is deterministic, so determinism/golden tests would
// NOT catch it -- this cross-checks the counters against GROUND TRUTH (dumpSwimbots/dumpFood return only
// living entities, so their length is the true living count) after EVERY tick. A DENSE clustered pool is
// used so multiple swimbots target the same food bit in one tick (the two-bots-one-food dedup path that the
// eaten-id Set + has()-guarded decrement must handle without double-counting).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const NUM_GENES = 256, NUM_GENES_USED = 112;
const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const baseGenes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);
for (let k = NUM_GENES_USED; k < NUM_GENES; k++) baseGenes[k] = 0; // junk-zeroed -> founders interbreed

function assertCountsMatchGroundTruth(world, ticks, label) {
    let sawDeath = false, sawFoodConsumed = false;
    let prevFood = world.getLivingFoodCount();
    for (let t = 1; t <= ticks; t++) {
        const deadBefore = world.getNumDeadSwimbots();
        world.tick();
        // ground truth: dump* return ONLY living entities
        assert.equal(world.getLivingSwimbotCount(), world.dumpSwimbots().length,
            `${label} tick ${t}: swimbot count ${world.getLivingSwimbotCount()} != ground truth ${world.dumpSwimbots().length}`);
        assert.equal(world.getLivingFoodCount(), world.dumpFood().length,
            `${label} tick ${t}: food count ${world.getLivingFoodCount()} != ground truth ${world.dumpFood().length}`);
        if (world.getNumDeadSwimbots() > deadBefore) sawDeath = true;
        const f = world.getLivingFoodCount();
        if (f < prevFood) sawFoodConsumed = true;
        prevFood = f;
    }
    return { sawDeath, sawFoodConsumed };
}

test('live counts match ground truth every tick — dense cluster (two-bots-one-food path)', () => {
    // pack many swimbots + food into a small region so multiple bots pursue/eat the same food in a tick
    const rng = mulberry32(99);
    const world = new World({ ...CONFIG, pool: { left: 0, top: 0, right: 1200, bottom: 1200 } }, 5);
    const N = 120;
    for (let i = 0; i < N; i++) {
        const g = new Genotype(); g.setGenes(baseGenes);
        world.loadSwimbot(i, { age: Math.floor(rng() * 8000), x: 200 + rng() * 800, y: 200 + rng() * 800, angle: rng() * 360 - 180, energy: 70, genes: g.getGenes() });
    }
    for (let i = 0; i < N * 2; i++) world.loadFood(i, { x: 200 + rng() * 800, y: 200 + rng() * 800, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });

    const { sawFoodConsumed } = assertCountsMatchGroundTruth(world, 500, 'cluster');
    assert.ok(world.getLivingSwimbotCount() > 0, 'cluster went extinct');
    assert.ok(sawFoodConsumed, 'no food was ever consumed -- the eaten-food count path was not exercised');
});

test('live counts match ground truth every tick — realistic seed-42 pool (births + deaths)', () => {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const world = new World(CONFIG, 7);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });

    const startId = world.getNextSwimbotId();
    const { sawDeath } = assertCountsMatchGroundTruth(world, 700, 'seed42');
    assert.ok(world.getLivingSwimbotCount() > 0, 'seed42 pool went extinct');
    assert.ok(world.getNextSwimbotId() > startId, 'no births occurred');
    assert.ok(sawDeath, 'no deaths occurred -- the onDeath count path was not exercised');
});
