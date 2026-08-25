'use strict';
// Bug M-stringgene (docs/BUGS-original-genepool.md): the WILSON (Genotype.js:296) and DENNETT (:322)
// preset genotypes store some gene values as STRINGS ("0","107","223","225","244","255") mixed in
// with integers. Genes are supposed to be integers 0..255. A string gene breaks mutation: mutateGene
// does `_genes[g] += amplitude`, which for a string becomes CONCATENATION ("225" + 200 -> "225200"),
// yielding a wildly out-of-range gene -> garbage body, assert-spam, or a TypeError if the corrupted
// gene lands on a branch-category slot. (The "-=" mutation branch coerces back to a number and heals
// it, which is why it's intermittent.) Fix: store every preset gene as an integer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/boot');

// preset ids from Genotype.js: PRESET_GENOTYPE_WILSON = 5, PRESET_GENOTYPE_DENNETT = 7
const PRESETS = { WILSON: 5, DENNETT: 7 };

test('M-stringgene: preset genotypes contain only integer genes in [0,255]', () => {
    const GP = loadSim();
    for (const [name, id] of Object.entries(PRESETS)) {
        const g = new GP.Genotype();
        g.setToPreset(id);
        const genes = g.getGenes();
        assert.equal(genes.length, GP.NUM_GENES, `${name}: expected ${GP.NUM_GENES} genes`);
        for (let i = 0; i < genes.length; i++) {
            const v = genes[i];
            assert.ok(
                Number.isInteger(v) && v >= 0 && v < GP.BYTE_SIZE,
                `${name} gene[${i}] = ${JSON.stringify(v)} (${typeof v}) is not an integer in [0,${GP.BYTE_SIZE})`
            );
        }
    }
});
