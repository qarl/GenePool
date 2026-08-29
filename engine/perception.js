// Shared perception selection (Parallelism productionization S0). ONE implementation of "what a swimbot perceives
// this tick" -- the CLOSEST-20 visible non-obstructed swimbots (via a (d2,id) min-heap partial-select + lazy
// obstruction) and the closest visible food of the preferred type -- fed to bot.setEnvironmentalStimuli. It was
// inlined in world.js#_giveSwimbotNearbyEnvironmentalStimuli; extracting it (behavior-preserving, guarded by the
// full engine suite) lets the single-thread World AND the worker-parallel path share EXACTLY the same selection,
// so the parallel result can be bit-identical to the engine instead of drifting from a replica.
//
// The only thing that varies between callers is HOW candidates near a point are enumerated (live Map / JS grid /
// snapshot views / a cooperative shared grid), so that is injected: `enumerateSwimbots(gpos, consider)` and
// `enumerateFood(mpos, consider)` call `consider(candidate)` for each entity in the neighborhood (a SUPERSET; the
// exact filters below narrow it). Candidates are duck-typed: swimbots need getIndex/getAlive/getGenitalPosition/
// getAge/getEnergy/getAttractiveness; food needs getIndex/getAlive/getType/getPosition. Self is skipped by id
// (unique -> identical to the old object-identity check). The looker's own gpos/mpos stay live (its own state).

import { BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS } from './constants.js';

export class Perception {
    constructor() {
        this._candidates = [];   // scratch: in-view swimbot candidates {other, d2, id}, heap-selected below
        this._nearbyArray = new Array(BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS);
        this._numNearby = 0;     // count of the last perceive()'s selected nearby array (result introspection)
    }

    // Min-heap sift-down over [0,n) ordered by (d2 asc, id asc) -- a strict total order (ids unique), so heap-pop
    // order == a full sort. Identical to the former World._siftDownCandidates.
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

    // Perceive for `bot` at `tick`. Fills the closest-20 nearby array + closest food, then hands them to the bot's
    // own setEnvironmentalStimuli (mate argmax / food branch). Bit-for-bit the former inlined logic.
    perceive(bot, tick, viewRadius, obstacle, numFoodTypes, enumerateSwimbots, enumerateFood) {
        const cands = this._candidates;
        cands.length = 0;
        const gpos = bot.getGenitalPosition(); // looker's LIVE genital (its own; order-independent)
        const vr2 = viewRadius * viewRadius;
        const selfId = bot.getIndex();
        enumerateSwimbots(gpos, (other) => {
            if (other.getIndex() === selfId || !other.getAlive()) return;
            const d2 = gpos.getDistanceSquaredTo(other.getGenitalPosition());
            if (d2 < vr2) cands.push({ other, d2, id: other.getIndex() }); // obstruction checked LAZILY below
        });

        // CLOSEST-20 via min-heap partial-select + lazy obstruction: pop in (d2,id) order, obstruction-test only
        // the popped, take the first BRAIN_MAX_PERCEIVED that pass -> identical selected set+order as sort+take.
        let heapSize = cands.length;
        for (let i = (heapSize >> 1) - 1; i >= 0; i--) this._siftDown(cands, i, heapSize); // Floyd heapify
        let numNearby = 0;
        while (heapSize > 0 && numNearby < BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS) {
            const top = cands[0];
            heapSize--;
            if (heapSize > 0) { cands[0] = cands[heapSize]; this._siftDown(cands, 0, heapSize); }
            if (!obstacle.getObstruction(gpos, top.other.getGenitalPosition())) {
                this._nearbyArray[numNearby++] = top.other;
            }
        }
        this._numNearby = numNearby; // expose the result count (introspection / tests)

        // closest visible food (of the preferred type when 2 food types); id tiebreak on equal distance -> the
        // choice is independent of enumeration order.
        let foundFoodBit = false;
        let chosenFoodBit = null;
        let smallestDistance = Number.MAX_SAFE_INTEGER;
        let chosenFoodId = Infinity;
        const mpos = bot.getMouthPosition();
        const preferredType = bot.getPreferredFoodType(); // constant during perception (hoist; value-identical)
        enumerateFood(mpos, (food) => {
            if (!food.getAlive()) return;
            if (numFoodTypes === 2 && food.getType() !== preferredType) return;
            const viewDistance = mpos.getDistanceTo(food.getPosition());
            if (viewDistance < viewRadius) {
                const distance = viewDistance / viewRadius;
                const id = food.getIndex();
                if ((distance < smallestDistance) || (distance === smallestDistance && id < chosenFoodId)) {
                    if (!obstacle.getObstruction(mpos, food.getPosition())) {
                        smallestDistance = distance;
                        chosenFoodId = id;
                        chosenFoodBit = food;
                        foundFoodBit = true;
                    }
                }
            }
        });

        bot.setEnvironmentalStimuli(numNearby, this._nearbyArray, foundFoodBit, chosenFoodBit, tick);
    }
}
