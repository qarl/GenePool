'use strict';
// L5: opt-in carrying-capacity knob config.maxPopulation. Default (absent) = no cap -> births never
// suppressed -> byte-identical to pre-cap (the whole fidelity suite guards that). This test proves the cap
// actually BINDS: with a cap set, the living population never exceeds it; and an otherwise-identical uncapped
// run grows past the cap (so the bound is real, not vacuous). Each setting stays deterministic.

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

const N = 250;
// dense reproducing pool: many junk-zeroed founders + abundant food in a small pool -> vigorous mating
function build(extra) {
    const rng = mulberry32(77);
    const world = new World({ ...CONFIG, pool: { left: 0, top: 0, right: 2000, bottom: 2000 }, ...extra }, 9);
    for (let i = 0; i < N; i++) {
        const g = new Genotype(); g.setGenes(baseGenes);
        world.loadSwimbot(i, { age: Math.floor(rng() * 10000), x: rng() * 2000, y: rng() * 2000, angle: rng() * 360 - 180, energy: 85, genes: g.getGenes() });
    }
    for (let i = 0; i < N * 4; i++) world.loadFood(i, { x: rng() * 2000, y: rng() * 2000, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    return world;
}
function runTrackingMax(world, ticks) {
    let maxPop = world.getLivingSwimbotCount();
    for (let t = 0; t < ticks; t++) { world.tick(); maxPop = Math.max(maxPop, world.getLivingSwimbotCount()); }
    return maxPop;
}

test('carrying capacity: living population never exceeds config.maxPopulation, and the cap binds', () => {
    const CAP = N + 20; // 270
    const TICKS = 1500;

    // uncapped: population must grow PAST the cap (else the bound would be vacuous)
    const uncappedMax = runTrackingMax(build({}), TICKS);
    assert.ok(uncappedMax > CAP, `uncapped pool only reached ${uncappedMax}, not > ${CAP} -- cap can't be shown to bind (make the pool reproduce more)`);

    // capped: population must NEVER exceed the cap, at any tick
    const capped = build({ maxPopulation: CAP });
    for (let t = 1; t <= TICKS; t++) {
        capped.tick();
        assert.ok(capped.getLivingSwimbotCount() <= CAP, `tick ${t}: living pop ${capped.getLivingSwimbotCount()} exceeded cap ${CAP}`);
    }
    assert.ok(capped.getLivingSwimbotCount() > 0, 'capped pool went extinct');
});

test('carrying capacity: a capped run is deterministic', () => {
    const CAP = N + 20;
    const run = () => { const w = build({ maxPopulation: CAP }); const h = []; for (let t = 0; t < 300; t++) { w.tick(); h.push(`${w.getLivingSwimbotCount()}:${w.getNextSwimbotId()}`); } return h.join('|'); };
    assert.equal(run(), run(), 'capped run is non-deterministic');
});
