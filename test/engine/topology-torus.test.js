'use strict';
// P4b — toroidal SWIMBOT MOVEMENT: on a torus the body wraps across the seam as a rigid unit (updateWallCollisions
// -> _wrapToTorus) instead of bouncing off walls. (Cross-seam PERCEPTION needs grid edge-wrap -- P4c, next.)
//
// These are SMOKE + determinism + rebaseline checks. They do NOT prove rigid-shift completeness: a review showed
// the geometry self-heals in ~1 tick (parts are recomputed from _position each updateBodyParts), so even a fully
// broken shift only dents the population ~6% -- it slips past a "healthy population" gate. The actual teeth for
// the rigid shift live in topology-torus-continuity.test.js (a white-box velocity-continuity assertion).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const NUM_GENES = 256, USED = 112, POOL = 5000, NF = 500, NFOOD = 1500, TICKS = 1500;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function run(topology, seed = 1, ticks = TICKS, useGrid = true, poolSize = POOL) {
    const config = {
        maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
        crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
        foodBitEnergy: 50, attractionCriterion: 10,
        pool: { left: 0, top: 0, right: poolSize, bottom: poolSize },
    };
    if (topology) config.topology = topology;
    const events = [];
    const world = new World(config, seed, { useSpatialGrid: useGrid, onEvent: (e) => {
        if (e.type === 'birth') events.push(`b:${e.tick}:${e.id}`);
        else if (e.type === 'death') events.push(`d:${e.tick}:${e.id}`);
        else if (e.type === 'eat') events.push(`e:${e.tick}:${e.id}`);
    } });
    const rng = mulberry32(seed ^ 0x5eed1234);
    for (let i = 0; i < NF; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        world.loadSwimbot(i, { age: Math.floor(rng() * 40000), x: rng() * poolSize, y: rng() * poolSize, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < NFOOD; i++) world.loadFood(i, { x: rng() * poolSize, y: rng() * poolSize, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    for (let t = 0; t < ticks; t++) world.tick();
    return { events, world };
}

test('torus is deterministic (same seed -> identical event stream)', () => {
    const a = run('torus'), b = run('torus');
    assert.ok(a.events.length > 20, 'fixture must exercise many decisions');
    assert.deepEqual(a.events, b.events, 'a torus run must reproduce bit-for-bit on the same seed');
});

test('torus REBASELINES: its trajectory differs from walls (same seed)', () => {
    const torus = run('torus'), walls = run(undefined);
    assert.notDeepEqual(torus.events, walls.events, 'torus must actually differ from walls (no walls -> wrap, not bounce)');
});

test('torus population stays healthy + comparable to walls (smoke check only)', () => {
    // NOTE: this is a loose smoke check, NOT proof of the rigid shift (a broken shift self-heals in ~1 tick and
    // still passes this). The rigid-shift teeth are in topology-torus-continuity.test.js.
    const torus = run('torus'), walls = run(undefined);
    const tp = torus.world.getLivingSwimbotCount(), wp = walls.world.getLivingSwimbotCount();
    assert.ok(wp > 100, `sanity: walls run should be healthy (got ${wp})`);
    assert.ok(tp > 100, `torus population should be healthy (torus=${tp}, walls=${wp})`);
});

test('torus grid perception == brute-force (P4c: cross-seam neighbors are found, none doubled)', () => {
    // Small pool -> many bots sit near a seam every tick, so the grid's wrapped image-queries are heavily
    // exercised. Brute-force considers ALL entities (topology min-images the distance), so it naturally sees
    // across seams; the grid MUST return the same perceived set. A MISSED cross-seam neighbor (no image query)
    // or a DOUBLED one (overlapping images) diverges the event streams. This is the P4c equivalence proof.
    const grid = run('torus', 5, 1000, true, 1200);
    const brute = run('torus', 5, 1000, false, 1200);
    assert.ok(grid.events.length > 50, `fixture must exercise many decisions (got ${grid.events.length})`);
    assert.deepEqual(grid.events, brute.events, 'torus grid (image-queries) must equal brute-force -> cross-seam perception correct');
});

test('torus grid == brute-force on a NON-ALIGNED pool (partial last cell at the seam)', () => {
    // pool 1250 with cellSize(viewRadius) 300 -> 4.17 cells: the last column [1200,1250) is a PARTIAL cell that
    // straddles the seam. This is the real-world case (8000/300 = 26.67). Grid must still equal brute-force.
    const grid = run('torus', 9, 1000, true, 1250);
    const brute = run('torus', 9, 1000, false, 1250);
    assert.ok(grid.events.length > 50, `fixture must exercise many decisions (got ${grid.events.length})`);
    assert.deepEqual(grid.events, brute.events, 'torus grid must equal brute-force even with a partial seam cell');
});

test('torus keeps every living body in-bounds (wrap folds the reference each tick)', () => {
    const { world } = run('torus');
    let checked = 0;
    for (const sb of world._swimbots.values()) {
        if (!sb.getAlive()) continue;
        const p = sb.getPosition();
        assert.ok(p.x >= 0 && p.x < POOL && p.y >= 0 && p.y < POOL, `body out of bounds after wrap: (${p.x},${p.y})`);
        checked++;
    }
    assert.ok(checked > 100, `expected many living bodies to check (got ${checked})`);
});
