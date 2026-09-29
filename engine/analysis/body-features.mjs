// body-features.mjs -- what a creature LOOKS like, as numbers: the input to the species plate (docs/PLAN-body-plate.md).
// Pure function of the GENOME: the body is decoded with a FROZEN decode config (category 3 on -- Karl 2026-09-29), never
// the run's, and only GENETIC part parameters are read (lengths, widths, colours, stroke) -- never pose/position -- so
// the same genome gives the same features in every pool, run, machine and app build. Shared by the species analyzer
// (plates), the plate-basis trainer (tools/plate/) and the Pool Atlas. Observer-only: never touches the sim trajectory.
//
// Portability: only + - * / Math.sqrt Math.round Math.abs Math.max/min and comparisons (all exactly specified in JS);
// no exp/log/pow/hypot. Features are stored as FIXED-POINT INTEGERS (x FEAT_ONE) so running sums add and subtract
// EXACTLY (a creature's contribution cancels bit-for-bit on death, whatever the order of births and deaths).
import { Embryology } from '../embryology.js';

export const PLATE_DECODE = Object.freeze({ numFoodTypes: 1, fixBranchCategoryGene: true });
export const FEAT_ONE = 65536;   // fixed-point scale (2^16)

// name -> visual group. Groups get equal total weight in the plate basis, so correlated features can't dominate.
export const FEATURES = [
  ['reach', 'size'], ['segs', 'size'],
  ['width', 'shape'], ['widthSpread', 'shape'], ['taper', 'shape'], ['cap', 'shape'],
  ['limbFrac', 'structure'], ['branches', 'structure'], ['depth', 'structure'], ['splay', 'structure'], ['symmetry', 'structure'],
  ['green', 'colour'], ['blue', 'colour'], ['contrast', 'colour'],
  ['hair', 'texture'],
  ['freq', 'motion'], ['amp', 'motion'], ['turn', 'motion'],
];
export const NF = FEATURES.length;
export const FEATURE_NAMES = FEATURES.map((f) => f[0]);

const EMB = new Embryology();   // module-level; decode is synchronous and resets all scratch per call (never world._embryology)
let _chain = new Int32Array(64), _arc = new Float64Array(64), _nest = new Int32Array(64);

// The phenotype a plate describes. Reuses the creature's own decoded body when the run decodes identically (only
// fixBranchCategoryGene changes the body; numFoodTypes only sets food preference); else decodes with PLATE_DECODE.
export function plateBodyOf(sb, config) {
  const ph = sb._phenotype;   // a REAL decoded body only (stand-ins, e.g. the atlas's, carry just numParts)
  if (config && config.fixBranchCategoryGene === true && ph && ph.parts && ph.parts.length && ph.numParts > 1) return ph;
  return EMB.generatePhenotypeFromGenotype(sb.getGenotype(), PLATE_DECODE);
}
export function plateBodyOfGenes(genes) {
  return EMB.generatePhenotypeFromGenotype({ getGeneValue: (k) => genes[k] }, PLATE_DECODE);
}

// Raw (float) feature values of a decoded body. Part 0 is the empty root and is skipped. Chains mirror the renderer
// (viewer buildSegs): chain[p] = p for a branch start, else the parent's chain; the TRUNK is chain[1]; a branch BASE is a
// chain start other than the trunk. Every mean over a possibly-empty set is 0 when empty.
export function rawFeatures(ph, out = new Float64Array(NF)) {
  const n = ph.numParts, P = ph.parts;
  if (_chain.length < n) { _chain = new Int32Array(n * 2); _arc = new Float64Array(n * 2); _nest = new Int32Array(n * 2); }
  const chain = _chain, arc = _arc, nest = _nest; chain[0] = 0; arc[0] = 0; nest[0] = 0;
  let reach = 0, totL = 0, area = 0, wSum = 0, wMax = 0, wMin = Infinity, capA = 0, g = 0, b = 0, conA = 0, hairA = 0, ampL = 0, turnL = 0;
  for (let p = 1; p < n; p++) {
    const q = P[p], par = q.parent;
    chain[p] = q.branch ? p : chain[par];
    arc[p] = arc[par] + P[par].length;
    const tip = arc[p] + q.length; if (tip > reach) reach = tip;
    const a = q.length * q.width;
    totL += q.length; area += a; wSum += q.width;
    if (q.width > wMax) wMax = q.width; if (q.width < wMin) wMin = q.width;
    capA += a * (q.endCapSpline || 0);
    g += a * q.green; b += a * q.blue;
    const pp = par >= 1 ? P[par] : q;   // colour gradient runs parent -> this part (renderer), none at the root
    conA += a * (Math.abs(q.red - pp.red) + Math.abs(q.green - pp.green) + Math.abs(q.blue - pp.blue));
    hairA += a * q.red;                 // cilia length ~ local width x red, only where red > 0.01 (renderer)
    ampL += q.length * Math.abs(q.amp); turnL += q.length * Math.abs(q.turnAmp);
  }
  const trunk = chain[1];
  // trunk taper, limb fraction, branch bases (count, nesting depth, splay, paired/symmetric)
  let tFirst = 0, tLast = 0, limbL = 0, nBase = 0, nestL = 0, splayL = 0, splayW = 0, paired = 0;
  for (let p = 1; p < n; p++) {
    const q = P[p];
    if (chain[p] === trunk) { if (!tFirst) tFirst = q.width; tLast = q.width; } else limbL += q.length;
    nest[p] = nest[q.parent] + (chain[p] === p && p !== trunk ? 1 : 0);   // a branch base sits one level deeper than its parent
    nestL += q.length * nest[p];
    if (chain[p] === p && p !== trunk) {
      nBase++; splayL += q.length * Math.abs(q.angle); splayW += q.length;
      for (let r = 1; r < n; r++) if (r !== p && chain[r] === r && r !== trunk && P[r].parent === q.parent) { paired++; break; }
    }
  }
  out[0] = Math.sqrt(reach);
  out[1] = Math.sqrt(n - 1);
  out[2] = Math.sqrt(area / totL);                       // length-weighted mean width
  out[3] = Math.sqrt(wMin > 0 ? wMax / wMin : 1);
  out[4] = Math.sqrt(tFirst > 0 ? tLast / tFirst : 1);
  out[5] = area > 0 ? capA / area : 0;
  out[6] = totL > 0 ? limbL / totL : 0;
  out[7] = Math.sqrt(nBase);
  out[8] = totL > 0 ? nestL / totL : 0;
  out[9] = splayW > 0 ? splayL / splayW : 0;
  out[10] = nBase > 0 ? paired / nBase : 0;
  out[11] = area > 0 ? g / area : 0;
  out[12] = area > 0 ? b / area : 0;
  out[13] = area > 0 ? conA / area : 0;
  out[14] = area > 0 ? hairA / area : 0;
  out[15] = ph.frequency;
  out[16] = totL > 0 ? ampL / totL : 0;
  out[17] = totL > 0 ? turnL / totL : 0;
  return out;
}

const _raw = new Float64Array(NF);
// Fixed-point integer feature vector (Float64Array of exact integers) -- what the analyzer caches and sums.
export function featuresOfBody(ph) {
  rawFeatures(ph, _raw);
  const f = new Float64Array(NF);
  for (let k = 0; k < NF; k++) {
    const v = Math.round(_raw[k] * FEAT_ONE);
    if (!Number.isInteger(v)) throw new Error(`body feature ${FEATURE_NAMES[k]} is not finite (${_raw[k]})`);
    f[k] = v;
  }
  return f;
}
export const featuresOf = (sb, config) => featuresOfBody(plateBodyOf(sb, config));
export const featuresOfGenes = (genes) => featuresOfBody(plateBodyOfGenes(genes));

// ---- plate encoding (basis constants live in plate-basis.mjs, generated by tools/plate/train-basis.mjs) ----
// coords = W . meanFeat + B, fixed summation order (k ascending) -> bit-identical wherever the literals are the same.
// meanFeat is in FIXED-POINT units (sum/count of the integer vectors).
export function coordsOf(meanFeat, W, B, out = new Float64Array(W.length)) {
  for (let c = 0; c < W.length; c++) { const w = W[c]; let s = B[c]; for (let k = 0; k < NF; k++) s += w[k] * meanFeat[k]; out[c] = s; }
  return out;
}
// symbol index = number of thresholds strictly below z (0..TH.length). One SHARED threshold set for every position.
export function binOf(z, TH) { let i = 0; while (i < TH.length && TH[i] < z) i++; return i; }
// Hysteresis: keep `prev` unless z has cleared the boundary into the new bin by eps = 0.25 x the narrower adjacent bin.
export function binWithHysteresis(z, TH, prev) {
  const raw = binOf(z, TH);
  if (prev == null || raw === prev) return raw;
  const width = (i) => (i <= 0 ? TH[1] - TH[0] : i >= TH.length ? TH[TH.length - 1] - TH[TH.length - 2] : TH[i] - TH[i - 1]);
  if (raw > prev) { const bnd = TH[prev], eps = 0.25 * Math.min(width(prev), width(prev + 1)); return z > bnd + eps ? raw : prev; }
  const bnd = TH[prev - 1], eps = 0.25 * Math.min(width(prev - 1), width(prev)); return z < bnd - eps ? raw : prev;
}
