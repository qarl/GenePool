'use strict';
// P1b validation: the World rebaselines (deletes the ABA + slot artifacts), so it is NOT validated by an
// old-engine byte-A/B (that proof was P1a, git 0cd88a8). Instead (PLAN-restructure.md §17):
//   - DETERMINISM: same initial state + same seed -> identical run (twice).
//   - INVARIANTS: ids unique, monotonic + NEVER REUSED, energies finite/non-negative, counts consistent.
//   - NO-ABA (the whole point): every id, once it leaves the collection, never returns for a DIFFERENT
//     individual -- provable now, where P1a could only preserve the bug.
//   - SANITY: over a real 500-swimbot run, births + deaths + food regeneration all occur and the
//     population survives.
// A realistic initial pool is taken from JJ's construction (Option B); the World then ticks under its own
// injected seed (P1b-i keeps the global-stream rng; P1b-ii swaps in the addressed rng).

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
// hands out a live buffer JJ clobbers in place).
function initialState() {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const obstacle = [pd.obstacleEnd1X, pd.obstacleEnd1Y, pd.obstacleEnd2X, pd.obstacleEnd2Y];
    const swimbots = pd.swimbotArray.map((s) => ({
        id: s.id, age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes),
        numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
    }));
    const food = pd.foodBitArray.map((f) => ({ id: f.id, x: f.x, y: f.y, type: f.type }));
    return { obstacle, swimbots, food };
}

function makeWorld(init, seed) {
    const world = new World(CONFIG, seed); // masterSeed is a non-negative integer (addressed rng)
    for (const s of init.swimbots) world.loadSwimbot(s.id, s);
    for (const f of init.food) world.loadFood(f.id, { x: f.x, y: f.y, type: f.type, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: init.obstacle[0], y: init.obstacle[1] }, { x: init.obstacle[2], y: init.obstacle[3] });
    return world;
}

// Assert the structural invariants against a World's live entities, tracking id history across ticks.
function makeInvariantChecker() {
    const swimbotIdsEverLive = new Set(); // ids seen alive at any tick
    const swimbotIdsGone = new Set();      // ids that were live then left the collection
    let lastNextSwimbotId = 0;
    let lastNextFoodId = 0;

    return function check(world, tick) {
        // never-reused id counters only advance
        assert.ok(world.getNextSwimbotId() >= lastNextSwimbotId, `tick ${tick}: nextSwimbotId went backwards`);
        assert.ok(world.getNextFoodId() >= lastNextFoodId, `tick ${tick}: nextFoodId went backwards`);
        lastNextSwimbotId = world.getNextSwimbotId();
        lastNextFoodId = world.getNextFoodId();

        const live = new Set();
        for (const s of world.dumpSwimbots()) {
            assert.ok(!live.has(s.id), `tick ${tick}: duplicate swimbot id ${s.id}`);
            live.add(s.id);
            assert.ok(s.id < world.getNextSwimbotId(), `tick ${tick}: id ${s.id} >= nextSwimbotId`);
            assert.ok(Number.isFinite(s.energy) && s.energy >= 0, `tick ${tick}: swimbot ${s.id} energy=${s.energy}`);
            assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `tick ${tick}: swimbot ${s.id} non-finite position`);
            // NO-ABA: an id that once left the collection must NEVER reappear (it would be a different
            // individual reusing the id).
            assert.ok(!swimbotIdsGone.has(s.id), `tick ${tick}: id ${s.id} REUSED after leaving (ABA!)`);
            swimbotIdsEverLive.add(s.id);
        }
        // record ids that left this tick
        for (const id of swimbotIdsEverLive) {
            if (!live.has(id)) swimbotIdsGone.add(id);
        }
        // food ids likewise unique + bounded
        const liveFood = new Set();
        for (const f of world.dumpFood()) {
            assert.ok(!liveFood.has(f.id), `tick ${tick}: duplicate food id ${f.id}`);
            liveFood.add(f.id);
            assert.ok(f.id < world.getNextFoodId(), `tick ${tick}: food id ${f.id} >= nextFoodId`);
        }
    };
}

test('P1b determinism: same initial state + same seed reproduces the run bit-for-bit', () => {
    const init = initialState();
    const runHashes = (seed) => {
        const world = makeWorld(init, seed);
        const hashes = new Array(200);
        for (let t = 0; t < 200; t++) { world.tick(); hashes[t] = hashEntities(world.dumpSwimbots(), world.dumpFood()); }
        assert.ok(world.getLivingSwimbotCount() > 0, `seed ${seed} went extinct -- hashes would be trivially equal`);
        return hashes;
    };
    const a = runHashes(9);
    const b = runHashes(9);
    for (let t = 0; t < a.length; t++) assert.equal(b[t], a[t], `determinism broke at tick ${t + 1}`);
    // a different seed must diverge -- compared at a MID-RUN (populated) tick, not the final one (which
    // could false-match if both runs went extinct and hash the empty set).
    const c = runHashes(10);
    assert.notEqual(c[99], a[99], 'different seed produced an identical run at tick 100');
});

test('P1b invariants hold every tick (uniqueness, never-reused ids, no-ABA, finite energy)', () => {
    const init = initialState();
    const world = makeWorld(init, 7);
    const check = makeInvariantChecker();
    for (let t = 1; t <= TICKS; t++) { world.tick(); check(world, t); }
    assert.ok(world.getLivingSwimbotCount() > 0, 'population went extinct');
});

test('P1b no-ABA BEHAVIOR: a chosenMate/food that died-and-was-swept yields no phantom birth/eat', () => {
    // The invariant test proves ids are never reused (the ABA precondition). This exercises the actual
    // fixed BEHAVIOR: a stale chosenMate/chosenFood reference to a dead/swept entity must produce nothing.
    // (White-box: reach into the World's collection + swimbot fields to force the dangerous state.)
    const init = initialState();
    const world = makeWorld(init, 5);

    // (a) mate SWEPT: B dies and is removed; A still "remembers" id 1 and is trying to mate.
    const A = world._swimbots.get(0);
    world._swimbots.get(1).die();
    world._sweepDead();
    assert.equal(world._swimbots.get(1), undefined, 'B should be swept from the collection');
    A._chosenMateIndex = 1;   // stale reference to the swept id
    A._tryingToMate = true;
    let nextId = world.getNextSwimbotId();
    let offspring = A.getNumOffspring();
    world._handleBirth(A);
    assert.equal(world.getNextSwimbotId(), nextId, 'a SWEPT mate must mint no newborn id');
    assert.equal(A.getNumOffspring(), offspring, 'a SWEPT mate must record no offspring');

    // (b) mate DEAD-but-present (died this tick, not yet swept): C references a dead D.
    const C = world._swimbots.get(2);
    world._swimbots.get(3)._alive = false; // dead, still in the Map
    C._chosenMateIndex = 3;
    C._tryingToMate = true;
    nextId = world.getNextSwimbotId();
    world._handleBirth(C);
    assert.equal(world.getNextSwimbotId(), nextId, 'a DEAD (present) mate must mint no newborn id');

    // (c) chosen food DEAD -> no eat (the pursuer steers at the corpse but gains nothing).
    const E = world._swimbots.get(4);
    E._chosenFoodBit = { getAlive: () => false, getPosition: () => ({ x: 0, y: 0 }), getEnergy: () => 50, getType: () => 0, kill() {} };
    E._chosenFoodBitIndex = 999;
    E._tryingToEat = true;
    const energyBefore = E.getEnergy();
    const eatenBefore = E.getNumFoodBitsEaten();
    E.eatChosenFoodBit();
    assert.equal(E.getEnergy(), energyBefore, 'a DEAD chosen food must not be eaten (no energy gain)');
    assert.equal(E.getNumFoodBitsEaten(), eatenBefore, 'a DEAD chosen food must not raise the eaten count');
});

test('P1b-ii addressed rng: the mate-pref draw is ORDER-INDEPENDENT (MATE_PREF is pairwise-addressed)', () => {
    // The point of MATE_PREF(looker, candidate, tick): the mate-pref draw is a pure function of WHO judges
    // WHOM and WHEN -- unaffected by how many other pairs were evaluated first. Under the old single global
    // stream, intervening draws would shift it. ATTRACTION_RANDOM makes getAttractiveness RETURN that draw.
    const init = initialState();
    const world = makeWorld(init, 4);
    const A = world._swimbots.get(0);
    const B = world._swimbots.get(1);
    const C = world._swimbots.get(2);
    B.setAttraction(16); C.setAttraction(16); // ATTRACTION_RANDOM
    const tick = 123;
    const bFirst = B.getAttractiveness(A, tick);
    // a flurry of OTHER pairings in between (a shared counter would advance; addressed draws do not)
    C.getAttractiveness(A, tick); C.getAttractiveness(B, tick); B.getAttractiveness(C, tick); C.getAttractiveness(A, 999);
    const bAgain = B.getAttractiveness(A, tick);
    assert.equal(bAgain, bFirst, 'MATE_PREF(A,B,tick) must be identical regardless of intervening evaluations');
    // and it genuinely depends on the address (a different tick gives a different draw)
    assert.notEqual(B.getAttractiveness(A, tick + 1), bFirst, 'a different tick must give a different mate-pref draw');
});

test('P1b sanity: a real run has births + deaths + food regeneration, and the ABA cannot occur', () => {
    const init = initialState();
    const world = makeWorld(init, 3);
    const startSwimbotId = world.getNextSwimbotId();
    const startFoodId = world.getNextFoodId();
    let totalOffspring = 0;
    for (let t = 1; t <= TICKS; t++) world.tick();
    for (const s of world.dumpSwimbots()) totalOffspring += s.numOffspring;

    assert.ok(world.getNextSwimbotId() > startSwimbotId, 'no births occurred (no new swimbot ids minted)');
    assert.ok(world.getNextFoodId() > startFoodId, 'no food regenerated (no new food ids minted)');
    // deaths: the pool started at 500 and ids kept climbing, so the collection is churning; a bounded
    // living count below (initial + births) proves deaths swept entities out.
    const births = world.getNextSwimbotId() - startSwimbotId;
    assert.ok(world.getLivingSwimbotCount() < init.swimbots.length + births, 'no deaths occurred (nothing swept)');
    assert.ok(totalOffspring > 0, 'no swimbot recorded offspring');
});

test('P1c closest-20: perception picks the 20 CLOSEST swimbots, not the first-20-by-id (D-b)', () => {
    // 25 candidates on a line at distances 10,20,..,250 (all < view radius 300); ids assigned in REVERSE
    // of distance, so first-20-by-id would be the FARTHEST 20. Identical genome + angle 0 => genital d^2
    // == position d^2, so distance order == y order.
    const gp = boot(42);
    const genes = Array.from(gp.getPoolData().swimbotArray[0].genes); // any real genome
    const world = new World(CONFIG, 1);
    world.loadSwimbot(100, { age: 5000, x: 4000, y: 4000, angle: 0, energy: 80, genes }); // the looker
    for (let k = 0; k < 25; k++) {
        world.loadSwimbot(24 - k, { age: 5000, x: 4000, y: 4000 + 10 * (k + 1), angle: 0, energy: 80, genes });
    }
    const looker = world._swimbots.get(100);
    world._rebuildGrids(); // this drives perception directly (no tick()); tick() would have built the grid
    world._giveSwimbotNearbyEnvironmentalStimuli(looker);

    assert.equal(world._perception._numNearby, 20, 'perception must cap at the 20 closest');
    const chosenIds = new Set();
    for (let i = 0; i < world._perception._numNearby; i++) chosenIds.add(world._perception._nearbyArray[i].getIndex());
    // the 20 closest are k=0..19 (distances 10..200), whose ids are 24..5.
    for (let id = 5; id <= 24; id++) assert.ok(chosenIds.has(id), `closest-20 must include id ${id}`);
    // the 5 farthest (k=20..24, distances 210..250) have ids 4..0 and must be EXCLUDED.
    for (let id = 0; id <= 4; id++) assert.ok(!chosenIds.has(id), `farthest id ${id} must be excluded (it's id-low but distance-far)`);
});

test('P1b/P1c 2-food-type World: the 2-type food ecology runs, both types persist and regenerate', () => {
    // The most rebaselined, branch-heavy tick code (2-type census + >=cap steering + extinct-type
    // fallbacks + the preferred-type perception filter + FOOD_TYPE_OFFSET eating) is unexercised by the
    // 1-type tests. Build a 2-type World and drive it.
    const gp = boot(42);
    const pd = gp.getPoolData();
    const obstacle = [pd.obstacleEnd1X, pd.obstacleEnd1Y, pd.obstacleEnd2X, pd.obstacleEnd2Y];
    const config2 = { ...CONFIG, numFoodTypes: 2 };
    const world = new World(config2, 8);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, {
            age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes),
            numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
        });
    }
    // seed BOTH food types (alternate by id) so the census + balance logic has something to balance
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: f.id % 2, energy: config2.foodBitEnergy });
    world.setObstacle({ x: obstacle[0], y: obstacle[1] }, { x: obstacle[2], y: obstacle[3] });

    const check = makeInvariantChecker();
    const startFoodId = world.getNextFoodId();
    for (let t = 1; t <= 700; t++) { world.tick(); check(world, t); }

    // regen actually ran (new food minted) and BOTH types still exist (the ecology didn't collapse a type)
    assert.ok(world.getNextFoodId() > startFoodId, '2-type food regen never minted new food');
    let t0 = 0; let t1 = 0;
    for (const f of world.dumpFood()) { if (f.type === 0) t0++; else if (f.type === 1) t1++; }
    assert.ok(t0 > 0, 'food type 0 went extinct in the 2-type World');
    assert.ok(t1 > 0, 'food type 1 went extinct in the 2-type World');
    assert.ok(world.getLivingSwimbotCount() > 0, '2-type World population went extinct');

    // determinism holds at 2 types too
    const world2 = new World(config2, 8);
    for (const s of pd.swimbotArray) world2.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    for (const f of pd.foodBitArray) world2.loadFood(f.id, { x: f.x, y: f.y, type: f.id % 2, energy: config2.foodBitEnergy });
    world2.setObstacle({ x: obstacle[0], y: obstacle[1] }, { x: obstacle[2], y: obstacle[3] });
    for (let t = 1; t <= 700; t++) world2.tick();
    assert.equal(hashEntities(world2.dumpSwimbots(), world2.dumpFood()), hashEntities(world.dumpSwimbots(), world.dumpFood()), '2-type run is non-deterministic');
});
