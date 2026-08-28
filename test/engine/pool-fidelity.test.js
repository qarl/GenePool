'use strict';
// Rung 3d of P1a: the engine/ World (the dynamic-collection pool) reproduces JJ's whole-pool tick
// BIT-FOR-BIT -- perception, the updateSwimbots loop, birth into the lowest dead slot (THE ABA), the
// junk-DNA reproduction gate, and food regeneration (PLAN-restructure.md §19). This is the payoff of
// "kill the slots": the collection swap is proven behavior-preserving against the 500-bot baseline.
//
// In-process record-then-replay A/B (like every other rung): boot the OLD engine at seed 42, capture
// its constructed state, then tick recording every gpRandom draw + a canonical per-tick ENTITY hash;
// load that state into the NEW World, tick replaying the draws, and assert identical per-tick hashes AND
// full draw consumption. Because the whole swimbot is already proven (rungs 1-2), any divergence is in
// the ORCHESTRATION, and the FIRST divergent tick is reported to pinpoint it.
//
// SINGLE-ENGINE (trig last-bits), so old + new run in the same process -- exactly the A/B. GP_SLOW runs
// the full 1000-tick baseline (which crosses the golden's ABA births at ticks 432..985); the default
// suite runs a shorter prefix that still exercises perception + food spawns + early dynamics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const SEED = 42;
// Default runs past the first ABA births (seed 42's first slot-reuse birth is at tick 432) so the
// default suite exercises the whole path incl. the ABA; GP_SLOW runs the full 1000-tick baseline.
const TICKS = process.env.GP_SLOW ? 1000 : 500;

// Config matching the OLD engine's RANDOM-mode defaults (verified: maximumLifeSpan 40000, numFoodTypes 1,
// childEnergyRatio 0.5, hungerThreshold 50, crossover 0.2, mutation 0.01, foodRegen 20, spread 4000,
// foodBitEnergy 50, attraction SIMILAR_COLOR). The obstacle endpoints are read live from the old engine.
function makeConfig(obstacle) {
    return {
        maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
        crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
        foodBitEnergy: 50, attractionCriterion: 10, obstacle,
    };
}

// Build the raw per-entity records the entity hash consumes, from the old engine. IMPORTANT: getPoolData
// returns each swimbot's genes as a LIVE buffer reference (the same object across calls), and JJ's
// create()/copyFromGenotype overwrites it IN PLACE when a birth reuses a slot -- so the captured initial
// state must COPY the genes (Array.from), or the founder genomes get clobbered by later ticks before the
// new World ever loads them.
function oldRaws(gp) {
    const pd = gp.getPoolData();
    const swimbots = pd.swimbotArray.map((s) => ({
        id: s.id, x: s.x, y: s.y, angle: s.angle, energy: s.energy, age: s.age, genes: Array.from(s.genes),
        numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
        chosenMate: gp.getSwimbotChosenMate(s.id), brainState: gp.getSwimbotBrainState(s.id),
    }));
    const food = pd.foodBitArray.map((f) => ({ id: f.id, x: f.x, y: f.y, type: f.type }));
    return { swimbots, food };
}

test(`rung3d: the World reproduces JJ's whole-pool tick bit-for-bit (seed ${SEED}, ${TICKS} ticks)`, () => {
    // --- OLD engine: construct, capture state, then tick recording draws + per-tick hash ---
    const gp = boot(SEED);
    const pd0 = gp.getPoolData();
    const obstacle = [pd0.obstacleEnd1X, pd0.obstacleEnd1Y, pd0.obstacleEnd2X, pd0.obstacleEnd2Y];
    const config = makeConfig(obstacle);

    const init = oldRaws(gp); // constructed state (post-construction, pre-tick)

    const draws = [];
    const underlying = globalThis.gpRandom; // mulberry32(42), mid-stream (construction already consumed)
    globalThis.gpRandom = () => { const v = underlying(); draws.push(v); return v; };

    const oldHashes = new Array(TICKS);
    for (let t = 0; t < TICKS; t++) {
        gp.update();
        const r = oldRaws(gp);
        oldHashes[t] = hashEntities(r.swimbots, r.food);
    }
    globalThis.gpRandom = underlying; // stop recording

    // --- NEW World: load the captured state, tick replaying the recorded draws, per-tick hash ---
    let di = 0;
    const rng = () => {
        if (di >= draws.length) throw new Error('World drew PAST the recorded sequence (extra draw)');
        return draws[di++];
    };
    const world = new World(config, rng);
    for (const s of init.swimbots) {
        world.loadSwimbot(s.id, {
            age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: s.genes,
            numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
        });
    }
    for (const f of init.food) {
        world.loadFood(f.id, { x: f.x, y: f.y, type: f.type, energy: config.foodBitEnergy });
    }
    world.setObstacle({ x: obstacle[0], y: obstacle[1] }, { x: obstacle[2], y: obstacle[3] });

    let firstDiff = -1;
    for (let t = 0; t < TICKS; t++) {
        world.tick();
        const newHash = hashEntities(world.dumpSwimbots(), world.dumpFood());
        if (newHash !== oldHashes[t] && firstDiff === -1) { firstDiff = t + 1; break; }
    }

    assert.equal(firstDiff, -1, firstDiff === -1 ? '' : `World diverged from JJ at tick ${firstDiff}`);
    assert.equal(di, draws.length, `World consumed ${di} draws but JJ drew ${draws.length} (draw-order drift)`);
});
