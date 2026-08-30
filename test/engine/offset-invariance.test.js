'use strict';
// Global-offset-invariance golden (PLAN-restructure.md §7, the "make-it-early" P1 topology commitment):
// shifting the WHOLE world -- pool bounds, every founder, every food, the obstacle -- by a constant delta must
// not change the simulation. This is the tripwire that catches any absolute-position dependency (a hardcoded
// coordinate, a position-seeded draw, a grid that keys on absolute cells in a way that leaks) BEFORE P4 (torus)
// arrives and a naive "raw subtraction on absolute positions" data model forces a costly rewrite.
//
// EXACTNESS: for an INTEGER delta the DISCRETE trajectory (the birth/death/eat event stream, ids and all) is
// bit-identical. Positions themselves are NOT bit-shifted -- float non-associativity ((root+delta)+offset !=
// (root+offset)+delta) perturbs them by ULPs -- and for a FRACTIONAL delta that perturbation eventually flips a
// distance tie and diverges the discrete stream too. That is inherent to a float sim, not an absolute-position
// bug, so this golden asserts discrete-stream identity under INTEGER shifts (the meaningful, achievable form).
//
// SCOPE: this guards against an ABSOLUTE-POSITION DEPENDENCY (a hardcoded coord, a position-seeded draw, a grid
// that leaks absolute cells). It does NOT prove §7 seam COMPLETENESS -- under flat topology a raw subtraction is
// exactly as offset-invariant as a topology call, so a missed inter-entity route would stay green here. Only a
// manual audit + a future torus test (P4) prove every inter-entity route actually goes through the seam.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const NUM_GENES = 256, USED = 112, POOL = 5000, NF = 500, NFOOD = 1500;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Run the same seeded pool shifted by (D,D) and return its discrete event stream + census. Positions are the
// only thing D touches; everything else (seed, genomes, ages, angles) is identical.
function run(D, ticks) {
    const config = {
        maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
        crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
        foodBitEnergy: 50, attractionCriterion: 10,
        pool: { left: D, top: D, right: POOL + D, bottom: POOL + D },
    };
    const events = [];
    const world = new World(config, 1, { onEvent: (e) => {
        if (e.type === 'birth') events.push(`b:${e.tick}:${e.id}:${e.parentId}:${e.mateId}`);
        else if (e.type === 'death') events.push(`d:${e.tick}:${e.id}`);
        else if (e.type === 'eat') events.push(`e:${e.tick}:${e.id}:${e.foodId}`);
    } });
    const rng = mulberry32(1 ^ 0x5eed1234);
    for (let i = 0; i < NF; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        world.loadSwimbot(i, { age: Math.floor(rng() * 40000), x: rng() * POOL + D, y: rng() * POOL + D, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < NFOOD; i++) world.loadFood(i, { x: rng() * POOL + D, y: rng() * POOL + D, type: 0, energy: 50 });
    world.setObstacle({ x: 40 + D, y: 40 + D }, { x: 80 + D, y: 40 + D });
    for (let t = 0; t < ticks; t++) world.tick();
    return { events, pop: world.getLivingSwimbotCount(), dead: world.getNumDeadSwimbots() };
}

test('shifting the whole world by an integer delta leaves the discrete trajectory identical (§7)', () => {
    const TICKS = 1500;
    const base = run(0, TICKS);
    assert.ok(base.events.length > 20, `fixture must exercise many decisions (got ${base.events.length} events)`);
    for (const D of [POOL, 100000, 500000]) { // small, big, bigger -- all within the spatial grid's coord range
        const s = run(D, TICKS);
        assert.equal(s.events.length, base.events.length, `delta=${D}: event COUNT changed -> an absolute-position dependency`);
        assert.deepEqual(s.events, base.events, `delta=${D}: discrete event stream differs -> the world is NOT offset-invariant`);
        assert.equal(s.pop, base.pop, `delta=${D}: final population differs`);
        assert.equal(s.dead, base.dead, `delta=${D}: death count differs`);
    }
});
