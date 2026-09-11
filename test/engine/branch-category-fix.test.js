'use strict';
// fixBranchCategoryGene (opt-in per-pool config): JJ's branchCategory selector has an off-by-one -- range
// NUM_CATEGORIES-1 with floor(range*ng), ng in [0,1), so the 4th category (index 3) is never selected and its whole
// gene block is inert (~1/4 of the shape genome ignored). The flag widens the range to the full NUM_CATEGORIES so
// category 3 becomes reachable. Default false MUST be byte-identical to the JJ decode.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Embryology } = require('../../engine/embryology.js');
const { Genotype } = require('../../engine/genotype.js');
const { resolveWorldConfig } = require('../../engine/config.js');

// gene 25 = category 0's branchCategory (frequency[0], cutOff[1], then 27 genes/category; branchCategory is #23 in the
// block -> 2 + 23 = 25). 255 -> ng ~= 0.996: floor(3*0.996)=2 (JJ) vs floor(4*0.996)=3 (fixed).
const BRANCH_CAT_G = 25;
function midGenome(overrides) {
    const a = new Uint8Array(256).fill(128); for (const [i, v] of Object.entries(overrides)) a[i] = v;
    const g = new Genotype(); g.setGenes(a); return g;
}
const bodySig = (p) => p.numParts + '|' + Array.from({ length: p.numParts }, (_, i) =>
    `${p.parts[i].category},${(p.parts[i].length || 0).toFixed(3)},${(p.parts[i].width || 0).toFixed(3)}`).join(';');

test('fixBranchCategoryGene: default/false leaves category 3 unreachable; true reaches it', () => {
    const emb = new Embryology();
    const g = midGenome({ [BRANCH_CAT_G]: 255 });

    emb.generatePhenotypeFromGenotype(g, { numFoodTypes: 1, fixBranchCategoryGene: false });
    assert.equal(emb._categoryValues[0].branchCategory, 2, 'JJ decode (false): 3*0.996 -> floor 2 (category 3 never selected)');

    emb.generatePhenotypeFromGenotype(g, { numFoodTypes: 1, fixBranchCategoryGene: true });
    assert.equal(emb._categoryValues[0].branchCategory, 3, 'fix (true): 4*0.996 -> floor 3 (category 3 reachable)');

    emb.generatePhenotypeFromGenotype(g, { numFoodTypes: 1 });   // absent flag == false
    assert.equal(emb._categoryValues[0].branchCategory, 2, 'absent flag decodes as the JJ off-by-one (byte-identical default)');
});

test('fixBranchCategoryGene: the fix actually changes expressed morphology (category 3 comes alive)', () => {
    const emb = new Embryology();
    const g = midGenome({ [BRANCH_CAT_G]: 255 });
    const off = bodySig(emb.generatePhenotypeFromGenotype(g, { numFoodTypes: 1, fixBranchCategoryGene: false }));
    const on = bodySig(emb.generatePhenotypeFromGenotype(g, { numFoodTypes: 1, fixBranchCategoryGene: true }));
    assert.notEqual(on, off, 'branching into category 3 must produce a different body than branching into category 2');
});

test('fixBranchCategoryGene: config surface -- defaults false, only fills when unset, rejects non-boolean', () => {
    assert.equal(resolveWorldConfig({}).fixBranchCategoryGene, false, 'defaults to false (byte-identical)');
    assert.equal(resolveWorldConfig({ fixBranchCategoryGene: true }).fixBranchCategoryGene, true, 'honored when set');
    assert.throws(() => resolveWorldConfig({ fixBranchCategoryGene: 1 }), /must be a boolean/, 'non-boolean rejected at the config boundary');
});
