// species.mjs -- shared species / plate / lifespan ANALYSIS, extracted verbatim from viewer-micrograph-gl.html so
// the headless generator (Node) and the viewer (browser) run the IDENTICAL computation. The generator runs it at a
// FIXED tick cadence and writes the result into each `stats` row, so a scrub shows the full panel instantly with no
// recompute (5-panel D2). Operates on engine Swimbot objects (getGenotype/getAlive/getAge/_phenotype) -- both
// contexts have them. Pure JS, no DOM. The viewer keeps the DOM rendering (plateHTML/makeRow/updateSpeciesUI); only
// the COMPUTE lives here.
//
// PLATES (docs/PLAN-body-plate.md): a species' 5-symbol plate describes its members' average BODY (body-features.mjs:
// a pure function of each genome, decoded with category 3 on), projected on a frozen, randomly rotated 5-axis basis
// (plate-basis.mjs) and binned on one shared scale -> visually similar species get similar plates. plateOf() is the
// pure function; the displayed lineage/population plates add letter hysteresis (no flicker) and follow the EXACT mean
// (integer fixed-point sums -> bit-exact add/remove), so they don't depend on frame rate.
//
// Determinism/cadence note: the diversity EMAs (SIG_EMA) and per-lineage lifeEMA are history-dependent, so a
// run's saved stats are reproducible only at a FIXED recompute cadence -- that cadence is part of the run contract
// (the generator recomputes once per stats/keyframe tick). foldDeath() folds each death exactly once (event-driven,
// via the D9 age-at-death), which is strictly more faithful than the viewer's old lossy per-frame polling.

import { NUM_GENES } from '../constants.js';
import { NF, featuresOf, coordsOf, binOf, binWithHysteresis } from './body-features.mjs';
import { PLATE_W, PLATE_B, PLATE_TH } from './plate-basis.mjs';

// --- genome layout for analysis (mirrors the viewer) ---
export const USED = 112;                 // coding genes [0,USED); junk region [USED,NUM_GENES)
export const NJ = NUM_GENES - USED;      // 144 junk genes -- the speciation metric span
// EXPRESSED: gene span of the DIVERSITY gauge only (unchanged, [0,83); widening it is a separate decision -- it would make
// `div` jump mid-timeline in resumed runs). The PLATE no longer reads genes directly (body-features.mjs).
export const EXPRESSED = 83;

// --- clustering / EMA constants (mirrors the viewer) ---
export const SPECIES_ISO = 0.9;          // = engine reproductiveIsolation default; same-species iff junkSim > this
export const SPECIES_K = 50;             // cap on tracked reps / list length (perf bound on N*K*NJ)
export const SIG_EMA = 0.08;             // diversity smoothing per recompute
export const LIFE_EMA = 0.05;            // slow EMA over per-death lifespans

const SIG_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export { SIG_ALPHA };

// --- pure helpers ---
// `nj` junk genes from [USED, USED+nj). Default NJ (the full span). When the mutation-rate gene is active it is a CODING
// gene, not a speciation marker -- and it is exactly the LAST junk gene (255 == NUM_GENES-1), so the analyzer passes
// nj = NJ-1 to drop it, matching the engine's _getJunkDnaSimilarity exclusion (world.js) so display clusters == mating.
export function junkOf(sb, nj = NJ) { const g = sb.getGenotype(); const a = new Float64Array(nj); for (let k = 0; k < nj; k++) a[k] = g.getGeneValue(USED + k); return a; }
export function junkSim(a, b) { const n = a.length; let d = 0; for (let k = 0; k < n; k++) d += Math.abs(a[k] - b[k]); return 1 - (d / 256) / n; }   // engine metric (/BYTE_SIZE), over the active span

// --- the plate: pure function of a mean body-feature vector (fixed-point units) ---
const K = PLATE_W.length;
export function plateIndices(meanFeat, prev = null) {
    const c = coordsOf(meanFeat, PLATE_W, PLATE_B), idx = new Array(K);
    for (let i = 0; i < K; i++) idx[i] = prev ? binWithHysteresis(c[i], PLATE_TH, prev[i]) : binOf(c[i], PLATE_TH);
    return idx;
}
export const plateString = (idx) => idx.map((i) => SIG_ALPHA[i]).join('');
export const plateOf = (meanFeat) => plateString(plateIndices(meanFeat));   // pure: same features -> same plate, everywhere

// --- the stateful analyzer: one per run (generator) / per live world (viewer) ---
// INCREMENTAL clustering: a creature's junk genes are IMMUTABLE for life, so its species is FIXED at birth. Rather than
// re-cluster every living creature every recompute (O(N*K*NJ) -> ~8ms at pop 1000), we assign each creature ONCE the
// first recompute it appears in, maintain per-lineage running sums, and just advance the EMAs (plate crawl) + rebuild the
// list each call. Per-recompute cost is O(new + dead), not O(N). Same outputs (tracked/speciesList/pop EMAs/statsRow).
export function createSpeciesAnalyzer(config = null) {
    // Active junk span for the speciation metric. When evolvableMutationRate is on, the last junk gene (255) is a coding
    // gene -> drop it (nj = NJ-1) so the display clustering matches the engine mating gate exactly. Off -> full NJ span.
    const nj = (config && config.evolvableMutationRate === true) ? NJ - 1 : NJ;
    let tracked = new Map();             // id -> { ema, divEMA, sig, plateIdx, sumFeat, count, misses, seed, idset, rep, lifeEMA, sumJunk, sumUsed, sumSqUsed }
    const assigned = new Map();          // sb -> { tid, feat } (lineage fixed at birth; feat = its fixed-point body features, cached once)
    let nextSpeciesId = 1;
    let popSig = null, popIdx = null, popDivEMA = null, popLifeEMA = null;
    let speciesById = new Map(), speciesList = [];

    function newLineage(jg) {
        return { seed: Float64Array.from(jg), sumJunk: new Float64Array(nj), sumUsed: new Float64Array(EXPRESSED), sumSqUsed: new Float64Array(EXPRESSED),
                 count: 0, ema: null, divEMA: 0, sig: null, plateIdx: null, sumFeat: new Float64Array(NF), misses: 0, idset: new Set(), rep: null, lifeEMA: null };
    }
    function memberAdd(t, sb, jg, feat) { // running sums so per-lineage mean/variance need no re-scan of members
        t.idset.add(sb); t.count++;
        for (let k = 0; k < NF; k++) t.sumFeat[k] += feat[k];   // exact: integer features
        for (let k = 0; k < nj; k++) t.sumJunk[k] += jg[k];
        const gt = sb.getGenotype();
        for (let k = 0; k < EXPRESSED; k++) { const v = gt.getGeneValue(k); t.sumUsed[k] += v; t.sumSqUsed[k] += v * v; }
    }
    function memberRemove(t, sb, feat) {   // genes/features are integers -> add-then-remove of the SAME values cancels exactly (no FP drift)
        if (!t.idset.has(sb)) return;
        t.idset.delete(sb); t.count--;
        for (let k = 0; k < NF; k++) t.sumFeat[k] -= feat[k];
        const jg = junkOf(sb, nj), gt = sb.getGenotype();
        for (let k = 0; k < nj; k++) t.sumJunk[k] -= jg[k];
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
            const jg = junkOf(sb, nj);
            let best = null, bestId = null, bestS = SPECIES_ISO;
            for (const [tid, t] of tracked) { const s = junkSim(jg, t.seed); if (s > bestS) { bestS = s; best = t; bestId = tid; } }
            if (!best) {
                if (tracked.size < SPECIES_K) { bestId = nextSpeciesId++; best = newLineage(jg); tracked.set(bestId, best); }
                else { let ns = -1; for (const [tid, t] of tracked) { const s = junkSim(jg, t.seed); if (s > ns) { ns = s; best = t; bestId = tid; } } }
            }
            const feat = featuresOf(sb, config);
            memberAdd(best, sb, jg, feat); assigned.set(sb, { tid: bestId, feat });
        }
        for (const [sb, a] of assigned) { if (!alive.has(sb)) { const t = tracked.get(a.tid); if (t) memberRemove(t, sb, a.feat); assigned.delete(sb); } }
        // per-lineage: running mean -> diversity EMA, plate (exact mean + letter hysteresis), rep; prune extinct after a little hysteresis
        const mean = new Float64Array(nj), meanUsed = new Float64Array(EXPRESSED), meanFeat = new Float64Array(NF);
        for (const [tid, t] of tracked) {
            if (t.count <= 0) { if (++t.misses > 4) tracked.delete(tid); continue; }
            t.misses = 0;
            for (let k = 0; k < nj; k++) mean[k] = t.sumJunk[k] / t.count;
            let ss = 0; for (let k = 0; k < EXPRESSED; k++) { const mu = t.sumUsed[k] / t.count; meanUsed[k] = mu; const vr = t.sumSqUsed[k] / t.count - mu * mu; ss += Math.sqrt(vr > 0 ? vr : 0); }
            const divRaw = ss / EXPRESSED;
            if (!t.ema) { t.ema = Float64Array.from(mean); t.divEMA = divRaw; }
            else { for (let k = 0; k < nj; k++) t.ema[k] += SIG_EMA * (mean[k] - t.ema[k]);
                   t.divEMA += SIG_EMA * (divRaw - t.divEMA); }
            for (let k = 0; k < NF; k++) meanFeat[k] = t.sumFeat[k] / t.count;
            t.plateIdx = plateIndices(meanFeat, t.plateIdx); t.sig = plateString(t.plateIdx);
            if (!(t.rep && t.rep.getAlive() && t.idset.has(t.rep))) { let best = null, bs = -1; for (const m of t.idset) { const s = junkSim(junkOf(m, nj), mean); if (s > bs) { bs = s; best = m; } } t.rep = best; }
        }
        let popTot = 0; const popSum = new Float64Array(EXPRESSED), popSumSq = new Float64Array(EXPRESSED), popFeat = new Float64Array(NF);
        for (const [, t] of tracked) { if (t.count <= 0) continue; popTot += t.count; for (let k = 0; k < EXPRESSED; k++) { popSum[k] += t.sumUsed[k]; popSumSq[k] += t.sumSqUsed[k]; } for (let k = 0; k < NF; k++) popFeat[k] += t.sumFeat[k]; }
        if (popTot > 0) {
            for (let k = 0; k < NF; k++) popFeat[k] /= popTot;   // population AVERAGE body (Karl: keep the average on the main view)
            popIdx = plateIndices(popFeat, popIdx); popSig = plateString(popIdx);
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
        const a = assigned.get(sb), t = a ? tracked.get(a.tid) : null;
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
        speciesIdOf: (sb) => assigned.get(sb)?.tid,   // sb -> its lineage/species-row id (fixed at birth); undefined for 1-part bots
        get tracked() { return tracked; },
        get speciesList() { return speciesList; },
        get speciesById() { return speciesById; },
        get popSig() { return popSig; },
        get popDivEMA() { return popDivEMA; },
        get popLifeEMA() { return popLifeEMA; },
        get nextSpeciesId() { return nextSpeciesId; },
    };
}
