'use strict';
// Deterministic mutation characterization for Genotype.setAsOffspring. With two IDENTICAL parents,
// crossover always yields the parent value, so any gene whose FINAL value differs from the base was
// mutated. (A mutation that happens to wrap exactly back to the base simply won't appear -- the set
// is self-consistently defined as "final value != base", which is exactly what we pin.) Under a seed
// (mulberry32) + MUTATION_RATE 0.01, the exact set of mutated {index: value} is deterministic -- so we
// pin it exactly (a golden). This catches ANY change to the mutation math, the per-gene mutation
// probability, or the RNG draw order. Prefer exact sets over tolerance bands: they're stronger and,
// because the decode is deterministic, they're not flaky. Update the golden only when a mutation
// change is intentional.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, mulberry32 } = require('../helpers/boot');

const GP = loadSim();

function mutatedGenes(seed, base) {
    globalThis.gpRandom = mulberry32(seed);
    const p = new GP.Genotype(); p.setAllGenesToOneValue(base);
    const child = new GP.Genotype(); child.setAsOffspring(p, p);
    const mutated = {};
    for (let i = 0; i < GP.NUM_GENES; i++) { const v = child.getGeneValue(i); if (v !== base) mutated[i] = v; }
    return mutated;
}

test('setAsOffspring mutates exactly this set of genes for seed 1', () => {
    assert.deepEqual(mutatedGenes(1, 100), { 54: 101, 155: 199 });
});

test('setAsOffspring mutates exactly this set of genes for seed 3', () => {
    assert.deepEqual(mutatedGenes(3, 100), { 16: 205, 55: 126, 176: 16, 202: 130 });
});

test('setAsOffspring mutation is reproducible (same seed -> same mutated set)', () => {
    assert.deepEqual(mutatedGenes(3, 100), mutatedGenes(3, 100));
});
