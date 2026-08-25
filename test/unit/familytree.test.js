'use strict';
// Unit tests for FamilyTree (GenePool/simulation/FamilyTree.js) -- the lineage record the competition
// scoring will read. Exercised through gp.getFamilyTree() (the class isn't exported), reset() first
// for a clean tree. Covers node append, parent-index resolution (which loops BACKWARDS so it resolves
// a reused pool slot to the latest occupant -- the reincarnation/ABA case), gene copying, deathTime.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, loadSim } = require('../helpers/boot');

const GP = loadSim();
const NULLI = GP.NULL_INDEX;
const gp = boot(1);              // one instance; each test resets the tree for isolation
const genesA = [1, 2, 3, 4];
const genesB = [9, 8, 7];

test('FamilyTree: reset empties the tree', () => {
    const ft = gp.getFamilyTree();
    ft.reset();
    assert.equal(ft.getNumNodes(), 0);
});

test('FamilyTree: addNode stores a founder (NULL parents) and copies genes independently', () => {
    const ft = gp.getFamilyTree();
    ft.reset();
    const genes = genesA.slice();
    ft.addNode(5, NULLI, NULLI, 0, genes);

    assert.equal(ft.getNumNodes(), 1);
    assert.equal(ft.getNodePoolIndex(0), 5);
    assert.equal(ft.getNodeParent1PoolIndex(0), NULLI);
    assert.equal(ft.getNodeParent2PoolIndex(0), NULLI);
    assert.equal(ft.getNodeParent1Index(0), NULLI); // no node has poolIndex==NULL -> unresolved
    assert.equal(ft.getNodeParent2Index(0), NULLI);
    assert.equal(ft.getNodeBirthTime(0), 0);
    assert.equal(ft.getNodeDeathTime(0), 0);
    assert.deepEqual(ft.getNodeGenes(0), genesA);

    genes[0] = 999;                                 // node kept its own copy
    assert.equal(ft.getNodeGenes(0)[0], 1);
});

test('FamilyTree: a child resolves parent pool-indices to the right node indices', () => {
    const ft = gp.getFamilyTree();
    ft.reset();
    ft.addNode(5, NULLI, NULLI, 0, genesA);   // node 0, slot 5
    ft.addNode(6, 5, 8, 10, genesB);          // node 1, slot 6, parents slot 5 (exists) + slot 8 (absent)

    assert.equal(ft.getNumNodes(), 2);
    assert.equal(ft.getNodeParent1PoolIndex(1), 5);
    assert.equal(ft.getNodeParent2PoolIndex(1), 8);
    assert.equal(ft.getNodeParent1Index(1), 0);    // slot 5 -> node 0
    assert.equal(ft.getNodeParent2Index(1), NULLI); // slot 8 has no node -> unresolved
    assert.equal(ft.getNodeBirthTime(1), 10);
});

test('FamilyTree: parent resolution loops backwards -> reused slot resolves to the LATEST occupant', () => {
    const ft = gp.getFamilyTree();
    ft.reset();
    ft.addNode(5, NULLI, NULLI, 0, genesA);   // node 0: original occupant of slot 5
    ft.addNode(9, NULLI, NULLI, 5, genesA);   // node 1: unrelated founder
    ft.addNode(5, NULLI, NULLI, 20, genesB);  // node 2: slot 5 REUSED (reincarnation)
    ft.addNode(7, 5, NULLI, 25, genesB);      // node 3: child of "slot 5"

    // must resolve to node 2 (latest slot-5 occupant), not node 0
    assert.equal(ft.getNodeParent1Index(3), 2);
});

test('FamilyTree: setDeathTime targets the latest node for a pool slot', () => {
    const ft = gp.getFamilyTree();
    ft.reset();
    ft.addNode(5, NULLI, NULLI, 0, genesA);   // node 0
    ft.addNode(5, NULLI, NULLI, 20, genesB);  // node 1: slot 5 reused
    ft.setDeathTime(5, 99);

    assert.equal(ft.getNodeDeathTime(1), 99); // latest occupant gets the death time
    assert.equal(ft.getNodeDeathTime(0), 0);  // original untouched
});
