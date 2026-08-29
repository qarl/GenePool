// PRODUCTIONIZE S2 — shared buffers for the cross-worker ECOLOGY resolution. Physics stays in the owning worker;
// the ecology mutations that cross partitions (eat energy award + food death; birth energy/numOffspring/mate-clear
// + newborns) are computed by a serial pass on worker 0 in ascending-GLOBAL-id order and written back as DELTAS
// the owners apply next tick. Worker 0 needs each bot's POST-UPDATE state (energy/genital/alive) to compute
// contributeToOffspring energy, birthPos, and the parent-alive gate -- so every worker publishes it after its
// phase-5 update(), read by worker 0 in the resolve tail.
//
// S2a wires only the POST-UPDATE SoA + a no-op resolve (to validate the barrier restructure in isolation).
// The staging (wantsEatFood/wantsMate) + delta arrays + genome SoA + newborn records land with S2b (eat)/S3 (birth).

// Post-update SoA (Float64), written by each owner after update() in phase 5, read by worker 0's resolve.
export const PU_ALIVE = 0;
export const PU_ENERGY = 1;
export const PU_GX = 2;   // genital x (post-update; for birthPos)
export const PU_GY = 3;   // genital y
export const PU_STRIDE = 4;

export function makePostUpdateBuffer(maxBots) {
    return new SharedArrayBuffer(maxBots * PU_STRIDE * Float64Array.BYTES_PER_ELEMENT);
}

export function writePostUpdate(pu64, id, alive, energy, gx, gy) {
    const o = id * PU_STRIDE;
    pu64[o + PU_ALIVE] = alive ? 1 : 0;
    pu64[o + PU_ENERGY] = energy;
    pu64[o + PU_GX] = gx;
    pu64[o + PU_GY] = gy;
}

// Cross-worker resolution buffers. STAGING: each owner writes its bots' intents in phase 5 (foodId/mateId, or -1).
// RESULTS: worker 0 computes ecology outcomes in the resolve tail; each owner applies to its bots in phase 1 of
// the next tick, then clears them. ENERGY is written as the FINAL value to SET (not a delta) -- float
// non-associativity means `start + (final-start) != final`, so the owner must take worker 0's exact final to stay
// bit-identical. Integer counts use deltas (exact). Sized to maxBots (id-indexed).
export function makeResolutionBuffers(maxBots, numGenes) {
    return {
        wantsEatSab: new SharedArrayBuffer(maxBots * Int32Array.BYTES_PER_ELEMENT),   // foodId this bot is eating, or -1
        wantsMateSab: new SharedArrayBuffer(maxBots * Int32Array.BYTES_PER_ELEMENT),  // mateId this bot chose, or -1
        resolvedEnergySab: new SharedArrayBuffer(maxBots * Float64Array.BYTES_PER_ELEMENT), // FINAL energy to SET (flag-gated)
        numFoodEatenDeltaSab: new SharedArrayBuffer(maxBots * Int32Array.BYTES_PER_ELEMENT),
        numOffspringDeltaSab: new SharedArrayBuffer(maxBots * Int32Array.BYTES_PER_ELEMENT),
        flagsSab: new SharedArrayBuffer(maxBots * Int32Array.BYTES_PER_ELEMENT),
        genomeSab: new SharedArrayBuffer(maxBots * numGenes),                          // Uint8 per-bot genome (birth)
    };
}

// flag bits (flagsSab per bot): what the owner applies in phase 1.
export const FLAG_ENERGY_SET = 1;   // _energy = resolvedEnergy[id]  (eat gain and/or mate/parent contribution)
export const FLAG_TIMER_RESET = 2;  // _timerDelta = 0               (eat winner OR mated)
export const FLAG_CLEAR_EAT = 4;    // _tryingToEat = false          (eat winner only; losers keep trying, per world.js)
export const FLAG_CLEAR_MATE = 8;   // contributeToOffspring's mate-clear (parent or mate role)
