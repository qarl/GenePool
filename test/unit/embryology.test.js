'use strict';
// Unit tests for Embryology (GenePool/simulation/Embryology.js) -- the genome->body decoder that
// turns a 256-gene Genotype into a Phenotype (the morphology selection acts on). Tested via the
// public `generatePhenotypeFromGenotype(genotype)`, which returns a fresh Phenotype. The decode is
// pure/deterministic (no RNG), so genotype construction is the only thing that needs a seed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, mulberry32 } = require('../helpers/boot');

const GP = loadSim();
const emb = new GP.Embryology();

const randomGenotype = (seed) => { globalThis.gpRandom = mulberry32(seed); const g = new GP.Genotype(); g.randomize(); return g; };
// stable signature of a phenotype's topology
const sig = (p) => p.numParts + '|' +
    Array.from({ length: p.numParts }, (_, i) => `${p.parts[i].category},${(p.parts[i].angle || 0).toFixed(4)}`).join(';');

test('Embryology: the decode is deterministic (same genotype -> identical phenotype)', () => {
    const g = randomGenotype(11);
    const a = emb.generatePhenotypeFromGenotype(g);
    const b = emb.generatePhenotypeFromGenotype(g);
    assert.equal(sig(a), sig(b), 'same genotype must decode to the same body');
});

test('Embryology: every decoded phenotype is structurally valid', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
        const p = emb.generatePhenotypeFromGenotype(randomGenotype(seed));
        // numParts is contractually > 1 (also enforced by an internal assert in the decode).
        assert.ok(Number.isInteger(p.numParts) && p.numParts > 1, `numParts must be an integer > 1, got ${p.numParts}`);

        // The DECODED body parts (index 1..numParts-1; part 0 is the unwritten ROOT default) must
        // carry real, finite morphology -- the fields the decoder actually writes. (part.position is
        // NOT decoded -- it stays (0,0) until the sim positions the body -- so it's not checked here.)
        for (let i = 1; i < p.numParts; i++) {
            const part = p.parts[i];
            assert.ok(Number.isInteger(part.category) && part.category >= 0, `part ${i} category invalid: ${part.category}`);
            assert.ok(Number.isFinite(part.angle), `part ${i} angle must be finite`);
            assert.ok(Number.isFinite(part.length) && part.length > 0, `part ${i} length must be finite > 0, got ${part.length}`);
            assert.ok(Number.isFinite(part.width) && part.width > 0, `part ${i} width must be finite > 0, got ${part.width}`);
            for (const ch of ['red', 'green', 'blue']) {
                const v = part[ch];
                assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `part ${i} ${ch} must be in [0,1], got ${v}`);
            }
        }
        // food-type traits are always in {0,1} (here numFoodTypes==1 so both decode to 0; the 2-type
        // decode path is exercised in the 2-type food-economy tests).
        assert.ok(p.digestibleFoodType === 0 || p.digestibleFoodType === 1, `digestibleFoodType in {0,1}, got ${p.digestibleFoodType}`);
        assert.ok(p.preferredFoodType === 0 || p.preferredFoodType === 1, `preferredFoodType in {0,1}, got ${p.preferredFoodType}`);
    }
});

test('Embryology: the decode responds to the genome (different genes -> different body)', () => {
    const allZero = new GP.Genotype(); allZero.setAllGenesToOneValue(0);
    const allMax = new GP.Genotype(); allMax.setAllGenesToOneValue(255);
    const p0 = emb.generatePhenotypeFromGenotype(allZero);
    const pMax = emb.generatePhenotypeFromGenotype(allMax);
    assert.notEqual(p0.numParts, pMax.numParts,
        `distinct genomes should build distinct bodies (all-0 numParts=${p0.numParts}, all-255 numParts=${pMax.numParts})`);
});
