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
