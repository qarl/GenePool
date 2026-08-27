'use strict';
// E2 genetics-fidelity oracle — verifies JJ's CURRENT crossover+mutation reproduces the frozen fixture
// when fed the recorded, explicit draw sequence.
//
// The OLD side of the second old-vs-new science oracle (PLAN-restructure.md §12/§17). Because the fixture
// records the exact draw VALUES (not a PRNG seed), the fresh engine's setAsOffspring can later be asserted
// against the SAME fixture to prove the genetics crossed the fork -- and a production-PRNG swap cannot
// silence it. Regenerate deliberately: node test/tools/gen-e2-oracle.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAll, replay, loadSim, BASE_DRAWS } = require('./e2-corpus');
const fixture = require('../fixtures/oracles/e2-genetics.json');

const GP = loadSim();

test('E2: current setAsOffspring, fed the frozen draw sequence, reproduces the frozen child exactly', () => {
    for (const e of fixture.entries) {
        const { child, used } = replay(GP, e.parent0, e.parent1, e.draws);
        assert.equal(used, e.draws.length, `${e.name}: draw consumption changed (used ${used} of ${e.draws.length})`);
        assert.deepEqual(child, e.child, `E2 child drift for "${e.name}"`);
        // structural: (draws - base) must be a non-negative multiple of 3 -- pins the mutateGene 3-draw
        // shape independently of the derived numMutations (which would make len==base+3*num a tautology).
        const extra = e.draws.length - BASE_DRAWS;
        assert.ok(extra >= 0 && extra % 3 === 0, `${e.name}: draws-base=${extra} is not a non-negative multiple of 3`);
        assert.ok(Number.isInteger(e.numMutations) && e.numMutations === extra / 3, `${e.name}: numMutations inconsistent`);
        // every child gene is a valid byte
        for (let i = 0; i < child.length; i++) {
            assert.ok(Number.isInteger(child[i]) && child[i] >= 0 && child[i] < 256, `${e.name} gene ${i}=${child[i]} invalid`);
        }
    }
});

test('E2: a full regeneration reproduces the committed fixture (the freeze is faithful)', () => {
    const live = buildAll();
    assert.equal(live.length, fixture.entries.length, 'case count drifted from the fixture');
    for (let k = 0; k < live.length; k++) {
        const a = live[k], b = fixture.entries[k];
        assert.equal(a.name, b.name, `case ${k} name drift`);
        assert.deepEqual(a.parent0, b.parent0, `${a.name} parent0 drift`);
        assert.deepEqual(a.parent1, b.parent1, `${a.name} parent1 drift`);
        assert.deepEqual(a.draws, b.draws, `${a.name} draw-sequence drift`);
        assert.deepEqual(a.child, b.child, `${a.name} child drift`);
        assert.equal(a.numMutations, b.numMutations, `${a.name} mutation-count drift`);
    }
});

test('E2: the corpus actually exercises mutation (the 3-draw mutateGene path)', () => {
    const total = fixture.entries.reduce((s, e) => s + e.numMutations, 0);
    assert.ok(total > 0, 'E2 corpus must contain at least one mutation to pin the mutation math');
    assert.ok(fixture.entries.every((e) => e.numMutations >= 0), 'negative mutation count => draw-shape wrong');
});
