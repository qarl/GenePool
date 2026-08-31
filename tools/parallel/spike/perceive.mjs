// PRODUCTIONIZE S0 — the worker now uses the SHARED engine/perception.js selection (was a replica). It only
// supplies HOW candidates are enumerated: swimbots from the cooperative shared grid (query by id -> SlotView) or,
// for the single-thread reference, a per-worker JS grid it rebuilds. Food is still omitted here (S1 adds the food
// SoA + food grid + food enumeration); until then enumerateFood yields nothing (foundFoodBit=false). Using the
// shared selector is what lets the parallel result be BIT-IDENTICAL to the engine instead of drifting.

import { Perception } from '../../../engine/perception.js';
import { SpatialGrid } from '../../../engine/spatialGrid.js';
import { STRIDE, F_ALIVE, F_GX, F_GY, SlotView } from './frozen-layout.mjs';
import { FoodSlotView } from './food-layout.mjs';

export class Perceiver {
    // foodGrid: a prebuilt read-only CoopGrid over the food SoA (foodF64); foodCapacity = max food ids (regen
    // grows the id space, so views must cover the CAPACITY, not just the initial count). enumerateFood queries it.
    constructor(f64, maxBots, matePref, viewRadius, obstacle, coopGrid = null, numFoodTypes = 1, foodGrid = null, foodF64 = null, foodCapacity = 0) {
        this._f64 = f64;
        this._matePref = matePref;                       // stored so rebind() can rebuild SlotViews on a grow
        this._viewRadius = viewRadius;
        this._obstacle = obstacle;
        this._numFoodTypes = numFoodTypes;
        this._coopGrid = coopGrid;                       // if set, query it; else rebuild+use a local JS grid
        this._grid = coopGrid ? null : new SpatialGrid(viewRadius);
        this._views = new Array(maxBots);
        for (let id = 0; id < maxBots; id++) this._views[id] = new SlotView(f64, id, matePref, viewRadius);
        this._foodGrid = foodGrid;
        this._foodViews = new Array(foodCapacity);
        for (let id = 0; id < foodCapacity; id++) this._foodViews[id] = new FoodSlotView(foodF64, id);
        this._perception = new Perception();             // the SHARED engine selector
    }

    // Grow (grow-on-near-full): the frozen SoA was reallocated bigger. MUTATE the existing SlotViews to point at the
    // new buffer (do NOT replace them) -- a pursuing swimbot holds one of these as its _chosenMate across ticks, so
    // replacing the object would leave it reading the OLD (pre-grow, never-updated) buffer -> the pursuer steers to
    // the mate's stale position. Only ids >= the old capacity get fresh views (no bot references them yet).
    rebindGrow(f64, maxBots, coopGrid) {
        this._f64 = f64;
        this._coopGrid = coopGrid;
        const old = this._views, oldLen = old.length;
        const views = new Array(maxBots);
        for (let id = 0; id < maxBots; id++) {
            if (id < oldLen) { old[id].rebind(f64); views[id] = old[id]; } // preserve object identity (held _chosenMate follows)
            else views[id] = new SlotView(f64, id, this._matePref, this._viewRadius);
        }
        this._views = views;
    }

    // Food-grow (grow-on-near-full): the food SoA was reallocated bigger. Same in-place discipline as rebindGrow --
    // MUTATE existing FoodSlotViews (a forager holds one as _chosenFood across ticks); only ids >= the old food
    // capacity get fresh views. foodGrid is the new (bigger) food grid.
    rebindFoodGrow(foodF64, maxFood, foodGrid) {
        this._foodGrid = foodGrid;
        const old = this._foodViews, oldLen = old.length;
        const views = new Array(maxFood);
        for (let id = 0; id < maxFood; id++) {
            if (id < oldLen) { old[id].rebind(foodF64); views[id] = old[id]; }
            else views[id] = new FoodSlotView(foodF64, id);
        }
        this._foodViews = views;
    }

    // JS-grid mode only: rebuild the local grid from the shared frozen buffer (O(n) per worker -- the cost the
    // coop grid eliminates). No-op in coop mode (the grid is built cooperatively via count/scatter).
    rebuild(maxBots) {
        if (this._coopGrid) return;
        const f64 = this._f64, grid = this._grid;
        grid.clear();
        for (let id = 0; id < maxBots; id++) {
            const o = id * STRIDE;
            if (f64[o + F_ALIVE] !== 1) continue;
            grid.insert(this._views[id], f64[o + F_GX], f64[o + F_GY]);
        }
    }

    perceive(bot, tick) {
        const views = this._views;
        const enumerateSwimbots = this._coopGrid
            ? (gpos, consider) => this._coopGrid.query(gpos.x, gpos.y, (id) => consider(views[id]))
            : (gpos, consider) => this._grid.forEachNear(gpos.x, gpos.y, consider);
        const foodViews = this._foodViews;
        const enumerateFood = this._foodGrid
            ? (mpos, consider) => this._foodGrid.query(mpos.x, mpos.y, (id) => consider(foodViews[id]))
            : () => {}; // no food grid (pre-S1 probes)
        this._perception.perceive(bot, tick, this._viewRadius, this._obstacle, this._numFoodTypes, enumerateSwimbots, enumerateFood);
    }
}
