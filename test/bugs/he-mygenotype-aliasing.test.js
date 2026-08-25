'use strict';
// Bug H-e (docs/BUGS-original-genepool.md): during reproduction, the shared scratch _myGenotype
// is REASSIGNED to a live swimbot's genotype object (`_myGenotype = _swimbots[s].getGenotype()`),
// not copied. It's never restored, so it keeps aliasing the last swimbot that reproduced. Then the
// UI creators mutate _myGenotype IN PLACE — makeNewRandomSwimbot() does `_myGenotype.randomize()`,
// createNewSwimbotWithGenes() does `_myGenotype.setGenes()` — which silently scrambles that live
// swimbot's genes (its offspring then inherit the corruption). Fix: copy into the scratch, don't alias.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step } = require('../helpers/boot');

test('H-e: makeNewRandomSwimbot must not mutate an existing live swimbot', () => {
    const gp = boot(42);
    step(gp, 1500); // sustaining population => reproductions happen => the alias at line 1208 fires

    // deep-copy: getPoolData genes are by-reference, so detach before the mutation we're testing
    const before = JSON.parse(JSON.stringify(gp.getPoolData()));

    gp.makeNewRandomSwimbot(); // adds one new swimbot; must NOT touch any existing one's genes

    const after = JSON.parse(JSON.stringify(gp.getPoolData()));
    const afterById = new Map(after.swimbotArray.map((s) => [s.id, s.genes]));

    for (const s of before.swimbotArray) {
        if (afterById.has(s.id)) {
            assert.deepEqual(afterById.get(s.id), s.genes, `existing swimbot ${s.id} genes changed after makeNewRandomSwimbot`);
        }
    }
});
