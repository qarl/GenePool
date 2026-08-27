// Brain — forked from JJ's Brain.js as an ES module (PLAN-restructure.md §15).
//
// A tiny energy-gated FSM: below the hunger threshold it looks for / pursues food; otherwise it looks
// for / pursues a mate. RNG-free. Field-for-field faithful to the original transitions (the swimbot
// tick is bit-exact against JJ, so the exact branch order matters).

import {
    BRAIN_STATE_NULL,
    BRAIN_STATE_LOOKING_FOR_MATE,
    BRAIN_STATE_PURSUING_MATE,
    BRAIN_STATE_LOOKING_FOR_FOOD,
    BRAIN_STATE_PURSUING_FOOD,
    NUM_BRAIN_STATES,
    ZERO,
} from './constants.js';
import { assert } from './assert.js';

export class Brain {
    constructor() {
        this._state = BRAIN_STATE_NULL;
        this._energy = ZERO;
        this._foundFoodBit = false;
        this._foundSwimbot = false;
        this._hungerThreshold = ZERO;
    }

    initialize() {
        this._state = BRAIN_STATE_NULL;
    }

    update() {
        // if low energy, look for food, otherwise, look for sex
        if (this._energy < this._hungerThreshold) {
            if ((this._state !== BRAIN_STATE_PURSUING_FOOD)
                && (this._state !== BRAIN_STATE_LOOKING_FOR_FOOD)) {
                this._state = BRAIN_STATE_LOOKING_FOR_FOOD;
            }
        } else {
            if ((this._state !== BRAIN_STATE_PURSUING_MATE)
                && (this._state !== BRAIN_STATE_LOOKING_FOR_MATE)) {
                this._state = BRAIN_STATE_LOOKING_FOR_MATE;
            }
        }

        if (this._state === BRAIN_STATE_LOOKING_FOR_FOOD) {
            if (this._foundFoodBit) {
                this._state = BRAIN_STATE_PURSUING_FOOD;
            }
        } else if (this._state === BRAIN_STATE_PURSUING_FOOD) {
            if (!this._foundFoodBit) {
                this._state = BRAIN_STATE_LOOKING_FOR_FOOD;
            }
        } else if (this._state === BRAIN_STATE_LOOKING_FOR_MATE) {
            if (this._foundSwimbot) {
                this._state = BRAIN_STATE_PURSUING_MATE;
            }
        } else if (this._state === BRAIN_STATE_PURSUING_MATE) {
            if (!this._foundSwimbot) {
                this._state = BRAIN_STATE_LOOKING_FOR_MATE;
            }
        }

        assert(this._state < NUM_BRAIN_STATES, '_state < NUM_BRAIN_STATES');
        assert(this._state > BRAIN_STATE_NULL, '_state > BRAIN_STATE_NULL');
    }

    setEnergyLevel(e) { this._energy = e; }
    setHungerThreshold(h) { this._hungerThreshold = h; }
    setFoundFoodBit(f) { this._foundFoodBit = f; }
    setFoundSwimbot(f) { this._foundSwimbot = f; }

    getHungerThreshold() { return this._hungerThreshold; }
    getState() { return this._state; }
}
