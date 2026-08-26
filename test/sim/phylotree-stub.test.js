'use strict';
// PhyloTree is a NON-FUNCTIONAL STUB in this release: PhyloTree.addJunkDNA is an empty loop, so it
// does NOT actually cluster species (corrects an earlier recon claim). It's still reached live by
// GenePool.generatePhyloTree() (the "print swimbot data" UI button). This test pins only that the
// public path is inert / crash-free headless -- it is NOT evidence of working phylogenetic clustering.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step } = require('../helpers/boot');

test('generatePhyloTree() runs without error over a populated pool (PhyloTree is an inert stub)', () => {
    const gp = boot(42);
    step(gp, 100); // a populated pool with varied genomes
    assert.ok(gp.getNumSwimbots() > 0, 'precondition: swimbots exist to feed the (stub) phylo tree');
    assert.doesNotThrow(() => gp.generatePhyloTree(), 'the phylo-tree build path must not crash');
    // and it's idempotent/crash-free on an empty pool too (no swimbots to add)
    const empty = boot(42, /* EMPTY */ 8);
    assert.doesNotThrow(() => empty.generatePhyloTree());
});
