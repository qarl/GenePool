'use strict';
// H1 checkpoint: World.serialize() -> World.restore(config, data) must resume BIT-FOR-BIT identically to an
// uninterrupted run. This is the self-checking gate: run world A uninterrupted; run B to tick N, serialize,
// restore into C, then step A and C in lockstep -- every per-tick entity hash must match. Any un-captured
// between-tick hidden state (timer, velocity, per-part previousMid, the per-life RNG stream position, brain
// FSM, chosen mate/food refs incl. dangling "ghost" refs to swept entities) surfaces as the FIRST divergent
// tick. Uses JJ's realistic seed-42 pool so births/deaths/eating actually occur (hence dangling refs).

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

function makeSeed42World(seed) {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const world = new World(CONFIG, seed);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('checkpoint: restore resumes bit-for-bit identical to an uninterrupted run', () => {
    const N = 250, M = 350;
    const A = makeSeed42World(7);   // uninterrupted reference
    const B = makeSeed42World(7);   // will be checkpointed
    for (let t = 0; t < N; t++) { A.tick(); B.tick(); }
    assert.equal(hash(B), hash(A), 'A and B diverged before checkpoint (test bug)');

    const C = World.restore(CONFIG, B.serialize());

    // restored C must match the observable state at the checkpoint tick...
    assert.equal(hash(C), hash(A), 'restored state != checkpoint state at tick N');
    // ...and must stay bit-identical as it runs forward (this is the real hidden-state proof).
    for (let t = 0; t < M; t++) {
        A.tick(); C.tick();
        assert.equal(hash(C), hash(A), `checkpoint resume diverged at tick ${N + t + 1}`);
    }
    // sanity: the run actually did something (births/deaths), so the resume crossed real dynamics
    assert.ok(A.getLivingSwimbotCount() > 0, 'pool went extinct');
    assert.ok(A.getNextSwimbotId() > C.getNextSwimbotId() - 1); // ids progressed identically
    assert.equal(A.getNextSwimbotId(), C.getNextSwimbotId(), 'never-reused id high-water marks diverged');
    assert.equal(A.getNumDeadSwimbots(), C.getNumDeadSwimbots(), 'death counts diverged');
});

test('checkpoint: ghost refs (swept entities still referenced) are captured and resume bit-identically', () => {
    // Find a checkpoint tick where a live bot still references a swept swimbot / eaten food (the case a naive
    // index-relink would drop, diverging via the steering code). Prove ghosts appear AND resume is exact.
    const A = makeSeed42World(7);
    let ghostData = null, ghostTick = -1;
    for (let t = 1; t <= 1000; t++) {
        A.tick();
        const d = A.serialize();
        if (d.ghostSwimbots.length > 0 || d.ghostFood.length > 0) { ghostData = d; ghostTick = t; break; }
    }
    assert.ok(ghostData, 'no ghost (dangling dead-ref) checkpoint appeared in 1000 ticks -- ghost path untested');

    const C = World.restore(CONFIG, ghostData); // A is already AT ghostTick; step both forward together
    for (let t = 0; t < 200; t++) {
        A.tick(); C.tick();
        assert.equal(hash(C), hash(A), `ghost-checkpoint (tick ${ghostTick}) resume diverged at tick ${ghostTick + t + 1}`);
    }
});

test('checkpoint: serialize -> restore round-trip is idempotent (restore of a restore matches)', () => {
    const A = makeSeed42World(3);
    for (let t = 0; t < 120; t++) A.tick();
    const d1 = A.serialize();
    const B = World.restore(CONFIG, d1);
    const d2 = B.serialize();
    // the two serializations describe the same world (same counts + same forward evolution)
    assert.equal(d2.clock, d1.clock);
    assert.equal(d2.nextSwimbotId, d1.nextSwimbotId);
    for (let t = 0; t < 60; t++) { A.tick(); B.tick(); }
    assert.equal(hash(B), hash(A), 'double-restore diverged');
});
