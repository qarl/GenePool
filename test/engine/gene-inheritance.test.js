'use strict';
// Per-birth gene-inheritance (PLAN-restructure.md §13): birth events must record WHICH parent contributed
// each gene (+ which genes mutated) -- provenance the genome-DAG / admixture scoring needs, and which is LOST
// after birth (the crossover mask is discarded). Capturing it must be bit-for-bit invisible to the genome
// science (the E2 oracle stays green -- checked by the full suite).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World, packMaskHex } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');
const { createSqliteSink } = require('../../tools/events/sqlite-sink.mjs');

const NUM_GENES = 256, USED = 112;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function unpackMaskHex(hex) {
    const mask = new Uint8Array(hex.length * 4);
    for (let byte = 0; byte < hex.length / 2; byte++) {
        const b = parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
        for (let bit = 0; bit < 8; bit++) mask[(byte << 3) + bit] = (b >> bit) & 1;
    }
    return mask;
}

test('setAsOffspring records correct per-gene provenance (non-mutated gene == the recorded parent)', () => {
    // parent0 and parent1 differ at EVERY gene, so a non-mutated child gene reveals which parent it came from.
    const p0 = new Genotype(), p1 = new Genotype();
    const a = new Uint8Array(NUM_GENES), b = new Uint8Array(NUM_GENES);
    for (let g = 0; g < NUM_GENES; g++) { a[g] = g % 256; b[g] = (g + 123) % 256; }
    p0.setGenes(a); p1.setGenes(b);
    const child = new Genotype();
    const prov = { parentOf: new Uint8Array(NUM_GENES), mutated: new Uint8Array(NUM_GENES) };
    child.setAsOffspring(p0, p1, mulberry32(99), { crossoverRate: 0.2, mutationRate: 0.05 }, prov);

    let sawParent0 = false, sawParent1 = false, sawMutation = false;
    for (let g = 0; g < NUM_GENES; g++) {
        assert.ok(prov.parentOf[g] === 0 || prov.parentOf[g] === 1, `parentOf[${g}] must be 0/1`);
        assert.ok(prov.mutated[g] === 0 || prov.mutated[g] === 1, `mutated[${g}] must be 0/1`);
        if (prov.parentOf[g] === 0) sawParent0 = true; else sawParent1 = true;
        if (prov.mutated[g]) { sawMutation = true; continue; } // mutated gene may differ from the source parent
        const src = prov.parentOf[g] === 0 ? p0.getGeneValue(g) : p1.getGeneValue(g);
        assert.equal(child.getGeneValue(g), src, `gene ${g}: non-mutated value must equal the recorded parent`);
    }
    assert.ok(sawParent0 && sawParent1, 'crossover should draw from BOTH parents across 256 genes');
    assert.ok(sawMutation, 'at 5% over 256 genes some genes should mutate (seed 99 fixed)');
});

test('provenance is pure bookkeeping: identical child genes with and without recording', () => {
    const p0 = new Genotype(), p1 = new Genotype();
    const a = new Uint8Array(NUM_GENES), b = new Uint8Array(NUM_GENES);
    for (let g = 0; g < NUM_GENES; g++) { a[g] = (g * 7) % 256; b[g] = (g * 13 + 5) % 256; }
    p0.setGenes(a); p1.setGenes(b);
    const rates = { crossoverRate: 0.2, mutationRate: 0.01 };
    const withProv = new Genotype(), without = new Genotype();
    withProv.setAsOffspring(p0, p1, mulberry32(7), rates, { parentOf: new Uint8Array(NUM_GENES), mutated: new Uint8Array(NUM_GENES) });
    without.setAsOffspring(p0, p1, mulberry32(7), rates); // no provenance arg
    for (let g = 0; g < NUM_GENES; g++) assert.equal(withProv.getGeneValue(g), without.getGeneValue(g), `gene ${g} must match (recording changes nothing)`);
});

test('packMaskHex round-trips (LSB-first) and is NUM_GENES/8 bytes', () => {
    const mask = new Uint8Array(NUM_GENES);
    for (let g = 0; g < NUM_GENES; g++) mask[g] = (g % 3 === 0) ? 1 : 0;
    const hex = packMaskHex(mask);
    assert.equal(hex.length, (NUM_GENES / 8) * 2, 'hex length = 2 chars per byte');
    assert.match(hex, /^[0-9a-f]+$/, 'lowercase hex');
    assert.deepEqual(unpackMaskHex(hex), mask, 'unpack(pack(mask)) === mask');
});

test('birth events carry parentMask + mutationMask into the run file (valid 64-hex)', () => {
    const CONFIG = {
        maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
        crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
        foodBitEnergy: 50, attractionCriterion: 10, pool: { left: 0, top: 0, right: 8000, bottom: 8000 },
    };
    const sink = createSqliteSink(':memory:');
    const world = new World(CONFIG, 11, { onEvent: sink.onEvent });
    const rng = mulberry32(11 ^ 0x5eed1234);
    for (let i = 0; i < 300; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        world.loadSwimbot(i, { age: Math.floor(rng() * 40000), x: rng() * 8000, y: rng() * 8000, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < 900; i++) world.loadFood(i, { x: rng() * 8000, y: rng() * 8000, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    for (let t = 0; t < 1000; t++) world.tick();
    sink.flush();

    const rows = sink.db.prepare('SELECT parentMask, mutationMask FROM births').all();
    assert.ok(rows.length > 0, 'expected births');
    for (const r of rows) {
        assert.match(r.parentMask, /^[0-9a-f]{64}$/, 'parentMask should be 64 hex chars (256 bits)');
        assert.match(r.mutationMask, /^[0-9a-f]{64}$/, 'mutationMask should be 64 hex chars (256 bits)');
    }
    sink.close();
});
