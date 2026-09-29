// analyze-pools.mjs -- the POOL ATLAS data pass. Reads every champion .pool (each = one seed's evolved population at
// day 1, or its peak if it starved first) and organises them by what they evolved:
//   * species per pool via the APP'S OWN analyzer (engine/analysis/species.mjs: junk-DNA reproductive clusters,
//     same SPECIES_ISO gate, same body plate) -> the atlas agrees with the in-app species list;
//   * everything below lives in PLATE SPACE (engine/analysis/body-features.mjs + plate-basis.mjs): the 5 frozen body
//     coordinates behind every plate, so map, families and plates all agree on "what looks alike";
//   * each species' FACE = its most typical grown member (closest to the species' mean plate coordinates);
//   * a MAP of all pools: PCA over body plan + motion features (colour + hairiness EXCLUDED, Karl) -> 2-D layout;
//     axis captions = the body features most correlated with each map axis;
//   * FAMILIES: Ward clustering on the same form+motion features (K by silhouette); gallery order = dendrogram leaf order;
//   * FAVOURITES: <jobsDir>/favorites.json (Karl's list + all seed-3 killers) -> flagged for the page;
//   * labels: population, species count, peak-vs-day-1, vs-seed-3 result (hunt log), tournament record.
// Observer-only: reads files, writes <jobsDir>/atlas/atlas.json. No engine state touched.
//   node tools/atlas/analyze-pools.mjs [--families K]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSpeciesAnalyzer } from '../../engine/analysis/species.mjs';
import { FEATURES, FEATURE_NAMES, NF, FEAT_ONE, featuresOfGenes, rawFeatures, plateBodyOfGenes, coordsOf } from '../../engine/analysis/body-features.mjs';
import { PLATE_W, PLATE_B } from '../../engine/analysis/plate-basis.mjs';
import { poolConfig, POOL_DEFAULTS, POOL_SETTINGS } from '../../engine/pool-seed.mjs';
import { jobsDir } from '../scrub/gen-jobs.mjs';

const TICKS_PER_DAY = 5184000;
const MIN_SPECIES = 5;        // ignore transient tiny clusters (same noise floor as tools/pca/extract-seed.mjs)
const MAX_SPECIES = 6;        // faces rendered per pool (main + up to 5 minor)
const args = process.argv.slice(2);
const famOpt = (() => { const i = args.indexOf('--families'); return i >= 0 ? Number(args[i + 1]) : null; })();

const champDir = join(jobsDir(), 'champions');
const outDir = join(jobsDir(), 'atlas'); mkdirSync(outDir, { recursive: true });
const readJSON = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

// ---- metadata sources (all optional) ----
const huntLog = new Map();    // seed -> last probe vs seed-3
try { for (const l of readFileSync(join(jobsDir(), 'hunt-log-vs-seed3.jsonl'), 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); huntLog.set(r.seed, r); } } catch { /* none */ }
const killers = new Set(((readJSON(join(jobsDir(), 'superorganisms-vs-seed3.json')) || {}).members || []).map((m) => m.seed));
const favDoc = readJSON(join(jobsDir(), 'favorites.json')) || {};
const favorites = new Set([...(favDoc.seeds || []), ...(favDoc.includeSeed3Killers ? killers : [])]);   // Karl's list + all seed-3 killers
const league = new Map((((readJSON(join(jobsDir(), 'tournament-standings.json')) || {}).table) || []).map((r, i) => [r.seed, { rank: i + 1, ...r }]));

// Named raw body features of one genome (the shared plate features) + its raw segment count, for labels + family names.
function bodyOf(genes) {
  const ph = plateBodyOfGenes(genes), r = rawFeatures(ph), o = { parts: ph.numParts - 1 };
  FEATURE_NAMES.forEach((n, k) => { o[n] = +r[k].toFixed(4); });
  return o;
}

// A .pool swimbot -> the minimal surface the analyzer reads (getAlive / _phenotype.numParts / getGenotype().getGeneValue).
const stand = (s) => { const g = s.genes; return { s, getAlive: () => s.alive !== false, _phenotype: { numParts: (s.parts || []).length },
  getGenotype: () => ({ getGeneValue: (k) => g[k] }) }; };

const cfg = poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS);
const pools = [];
const files = readdirSync(champDir).filter((f) => /^seed-\d+\.pool$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
for (const f of files) {
  const p = readJSON(join(champDir, f)); if (!p) continue;
  const bots = ((p.data && p.data.swimbots) || []).filter((s) => s && s.alive !== false);
  const an = createSpeciesAnalyzer(cfg);
  const { speciesList } = an.recompute(bots.map(stand));
  const grownTotal = speciesList.reduce((n, r) => n + r.count, 0);
  const species = [];
  for (const r of speciesList) {
    if (r.count < MIN_SPECIES || species.length >= MAX_SPECIES) continue;
    const members = [...r.t.idset].map((x) => x.s);
    const feats = members.map((m) => featuresOfGenes(m.genes));
    const mean = new Float64Array(NF); for (const f of feats) for (let k = 0; k < NF; k++) mean[k] += f[k]; for (let k = 0; k < NF; k++) mean[k] /= feats.length;
    const mc = coordsOf(mean, PLATE_W, PLATE_B);
    // face = most typical GROWN member in plate space (growthScale ~1 so every face is an adult at comparable scale)
    let face = null, bd = Infinity;
    const pool = members.map((m, i) => [m, feats[i]]), grown = pool.filter(([m]) => (m.growthScale ?? 1) >= 0.9);
    for (const [m, f] of (grown.length ? grown : pool)) { const c = coordsOf(f, PLATE_W, PLATE_B); let d = 0; for (let k = 0; k < c.length; k++) d += (c[k] - mc[k]) ** 2; if (d < bd) { bd = d; face = m; } }
    species.push({ count: r.count, share: r.count / Math.max(1, grownTotal), sig: r.t.sig, coords: Array.from(mc, (v) => +v.toFixed(4)), featMean: Array.from(mean, (v) => +(v / FEAT_ONE).toFixed(5)),
      face: { genes: face.genes, age: face.age, angle: face.angle, energy: face.energy, parts: (face.parts || []).length, body: bodyOf(face.genes) } });
  }
  const seed = p.seed;
  const hl = huntLog.get(seed);
  pools.push({ seed, tick: p.tick, day: +(p.tick / TICKS_PER_DAY).toFixed(3), peak: p.tick < TICKS_PER_DAY - 2000,
    living: bots.length, nSpecies: species.length, species,
    vs3: seed === 3 ? { self: true } : hl ? { a: hl.a, b: hl.b, kill: !!hl.kill, days: hl.days } : null,
    killer: killers.has(seed), favorite: favorites.has(seed), league: league.get(seed) || null });
}

// ---- map + families on BODY PLAN + MOTION only (Karl 2026-09-29: no colour / hairiness in the clustering) ----
// z-scored main-species mean features, colour + texture groups dropped, each remaining group weighted equally.
// (Plates still include colour + hair; the atlas grouping is deliberately about form and movement.)
const CLUSTER_EXCLUDE = new Set(['colour', 'texture']);
const keep = FEATURES.map(([, g], k) => (CLUSTER_EXCLUDE.has(g) ? -1 : k)).filter((k) => k >= 0);
const gN = {}; for (const k of keep) gN[FEATURES[k][1]] = (gN[FEATURES[k][1]] || 0) + 1;
const P = pools.filter((p) => p.species.length);
const Fm = P.map((p) => keep.map((k) => p.species[0].featMean[k]));
const fMu = keep.map((_, j) => Fm.reduce((s, f) => s + f[j], 0) / Fm.length);
const fSd = keep.map((_, j) => Math.sqrt(Fm.reduce((s, f) => s + (f[j] - fMu[j]) ** 2, 0) / Math.max(1, Fm.length - 1)) || 1);
const X = Fm.map((f) => f.map((v, j) => ((v - fMu[j]) / fSd[j]) / Math.sqrt(gN[FEATURES[keep[j]][1]])));
const D = X[0].length, N = X.length;
const mu = new Float64Array(D); for (const x of X) for (let k = 0; k < D; k++) mu[k] += x[k] / N;
const Xc = X.map((x) => Float64Array.from(x, (v, k) => v - mu[k]));
// top-2 PCA via power iteration on the covariance (dependency-free; N,D small)
const C = Array.from({ length: D }, () => new Float64Array(D));
for (const x of Xc) for (let i = 0; i < D; i++) { const xi = x[i]; if (!xi) continue; for (let j = 0; j < D; j++) C[i][j] += xi * x[j] / (N - 1); }
let totVar = 0; for (let i = 0; i < D; i++) totVar += C[i][i];
const comps = [], evals = [];
for (let c = 0; c < 2; c++) {
  let v = new Float64Array(D).fill(1 / Math.sqrt(D)), lam = 0;
  for (let it = 0; it < 500; it++) { const w = new Float64Array(D); for (let i = 0; i < D; i++) { let s = 0; for (let j = 0; j < D; j++) s += C[i][j] * v[j]; w[i] = s; }
    lam = Math.hypot(...w); for (let i = 0; i < D; i++) w[i] /= lam || 1; v = w; }
  comps.push(v); evals.push(lam);
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) C[i][j] -= lam * v[i] * v[j];   // deflate
}
P.forEach((p, i) => { p.map = comps.map((v) => +Xc[i].reduce((s, x, k) => s + x * v[k], 0).toFixed(2)); });
// axis captions: the body features most correlated (across pools) with each map axis -- signed, so the page can say which end is which
const corr = (a, b) => { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt((saa * sbb) || 1); };
const mapAxes = [0, 1].map((ax) => FEATURE_NAMES.map((k) => [k, +corr(P.map((p) => p.map[ax]), P.map((p) => p.species[0].face.body[k])).toFixed(2)])
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4));

// WARD agglomerative clustering on body plan + motion -> merge tree (+ leaf order for the gallery).
// Ward merges the pair that least increases within-cluster variance -> compact, balanced families (average linkage
// just peeled off outliers). K = the family count with the best mean silhouette in [4,10] (or --families K).
const dist = (a, b) => { let s = 0; for (let k = 0; k < D; k++) { const x = a[k] - b[k]; s += x * x; } return Math.sqrt(s); };
let clusters = P.map((_, i) => ({ items: [i], order: [i], h: 0, c: Float64Array.from(X[i]) }));
const ward = (A, B) => { const na = A.items.length, nb = B.items.length; let s = 0; for (let k = 0; k < D; k++) { const x = A.c[k] - B.c[k]; s += x * x; } return (na * nb / (na + nb)) * s; };
while (clusters.length > 1) {
  let bi = 0, bj = 1, bdist = Infinity;
  for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const d = ward(clusters[i], clusters[j]); if (d < bdist) { bdist = d; bi = i; bj = j; } }
  const A = clusters[bi], B = clusters[bj], na = A.items.length, nb = B.items.length;
  const M = { items: [...A.items, ...B.items], order: [...A.order, ...B.order], h: bdist, kids: [A, B], c: Float64Array.from(A.c, (v, k) => (v * na + B.c[k] * nb) / (na + nb)) };
  clusters = clusters.filter((_, k) => k !== bi && k !== bj); clusters.push(M);
}
const root = clusters[0];
const cutK = (k) => { let fs = [root]; while (fs.length < k) { fs.sort((a, b) => b.h - a.h); const t = fs.shift(); if (!t.kids) { fs.push(t); break; } fs.push(...t.kids); } return fs; };
const silhouette = (fs) => { const lab = new Array(N); fs.forEach((f, fi) => f.items.forEach((i) => { lab[i] = fi; })); let tot = 0;
  for (let i = 0; i < N; i++) { const own = fs[lab[i]].items; if (own.length < 2) continue;
    const a = own.reduce((s, j) => s + (j === i ? 0 : dist(X[i], X[j])), 0) / (own.length - 1);
    let b = Infinity; fs.forEach((f, fi) => { if (fi === lab[i]) return; const m = f.items.reduce((s, j) => s + dist(X[i], X[j]), 0) / f.items.length; if (m < b) b = m; });
    tot += (b - a) / Math.max(a, b); }
  return tot / N; };
let K = famOpt, sil = {};
if (!K) { let best = -2; for (let k = 4; k <= 10; k++) { const s = silhouette(cutK(k)); sil[k] = +s.toFixed(3); if (s > best) { best = s; K = k; } } }
let fams = cutK(K);
fams.sort((a, b) => root.order.indexOf(a.order[0]) - root.order.indexOf(b.order[0]));   // families in dendrogram order
fams.forEach((fm, fi) => fm.order.forEach((i, oi) => { P[i].family = fi; P[i].order = root.order.indexOf(i); }));

const out = { generatedAt: new Date().toISOString(), pools: pools.length, families: fams.length, silhouette: sil,
  mapVariance: evals.map((e) => +(e / totVar).toFixed(3)), mapAxes, features: FEATURE_NAMES,
  familySummary: fams.map((fm, fi) => ({ family: fi, size: fm.items.length, seeds: fm.order.map((i) => P[i].seed), killers: fm.order.map((i) => P[i]).filter((p) => p.killer).map((p) => p.seed) })),
  data: pools };
writeFileSync(join(outDir, 'atlas.json'), JSON.stringify(out));
console.log(`atlas: ${pools.length} pools, ${fams.length} families (map axes explain ${(out.mapVariance[0] * 100).toFixed(0)}% + ${(out.mapVariance[1] * 100).toFixed(0)}% of body variance) -> ${join(outDir, 'atlas.json')}`);
for (const f of out.familySummary) console.log(`  family ${f.family}: ${String(f.size).padStart(3)} pools${f.killers.length ? `  killers: ${f.killers.map((s) => 'seed-' + s).join(', ')}` : ''}  [${f.seeds.slice(0, 14).join(',')}${f.size > 14 ? ',…' : ''}]`);
