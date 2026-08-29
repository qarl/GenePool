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

// colorSimilarity(cand, judge) -- mirrors Swimbot.getColorSimilarity (this=cand c2, judge=c1).
function colorSimilarity(cand, judge) {
    const rDiff = Math.abs(cand.red - judge.red);
    const gDiff = Math.abs(cand.green - judge.green);
    const bDiff = Math.abs(cand.blue - judge.blue);
    return ONE - ((rDiff + gDiff + bDiff) * ONE_THIRD);
}

// closeness -- mirrors Swimbot.getCloseness: distance = candRoot.getDistanceTo(judgeRoot) (this=cand).
function closeness(cand, judge, viewRadius) {
    const xx = cand.rootX - judge.rootX;
    const yy = cand.rootY - judge.rootY;
    const distance = Math.sqrt(xx * xx + yy * yy);
    const closest = distance < viewRadius ? distance : viewRadius;
    return ONE - (closest / viewRadius);
}

// Bit-for-bit mirror of Swimbot.getAttractiveness(judge, tick): attractiveness of `cand` as judged by
// `judge` (both METRICS structs), for `criterion` (the CANDIDATE's own brain criterion). matePref is
// matePref(judgeId, candId, tick, drawIdx). Same mutually-exclusive if-chain + same draw structure (idx 0
// always, idx 1 only for RANDOM) as the live method, so it is identical (parity-tested).
export function attractivenessOf(cand, judge, criterion, tick, matePref, candId, judgeId, viewRadius) {
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

    if (criterion === ATTRACTION_CLOSEST) a = closeness(cand, judge, viewRadius);
    if (criterion === ATTRACTION_RANDOM) a = matePref(judgeId, candId, tick, 1);

    return a;
}
