'use strict';
// P2 validation (PLAN-restructure.md §19): the spatial grid is a BEHAVIOR-PRESERVING optimization of the
// O(n^2) perception scans. The proof is an in-process A/B: from ONE seeded initial pool, run the SAME World
// twice under the SAME masterSeed -- once brute-force (useSpatialGrid:false), once grid (:true) -- and
// assert IDENTICAL per-tick entity hashes for the whole run. Same process, same float ops, so any
// divergence is a real behavior change, caught at the FIRST tick it appears (the most diagnostic point).
//
// This is the grid analogue of the P1a byte-A/B: spatial-grid.test.js proves grid+filter == brute-force as
// a SET on adversarial fixtures; this proves the whole ecology (perception -> mate/food choice -> births,
// deaths, regen) is bit-identical over a long run, including the branch-heavy 2-food-type path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};

const TICKS = process.env.GP_SLOW ? 2000 : 700;

// A realistic constructed pool (Option B) from JJ's seed-42 RANDOM start. genes are COPIED (getPoolData
// hands out a live buffer JJ clobbers in place). foodType(f) lets a caller split food across two types.
function initialState(foodType = () => 0) {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const obstacle = [pd.obstacleEnd1X, pd.obstacleEnd1Y, pd.obstacleEnd2X, pd.obstacleEnd2Y];
    const swimbots = pd.swimbotArray.map((s) => ({
        id: s.id, age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes),
        numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
    }));
    const food = pd.foodBitArray.map((f) => ({ id: f.id, x: f.x, y: f.y, type: foodType(f) }));
    return { obstacle, swimbots, food };
}

function makeWorld(init, config, seed, useSpatialGrid) {
    const world = new World(config, seed, { useSpatialGrid });
    for (const s of init.swimbots) world.loadSwimbot(s.id, s);
    for (const f of init.food) world.loadFood(f.id, { x: f.x, y: f.y, type: f.type, energy: config.foodBitEnergy });
    world.setObstacle({ x: init.obstacle[0], y: init.obstacle[1] }, { x: init.obstacle[2], y: init.obstacle[3] });
    return world;
}

// Run brute-force and grid Worlds in lockstep; assert identical hashes at EVERY tick.
function assertGridEqualsBruteForce(init, config, seed) {
    const brute = makeWorld(init, config, seed, false);
    const grid = makeWorld(init, config, seed, true);
    for (let t = 1; t <= TICKS; t++) {
        brute.tick();
        grid.tick();
        const hb = hashEntities(brute.dumpSwimbots(), brute.dumpFood());
        const hg = hashEntities(grid.dumpSwimbots(), grid.dumpFood());
        assert.equal(hg, hb, `grid diverged from brute-force at tick ${t} (seed ${seed})`);
    }
    // Guard against a trivially-equal (extinct) pass: SOMETHING must still be alive and the run must have
    // actually evolved (births/deaths), or "identical" would be meaningless.
    assert.ok(brute.getLivingSwimbotCount() > 0, `seed ${seed}: population went extinct -- A/B is trivial`);
    assert.ok(brute.getNextSwimbotId() > init.swimbots.length, `seed ${seed}: no births occurred -- A/B is weak`);
    // ...and DEATHS occurred, so the grid's remove-on-sweep path was actually exercised (not just insert/move).
    assert.ok(brute.getNumDeadSwimbots() > 0, `seed ${seed}: no deaths occurred -- grid remove path uncovered`);
    return { brute, grid };
}

test('P2 A/B: grid == brute-force tick-for-tick over a full 1-food-type run', () => {
    const init = initialState();
    assertGridEqualsBruteForce(init, CONFIG, 7);
});

test('P2 A/B: grid == brute-force across multiple seeds (independent ecologies)', () => {
    const init = initialState();
    for (const seed of [9, 10, 23]) assertGridEqualsBruteForce(init, CONFIG, seed);
});

test('P2 A/B: grid == brute-force over the branch-heavy 2-food-type run', () => {
    // 2 types is the most rebaselined tick path (census + steering + extinct-type fallback + the preferred-
    // type PERCEPTION FILTER, which the grid must honor identically). Split food across types by id.
    const init = initialState((f) => f.id % 2);
    const config2 = { ...CONFIG, numFoodTypes: 2 };
    const { grid } = assertGridEqualsBruteForce(init, config2, 8);
    // sanity: both food types survived the run (the 2-type ecology genuinely exercised, not collapsed)
    let t0 = 0, t1 = 0;
    for (const f of grid.dumpFood()) { if (f.type === 0) t0++; else t1++; }
    assert.ok(t0 > 0 && t1 > 0, 'a food type went extinct -- the 2-type path was under-exercised');
});
