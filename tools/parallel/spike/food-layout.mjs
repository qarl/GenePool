// SPIKE/PRODUCTIONIZE — the shared FOOD SoA. Workers can't see the main thread's FoodBit objects, so food lives
// in a SharedArrayBuffer just like the swimbot frozen snapshot. Fields are exactly what the engine's food path
// reads: the food scan (world.js#_giveSwimbotNearbyEnvironmentalStimuli) reads position + type + alive; eating
// (swimbot.js#eatChosenFoodBit) reads energy + type + alive. Food never moves; only `alive` toggles (eaten) and
// new food appears (regen) -- both at end-of-tick resolution, so food is STABLE during the parallel perceive phase.
//
// Layout is data-only here (no scan/resolution logic) -- that stays architecture-dependent and waits on the
// productionization review. This buffer shape is fixed by the engine, so it is safe to define now.

import { allocCoopGrid, CoopGrid } from './coop-grid.mjs';

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

// A read-only food candidate view backed by a shared-buffer slot. Duck-types the subset of FoodBit the food scan
// reads (getIndex/getAlive/getType/getPosition). One persistent instance per id per worker. getPosition returns
// {x,y} (only read for .x/.y as the 2nd arg of distance/obstruction). alive is read live so an eaten food (S2+,
// slot flipped to 0) is filtered by the scan even though the static grid still lists its id.
export class FoodSlotView {
    constructor(f64, id) { this._f64 = f64; this._id = id; this._pos = { x: 0, y: 0 }; }
    getIndex() { return this._id; }
    getAlive() { return this._f64[this._id * FD_STRIDE + FD_ALIVE] === 1; }
    getType() { return this._f64[this._id * FD_STRIDE + FD_TYPE]; }
    getEnergy() { return this._f64[this._id * FD_STRIDE + FD_ENERGY]; }
    getPosition() {
        const o = this._id * FD_STRIDE;
        this._pos.x = this._f64[o + FD_POSX]; this._pos.y = this._f64[o + FD_POSY];
        return this._pos;
    }
}

// Build a CoopGrid over the food SoA ONCE (serial). Food positions are static, so the grid is prebuilt and then
// read-only for perception; an eaten food is filtered by the alive flag (grid needn't change). Regen (S2+) that
// ADDS food is the only thing that will require re-inserting. `grid` is a CoopGrid; `numFood` its id count.
export function buildFoodGridOnce(grid, f64, numFood) {
    grid.zeroCellRange(0, 1);
    for (let id = 0; id < numFood; id++) {
        if (f64[id * FD_STRIDE + FD_ALIVE] !== 1) continue;
        grid.countOne(f64[id * FD_STRIDE + FD_POSX], f64[id * FD_STRIDE + FD_POSY]);
    }
    grid.prefixSum();
    for (let id = 0; id < numFood; id++) {
        if (f64[id * FD_STRIDE + FD_ALIVE] !== 1) continue;
        grid.scatterOne(id, f64[id * FD_STRIDE + FD_POSX], f64[id * FD_STRIDE + FD_POSY]);
    }
}

// One-shot food setup shared by the baseline and the parallel run so both perceive IDENTICAL food. Allocates the
// food SoA, writes the food records (all alive), allocates a food CoopGrid and builds it once. maxFood caps ids
// (regen headroom, S2+). Returns everything the workers/baseline need (spec is SAB-backed -> passable to workers).
export function setupFood(food, pool, cellSize, maxFood) {
    const foodSab = makeFoodBuffer(maxFood);
    const foodF64 = new Float64Array(foodSab);
    for (let i = 0; i < food.length; i++) writeFood(foodF64, i, { x: food[i].x, y: food[i].y, type: food[i].type, alive: true, energy: food[i].energy });
    const foodGridSpec = allocCoopGrid(pool, cellSize, maxFood);
    const foodGrid = new CoopGrid(foodGridSpec);
    buildFoodGridOnce(foodGrid, foodF64, food.length);
    return { foodSab, foodF64, foodGridSpec, foodGrid, numFood: food.length };
}
