// analyze-pools.mjs -- the POOL ATLAS data pass. Reads every champion .pool (each = one seed's evolved population at
// day 1, or its peak if it starved first) and organises them by what they evolved:
//   * species per pool via the APP'S OWN analyzer (engine/analysis/species.mjs: junk-DNA reproductive clusters,
//     same SPECIES_ISO gate, same 5-symbol plate signature) -> the atlas agrees with the in-app species list;
//   * each species' FACE = its most typical grown body (member closest to the species' mean EXPRESSED genes [0,83)
//     -- the genes that build the body; junk [112,256) is a random identity tag and says nothing about form);
//   * a MAP of all pools: PCA over the pools' main-species body means -> 2-D layout (look-alikes land together);
//   * FAMILIES: average-linkage clustering of those body means; gallery order = dendrogram leaf order;
//   * labels: population, species count, peak-vs-day-1, vs-seed-3 result (hunt log), tournament record.
// Observer-only: reads files, writes <jobsDir>/atlas/atlas.json. No engine state touched.
//   node tools/atlas/analyze-pools.mjs [--families K]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSpeciesAnalyzer, EXPRESSED } from '../../engine/analysis/species.mjs';
import { poolConfig, POOL_DEFAULTS, POOL_SETTINGS } from '../../engine/pool-seed.mjs';
import { jobsDir } from '../scrub/gen-jobs.mjs';
import { Genotype } from '../../engine/genotype.js';
import { Embryology } from '../../engine/embryology.js';

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
const league = new Map((((readJSON(join(jobsDir(), 'tournament-standings.json')) || {}).table) || []).map((r, i) => [r.seed, { rank: i + 1, ...r }]));

// BODY features of a genome, from the engine's own embryology (the phenotype the creature actually grows). Gene-space
// distance is a poor ruler for 'similar creatures' (genes act as thresholds/switches and the space is near-isotropic),
// so families + map are built on these. Colour is kept but down-weighted (COLOR_W) so shape dominates.
const emb = new Embryology();
const FEATURES = ['parts', 'length', 'width', 'taper', 'aspect', 'branches', 'depth', 'freq', 'amp', 'turn', 'red', 'green', 'blue'];
const COLOR_W = 0.5;
function bodyFeatures(genes, config) {
  const gt = new Genotype(); gt.setGenes(genes);
  const ph = emb.generatePhenotypeFromGenotype(gt, config);
  const n = ph.numParts, parts = ph.parts.slice(1, n);          // part 0 = root (no body segment)
  let L = 0, W = 0, wL = 0, r = 0, g = 0, b = 0, amp = 0, turn = 0, branches = 0, depth = 0;
  const dep = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const q = ph.parts[i]; L += q.length; W += q.width; const a = q.length * q.width; wL += a;
    r += q.red * a; g += q.green * a; b += q.blue * a; amp += Math.abs(q.amp); turn += Math.abs(q.turnAmp);
    if (q.branch && q.parent > 0) branches++;
    dep[i] = (q.parent > 0 ? dep[q.parent] : 0) + (q.branch ? 1 : 0); if (dep[i] > depth) depth = dep[i];
  }
  const m = parts.length || 1, first = parts[0], last = parts[parts.length - 1];
  return { parts: n - 1, length: L, width: W / m, taper: first && last ? last.width / first.width : 1, aspect: L / (W / m || 1),
    branches, depth, freq: ph.frequency, amp: amp / m, turn: turn / m, red: r / (wL || 1), green: g / (wL || 1), blue: b / (wL || 1) };
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
    const mean = new Float64Array(EXPRESSED);
    for (const m of members) for (let k = 0; k < EXPRESSED; k++) mean[k] += m.genes[k];
    for (let k = 0; k < EXPRESSED; k++) mean[k] /= members.length;
    // face = most typical GROWN body (growthScale ~1 so every face is an adult at comparable scale)
    const grown = members.filter((m) => (m.growthScale ?? 1) >= 0.9);
    let face = null, bd = Infinity;
    for (const m of (grown.length ? grown : members)) { let d = 0; for (let k = 0; k < EXPRESSED; k++) { const x = m.genes[k] - mean[k]; d += x * x; } if (d < bd) { bd = d; face = m; } }
    species.push({ count: r.count, share: r.count / Math.max(1, grownTotal), sig: r.t.sig, mean: Array.from(mean, (v) => +v.toFixed(2)),
      face: { genes: face.genes, age: face.age, angle: face.angle, energy: face.energy, parts: (face.parts || []).length, body: bodyFeatures(face.genes, cfg) } });
  }
  const seed = p.seed;
  const hl = huntLog.get(seed);
  pools.push({ seed, tick: p.tick, day: +(p.tick / TICKS_PER_DAY).toFixed(3), peak: p.tick < TICKS_PER_DAY - 2000,
    living: bots.length, nSpecies: species.length, species,
    vs3: seed === 3 ? { self: true } : hl ? { a: hl.a, b: hl.b, kill: !!hl.kill, days: hl.days } : null,
    killer: killers.has(seed), league: league.get(seed) || null });
}

// ---- map + families over the pools' MAIN-species BODY features (z-scored; colour down-weighted) ----
const P = pools.filter((p) => p.species.length);
const F = P.map((p) => FEATURES.map((k) => p.species[0].face.body[k]));
const fMu = FEATURES.map((_, j) => F.reduce((s, f) => s + f[j], 0) / F.length);
const fSd = FEATURES.map((_, j) => Math.sqrt(F.reduce((s, f) => s + (f[j] - fMu[j]) ** 2, 0) / Math.max(1, F.length - 1)) || 1);
const X = F.map((f) => f.map((v, j) => ((v - fMu[j]) / fSd[j]) * (['red', 'green', 'blue'].includes(FEATURES[j]) ? COLOR_W : 1)));
const D = FEATURES.length, N = X.length;
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
const mapAxes = comps.map((v) => FEATURES.map((k, j) => [k, +v[j].toFixed(2)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4));

// WARD agglomerative clustering on the z-scored body features -> merge tree (+ leaf order for the gallery).
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
  mapVariance: evals.map((e) => +(e / totVar).toFixed(3)), mapAxes, features: FEATURES,
  familySummary: fams.map((fm, fi) => ({ family: fi, size: fm.items.length, seeds: fm.order.map((i) => P[i].seed), killers: fm.order.map((i) => P[i]).filter((p) => p.killer).map((p) => p.seed) })),
  data: pools };
writeFileSync(join(outDir, 'atlas.json'), JSON.stringify(out));
console.log(`atlas: ${pools.length} pools, ${fams.length} families (map axes explain ${(out.mapVariance[0] * 100).toFixed(0)}% + ${(out.mapVariance[1] * 100).toFixed(0)}% of body variance) -> ${join(outDir, 'atlas.json')}`);
for (const f of out.familySummary) console.log(`  family ${f.family}: ${String(f.size).padStart(3)} pools${f.killers.length ? `  killers: ${f.killers.map((s) => 'seed-' + s).join(', ')}` : ''}  [${f.seeds.slice(0, 14).join(',')}${f.size > 14 ? ',…' : ''}]`);
