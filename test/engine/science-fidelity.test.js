'use strict';
// P0 milestone — the fresh engine/ reproduces JJ's genome science bit-for-bit (old-vs-new).
//
// This is the point of freezing E1/E2 (PLAN-restructure.md §12/§17): the engine's decode + genetics,
// forked to ES modules with injected rng/config, must reproduce the exact signatures/children the OLD
// simulation/ code produced. Reuses the oracle's OWN signature function (signatureOf) so it's a true
// apples-to-apples decode comparison. Green here proves the science crossed the fork AND validates the
// ctx={rng,config} injection seams -- with NO simulation behavior yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signatureOf } = require('../oracles/e1-corpus'); // pure; does not load the old sim unless called
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');
const e1 = require('../fixtures/oracles/e1-decode.json');
const e2 = require('../fixtures/oracles/e2-genetics.json');

const emb = new Embryology();
function decodeSig(genes, numFoodTypes) {
    const g = new Genotype();
    g.setGenes(genes);
    return signatureOf(emb.generatePhenotypeFromGenotype(g, { numFoodTypes }));
}
const rngFromDraws = (draws) => { let i = 0; return () => { if (i >= draws.length) throw new Error('engine drew past the recorded sequence'); return draws[i++]; }; };
function readGenes(g) { const out = new Array(256); for (let i = 0; i < 256; i++) out[i] = g.getGeneValue(i); return out; }

test('E1: the ENGINE decode reproduces the frozen decode signature on every corpus entry (old-vs-new)', () => {
    for (const e of e1.entries) {
        const got = decodeSig(e.genes, e.numFoodTypes);
        assert.deepEqual(got, e.sig, `engine decode drift vs frozen oracle for "${e.name}"`);
    }
});

test('E1: the engine decode is RNG-free and call-order-independent', () => {
    const a1 = decodeSig(e1.entries[0].genes, e1.entries[0].numFoodTypes);
    // decode other genomes in between; the first genome must decode identically again
    for (const e of e1.entries) decodeSig(e.genes, e.numFoodTypes);
    const a2 = decodeSig(e1.entries[0].genes, e1.entries[0].numFoodTypes);
    assert.deepEqual(a1, a2, 'decode must not depend on prior decodes (shared-state leak) or any RNG');
});

test('E1: the engine canonicalization lets the out-of-range genome decode (clamp before decode)', () => {
    const oor = e1.entries.find((x) => x.name === 'out-of-range');
    // setGenes(rawGenes) canonicalizes (clamps), so decode succeeds and matches the clamped signature.
    const g = new Genotype();
    g.setGenes(oor.rawGenes);
    const sig = signatureOf(emb.generatePhenotypeFromGenotype(g, { numFoodTypes: oor.numFoodTypes }));
    assert.deepEqual(sig, oor.sig, 'clamped out-of-range genome must decode to the frozen signature');
});

test('E2: the ENGINE crossover+mutation reproduces the frozen child on every case (old-vs-new)', () => {
    for (const e of e2.entries) {
        const p0 = new Genotype(); p0.setGenes(e.parent0);
        const p1 = new Genotype(); p1.setGenes(e.parent1);
        const child = new Genotype();
        const rng = rngFromDraws(e.draws);
        child.setAsOffspring(p0, p1, rng, { crossoverRate: e.crossoverRate, mutationRate: e.mutationRate });
        assert.deepEqual(readGenes(child), e.child, `engine genetics drift vs frozen oracle for "${e.name}"`);
        // parents must be untouched (no aliasing of a parent buffer into the child)
        assert.deepEqual(readGenes(p0), e.parent0, `${e.name}: parent0 mutated`);
        assert.deepEqual(readGenes(p1), e.parent1, `${e.name}: parent1 mutated`);
    }
});

test('E2: the engine setAsOffspring consumes exactly the recorded number of draws', () => {
    for (const e of e2.entries) {
        const p0 = new Genotype(); p0.setGenes(e.parent0);
        const p1 = new Genotype(); p1.setGenes(e.parent1);
        let used = 0;
        const rng = () => { used++; return e.draws[used - 1]; };
        new Genotype().setAsOffspring(p0, p1, rng, { crossoverRate: e.crossoverRate, mutationRate: e.mutationRate });
        assert.equal(used, e.draws.length, `${e.name}: engine drew ${used}, recorded ${e.draws.length} (draw order changed)`);
    }
});
