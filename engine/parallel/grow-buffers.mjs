// Grow-on-near-full buffer allocation + copy, shared by the handshake driver (run.mjs) and the free-run driver
// (run-freerun.mjs) so the determinism-critical copy lives in ONE place. Keeps slot==id / food-id==slot: only the
// backing grows; the id-keyed content is preserved bit-for-bit, so the fingerprint is unchanged across a grow.

import { makeFrozenBuffer } from './frozen-layout.mjs';
import { makeFoodBuffer } from './food-layout.mjs';
import { makePostUpdateBuffer, makeResolutionBuffers } from './resolution-layout.mjs';

const NUM_GENES = 256; // constants.js NUM_GENES

// Allocate the bigger SWIMBOT SABs and copy the two cross-tick carriers into them (old region -> [0,oldMax), new
// region stays 0/-1). Everything else is per-tick scratch: pu (rewritten phase 5; swept read PU_ALIVE=0 -> skipped),
// botIds (rebuilt every tick), and wants (re-staged phase 5 -- filled -1 because a swept trying-to-mate bot's slot is
// never rewritten and copying its stale intent would resurrect a birth). Returns the grow-message fields.
export function growSwimbotBuffers(frozenSab, resSabs, newMax) {
    const nFrozen = makeFrozenBuffer(newMax);
    const nBotIds = new SharedArrayBuffer(newMax * Int32Array.BYTES_PER_ELEMENT);
    const nPu = makePostUpdateBuffer(newMax);
    const nRes = makeResolutionBuffers(newMax, NUM_GENES);
    new Float64Array(nFrozen).set(new Float64Array(frozenSab));                                  // ghost read by next applyDeltas sweep
    new Uint8Array(nRes.genomeSab).set(new Uint8Array(resSabs.genomeSab));                       // genome accumulator (all genomes ever)
    new Int32Array(nRes.flagsSab).set(new Int32Array(resSabs.flagsSab));                         // pending resolution deltas ...
    new Float64Array(nRes.resolvedEnergySab).set(new Float64Array(resSabs.resolvedEnergySab));   //   (applied by next applyDeltas)
    new Int32Array(nRes.numFoodEatenDeltaSab).set(new Int32Array(resSabs.numFoodEatenDeltaSab));
    new Int32Array(nRes.numOffspringDeltaSab).set(new Int32Array(resSabs.numOffspringDeltaSab));
    new Int32Array(nRes.newbornCountSab).set(new Int32Array(resSabs.newbornCountSab));           // this-tick newborns, constructed ...
    new Float64Array(nRes.newbornRecSab).set(new Float64Array(resSabs.newbornRecSab));           //   by next applyDeltas
    new Int32Array(nRes.wantsEatSab).fill(-1);
    new Int32Array(nRes.wantsMateSab).fill(-1);
    return { frozenSab: nFrozen, botIdsSab: nBotIds, maxBots: newMax, puSab: nPu, resSabs: nRes };
}

// Allocate the bigger FOOD SABs and copy the PERSISTENT food SoA + the STATIC food-grid scatter (foodBotIds); the
// pool-sized cells are reused (rebuilt on the next regen). Returns the grow-message fields.
export function growFoodBuffers(foodSab, foodBotIdsSab, newMaxFood) {
    const nFoodSab = makeFoodBuffer(newMaxFood);
    const nFoodBotIds = new SharedArrayBuffer(newMaxFood * Int32Array.BYTES_PER_ELEMENT);
    new Float64Array(nFoodSab).set(new Float64Array(foodSab));               // food positions/type/alive/energy
    new Int32Array(nFoodBotIds).set(new Int32Array(foodBotIdsSab));          // static grid scatter (cells reused)
    return { foodSab: nFoodSab, foodBotIdsSab: nFoodBotIds, maxFood: newMaxFood };
}
