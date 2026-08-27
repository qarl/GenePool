// FoodBit — forked from JJ's FoodBit.js as an ES module (PLAN-restructure.md §15).
//
// MINIMAL for the rung-1 eating path: a food bit is a position + energy + type + identity, and
// getAlive() is "has a valid index" (JJ's convention). The ecology (spawn / regen / randomize) is
// ported with the food subsystem in a later slice. Placement helpers will take an INJECTED rng (§3).

import { NULL_INDEX, ZERO } from './constants.js';
import { Vector2D } from './vector2d.js';

export class FoodBit {
    constructor() {
        this._position = new Vector2D();
        this._energy = ZERO;
        this._type = 0;
        this._index = NULL_INDEX;
    }

    setPosition(p) { this._position.set(p); }
    setEnergy(e) { this._energy = e; }
    setType(n) { this._type = n; }
    setIndex(i) { this._index = i; }
    kill() { this._index = NULL_INDEX; }

    getPosition() { return this._position; }
    getEnergy() { return this._energy; }
    getType() { return this._type; }
    getIndex() { return this._index; }
    getAlive() { return this._index !== NULL_INDEX; }
}
