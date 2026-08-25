'use strict';
// Bug H-g (docs/BUGS-original-genepool.md): createNewSwimbotWithGenes() doesn't guard the
// "pool full" case. findLowestDeadSwimbotInArray() returns NULL_INDEX (-1) when all MAX_SWIMBOTS
// slots are alive, and the function then did _swimbots[-1].create(...) -> crash. Its siblings
// makeNewRandomSwimbot() and cloneSwimbot() already guard with `if (index != NULL_INDEX)`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

test('H-g: createNewSwimbotWithGenes is a safe no-op when the pool is full', () => {
    const GP = loadSim();

    // Build a FULL pool (every slot alive) from a real snapshot swimbot as the prototype.
    const seed = boot(42);
    step(seed, 200);
    const pd = JSON.parse(JSON.stringify(seed.getPoolData()));
    const proto = pd.swimbotArray[0];
    const full = {
        ...pd,
        numSwimbots: GP.MAX_SWIMBOTS,
        swimbotArray: Array.from({ length: GP.MAX_SWIMBOTS }, (_, i) => ({ ...proto, id: i, genes: proto.genes.slice() })),
    };
    const gp = boot(42);
    gp.setPoolData(full);
    assert.equal(gp.getNumSwimbots(), GP.MAX_SWIMBOTS, 'pool should be full');

    // With no free slot, creating another swimbot must be a safe no-op, not a crash.
    assert.doesNotThrow(() => gp.createNewSwimbotWithGenes(proto.genes.slice()));
});
