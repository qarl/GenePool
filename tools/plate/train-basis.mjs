// train-basis.mjs -- train the FROZEN body-plate basis (docs/PLAN-body-plate.md) and emit engine/analysis/plate-basis.mjs.
// Data: every champion pool (+ early-run snapshots from the seed timelines, so founders/young runs don't saturate).
// Unit = a SPECIES (junk-DNA reproductive cluster, the engine's gate) mean body-feature vector. Each pool/snapshot counts
// EQUALLY (a pool's species are near-duplicates of each other). 30% of pools (seed % 10 < 3) are HELD OUT for
// validation. Pipeline: z-score -> group weights -> weighted PCA top-5 -> fixed random rotation (Karl: no single cell
// readable) -> ONE shared set of 35 letter thresholds (weighted quantiles of all 5 rotated coords pooled). The runtime
// computes coords with body-features coordsOf() on the emitted literals (shortest round-trip), so trainer and runtime
// agree bit-for-bit.
//   node tools/plate/train-basis.mjs [--no-early]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsDir } from '../scrub/gen-jobs.mjs';
import { openRunReader } from '../events/run-db.mjs';
import { USED, NJ, SPECIES_ISO, junkSim } from '../../engine/analysis/species.mjs';
import { NF, FEATURES, FEATURE_NAMES, FEAT_ONE, featuresOfGenes, coordsOf } from '../../engine/analysis/body-features.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TICKS_PER_DAY = 5184000, MIN_SPECIES = 5, K = 5, NSYM = 36;
const VISIBILITY = { size: 1, shape: 1, structure: 1, colour: 0.6, texture: 1, motion: 0.8 };   // colour is washed out by the shader
const noEarly = process.argv.includes('--no-early');
const isHeldOut = (seed) => seed % 10 < 3;

// ---- species partition (the analyzer's rule: first-seen lineage seeds, junkSim > SPECIES_ISO; the evolvable
// mutation-rate gene 255 excluded from the junk span, as in every POOL_SETTINGS run) ----
const nj = NJ - 1;
function speciesMeans(swimbots) {
  const reps = [];
  for (const s of swimbots) {
    if (s.alive === false || !s.genes) continue;
    const jg = new Float64Array(nj); for (let k = 0; k < nj; k++) jg[k] = s.genes[USED + k];
    let best = null, bs = SPECIES_ISO;
    for (const r of reps) { const v = junkSim(jg, r.seed); if (v > bs) { bs = v; best = r; } }
    const f = featuresOfGenes(s.genes);
    if (!best) reps.push(best = { seed: jg, sum: new Float64Array(NF), n: 0, genes: s.genes });
    for (let k = 0; k < NF; k++) best.sum[k] += f[k]; best.n++;
  }
  return reps.filter((r) => r.n >= MIN_SPECIES).map((r) => ({ mean: Array.from(r.sum, (v) => v / r.n), n: r.n, genes: r.genes }));
}

// ---- gather ----
const units = [];   // { mean[NF] (fixed-point units), w, seed, kind, heldOut }
const champ = join(jobsDir(), 'champions');
for (const f of readdirSync(champ).filter((x) => /^seed-\d+\.pool$/.test(x))) {
  const p = JSON.parse(readFileSync(join(champ, f), 'utf8'));
  const sp = speciesMeans(p.data.swimbots);
  for (const s of sp) units.push({ mean: s.mean, w: 1 / sp.length, seed: p.seed, kind: 'pool', heldOut: isHeldOut(p.seed), n: s.n, genes: s.genes });
}
let early = 0;
if (!noEarly) {
  const tl = join(jobsDir(), 'timelines');
  for (const f of readdirSync(tl).filter((x) => /^seed-\d+\.db$/.test(x))) {
    const seed = parseInt(f.slice(5));
    if (isHeldOut(seed)) continue;
    const r = openRunReader(join(tl, f));
    try {
      for (const t of [0, 0.05 * TICKS_PER_DAY, 0.2 * TICKS_PER_DAY]) {
        const kf = r.getKeyframe(t); if (!kf) continue;
        const sp = speciesMeans(kf.snapshot.swimbots || []);
        for (const s of sp) units.push({ mean: s.mean, w: 0.5 / sp.length, seed, kind: 'early', heldOut: false, n: s.n });
        early++;
      }
    } finally { r.close(); }
  }
}
const train = units.filter((u) => !u.heldOut), held = units.filter((u) => u.heldOut);
console.log(`units: ${units.length} species (${train.length} train incl. ${early} early snapshots, ${held.length} held out)`);

// ---- standardise + group weights ----
const W0 = train.reduce((s, u) => s + u.w, 0);
const mean = new Float64Array(NF), sd = new Float64Array(NF);
for (const u of train) for (let k = 0; k < NF; k++) mean[k] += u.w * u.mean[k] / W0;
for (const u of train) for (let k = 0; k < NF; k++) sd[k] += u.w * (u.mean[k] - mean[k]) ** 2 / W0;
for (let k = 0; k < NF; k++) sd[k] = Math.sqrt(sd[k]) || 1;
const groupN = {}; for (const [, g] of FEATURES) groupN[g] = (groupN[g] || 0) + 1;
const gw = FEATURES.map(([, g]) => (VISIBILITY[g] ?? 1) / Math.sqrt(groupN[g]));
const Z = (u) => u.mean.map((v, k) => ((v - mean[k]) / sd[k]) * gw[k]);

// ---- weighted PCA (power iteration + deflation) ----
function topK(rows, weights, k) {
  const Wt = weights.reduce((a, b) => a + b, 0);
  const C = Array.from({ length: NF }, () => new Float64Array(NF));
  rows.forEach((x, i) => { const w = weights[i] / Wt; for (let a = 0; a < NF; a++) for (let b = 0; b < NF; b++) C[a][b] += w * x[a] * x[b]; });
  let tot = 0; for (let a = 0; a < NF; a++) tot += C[a][a];
  const vecs = [], vals = [];
  for (let c = 0; c < k; c++) {
    let v = new Float64Array(NF).fill(1 / Math.sqrt(NF)).map((x, i) => x + i * 1e-3), lam = 0;
    for (let it = 0; it < 2000; it++) { const nv = new Float64Array(NF); for (let a = 0; a < NF; a++) { let s = 0; for (let b = 0; b < NF; b++) s += C[a][b] * v[b]; nv[a] = s; }
      lam = Math.sqrt(nv.reduce((s, x) => s + x * x, 0)); for (let a = 0; a < NF; a++) nv[a] /= lam || 1; v = nv; }
    let big = 0; for (let a = 1; a < NF; a++) if (Math.abs(v[a]) > Math.abs(v[big])) big = a; if (v[big] < 0) v = v.map((x) => -x);
    vecs.push(v); vals.push(lam);
    for (let a = 0; a < NF; a++) for (let b = 0; b < NF; b++) C[a][b] -= lam * v[a] * v[b];
  }
  return { vecs, vals, tot };
}
const X = train.map(Z), wts = train.map((u) => u.w);
const { vecs: comps, vals, tot } = topK(X, wts, K);
const varExpl = vals.map((v) => v / tot);
// bootstrap subspace stability over pools/seeds: ||U^T U_b||_F^2 / K  (1 = identical 5-D subspace)
const seeds = [...new Set(train.map((u) => u.seed))];
let rs = 0x5eed; const rnd = () => ((rs = (rs * 1103515245 + 12345) >>> 0) / 4294967296);
const stab = [];
for (let b = 0; b < 20; b++) {
  const pick = new Map(); for (let i = 0; i < seeds.length; i++) { const s = seeds[Math.floor(rnd() * seeds.length)]; pick.set(s, (pick.get(s) || 0) + 1); }
  const rows = [], ws = []; train.forEach((u, i) => { const m = pick.get(u.seed); if (m) { rows.push(X[i]); ws.push(u.w * m); } });
  const { vecs } = topK(rows, ws, K);
  let f = 0; for (const a of comps) for (const c of vecs) { let d = 0; for (let k = 0; k < NF; k++) d += a[k] * c[k]; f += d * d; }
  stab.push(f / K);
}

// ---- fixed random rotation of the 5-D subspace (frozen via the emitted literals) ----
let rr = 0x9ea7e5; const u01 = () => ((rr = (Math.imul(rr ^ (rr >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0) / 4294967296) || 1e-12;
const gauss = () => Math.sqrt(-2 * Math.log(u01())) * Math.cos(2 * Math.PI * u01());
const R = Array.from({ length: K }, () => Array.from({ length: K }, gauss));
for (let i = 0; i < K; i++) { for (let j = 0; j < i; j++) { let d = 0; for (let k = 0; k < K; k++) d += R[i][k] * R[j][k]; for (let k = 0; k < K; k++) R[i][k] -= d * R[j][k]; }
  const n = Math.sqrt(R[i].reduce((s, x) => s + x * x, 0)); for (let k = 0; k < K; k++) R[i][k] /= n; }
// fold: coords = R . C . diag(gw/sd) . (f - mean)  ->  W . f + B   (f in fixed-point units)
const M = R.map((row) => Array.from({ length: NF }, (_, k) => row.reduce((s, r, j) => s + r * comps[j][k], 0)));
const W = M.map((row) => row.map((m, k) => (m * gw[k]) / sd[k]));
const B = W.map((row) => -row.reduce((s, w, k) => s + w * mean[k], 0));

// ---- ONE shared letter scale: weighted quantiles of all 5 rotated coords pooled (training species) ----
const pooled = [];
for (const u of train) { const c = coordsOf(u.mean, W, B); for (let i = 0; i < K; i++) pooled.push([c[i], u.w]); }
pooled.sort((a, b) => a[0] - b[0]);
const totW = pooled.reduce((s, p) => s + p[1], 0), TH = [];
let acc = 0, j = 0;
for (let q = 1; q < NSYM; q++) { const target = (q / NSYM) * totW; while (j < pooled.length && acc + pooled[j][1] < target) { acc += pooled[j][1]; j++; } TH.push(pooled[Math.min(j, pooled.length - 1)][0]); }
for (let i = 1; i < TH.length; i++) if (!(TH[i] > TH[i - 1])) TH[i] = TH[i - 1] + 1e-9 * (Math.abs(TH[i - 1]) + 1);   // strictly increasing

// ---- emit ----
const num = (x) => String(x);
const out = `// GENERATED by tools/plate/train-basis.mjs on ${new Date().toISOString().slice(0, 10)} -- do not edit by hand.
// Frozen body-plate basis (docs/PLAN-body-plate.md). coords = W . meanFeat + B (meanFeat in body-features FEAT_ONE
// fixed-point units, k ascending), letter = number of TH strictly below each coord (one shared scale, 0..35).
// Trained on ${train.length} species (${seeds.length} pools/seeds; each pool weighted equally; ${held.length} held-out species not used).
// Top-5 PCA of the weighted body-feature space explains ${(varExpl.reduce((a, b) => a + b, 0) * 100).toFixed(1)}% (${varExpl.map((v) => (v * 100).toFixed(1)).join(' / ')});
// bootstrap 5-D subspace stability ${Math.min(...stab).toFixed(3)} (min of 20). Axes are RANDOMLY ROTATED (Karl: no readable cell).
// Features: ${FEATURE_NAMES.join(', ')}.
export const PLATE_W = [
${W.map((r) => '  [' + r.map(num).join(',') + '],').join('\n')}
];
export const PLATE_B = [${B.map(num).join(',')}];
export const PLATE_TH = [${TH.map(num).join(',')}];
`;
writeFileSync(join(ROOT, 'engine', 'analysis', 'plate-basis.mjs'), out);
const report = { date: new Date().toISOString(), trainSpecies: train.length, heldSpecies: held.length, pools: seeds.length, early, varExpl, eigen: vals,
  eigenGaps: vals.slice(1).map((v, i) => +(vals[i] / v).toFixed(3)), stability: stab.map((x) => +x.toFixed(3)), visibility: VISIBILITY, features: FEATURE_NAMES,
  mean: Array.from(mean), sd: Array.from(sd), loadings: comps.map((v) => FEATURE_NAMES.map((n, k) => [n, +v[k].toFixed(3)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5)) };
writeFileSync(join(HERE, 'basis-report.json'), JSON.stringify(report, null, 2));
console.log(`top-5 variance explained: ${(varExpl.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%  [${varExpl.map((v) => (v * 100).toFixed(1)).join(', ')}]`);
console.log(`eigen gaps (λi/λi+1): ${report.eigenGaps.join(', ')}   subspace stability: min ${Math.min(...stab).toFixed(3)} mean ${(stab.reduce((a, b) => a + b, 0) / stab.length).toFixed(3)}`);
report.loadings.forEach((l, i) => console.log(`  PC${i + 1}: ${l.map(([n, v]) => `${n} ${v}`).join(', ')}`));
console.log(`-> engine/analysis/plate-basis.mjs, tools/plate/basis-report.json`);
