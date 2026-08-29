// SPIKE — the per-bot perception work a worker runs, REPLICATED from world.js#_giveSwimbotNearbyEnvironmentalStimuli
// (the swimbot nearby-scan + closest-20 min-heap + lazy obstruction + the mate argmax inside setEnvironmentalStimuli).
// It runs against SlotView candidates (shared-buffer-backed). This is a PERF PROBE: it OMITS the food scan (the
// spike disables ecology for a stable measurement), so it passes foundFoodBit=false. If the spike validates, this
// logic gets shared with world.js (one implementation) rather than duplicated.
//
// Candidate source is either a COOP grid (query by id -> view; built cooperatively, no per-worker rebuild) or a
// per-worker JS grid (the old path, kept as the single-thread reference for the A/B). Selection is identical.

import { BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS } from '../../../engine/constants.js';
import { SpatialGrid } from '../../../engine/spatialGrid.js';
import { STRIDE, F_ALIVE, F_GX, F_GY, SlotView } from './frozen-layout.mjs';

export class Perceiver {
    constructor(f64, maxBots, matePref, viewRadius, obstacle, coopGrid = null) {
        this._f64 = f64;
        this._viewRadius = viewRadius;
        this._obstacle = obstacle;
        this._coopGrid = coopGrid;                       // if set, query it; else rebuild+use a local JS grid
        this._grid = coopGrid ? null : new SpatialGrid(viewRadius);
        this._views = new Array(maxBots);
        for (let id = 0; id < maxBots; id++) this._views[id] = new SlotView(f64, id, matePref, viewRadius);
        this._candidates = [];
        this._nearbyArray = new Array(BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS);
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

    _siftDown(heap, i, n) {
        for (;;) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            let s = heap[smallest];
            if (l < n) { const c = heap[l]; if (c.d2 < s.d2 || (c.d2 === s.d2 && c.id < s.id)) { smallest = l; s = c; } }
            if (r < n) { const c = heap[r]; if (c.d2 < s.d2 || (c.d2 === s.d2 && c.id < s.id)) { smallest = r; s = c; } }
            if (smallest === i) return;
            heap[smallest] = heap[i]; heap[i] = s;
            i = smallest;
        }
    }

    // Perceive for a LIVE local bot: closest-20 visible non-obstructed swimbots (frozen views), then hand them to
    // the bot's own setEnvironmentalStimuli (mate argmax / rescan). Faithful to world.js selection.
    perceive(bot, tick) {
        const cands = this._candidates;
        cands.length = 0;
        const gpos = bot.getGenitalPosition(); // looker LIVE genital (its own; order-independent)
        const vr2 = this._viewRadius * this._viewRadius;
        const selfId = bot.getIndex();
        const views = this._views;
        const consider = (view) => {
            if (view.getIndex() === selfId || !view.getAlive()) return;
            const d2 = gpos.getDistanceSquaredTo(view.getGenitalPosition());
            if (d2 < vr2) cands.push({ other: view, d2, id: view.getIndex() });
        };
        if (this._coopGrid) {
            this._coopGrid.query(gpos.x, gpos.y, (id) => consider(views[id]));
        } else {
            this._grid.forEachNear(gpos.x, gpos.y, consider);
        }

        let heapSize = cands.length;
        for (let i = (heapSize >> 1) - 1; i >= 0; i--) this._siftDown(cands, i, heapSize);
        let numNearby = 0;
        while (heapSize > 0 && numNearby < BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS) {
            const top = cands[0];
            heapSize--;
            if (heapSize > 0) { cands[0] = cands[heapSize]; this._siftDown(cands, 0, heapSize); }
            if (!this._obstacle.getObstruction(gpos, top.other.getGenitalPosition())) {
                this._nearbyArray[numNearby++] = top.other;
            }
        }

        // Food scan omitted (spike): foundFoodBit=false, theFoodBit=null.
        bot.setEnvironmentalStimuli(numNearby, this._nearbyArray, false, null, tick);
    }
}
