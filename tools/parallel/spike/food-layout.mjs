// SPIKE/PRODUCTIONIZE — the shared FOOD SoA. Workers can't see the main thread's FoodBit objects, so food lives
// in a SharedArrayBuffer just like the swimbot frozen snapshot. Fields are exactly what the engine's food path
// reads: the food scan (world.js#_giveSwimbotNearbyEnvironmentalStimuli) reads position + type + alive; eating
// (swimbot.js#eatChosenFoodBit) reads energy + type + alive. Food never moves; only `alive` toggles (eaten) and
// new food appears (regen) -- both at end-of-tick resolution, so food is STABLE during the parallel perceive phase.
//
// Layout is data-only here (no scan/resolution logic) -- that stays architecture-dependent and waits on the
// productionization review. This buffer shape is fixed by the engine, so it is safe to define now.

export const FD_POSX = 0;
export const FD_POSY = 1;
export const FD_TYPE = 2;
export const FD_ALIVE = 3;
export const FD_ENERGY = 4;
export const FD_STRIDE = 5;

// maxFood must cover the peak living food count (founders' food + regen headroom). Regen mints monotonic ids like
// swimbots; a real pool caps/recycles -- capacity policy is a review question (fixed cap vs grow). For a fixed-N
// probe, size generously.
export function makeFoodBuffer(maxFood) {
    return new SharedArrayBuffer(maxFood * FD_STRIDE * Float64Array.BYTES_PER_ELEMENT);
}

export function writeFood(f64, id, { x, y, type, alive, energy }) {
    const o = id * FD_STRIDE;
    f64[o + FD_POSX] = x;
    f64[o + FD_POSY] = y;
    f64[o + FD_TYPE] = type;
    f64[o + FD_ALIVE] = alive ? 1 : 0;
    f64[o + FD_ENERGY] = energy;
}
