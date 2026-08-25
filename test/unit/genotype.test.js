'use strict';
// Unit tests for Genotype (GenePool/simulation/Genotype.js) -- the 256-gene chromosome and the
// crossover/mutation operators that drive evolution (and that the competition will score on).
// RNG-using methods are seeded via globalThis.gpRandom = mulberry32(seed) so they're deterministic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, mulberry32 } = require('../helpers/boot');

const GP = loadSim();
const NG = GP.NUM_GENES;      // 256
const BYTE = GP.BYTE_SIZE;    // 256
const seed = (s) => { globalThis.gpRandom = mulberry32(s); };
const isByte = (v) => Number.isInteger(v) && v >= 0 && v < BYTE;

test('Genotype: randomize fills NUM_GENES integer genes in [0,255]', () => {
    seed(1);
    const g = new GP.Genotype();
    g.randomize();
    const genes = g.getGenes();
    assert.equal(genes.length, NG);
    for (let i = 0; i < NG; i++) assert.ok(isByte(genes[i]), `gene[${i}] = ${genes[i]} not a byte`);
});

test('Genotype: setAllGenesToOneValue / clear / get+setGeneValue', () => {
    const g = new GP.Genotype();
    g.setAllGenesToOneValue(123);
    for (let i = 0; i < NG; i++) assert.equal(g.getGeneValue(i), 123);
    g.clear();
    for (let i = 0; i < NG; i++) assert.equal(g.getGeneValue(i), 0);
    g.setGeneValue(5, 200);
    assert.equal(g.getGeneValue(5), 200);
    assert.equal(g.getGeneValue(4), 0);
});

test('Genotype: setGenes/getGenes round-trip (note: by reference)', () => {
    const g = new GP.Genotype();
    const arr = Array.from({ length: NG }, (_, i) => i % BYTE);
    g.setGenes(arr);
    const out = g.getGenes();
    assert.equal(out.length, NG);
    for (let i = 0; i < NG; i++) assert.equal(out[i], i % BYTE);
});

test('Genotype: copyFromGenotype makes an independent value copy', () => {
    const src = new GP.Genotype(); src.setAllGenesToOneValue(10);
    const dst = new GP.Genotype(); dst.copyFromGenotype(src);
    for (let i = 0; i < NG; i++) assert.equal(dst.getGeneValue(i), 10);
    src.setAllGenesToOneValue(20);           // mutating source must not touch the copy
    for (let i = 0; i < NG; i++) assert.equal(dst.getGeneValue(i), 10);
});

test('Genotype: mutateGene keeps the gene an integer in [0,255] (wraps, never out of range)', () => {
    seed(42);
    const g = new GP.Genotype();
    g.setAllGenesToOneValue(100);
    for (let n = 0; n < 2000; n++) {
        g.mutateGene(0);
        const v = g.getGeneValue(0);
        assert.ok(isByte(v), `after mutation #${n}, gene = ${v} out of [0,${BYTE})`);
    }
});

test('Genotype: setAsOffspring with identical parents yields (mostly) that value, all in range', () => {
    seed(7);
    const p = new GP.Genotype(); p.setAllGenesToOneValue(123);
    const child = new GP.Genotype();
    child.setAsOffspring(p, p);
    let same = 0;
    for (let i = 0; i < NG; i++) {
        const v = child.getGeneValue(i);
        assert.ok(isByte(v), `child gene[${i}] = ${v} out of range`);
        if (v === 123) same++;
    }
    // MUTATION_RATE is 0.01 (~2-3 genes), so the vast majority must be inherited unchanged.
    assert.ok(same >= 240, `expected >=240/256 genes inherited from identical parents, got ${same}`);
});

test('Genotype: setAsOffspring draws each gene from one parent (0 vs 255)', () => {
    seed(9);
    const p0 = new GP.Genotype(); p0.setAllGenesToOneValue(0);
    const p1 = new GP.Genotype(); p1.setAllGenesToOneValue(255);
    const child = new GP.Genotype();
    child.setAsOffspring(p0, p1);
    let fromParent = 0;
    for (let i = 0; i < NG; i++) {
        const v = child.getGeneValue(i);
        assert.ok(isByte(v), `child gene[${i}] = ${v} out of range`);
        if (v === 0 || v === 255) fromParent++;
    }
    // Crossover must pick each gene from a parent; only the ~1% mutations deviate.
    assert.ok(fromParent >= 240, `expected >=240/256 genes to come straight from a parent, got ${fromParent}`);
});
