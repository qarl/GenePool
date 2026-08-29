// PRODUCTIONIZE S0 — the worker now uses the SHARED engine/perception.js selection (was a replica). It only
// supplies HOW candidates are enumerated: swimbots from the cooperative shared grid (query by id -> SlotView) or,
// for the single-thread reference, a per-worker JS grid it rebuilds. Food is still omitted here (S1 adds the food
// SoA + food grid + food enumeration); until then enumerateFood yields nothing (foundFoodBit=false). Using the
// shared selector is what lets the parallel result be BIT-IDENTICAL to the engine instead of drifting.

import { Perception } from '../../../engine/perception.js';
import { SpatialGrid } from '../../../engine/spatialGrid.js';
import { STRIDE, F_ALIVE, F_GX, F_GY, SlotView } from './frozen-layout.mjs';

const NO_FOOD = () => {}; // enumerateFood no-op until S1

export class Perceiver {
    constructor(f64, maxBots, matePref, viewRadius, obstacle, coopGrid = null, numFoodTypes = 1) {
        this._f64 = f64;
        this._viewRadius = viewRadius;
        this._obstacle = obstacle;
        this._numFoodTypes = numFoodTypes;
        this._coopGrid = coopGrid;                       // if set, query it; else rebuild+use a local JS grid
        this._grid = coopGrid ? null : new SpatialGrid(viewRadius);
        this._views = new Array(maxBots);
        for (let id = 0; id < maxBots; id++) this._views[id] = new SlotView(f64, id, matePref, viewRadius);
        this._perception = new Perception();             // the SHARED engine selector
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
        this._perception.perceive(bot, tick, this._viewRadius, this._obstacle, this._numFoodTypes, enumerateSwimbots, NO_FOOD);
    }
}
