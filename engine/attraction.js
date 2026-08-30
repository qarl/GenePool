// Pure attraction helpers (Parallelism Step 1a). These let mate attractiveness be computed from a plain
// METRICS struct instead of a live Swimbot, which is what snapshot-perception mode (order-independent, for
// parallelism) needs: a judge scores a FROZEN candidate. `attractivenessOf` is a bit-for-bit mirror of
// Swimbot.getAttractiveness (proven in test/engine/attraction-parity.test.js) -- so mixed-live's getAttractiveness
// stays UNTOUCHED (the faithful default is unchanged) while snapshot mode calls this with frozen candidate
// metrics + the live judge's metrics. No RNG state: `matePref` is the addressed (stateless) MATE_PREF draw.

import {
    ONE, ONE_THIRD,
    ATTRACTION_COLORFUL, ATTRACTION_BIG, ATTRACTION_HYPER, ATTRACTION_LONG, ATTRACTION_STRAIGHT,
    ATTRACTION_NO_COLOR, ATTRACTION_SMALL, ATTRACTION_STILL, ATTRACTION_SHORT, ATTRACTION_CROOKED,
    ATTRACTION_SIMILAR_COLOR, ATTRACTION_SIMILAR_SIZE, ATTRACTION_SIMILAR_HYPER,
    ATTRACTION_SIMILAR_LENGTH, ATTRACTION_SIMILAR_STRAIGHT, ATTRACTION_CLOSEST, ATTRACTION_RANDOM,
} from './constants.js';
import { FLAT } from './topology.js';

// A swimbot's attraction-relevant metrics -- the candidate view a judge reads. Calls the swimbot's own
// getters so it stays consistent with the live methods (parity-tested). STATIC-within-a-tick metrics
// (colorSaturation/avgColor/bigness) and DYNAMIC ones (hyperness/longness/straightness, root position) are
// all captured, so a frozen copy answers every attraction criterion.
export function computeAttractionMetrics(sb) {
    const pos = sb.getPosition();
    return {
        colorSaturation: sb.getColorSaturation(),
        avgColor: sb.getAverageColor(),
        bigness: sb.getCurrentBodyBigness(),
        hyperness: sb.getCurrentBodyHyperness(),
        longness: sb.getCurrentBodyLongness(),
        straightness: sb.getCurrentBodyStraightness(),
        rootX: pos.x, rootY: pos.y,
    };
}

// The metric a criterion ACTUALLY reads -- so snapshot mode computes ONLY that one per bot per tick, not the
// whole six-field struct (getCurrentBodyLongness/Straightness are O(parts^2) and Straightness allocates, so
// computing all six for every bot every tick dominated the snapshot cost). attractivenessOf's if-chain touches
// exactly cand.<oneField> (and, for the similarity/closest criteria, judge.<sameField>) for a given criterion;
// every other field is untouched, so a PARTIAL metrics object holding just that field yields a BIT-IDENTICAL
// result to the full computeAttractionMetrics (proven by the same parity tests). RANDOM reads no metric.
export function computeMetricForCriterion(sb, criterion) {
    switch (criterion) {
        case ATTRACTION_COLORFUL: case ATTRACTION_NO_COLOR: return { colorSaturation: sb.getColorSaturation() };
        case ATTRACTION_BIG: case ATTRACTION_SMALL: case ATTRACTION_SIMILAR_SIZE: return { bigness: sb.getCurrentBodyBigness() };
        case ATTRACTION_HYPER: case ATTRACTION_STILL: case ATTRACTION_SIMILAR_HYPER: return { hyperness: sb.getCurrentBodyHyperness() };
        case ATTRACTION_LONG: case ATTRACTION_SHORT: case ATTRACTION_SIMILAR_LENGTH: return { longness: sb.getCurrentBodyLongness() };
        case ATTRACTION_STRAIGHT: case ATTRACTION_CROOKED: case ATTRACTION_SIMILAR_STRAIGHT: return { straightness: sb.getCurrentBodyStraightness() };
        case ATTRACTION_SIMILAR_COLOR: return { avgColor: sb.getAverageColor() };
        case ATTRACTION_CLOSEST: { const p = sb.getPosition(); return { rootX: p.x, rootY: p.y }; }
        default: return {}; // ATTRACTION_RANDOM (and any out-of-range) -> matePref only, no metric read
    }
}

// The criteria whose score reads a JUDGE metric too (the "similar-to-me" family + closest). For every other
// criterion the judge's metrics are never read, so snapshot mode can skip computing them entirely.
export const CRITERIA_NEEDING_JUDGE_METRIC = new Set([
    ATTRACTION_SIMILAR_COLOR, ATTRACTION_SIMILAR_SIZE, ATTRACTION_SIMILAR_HYPER,
    ATTRACTION_SIMILAR_LENGTH, ATTRACTION_SIMILAR_STRAIGHT, ATTRACTION_CLOSEST,
]);

// colorSimilarity(cand, judge) -- mirrors Swimbot.getColorSimilarity (this=cand c2, judge=c1).
function colorSimilarity(cand, judge) {
    const rDiff = Math.abs(cand.red - judge.red);
    const gDiff = Math.abs(cand.green - judge.green);
    const bDiff = Math.abs(cand.blue - judge.blue);
    return ONE - ((rDiff + gDiff + bDiff) * ONE_THIRD);
}

// closeness -- mirrors Swimbot.getCloseness: distance cand<->judge via the §7 topology seam (flat: plain
// hypot, bit-identical to the old inline sqrt; torus would minimum-image it at P4).
function closeness(cand, judge, viewRadius, topology) {
    const distance = topology.distance(cand.rootX, cand.rootY, judge.rootX, judge.rootY);
    const closest = distance < viewRadius ? distance : viewRadius;
    return ONE - (closest / viewRadius);
}

// Bit-for-bit mirror of Swimbot.getAttractiveness(judge, tick): attractiveness of `cand` as judged by
// `judge` (both METRICS structs), for `criterion` (the CANDIDATE's own brain criterion). matePref is
// matePref(judgeId, candId, tick, drawIdx). Same mutually-exclusive if-chain + same draw structure (idx 0
// always, idx 1 only for RANDOM) as the live method, so it is identical (parity-tested).
export function attractivenessOf(cand, judge, criterion, tick, matePref, candId, judgeId, viewRadius, topology = FLAT) {
    let a = matePref(judgeId, candId, tick, 0);

    if (criterion === ATTRACTION_COLORFUL) a = cand.colorSaturation;
    if (criterion === ATTRACTION_BIG) a = cand.bigness;
    if (criterion === ATTRACTION_HYPER) a = cand.hyperness;
    if (criterion === ATTRACTION_LONG) a = cand.longness;
    if (criterion === ATTRACTION_STRAIGHT) a = cand.straightness;

    if (criterion === ATTRACTION_NO_COLOR) a = ONE - cand.colorSaturation;
    if (criterion === ATTRACTION_SMALL) a = ONE - cand.bigness;
    if (criterion === ATTRACTION_STILL) a = ONE - cand.hyperness;
    if (criterion === ATTRACTION_SHORT) a = ONE - cand.longness;
    if (criterion === ATTRACTION_CROOKED) a = ONE - cand.straightness;

    if (criterion === ATTRACTION_SIMILAR_COLOR) a = colorSimilarity(cand.avgColor, judge.avgColor);
    if (criterion === ATTRACTION_SIMILAR_SIZE) a = ONE - Math.abs(judge.bigness - cand.bigness);
    if (criterion === ATTRACTION_SIMILAR_HYPER) a = ONE - Math.abs(judge.hyperness - cand.hyperness);
    if (criterion === ATTRACTION_SIMILAR_LENGTH) a = ONE - Math.abs(judge.longness - cand.longness);
    if (criterion === ATTRACTION_SIMILAR_STRAIGHT) a = ONE - Math.abs(judge.straightness - cand.straightness);

    if (criterion === ATTRACTION_CLOSEST) a = closeness(cand, judge, viewRadius, topology);
    if (criterion === ATTRACTION_RANDOM) a = matePref(judgeId, candId, tick, 1);

    return a;
}
