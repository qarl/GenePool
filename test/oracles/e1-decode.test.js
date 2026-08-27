'use strict';
// E1 decode-fidelity oracle — verifies JJ's CURRENT decode reproduces the frozen fixture.
//
// The OLD side of the old-vs-new science oracle (PLAN-restructure.md §12/§17): it proves the committed
// baseline (test/fixtures/oracles/e1-decode.json) is faithful to the live simulation/ decode, so the
// fresh engine/ decode can later be asserted against the SAME fixture to prove the genome->body science
// crossed the fork bit-for-bit. The signature is full-precision + all-fields, so any drift in
// geometry/color/motion/food-type decode fails here. Regenerate deliberately: node test/tools/gen-e1-oracle.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAll, decodeSignature, clampByte } = require('./e1-corpus');
const { loadSim } = require('../helpers/load-sim');
const fixture = require('../fixtures/oracles/e1-decode.json');

const GP = loadSim();
const emb = new GP.Embryology();
const fixByName = new Map(fixture.entries.map((e) => [e.name, e]));

test('E1: the current decode reproduces the frozen signature (RNG-free: decode the STORED bytes)', () => {
    // Core check. Decodes each fixture's resolved bytes directly -- no PRNG, no minting -- so it depends
    // only on the decode, not on mulberry32. Deep-equal is bit-exact (JSON round-trips the doubles; -0
    // is normalized in the signature).
    for (const e of fixture.entries) {
        const got = decodeSignature(GP, emb, e.genes, e.numFoodTypes);
        assert.deepEqual(got, e.sig, `E1 signature drift for "${e.name}"`);
    }
});

test('E1: a full regeneration reproduces the committed fixture (the corpus + minting are stable)', () => {
    // Separately proves the corpus DEFINITION (incl. seeded minting via mulberry32) still yields the same
    // bytes + signatures -- i.e. the fixture is a faithful freeze, not just internally consistent.
    const live = buildAll();
    assert.equal(live.length, fixture.entries.length, 'corpus size drifted from the fixture');
    const liveByName = new Map(live.map((e) => [e.name, e]));
    for (const e of fixture.entries) {
        const got = liveByName.get(e.name);
        assert.ok(got, `corpus entry "${e.name}" is in the fixture but not produced live`);
        assert.deepEqual(got.genes, e.genes, `input bytes drift for "${e.name}"`);
        assert.deepEqual(got.sig, e.sig, `E1 signature drift (regen) for "${e.name}"`);
    }
    for (const e of live) assert.ok(fixByName.get(e.name), `live corpus entry "${e.name}" missing from fixture`);
});

test('E1: the food genes are SEPARATE (an entry has preferredFoodType != digestibleFoodType)', () => {
    // Guards against a decode that reads one gene for both food traits (the commented-out legacy path).
    const split = fixByName.get('two-type-split-food-genes');
    assert.ok(split, 'expected a two-type entry that splits the food genes');
    assert.equal(split.sig.preferredFoodType, 1, 'forced gene[110]=255 must decode preferred=1');
    assert.equal(split.sig.digestibleFoodType, 0, 'forced gene[111]=0 must decode digestible=0');
    assert.notEqual(split.sig.preferredFoodType, split.sig.digestibleFoodType,
        'the oracle must contain a case where the two food traits differ (they read distinct genes)');
});

test('E1: the out-of-range fixture clamps to [0,255] (the canonicalization the engine must reproduce)', () => {
    const e = fixByName.get('out-of-range');
    assert.ok(e && e.rawGenes, 'expected an out-of-range entry carrying rawGenes');
    // The stored `genes` must be exactly the explicit clamp of rawGenes (clamp, NOT the Uint8Array
    // mod-256 wrap): 300->255, -5->0, 1000->255, 255.9->255. This is what engine canonicalization owes.
    assert.deepEqual(e.genes, e.rawGenes.map(clampByte), 'out-of-range genes are not the clamp of rawGenes');
    assert.notDeepEqual(e.genes, e.rawGenes, 'out-of-range fixture must actually carry out-of-range raw values');
});

test('E1: decode is deterministic (same genome -> identical full-precision signature)', () => {
    const e = fixByName.get('preset-WILSON');
    const a = decodeSignature(GP, emb, e.genes, e.numFoodTypes);
    const b = decodeSignature(GP, emb, e.genes, e.numFoodTypes);
    assert.deepEqual(a, b, 'same genome must decode to the same signature');
    assert.deepEqual(a, e.sig, 'live WILSON signature must match the fixture');
});
