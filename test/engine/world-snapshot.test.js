'use strict';
// Parallelism S1b: config.perceptionMode='snapshot'. Every bot perceives a FROZEN tick-start view of all
// others, so the tick is ORDER-INDEPENDENT (the prerequisite for intra-tick parallelism) -- a different but
// deterministic trajectory ("consistent, not identical"), NOT bit-for-bit vs mixed-live. This file proves:
//   1. snapshot is DETERMINISTIC (same seed -> identical twice);
//   2. snapshot is ORDER-INDEPENDENT (permuting the founders' insertion order -> identical per-tick state) --
//      the core gate; if this fails the mode is not parallelizable;
//   3. snapshot is NON-DEGENERATE (sustains a living, reproducing pool; no negative energy; no assert firing);
//   4. snapshot actually DIFFERS from mixed-live (it is a real alternate trajectory, not a no-op), while
//      mixed-live stays available unchanged.
// (The full macro-tolerance consistency battery + multi-permutation/contention gates are S1d.)

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
    pool: { left: 0, top: 0, right: 2000, bottom: 2000 }, // dense pool -> vigorous mating/eating -> exercises contention
};
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const baseGenes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);
for (let k = NUM_GENES_USED; k < NUM_GENES; k++) baseGenes[k] = 0; // junk-zeroed -> founders share a species -> interbreed

const N = 200;
// Precompute the per-id founder + food data ONCE (in id order) so it can be loaded into different worlds in
// different insertion orders while keeping the same id->data mapping (the order-independence test needs this).
function makeFounders(seed) {
    const rng = mulberry32(seed);
    const founders = [];
    for (let i = 0; i < N; i++) {
        founders.push({ age: Math.floor(rng() * 10000), x: rng() * 2000, y: rng() * 2000, angle: rng() * 360 - 180, energy: 85, genes: baseGenes });
    }
    const food = [];
    for (let i = 0; i < N * 4; i++) food.push({ x: rng() * 2000, y: rng() * 2000, type: 0, energy: 50 });
    return { founders, food };
}
function loadFood(world, food) { for (let i = 0; i < food.length; i++) world.loadFood(i, food[i]); }
function loadSwimbot(world, i, d) { const g = new Genotype(); g.setGenes(d.genes); world.loadSwimbot(i, { ...d, genes: g.getGenes() }); }

function buildWorld(mode, seed, insertOrder /* 'asc' | 'desc' */) {
    const { founders, food } = makeFounders(seed);
    const world = new World({ ...CONFIG, perceptionMode: mode }, 9);
    if (insertOrder === 'desc') { for (let i = N - 1; i >= 0; i--) loadSwimbot(world, i, founders[i]); }
    else { for (let i = 0; i < N; i++) loadSwimbot(world, i, founders[i]); }
    loadFood(world, food);
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    return world;
}

// Canonical fingerprint of the world state, SORTED BY ID (so it is independent of Map/insertion order -- the
// whole point). Captures the scalar per-bot state + food set; divergence in any of them changes the hash.
function hashWorld(world) {
    const sb = world.dumpSwimbots().slice().sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.chosenMate},${s.brainState}`).join('|');
    const fd = world.dumpFood().slice().sort((a, b) => a.id - b.id)
        .map(f => `${f.id}:${f.x},${f.y},${f.type}`).join('|');
    return `${world.getClock()}#${world.getLivingSwimbotCount()}#${world.getNextSwimbotId()}#${sb}#${fd}`;
}

test('snapshot mode is deterministic (same seed -> identical trajectory twice)', () => {
    const TICKS = 400;
    const a = buildWorld('snapshot', 123, 'asc');
    const b = buildWorld('snapshot', 123, 'asc');
    for (let t = 0; t < TICKS; t++) { a.tick(); b.tick(); }
    assert.equal(hashWorld(a), hashWorld(b), 'two identical snapshot runs diverged -> non-deterministic');
    assert.ok(a.getLivingSwimbotCount() > 0, 'pool went extinct -- test is not exercising a live pool');
});

test('snapshot mode is ORDER-INDEPENDENT: permuting founder insertion order -> identical per-tick state', () => {
    const TICKS = 400;
    const asc = buildWorld('snapshot', 55, 'asc');   // founders inserted id 0..N-1
    const desc = buildWorld('snapshot', 55, 'desc');  // SAME id->data, inserted N-1..0 (reversed Map order)
    // Identical at EVERY tick, not just the end -- so a divergence can't cancel out.
    for (let t = 1; t <= TICKS; t++) {
        asc.tick(); desc.tick();
        if (hashWorld(asc) !== hashWorld(desc)) {
            assert.fail(`order-dependence at tick ${t}: reversed insertion order produced different state`);
        }
    }
    assert.ok(asc.getNextSwimbotId() > N, 'no births occurred -- the order-independence gate did not exercise birth/mate resolution');
});

test('snapshot mode is non-degenerate: sustains a reproducing pool, no negative energy', () => {
    const TICKS = 600;
    const w = buildWorld('snapshot', 7, 'asc');
    for (let t = 0; t < TICKS; t++) {
        w.tick();
        // assert.js quirks aside, a broken resolution would surface as negative energy or extinction here.
        for (const s of w.dumpSwimbots()) assert.ok(s.energy >= 0, `tick ${t}: bot ${s.id} has negative energy ${s.energy}`);
    }
    assert.ok(w.getLivingSwimbotCount() > 0, 'snapshot pool went extinct');
    assert.ok(w.getNextSwimbotId() > N, 'snapshot pool never reproduced (no births)');
});

test('snapshot is a REAL alternate trajectory: differs from mixed-live from the same seed', () => {
    const TICKS = 300;
    const live = buildWorld('mixed-live', 99, 'asc');
    const snap = buildWorld('snapshot', 99, 'asc');
    for (let t = 0; t < TICKS; t++) { live.tick(); snap.tick(); }
    assert.notEqual(hashWorld(live), hashWorld(snap), 'snapshot produced the SAME trajectory as mixed-live -- it is not actually freezing perception');
    // ...but both should be living, reproducing pools (consistency: same kind of world, different path).
    assert.ok(live.getLivingSwimbotCount() > 0 && snap.getLivingSwimbotCount() > 0, 'one of the modes went extinct');
    assert.ok(live.getNextSwimbotId() > N && snap.getNextSwimbotId() > N, 'one of the modes never reproduced');
});

test('default perceptionMode is mixed-live (absent config -> faithful default)', () => {
    const w = new World({ ...CONFIG }, 1);
    assert.equal(w._snapshotMode, false, 'default world must be mixed-live (bit-for-bit faithful path)');
});
