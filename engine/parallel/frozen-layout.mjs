// SPIKE (intra-tick parallelism, Step 3 probe). The shared frozen-snapshot layout: the SMALL per-bot view that
// crosses threads. In worker-owns-partition parallelism each worker keeps the HEAVY bot state (phenotype/brain/
// vectors) in its OWN heap and never ships it; the only thing shared is this frozen tick-start view, packed as a
// Structure-of-Arrays into a SharedArrayBuffer. Every worker writes its own bots' slots, then (after a barrier)
// reads every bot's slot to perceive. 11 float64s/bot -> 88 bytes/bot -> ~0.9MB for 10k bots.
//
// This is a PERF PROBE, not the production engine: it mirrors exactly the fields perception + attractiveness read
// of OTHER bots (proven set from world.js/swimbot.js). If the spike shows real speedup, this layout graduates
// into the hardened build (plus genotype for the birth junk-DNA gate, which the no-birth spike omits).

import {
    ATTRACTION_COLORFUL, ATTRACTION_BIG, ATTRACTION_HYPER, ATTRACTION_LONG, ATTRACTION_STRAIGHT,
    ATTRACTION_NO_COLOR, ATTRACTION_SMALL, ATTRACTION_STILL, ATTRACTION_SHORT, ATTRACTION_CROOKED,
    ATTRACTION_SIMILAR_COLOR, ATTRACTION_SIMILAR_SIZE, ATTRACTION_SIMILAR_HYPER,
    ATTRACTION_SIMILAR_LENGTH, ATTRACTION_SIMILAR_STRAIGHT, ATTRACTION_CLOSEST,
} from '../constants.js';
import { attractivenessOf, CRITERIA_NEEDING_JUDGE_METRIC, computeMetricForCriterion } from '../attraction.js';

// Per-bot field offsets within a slot, and the slot stride.
export const F_ALIVE = 0;   // 0/1
export const F_AGE = 1;
export const F_ENERGY = 2;
export const F_GX = 3;      // genital x (nearby-scan distance + obstruction)
export const F_GY = 4;      // genital y
export const F_RX = 5;      // root (body) x -- getPosition, for the CLOSEST criterion
export const F_RY = 6;      // root (body) y
export const F_CRIT = 7;    // attraction criterion (the candidate's own)
export const F_MA = 8;      // attraction metric slot A (single value, or avgColor.red)
export const F_MB = 9;      // avgColor.green (SIMILAR_COLOR only)
export const F_MC = 10;     // avgColor.blue  (SIMILAR_COLOR only)
export const STRIDE = 11;

export function makeFrozenBuffer(maxBots) {
    return new SharedArrayBuffer(maxBots * STRIDE * Float64Array.BYTES_PER_ELEMENT);
}

// Pack a bot's frozen view into its slot. `metric` is the object from attraction.js#computeMetricForCriterion
// (only the ONE field the criterion reads is populated). root is always stored (cheap; CLOSEST needs it).
export function writeSlot(f64, id, { alive, age, energy, genitalX, genitalY, rootX, rootY, criterion, metric }) {
    const o = id * STRIDE;
    f64[o + F_ALIVE] = alive ? 1 : 0;
    f64[o + F_AGE] = age;
    f64[o + F_ENERGY] = energy;
    f64[o + F_GX] = genitalX;
    f64[o + F_GY] = genitalY;
    f64[o + F_RX] = rootX;
    f64[o + F_RY] = rootY;
    f64[o + F_CRIT] = criterion;
    let a = 0, b = 0, c = 0;
    if (metric) {
        if (metric.colorSaturation !== undefined) a = metric.colorSaturation;
        else if (metric.bigness !== undefined) a = metric.bigness;
        else if (metric.hyperness !== undefined) a = metric.hyperness;
        else if (metric.longness !== undefined) a = metric.longness;
        else if (metric.straightness !== undefined) a = metric.straightness;
        else if (metric.avgColor !== undefined) { a = metric.avgColor.red; b = metric.avgColor.green; c = metric.avgColor.blue; }
        // CLOSEST/RANDOM: no metric field -> a/b/c stay 0 (closeness reads root; random reads matePref)
    }
    f64[o + F_MA] = a; f64[o + F_MB] = b; f64[o + F_MC] = c;
}

// Rebuild the partial-metrics object attractivenessOf expects, from a slot (inverse of writeSlot's packing).
export function metricFromSlot(criterion, a, b, c, rootX, rootY) {
    switch (criterion) {
        case ATTRACTION_COLORFUL: case ATTRACTION_NO_COLOR: return { colorSaturation: a };
        case ATTRACTION_BIG: case ATTRACTION_SMALL: case ATTRACTION_SIMILAR_SIZE: return { bigness: a };
        case ATTRACTION_HYPER: case ATTRACTION_STILL: case ATTRACTION_SIMILAR_HYPER: return { hyperness: a };
        case ATTRACTION_LONG: case ATTRACTION_SHORT: case ATTRACTION_SIMILAR_LENGTH: return { longness: a };
        case ATTRACTION_STRAIGHT: case ATTRACTION_CROOKED: case ATTRACTION_SIMILAR_STRAIGHT: return { straightness: a };
        case ATTRACTION_SIMILAR_COLOR: return { avgColor: { red: a, green: b, blue: c } };
        case ATTRACTION_CLOSEST: return { rootX, rootY };
        default: return {};
    }
}

// A read-only candidate view backed by a shared-buffer slot. Duck-types the subset of Swimbot the perception /
// mate-selection path reads of OTHER bots (getIndex/getAlive/getAge/getEnergy/getGenitalPosition/getAttractiveness)
// -- so it drops straight into the existing setEnvironmentalStimuli + steering with no engine changes. One
// persistent instance per id per worker (bound once); every getter reads live from the frozen slot (which is
// immutable during the perception phase). getAttractiveness mirrors FrozenSwimbot exactly (same proven path).
export class SlotView {
    constructor(f64, id, matePref, viewRadius) {
        this._f64 = f64; this._id = id; this._matePref = matePref; this._viewRadius = viewRadius;
        this._genital = { x: 0, y: 0 };
    }
    // Point this view at a new frozen buffer (grow-on-near-full reallocated it). CRITICAL: mutate IN PLACE rather
    // than build a fresh SlotView, because a swimbot holds its _chosenMate as THIS object across ticks during
    // mate pursuit (perception is periodic) -- replacing the object would orphan that reference to the old buffer,
    // and the pursuer would keep steering toward the mate's pre-grow (frozen) position. Same reason chosenFood.
    rebind(f64) { this._f64 = f64; }
    getIndex() { return this._id; }
    getAlive() { return this._f64[this._id * STRIDE + F_ALIVE] === 1; }
    getAge() { return this._f64[this._id * STRIDE + F_AGE]; }
    getEnergy() { return this._f64[this._id * STRIDE + F_ENERGY]; }
    getGenitalPosition() {
        const o = this._id * STRIDE;
        this._genital.x = this._f64[o + F_GX]; this._genital.y = this._f64[o + F_GY];
        return this._genital;
    }
    getAttractiveness(judge, tick) {
        const o = this._id * STRIDE;
        const crit = this._f64[o + F_CRIT];
        const candMetric = metricFromSlot(crit, this._f64[o + F_MA], this._f64[o + F_MB], this._f64[o + F_MC], this._f64[o + F_RX], this._f64[o + F_RY]);
        const judgeMetric = CRITERIA_NEEDING_JUDGE_METRIC.has(crit) ? computeMetricForCriterion(judge, crit) : {};
        return attractivenessOf(candMetric, judgeMetric, crit, tick, this._matePref, this._id, judge.getIndex(), this._viewRadius);
    }
}
