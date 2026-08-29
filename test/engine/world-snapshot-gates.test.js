'use strict';
// Parallelism S1d: the HARDENED gate battery for snapshot perception mode (world-snapshot.test.js has the
// basic determinism/order-independence/non-degeneracy proofs; this file is the teeth). Three gates:
//   1. MULTI-PERMUTATION order-independence: not just reversed -- several seeded shuffles of the founders'
//      insertion order ALL produce identical per-tick state. (If snapshot were secretly order-dependent, some
//      permutation would expose it.)
//   2. CONTENTION + conservation: a DENSE pool forces many bots to compete for the same food/mate. Via the
//      event sink, prove NO food is eaten twice in a tick (no energy duplication) -- the core risk of "everyone
//      reads frozen alive=true food" -- and that order-independence still holds under heavy contention.
//   3. CONSISTENCY vs mixed-live (Karl's "consistent, not identical" bar): a macro-TOLERANCE A/B (same seed-42
//      founded pool, same technique as world-macro-fidelity). Measured divergence over 4000 ticks: time-avg pop
//      1.3%, food 0.8%, eaten 2.1%, births 16.7%. Bands are several x that -- tight enough to catch a broken
//      resolution, loose enough for the intended snapshot rebaseline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('../helpers/boot');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const NUM_GENES = 256, NUM_GENES_USED = 112;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const baseGenes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);
for (let k = NUM_GENES_USED; k < NUM_GENES; k++) baseGenes[k] = 0; // junk-zeroed founders interbreed

function hashWorld(world) {
    const sb = world.dumpSwimbots().slice().sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.chosenMate},${s.brainState}`).join('|');
    const fd = world.dumpFood().slice().sort((a, b) => a.id - b.id)
        .map(f => `${f.id}:${f.x},${f.y},${f.type}`).join('|');
    return `${world.getClock()}#${world.getLivingSwimbotCount()}#${world.getNextSwimbotId()}#${sb}#${fd}`;
}

// ---- Gate 1: multi-permutation order-independence -------------------------------------------------------
function makePool(seed, n, poolSize) {
    const rng = mulberry32(seed);
    const founders = [], food = [];
    for (let i = 0; i < n; i++) founders.push({ age: Math.floor(rng() * 10000), x: rng() * poolSize, y: rng() * poolSize, angle: rng() * 360 - 180, energy: 85, genes: baseGenes });
    for (let i = 0; i < n * 4; i++) food.push({ x: rng() * poolSize, y: rng() * poolSize, type: 0, energy: 50 });
    return { founders, food };
}
function permutation(n, seed) {
    const p = Array.from({ length: n }, (_, i) => i);
    if (seed === null) return p;                 // identity
    if (seed === 'rev') return p.reverse();      // reverse
    const rng = mulberry32(seed);                // seeded Fisher-Yates shuffle
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
}
function buildPermuted(pool, poolSize, order, options = {}) {
    const w = new World({ maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50, crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000, foodBitEnergy: 50, attractionCriterion: 10, pool: { left: 0, top: 0, right: poolSize, bottom: poolSize }, perceptionMode: 'snapshot' }, 9, options);
    for (const i of order) { const g = new Genotype(); g.setGenes(pool.founders[i].genes); w.loadSwimbot(i, { ...pool.founders[i], genes: g.getGenes() }); }
    for (let i = 0; i < pool.food.length; i++) w.loadFood(i, pool.food[i]);
    w.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    return w;
}

test('snapshot order-independence holds under MULTIPLE founder-insertion permutations', () => {
    const N = 180, SIZE = 2000, TICKS = 350;
    const pool = makePool(31, N, SIZE);
    const orders = [permutation(N, null), permutation(N, 'rev'), permutation(N, 101), permutation(N, 202), permutation(N, 303)];
    const worlds = orders.map(o => buildPermuted(pool, SIZE, o));
    for (let t = 1; t <= TICKS; t++) {
        const hashes = worlds.map(w => { w.tick(); return hashWorld(w); });
        for (let k = 1; k < hashes.length; k++) {
            if (hashes[k] !== hashes[0]) assert.fail(`permutation ${k} diverged from identity at tick ${t} -- snapshot is order-dependent`);
        }
    }
    assert.ok(worlds[0].getNextSwimbotId() > N, 'no births -- permutation gate did not exercise birth/mate resolution');
});

// ---- Gate 2: contention + no double-eat (conservation) --------------------------------------------------
test('snapshot: under dense contention NO food is eaten twice in a tick, and order-independence holds', () => {
    const N = 150, SIZE = 1200, TICKS = 400; // dense: many bots per view radius -> shared food + shared mates
    const pool = makePool(64, N, SIZE);

    // event sink records every eat; assert no (tick, foodId) pair appears twice -> no energy duplication.
    const eats = [];
    const onEvent = (e) => { if (e.type === 'eat') eats.push(`${e.tick}:${e.foodId}`); };
    const asc = buildPermuted(pool, SIZE, permutation(N, null), { onEvent });
    const desc = buildPermuted(pool, SIZE, permutation(N, 'rev')); // no sink; just for the order-independence check

    for (let t = 1; t <= TICKS; t++) {
        asc.tick(); desc.tick();
        assert.equal(hashWorld(asc), hashWorld(desc), `dense-contention order-dependence at tick ${t}`);
        for (const s of asc.dumpSwimbots()) assert.ok(s.energy >= 0, `tick ${t}: bot ${s.id} negative energy ${s.energy}`);
    }
    // no food eaten twice
    const seen = new Set();
    for (const key of eats) { assert.ok(!seen.has(key), `food eaten twice in one tick (energy duplication): ${key}`); seen.add(key); }
    assert.ok(eats.length > 0, 'no eats occurred -- contention gate did not actually exercise eating');
    assert.ok(asc.getNextSwimbotId() > N, 'no births -- contention gate did not exercise mate contention');
});

// ---- Gate 3: consistency vs mixed-live (Karl's "consistent, not identical") -----------------------------
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'jj-macro-seed42.json'), 'utf8'));
function buildFixtureWorld(mode) {
    const w = new World({ ...FIX.config, perceptionMode: mode }, FIX.seed);
    for (const s of FIX.init.swimbots) w.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(Buffer.from(s.genes, 'base64')), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    for (const f of FIX.init.food) w.loadFood(f.id, { x: f.x, y: f.y, type: f.type, energy: FIX.config.foodBitEnergy });
    w.setObstacle({ x: FIX.obstacle[0], y: FIX.obstacle[1] }, { x: FIX.obstacle[2], y: FIX.obstacle[3] });
    return w;
}
function runMacro(mode, ticks) {
    const w = buildFixtureWorld(mode);
    let popSum = 0, foodSum = 0;
    for (let t = 1; t <= ticks; t++) { w.tick(); popSum += w.getLivingSwimbotCount(); foodSum += w.getLivingFoodCount(); }
    return { avgPop: popSum / ticks, avgFood: foodSum / ticks, births: w.getNextSwimbotId() - FIX.init.swimbots.length, endPop: w.getLivingSwimbotCount() };
}

test('snapshot is CONSISTENT with mixed-live at the macro level (same seed-42 pool, tolerance bands)', () => {
    const TICKS = 4000;
    const live = runMacro('mixed-live', TICKS);
    const snap = runMacro('snapshot', TICKS);
    const rel = (base, val) => Math.abs(val - base) / base;

    // Time-averaged pop/food are phase-insensitive; measured ~1% apart -> ±15% band (~10x measured).
    assert.ok(rel(live.avgPop, snap.avgPop) <= 0.15, `avg pop diverged: mixed-live ${live.avgPop.toFixed(1)} vs snapshot ${snap.avgPop.toFixed(1)} (${(rel(live.avgPop, snap.avgPop) * 100).toFixed(1)}% > 15%)`);
    assert.ok(rel(live.avgFood, snap.avgFood) <= 0.15, `avg food diverged: mixed-live ${live.avgFood.toFixed(1)} vs snapshot ${snap.avgFood.toFixed(1)} (${(rel(live.avgFood, snap.avgFood) * 100).toFixed(1)}% > 15%)`);
    // Cumulative births is a smaller, noisier count; measured ~17% apart -> ±40% band.
    assert.ok(rel(live.births, snap.births) <= 0.40, `births diverged: mixed-live ${live.births} vs snapshot ${snap.births} (${(rel(live.births, snap.births) * 100).toFixed(1)}% > 40%)`);
    // Both are living, reproducing pools (the "same kind of world" half of consistency).
    assert.ok(snap.endPop > 0 && snap.births > 0, 'snapshot pool did not sustain/reproduce');
    assert.ok(live.endPop > 0 && live.births > 0, 'mixed-live pool did not sustain/reproduce');
});
