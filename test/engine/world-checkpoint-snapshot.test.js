'use strict';
// C1 -- SNAPSHOT-mode checkpoint: World.serialize() -> World.restore() must resume BIT-FOR-BIT identically to an
// uninterrupted SNAPSHOT run. Snapshot perception is a different deterministic baseline than mixed-live (every bot
// reads a frozen tick-start view), so a bot's _chosenMate is a FrozenSwimbot and a swept-but-referenced mate is a
// GHOST VIEW (index + frozen genital), not a full ghost swimbot. This gate proves the persistent-view + ghost-view
// reconstruction across restore is exact -- the prerequisite for rebuilding a live World from the parallel engine,
// which runs precisely this snapshot baseline. Mirrors world-checkpoint.test.js (mixed-live) tick-for-tick.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const BASE = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};

function makeWorld(seed, config) {
    const gp = boot(42); // JJ's realistic seed-42 pool -> births/deaths/eating actually occur (hence dangling refs)
    const pd = gp.getPoolData();
    const world = new World(config, seed);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: config.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

for (const grid of [false, true]) {
    const tag = grid ? 'grid' : 'brute';
    const CONFIG = { ...BASE, perceptionMode: 'snapshot', useSpatialGrid: grid };
    // restore is handed the SAME world config but NOT the perception mode -- it must pick that up from the checkpoint.
    const RESTORE = { ...BASE, useSpatialGrid: grid };

    test(`snapshot-checkpoint (${tag}): restore resumes bit-for-bit identical to an uninterrupted snapshot run`, () => {
        const N = 250, M = 350;
        const A = makeWorld(7, CONFIG);   // uninterrupted reference
        const B = makeWorld(7, CONFIG);   // will be checkpointed
        for (let t = 0; t < N; t++) { A.tick(); B.tick(); }
        assert.equal(hash(B), hash(A), 'A and B diverged before checkpoint (test bug)');

        const data = B.serialize();
        assert.equal(data.perceptionMode, 'snapshot', 'checkpoint did not record the snapshot baseline');

        const C = World.restore(RESTORE, data); // mode comes from the checkpoint, not the caller's config
        assert.equal(hash(C), hash(A), 'restored snapshot state != checkpoint state at tick N');
        for (let t = 0; t < M; t++) {
            A.tick(); C.tick();
            assert.equal(hash(C), hash(A), `snapshot resume diverged at tick ${N + t + 1}`);
        }
        assert.ok(A.getLivingSwimbotCount() > 0, 'pool went extinct');
        assert.equal(A.getNextSwimbotId(), C.getNextSwimbotId(), 'never-reused id high-water marks diverged');
        assert.equal(A.getNumDeadSwimbots(), C.getNumDeadSwimbots(), 'death counts diverged');
    });

    test(`snapshot-checkpoint (${tag}): ghost VIEWS (swept referenced mates) are captured and resume bit-identically`, () => {
        // Find a checkpoint tick with a live bot still referencing a swept mate (a FrozenSwimbot ghost view) or an
        // eaten food -- the case a naive relink would drop, diverging via the unguarded genital-steering deref.
        // Break ONLY on a ghost VIEW (swept referenced mate) -- NOT on ghost food, which appears far earlier (~tick 13)
        // and would leave ghostViews.length===0, silently skipping the ghost-VIEW reconstruction path this test exists
        // to cover. The first swept-mate ghost view in this pool arises around tick ~610, so the 1500 bound is ample.
        const A = makeWorld(7, CONFIG);
        let ghostData = null, ghostTick = -1;
        for (let t = 1; t <= 1500; t++) {
            A.tick();
            const d = A.serialize();
            if (d.ghostViews.length > 0) { ghostData = d; ghostTick = t; break; }
        }
        assert.ok(ghostData, 'no ghost-VIEW (dangling dead-mate ref) checkpoint appeared in 1500 ticks -- ghost-view path untested');
        assert.ok(ghostData.ghostViews.length > 0, 'expected a swept-mate ghost view to reconstruct');
        assert.equal(ghostData.ghostSwimbots.length, 0, 'snapshot mode should emit ghost VIEWS, not full ghost swimbots');

        const C = World.restore(RESTORE, ghostData); // A is already AT ghostTick; step both forward together
        for (let t = 0; t < 200; t++) {
            A.tick(); C.tick();
            assert.equal(hash(C), hash(A), `ghost-view checkpoint (tick ${ghostTick}) resume diverged at tick ${ghostTick + t + 1}`);
        }
    });
}

test('snapshot-checkpoint: serialize -> restore round-trip preserves the snapshot baseline (double restore matches)', () => {
    const CONFIG = { ...BASE, perceptionMode: 'snapshot' };
    const A = makeWorld(3, CONFIG);
    for (let t = 0; t < 120; t++) A.tick();
    const d1 = A.serialize();
    const B = World.restore(BASE, d1); // BASE has no perceptionMode -> must resume as snapshot from the checkpoint
    const d2 = B.serialize();
    assert.equal(d2.clock, d1.clock);
    assert.equal(d2.perceptionMode, 'snapshot', 'restored world dropped the snapshot baseline');
    assert.equal(d2.nextSwimbotId, d1.nextSwimbotId);
    for (let t = 0; t < 60; t++) { A.tick(); B.tick(); }
    assert.equal(hash(B), hash(A), 'double-restore diverged');
});
