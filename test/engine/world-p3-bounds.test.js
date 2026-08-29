'use strict';
// P3a: arbitrary world bounds via config.pool. The engine's fixed 8000x8000 pool becomes user config -- the
// North Star (bounds are config, not an engine-imposed limit). The DEFAULT path (no config.pool) is proven
// byte-identical by every other fidelity test; this test proves NON-default bounds actually take effect:
// swimbots bounce off the NEW walls and food spawns within the NEW bounds -- not the old 8000 defaults.

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

// one real canonicalized genome, junk DNA zeroed (JJ's founder rule) so the pool interbreeds
const baseGenes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);
for (let k = NUM_GENES_USED; k < NUM_GENES; k++) baseGenes[k] = 0;

function build(pool, seed) {
    const rng = mulberry32(seed);
    const world = new World({ ...CONFIG, pool }, seed);
    const { left, top, right, bottom } = world.getPoolBounds();
    const inset = 200;
    const N = 120;
    for (let i = 0; i < N; i++) {
        const g = new Genotype(); g.setGenes(baseGenes);
        world.loadSwimbot(i, {
            age: Math.floor(rng() * 15000),
            x: left + inset + rng() * (right - left - 2 * inset),
            y: top + inset + rng() * (bottom - top - 2 * inset),
            angle: rng() * 360 - 180, energy: 80, genes: g.getGenes(),
        });
    }
    for (let i = 0; i < N * 3; i++) {
        world.loadFood(i, { x: left + rng() * (right - left), y: top + rng() * (bottom - top), type: 0, energy: 50 });
    }
    return { world, N };
}

test('P3a: getPoolBounds resolves config.pool, defaulting missing edges to the JJ 8000 pool', () => {
    const dflt = new World(CONFIG, 1).getPoolBounds();
    assert.deepEqual({ left: dflt.left, top: dflt.top, right: dflt.right, bottom: dflt.bottom }, { left: 0, top: 0, right: 8000, bottom: 8000 });
    assert.equal(dflt.margin, 80); // 8000 * 0.01, JJ's FOOD_BIT_BOUNDARY_MARGIN

    const partial = new World({ ...CONFIG, pool: { right: 3000, bottom: 12000 } }, 1).getPoolBounds();
    assert.deepEqual({ left: partial.left, top: partial.top, right: partial.right, bottom: partial.bottom }, { left: 0, top: 0, right: 3000, bottom: 12000 });
    assert.equal(partial.width, 3000);
    assert.equal(partial.height, 12000);
    assert.equal(partial.margin, 30); // scales with width
});

test('P3a: entities stay within a SMALL non-default pool (walls + food spawn honor config bounds)', () => {
    // A 3000x3000 pool -- far smaller than the 8000 default AND smaller than foodSpread(4000), so food regen
    // MUST clamp to these bounds. If bounds were ignored (still 8000), swimbots would wander toward 8000 and
    // food would spawn out to ~7920 -- both caught here.
    const pool = { left: 0, top: 0, right: 3000, bottom: 3000 };
    const { world } = build(pool, 7);
    const BODY_MARGIN = 400; // swimbot centers may sit a body-half outside the wall during a bounce

    let maxSwimX = -Infinity, maxSwimY = -Infinity, minSwimX = Infinity, minSwimY = Infinity;
    let maxFoodX = -Infinity, maxFoodY = -Infinity, minFoodX = Infinity, minFoodY = Infinity;
    for (let t = 1; t <= 500; t++) {
        world.tick();
        for (const s of world.dumpSwimbots()) {
            maxSwimX = Math.max(maxSwimX, s.x); minSwimX = Math.min(minSwimX, s.x);
            maxSwimY = Math.max(maxSwimY, s.y); minSwimY = Math.min(minSwimY, s.y);
        }
        for (const f of world.dumpFood()) {
            maxFoodX = Math.max(maxFoodX, f.x); minFoodX = Math.min(minFoodX, f.x);
            maxFoodY = Math.max(maxFoodY, f.y); minFoodY = Math.min(minFoodY, f.y);
        }
    }
    // swimbots stay near the NEW pool (crucially << the 8000 default), bounded by a body margin
    assert.ok(maxSwimX <= pool.right + BODY_MARGIN, `swimbot escaped right wall: maxX=${maxSwimX}`);
    assert.ok(maxSwimY <= pool.bottom + BODY_MARGIN, `swimbot escaped bottom wall: maxY=${maxSwimY}`);
    assert.ok(minSwimX >= pool.left - BODY_MARGIN, `swimbot escaped left wall: minX=${minSwimX}`);
    assert.ok(minSwimY >= pool.top - BODY_MARGIN, `swimbot escaped top wall: minY=${minSwimY}`);
    // food spawns strictly inside the NEW bounds (spawn clamp uses config bounds, not the 8000 default)
    assert.ok(maxFoodX <= pool.right && maxFoodY <= pool.bottom, `food spawned past far wall: (${maxFoodX},${maxFoodY})`);
    assert.ok(minFoodX >= pool.left && minFoodY >= pool.top, `food spawned before near wall: (${minFoodX},${minFoodY})`);
    // and the ecology actually ran in the new-shaped pool
    assert.ok(world.getLivingSwimbotCount() > 0, 'population went extinct');
    assert.ok(world.getNextSwimbotId() > 120, 'no births occurred in the resized pool');
});

test('P3a: a resized pool is deterministic (same bounds + seed -> identical run)', () => {
    const pool = { left: -2000, top: 1000, right: 6000, bottom: 9000 }; // offset + rectangular
    const runHashes = () => {
        const { world } = build(pool, 3);
        const h = [];
        for (let t = 0; t < 150; t++) { world.tick(); h.push(`${world.getLivingSwimbotCount()}:${world.getLivingFoodCount()}:${world.getNextSwimbotId()}`); }
        assert.ok(world.getLivingSwimbotCount() > 0, 'offset pool went extinct');
        return h.join('|');
    };
    assert.equal(runHashes(), runHashes(), 'resized-pool run is non-deterministic');
});
