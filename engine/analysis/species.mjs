// species.mjs -- shared species / plate / lifespan ANALYSIS, extracted verbatim from viewer-micrograph-gl.html so
// the headless generator (Node) and the viewer (browser) run the IDENTICAL computation. The generator runs it at a
// FIXED tick cadence and writes the result into each `stats` row, so a scrub shows the full panel instantly with no
// recompute (5-panel D2). Operates on engine Swimbot objects (getGenotype/getAlive/getAge/_phenotype) -- both
// contexts have them. Pure JS, no DOM. The viewer keeps the DOM rendering (plateHTML/makeRow/updateSpeciesUI); only
// the COMPUTE lives here.
//
// Determinism/cadence note: the tracked-centroid EMAs (SIG_EMA) and per-lineage lifeEMA are history-dependent, so a
// run's saved stats are reproducible only at a FIXED recompute cadence -- that cadence is part of the run contract
// (the generator recomputes once per stats/keyframe tick). foldDeath() folds each death exactly once (event-driven,
// via the D9 age-at-death), which is strictly more faithful than the viewer's old lossy per-frame polling.

import { NUM_GENES } from '../constants.js';

// --- genome layout for analysis (mirrors the viewer) ---
export const USED = 112;                 // coding genes [0,USED); junk region [USED,NUM_GENES)
export const NJ = NUM_GENES - USED;      // 144 junk genes -- the speciation metric span
// EXPRESSED = coding genes actually under selection [0,EXPRESSED). [EXPRESSED,USED) are decoded but never expressed
// (JJ's category-3 off-by-one + food-type genes with one food type) so they drift like junk -> excluded from the
// plate / PCA / diversity. The speciation gate is UNCHANGED (full junk region [USED,NUM_GENES)).
export const EXPRESSED = 83;

// --- clustering / EMA constants (mirrors the viewer) ---
export const SPECIES_ISO = 0.9;          // = engine reproductiveIsolation default; same-species iff junkSim > this
export const SPECIES_K = 50;             // cap on tracked reps / list length (perf bound on N*K*NJ)
export const SIG_EMA = 0.08;             // centroid smoothing per recompute -> the plate crawls
export const LIFE_EMA = 0.05;            // slow EMA over per-death lifespans

// --- PCA species-signature basis (docs/pca-plate-basis.md). Spliced verbatim from the viewer at build time to
//     guarantee byte-identical constants; regenerate with tools/pca/ if EXPRESSED changes. ---
export const PCA_MEAN = [159.55,77.08,118.08,123.69,125.1,117.42,123.77,116.43,141.86,143.17,140.82,152.39,132.75,99.68,132.72,124.69,122.94,125.07,120.83,138.32,113.76,128.37,121.39,124.73,137.4,115.37,128.87,118.75,118.05,139.98,119.81,120.57,121.8,139.32,124.49,110.94,128.91,128.15,130.42,124.48,130.54,132.63,138.35,118.17,118.19,143.83,126.18,143.75,127.62,127.69,130.48,122.92,125.05,116.89,130.66,133.9,139.69,123.09,126.06,126.1,137.41,126.78,134.23,120.68,148.48,128.35,121.67,135.96,125.71,119.62,130.96,125.88,132.18,132.25,147.95,127.11,121.45,115.17,124.16,122.16,141.24,122.59,138.7];
export const PCA_COMPONENTS = [
  [-0.06199,-0.12095,0.1026,0.10513,-0.14544,-0.0491,-0.04829,-0.06342,0.0532,0.12569,-0.05097,0.03041,0.00815,-0.10372,-0.16094,-0.00777,-0.177,-0.09967,0.1933,-0.07145,-0.09477,-0.2287,0.05388,0.02194,-0.0068,0.09371,-0.06143,0.13228,-0.04212,0.01479,0.04216,-0.11761,-0.15362,0.05425,-0.13298,-0.2021,0.1038,-0.03648,-0.03597,-0.00552,0.1659,-0.08831,0.24514,0.1114,0.08533,-0.0979,0.0106,0.0062,0.13122,-0.04831,-0.06347,0.04192,-0.14965,-0.11812,-0.05282,-0.07355,-0.07651,0.09103,-0.21076,-0.08752,0.1272,0.04517,0.03853,-0.14938,0.21711,0.04244,-0.06809,0.03405,0.03718,-0.10204,0.18708,-0.09066,0.11773,0.0267,0.20407,-0.02463,-0.12178,0.28707,0.04486,0.03231,-0.01379,-0.04046,-0.06951],
  [0.08066,0.06212,-0.11715,-0.04473,0.09055,0.04943,-0.05797,0.22151,0.0064,0.04753,-0.15728,-0.1089,0.01427,0.00719,0.2441,0.11558,0.07315,-0.1288,0.02069,-0.19062,0.10479,-0.02242,0.0897,0.09422,-0.17804,0.19724,-0.18916,0.01072,0.04102,0.26139,-0.10543,-0.00172,-0.08546,0.09281,-0.0341,-0.09523,0.00759,-0.01807,0.04411,-0.00435,0.08562,0.02879,-0.03377,-0.04458,-0.19696,-0.05822,0.06026,0.24138,-0.07823,0.16307,0.0811,0.00746,-0.03077,0.24233,0.08795,-0.02565,0.08479,-0.04612,0.0343,-0.04998,0.08862,0.01988,-0.1896,-0.13131,0.1468,0.15289,0.0938,0.09397,-0.17263,-0.08178,-0.01129,0.04289,0.01592,0.04516,0.14024,0.06526,-0.04295,-0.04513,-0.24707,0.05917,-0.04044,-0.01071,0.03015],
  [-0.13791,-0.0337,0.00992,0.04223,0.06599,-0.20018,-0.01896,-0.04312,-0.17404,-0.02445,0.32415,0.16521,0.06298,0.08092,0.065,0.03229,-0.07181,0.14406,0.03622,-0.02397,-0.05451,-0.07706,-0.08126,-0.15864,-0.21104,-0.0375,0.08528,-0.09303,0.03719,0.14466,0.0965,0.09408,0.10076,-0.07066,0.02292,0.01117,-0.15495,-0.13366,0.00331,-0.12766,0.0388,-0.14156,-0.09055,0.00569,-0.12347,-0.23145,0.00136,-0.01267,0.06925,0.04828,-0.06407,0.08102,-0.22075,-0.01131,-0.00012,-0.12809,-0.05581,0.06526,0.03477,-0.02391,0.01477,-0.05838,0.10232,0.08537,0.23833,0.00177,0.19196,0.19631,0.1732,-0.00376,-0.02621,0.11816,-0.04233,0.10608,-0.02134,0.02943,0.08183,-0.03957,-0.13064,0.18134,0.15341,-0.02717,0.14637],
  [-0.06203,-0.04602,-0.1701,0.10936,0.17822,-0.03308,-0.03216,-0.07599,0.0228,0.05505,-0.04549,-0.01735,0.08968,-0.20019,-0.20387,-0.17372,-0.12023,-0.14229,0.23219,-0.0354,0.0626,-0.01785,-0.04704,-0.1921,0.01239,-0.11274,0.03592,-0.10878,0.12435,0.10504,-0.12608,-0.08368,-0.01943,-0.09248,0.12158,-0.03016,0.08095,0.0547,-0.12137,-0.04245,-0.02202,0.09382,-0.03966,-0.23616,-0.03653,0.11166,-0.23405,0.12097,0.01781,0.09315,0.07129,0.22672,-0.09345,0.11479,0.14539,0.08203,0.09819,-0.08354,0.00262,-0.0326,0.16573,-0.05052,-0.03349,0.11714,-0.02933,0.00811,-0.08318,0.12045,0.06766,0.25419,0.21289,-0.04185,-0.15953,0.0359,0.03547,-0.00678,0.10088,-0.04951,0.09592,-0.10694,-0.022,-0.01787,-0.00348],
  [-0.01499,0.03755,0.09016,0.06686,-0.09442,-0.05772,0.19201,-0.0138,-0.09768,0.08937,-0.06328,0.21765,-0.0028,0.06721,0.02945,0.14401,-0.02968,-0.05939,-0.19101,0.1451,0.17359,-0.0329,0.02317,-0.11486,0.15782,-0.22219,-0.074,0.05987,-0.0461,-0.03942,-0.12699,0.03356,0.16049,-0.08451,-0.0043,0.05995,0.07774,-0.03483,-0.07581,0.09676,0.17589,0.069,0.17708,-0.07677,-0.13478,-0.0792,0.02142,0.05899,0.09385,-0.19401,0.21046,-0.03379,0.01764,0.05684,-0.03906,0.07344,0.16962,0.09186,0.16146,-0.0178,0.17792,0.11177,0.03237,0.13011,0.12492,-0.03462,0.09208,-0.01411,-0.01239,-0.03737,-0.15563,-0.06062,-0.18585,-0.04283,0.29817,0.1539,-0.00987,-0.00324,0.04645,0.04048,-0.12862,-0.11132,-0.0726]
];
export const PCA_SCALES = [138.951,136.159,133.33,129.247,121.914];

const SIG_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export { SIG_ALPHA };
const SIG_AMP = 2.0;                      // amplify signature coordinates (stronger plates; extremes clamp)

// --- pure helpers ---
export function junkOf(sb) { const g = sb.getGenotype(); const a = new Float64Array(NJ); for (let k = 0; k < NJ; k++) a[k] = g.getGeneValue(USED + k); return a; }
export function junkSim(a, b) { let d = 0; for (let k = 0; k < NJ; k++) d += Math.abs(a[k] - b[k]); return 1 - (d / 256) / NJ; }   // engine metric (/BYTE_SIZE)

function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const normCDF = z => 0.5 * (1 + erf(z / Math.SQRT2));
function sigCoord(vec, i) {               // signed, amplified, clamped coordinate of `vec` on PC i -> [-1,1] (0 = mean)
    let dot = 0; const comp = PCA_COMPONENTS[i];
    for (let k = 0; k < EXPRESSED; k++) dot += ((vec[k] || 0) - PCA_MEAN[k]) * comp[k];
    const p = 2 * (normCDF(dot / PCA_SCALES[i]) - 0.5);
    return Math.max(-1, Math.min(1, p * SIG_AMP));
}
export function signatureOf(vec) {        // -> 5 signed base36 symbols ('0' = mean)
    let s = '';
    for (let c = 0; c < 5; c++) { const signed = Math.round(sigCoord(vec, c) * 17); s += SIG_ALPHA[((signed % 36) + 36) % 36]; }
    return s;
}

// --- the stateful analyzer: one per run (generator) / per live world (viewer) ---
// INCREMENTAL clustering: a creature's junk genes are IMMUTABLE for life, so its species is FIXED at birth. Rather than
// re-cluster every living creature every recompute (O(N*K*NJ) -> ~8ms at pop 1000), we assign each creature ONCE the
// first recompute it appears in, maintain per-lineage running sums, and just advance the EMAs (plate crawl) + rebuild the
// list each call. Per-recompute cost is O(new + dead), not O(N). Same outputs (tracked/speciesList/pop EMAs/statsRow).
export function createSpeciesAnalyzer() {
    let tracked = new Map();             // id -> { ema, emaUsed, divEMA, sig, count, misses, seed, idset, rep, lifeEMA, sumJunk, sumUsed, sumSqUsed }
    const assigned = new Map();          // sb -> lineage id (fixed at birth; genes never change -> membership never migrates)
    let nextSpeciesId = 1;
    let popUsedEMA = null, popSig = '00000', popDivEMA = null, popLifeEMA = null;
    let speciesById = new Map(), speciesList = [];

    function newLineage(jg) {
        return { seed: Float64Array.from(jg), sumJunk: new Float64Array(NJ), sumUsed: new Float64Array(EXPRESSED), sumSqUsed: new Float64Array(EXPRESSED),
                 count: 0, ema: null, emaUsed: null, divEMA: 0, sig: '00000', misses: 0, idset: new Set(), rep: null, lifeEMA: null };
    }
    function memberAdd(t, sb, jg) {       // running sums so per-lineage mean/variance need no re-scan of members
        t.idset.add(sb); t.count++;
        for (let k = 0; k < NJ; k++) t.sumJunk[k] += jg[k];
        const gt = sb.getGenotype();
        for (let k = 0; k < EXPRESSED; k++) { const v = gt.getGeneValue(k); t.sumUsed[k] += v; t.sumSqUsed[k] += v * v; }
    }
    function memberRemove(t, sb) {         // genes are immutable -> add-then-remove of the SAME integer values cancels exactly (no FP drift)
        if (!t.idset.has(sb)) return;
        t.idset.delete(sb); t.count--;
        const jg = junkOf(sb), gt = sb.getGenotype();
        for (let k = 0; k < NJ; k++) t.sumJunk[k] -= jg[k];
        for (let k = 0; k < EXPRESSED; k++) { const v = gt.getGeneValue(k); t.sumUsed[k] -= v; t.sumSqUsed[k] -= v * v; }
    }

    // Recompute: assign NEW living creatures (once, by seed), drop the dead, advance every lineage's EMAs, rebuild the list.
    function recompute(swimbots) {
        const alive = new Set();
        for (const sb of swimbots) {
            if (!sb.getAlive()) continue;
            const ph = sb._phenotype; if (!ph || ph.numParts <= 1) continue;
            alive.add(sb);
            if (assigned.has(sb)) continue;                        // already in a lineage (fixed at birth) -> no re-scan
            const jg = junkOf(sb);
            let best = null, bestId = null, bestS = SPECIES_ISO;
            for (const [tid, t] of tracked) { const s = junkSim(jg, t.seed); if (s > bestS) { bestS = s; best = t; bestId = tid; } }
            if (!best) {
                if (tracked.size < SPECIES_K) { bestId = nextSpeciesId++; best = newLineage(jg); tracked.set(bestId, best); }
                else { let ns = -1; for (const [tid, t] of tracked) { const s = junkSim(jg, t.seed); if (s > ns) { ns = s; best = t; bestId = tid; } } }
            }
            memberAdd(best, sb, jg); assigned.set(sb, bestId);
        }
        for (const [sb, tid] of assigned) { if (!alive.has(sb)) { const t = tracked.get(tid); if (t) memberRemove(t, sb); assigned.delete(sb); } }
        // per-lineage: running mean -> advance EMAs (the plate crawls) -> sig -> rep; prune extinct after a little hysteresis
        const mean = new Float64Array(NJ), meanUsed = new Float64Array(EXPRESSED);
        for (const [tid, t] of tracked) {
            if (t.count <= 0) { if (++t.misses > 4) tracked.delete(tid); continue; }
            t.misses = 0;
            for (let k = 0; k < NJ; k++) mean[k] = t.sumJunk[k] / t.count;
            let ss = 0; for (let k = 0; k < EXPRESSED; k++) { const mu = t.sumUsed[k] / t.count; meanUsed[k] = mu; const vr = t.sumSqUsed[k] / t.count - mu * mu; ss += Math.sqrt(vr > 0 ? vr : 0); }
            const divRaw = ss / EXPRESSED;
            if (!t.ema) { t.ema = Float64Array.from(mean); t.emaUsed = Float64Array.from(meanUsed); t.divEMA = divRaw; }
            else { for (let k = 0; k < NJ; k++) t.ema[k] += SIG_EMA * (mean[k] - t.ema[k]);
                   for (let k = 0; k < EXPRESSED; k++) t.emaUsed[k] += SIG_EMA * (meanUsed[k] - t.emaUsed[k]);
                   t.divEMA += SIG_EMA * (divRaw - t.divEMA); }
            t.sig = signatureOf(t.emaUsed);
            if (!(t.rep && t.rep.getAlive() && t.idset.has(t.rep))) { let best = null, bs = -1; for (const m of t.idset) { const s = junkSim(junkOf(m), mean); if (s > bs) { bs = s; best = m; } } t.rep = best; }
        }
        let popTot = 0; const popSum = new Float64Array(EXPRESSED), popSumSq = new Float64Array(EXPRESSED);
        for (const [, t] of tracked) { if (t.count <= 0) continue; popTot += t.count; for (let k = 0; k < EXPRESSED; k++) { popSum[k] += t.sumUsed[k]; popSumSq[k] += t.sumSqUsed[k]; } }
        if (popTot > 0) {
            if (!popUsedEMA) { popUsedEMA = new Float64Array(EXPRESSED); for (let k = 0; k < EXPRESSED; k++) popUsedEMA[k] = popSum[k] / popTot; }
            else for (let k = 0; k < EXPRESSED; k++) popUsedEMA[k] += SIG_EMA * (popSum[k] / popTot - popUsedEMA[k]);
            popSig = signatureOf(popUsedEMA);
            let ss = 0; for (let k = 0; k < EXPRESSED; k++) { const m = popSum[k] / popTot, vr = popSumSq[k] / popTot - m * m; ss += Math.sqrt(vr > 0 ? vr : 0); }
            const popDivRaw = ss / EXPRESSED;
            popDivEMA = popDivEMA == null ? popDivRaw : popDivEMA + SIG_EMA * (popDivRaw - popDivEMA);
        }
        const rs = [];
        for (const [tid, t] of tracked) if (t.count > 0) rs.push({ id: tid, count: t.count, t });
        rs.sort((a, b) => b.count - a.count);
        speciesList = rs; speciesById = new Map(rs.map(r => [r.id, r]));
        return { speciesList, speciesById };
    }

    // Fold one death's age into the whole-population EMA + its OWN lineage's EMA (assignment is fixed at birth, so no
    // re-match needed). `age` = age-at-death (D9 event age, == sb.getAge() at the death tick). Event-driven: exact.
    function foldDeath(sb, age) {
        popLifeEMA = popLifeEMA == null ? age : popLifeEMA + LIFE_EMA * (age - popLifeEMA);
        const tid = assigned.get(sb), t = tid != null ? tracked.get(tid) : null;
        if (t) t.lifeEMA = t.lifeEMA == null ? age : t.lifeEMA + LIFE_EMA * (age - t.lifeEMA);
    }

    // Compact, serializable panel state for a `stats` row: everything the playback panel needs to draw WITHOUT any
    // recompute (main plate + diversity + lifespan, and the per-lineage list keyed by stable id).
    function statsRow() {
        const lineages = [];
        for (const [id, t] of tracked) { if (t.count <= 0) continue; lineages.push({ id, sig: t.sig, count: t.count, divEMA: t.divEMA, lifeEMA: t.lifeEMA ?? null }); }
        lineages.sort((a, b) => b.count - a.count);
        return { popSig, popDivEMA, popLifeEMA, lineages };
    }

    return {
        recompute, foldDeath, statsRow,
        speciesIdOf: (sb) => assigned.get(sb),   // sb -> its lineage/species-row id (fixed at birth); undefined for 1-part bots
        get tracked() { return tracked; },
        get speciesList() { return speciesList; },
        get speciesById() { return speciesById; },
        get popSig() { return popSig; },
        get popDivEMA() { return popDivEMA; },
        get popLifeEMA() { return popLifeEMA; },
        get popUsedEMA() { return popUsedEMA; },
        get nextSpeciesId() { return nextSpeciesId; },
    };
}
