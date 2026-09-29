'use strict';
// Body-plate (docs/PLAN-body-plate.md): the species plate is a pure function of body features, which are a pure function
// of the genome. These tests freeze that contract: golden plates + integer feature vectors for fixed genomes (any change
// to features, basis or encoding shows up here -- retraining the basis = a deliberate new plate epoch, update goldens),
// a monotonic shared letter scale, exact add/remove of fixed-point sums, and reuse-of-phenotype == fresh decode.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mulberry = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const genome = (seed) => { const r = mulberry(seed); return Array.from({ length: 256 }, () => Math.floor(r() * 256)); };

const GOLDEN = [
    [1, 'QXX00', [350441, 92682, 148908, 95573, 95573, 183296, 0, 0, 0, 0, 0, 47405, 52057, 39378, 23208, 8684, 1515352, 0]],
    [2, 'BKMR2', [517070, 173392, 123913, 139206, 30853, 168982, 33203, 92682, 33203, 1751040, 0, 30631, 48618, 27092, 14904, 9928, 2358917, 1249016]],
    [3, 'FYX00', [284488, 113512, 113696, 89225, 89225, 128640, 0, 0, 0, 0, 0, 19147, 28971, 24013, 30648, 9789, 1559842, 0]],
    [42, 'IJA3P', [567204, 185364, 139042, 86025, 49927, 153728, 32768, 65536, 32768, 1059840, 0, 29205, 27692, 20979, 43808, 8361, 1842458, 1301716]],
    [1000, 'N00UZ', [862147, 236293, 151005, 67806, 63342, 227200, 55773, 160530, 188194, 3640320, 0, 48293, 2523, 55261, 41002, 10665, 2316048, 424721]],
];

test('plate: golden integer features + plates for fixed genomes (pure, portable)', async () => {
    const S = await import('../../engine/analysis/species.mjs');
    const B = await import('../../engine/analysis/body-features.mjs');
    for (const [seed, plate, feat] of GOLDEN) {
        const f = B.featuresOfGenes(genome(seed));
        assert.deepEqual(Array.from(f), feat, `features drifted for genome ${seed}`);
        assert.ok(Array.from(f).every(Number.isInteger), 'features are exact integers');
        assert.equal(S.plateOf(f), plate, `plate drifted for genome ${seed}`);
    }
});

test('plate: one shared monotonic scale (raising a coordinate never lowers its letter; hysteresis only delays)', async () => {
    const B = await import('../../engine/analysis/body-features.mjs');
    const { PLATE_TH } = await import('../../engine/analysis/plate-basis.mjs');
    assert.equal(PLATE_TH.length, 35, '35 thresholds -> 36 symbols');
    for (let i = 1; i < PLATE_TH.length; i++) assert.ok(PLATE_TH[i] > PLATE_TH[i - 1], 'thresholds strictly increasing');
    const lo = PLATE_TH[0] - 1, hi = PLATE_TH[34] + 1;
    let prev = -1;
    for (let k = 0; k <= 400; k++) { const z = lo + (hi - lo) * k / 400, b = B.binOf(z, PLATE_TH); assert.ok(b >= prev, 'monotonic'); prev = b; }
    assert.equal(B.binOf(lo, PLATE_TH), 0); assert.equal(B.binOf(hi, PLATE_TH), 35);
    // hysteresis: a value just past a boundary keeps the old bin; well past it switches
    const bnd = PLATE_TH[17], w = PLATE_TH[18] - PLATE_TH[17];
    assert.equal(B.binWithHysteresis(bnd + 0.01 * w, PLATE_TH, 17), 17, 'just past the boundary: hold');
    assert.equal(B.binWithHysteresis(bnd + 0.9 * w, PLATE_TH, 17), 18, 'clearly past: switch');
});

test('plate: analyzer sums are exact (add-then-remove cancels) and phenotype reuse == fresh decode', async () => {
    const { createSpeciesAnalyzer } = await import('../../engine/analysis/species.mjs');
    const B = await import('../../engine/analysis/body-features.mjs');
    const { buildWorld } = await import('../../tools/scrub/run-gen.mjs');
    const { world, config } = buildWorld(11, { n: 300, pool: 4000 });
    const A = createSpeciesAnalyzer(config);
    for (let t = 1; t <= 3000; t++) { world.tick(); if (t % 250 === 0) A.recompute(world._swimbots.values()); }
    // fresh analyzer on the SAME living set: same lineage seeds are not guaranteed, but per-lineage sums must equal the
    // exact sum of their current members' features (no drift from the long history of births/deaths)
    for (const [, t] of A.tracked) {
        if (t.count <= 0) continue;
        const s = new Float64Array(B.NF);
        for (const sb of t.idset) { const f = B.featuresOf(sb, config); for (let k = 0; k < B.NF; k++) s[k] += f[k]; }
        assert.deepEqual(Array.from(t.sumFeat), Array.from(s), 'lineage sumFeat == exact sum of current members');
    }
    // reuse of the creature's own phenotype (run has category 3 on) == fresh PLATE_DECODE decode
    let n = 0;
    for (const sb of world._swimbots.values()) {
        if (!sb.getAlive() || !sb._phenotype || sb._phenotype.numParts <= 1) continue;
        assert.deepEqual(Array.from(B.featuresOf(sb, config)), Array.from(B.featuresOfGenes(Array.from(sb.getGenotype().getGenes()))), 'reuse == fresh');
        if (++n >= 100) break;
    }
    assert.ok(n > 0);
});
