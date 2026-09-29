// validate.mjs -- does the body plate make look-alikes carry similar plates? (docs/PLAN-body-plate.md §4)
// Uses ONLY held-out pools (seed % 10 < 3; never seen by train-basis). Judged on measures INDEPENDENT of the plate's
// features (the plate is built from body features, so "plate vs feature distance" would be circular):
//   1. PIXEL descriptors: each species' typical member rendered at a FIXED zoom (size kept) over 8 swim frames ->
//      silhouette area / compactness / elongation / radial profile / pixel colour + a motion term (mask change between
//      frames). Spearman rho(plate distance, picture distance) over CROSS-POOL pairs, NEW plate vs OLD plate.
//   2. Contact sheets: random species + their 3 nearest-plate species from OTHER pools (new vs old) -> HTML + PNG.
//   3. Letter uniformity per position (new plates, held-out species).
//   4. A triplet page for Karl ("which of B/C looks more like A?") that scores new vs old plates against his eye.
// Outputs: <jobsDir>/plate-validation/{report.json, sheet-new.html/png, sheet-old.html/png, triplets.html, faces/}
//   node tools/plate/validate.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { jobsDir } from '../scrub/gen-jobs.mjs';
import { USED, NJ, SPECIES_ISO, junkSim, plateOf } from '../../engine/analysis/species.mjs';
import { NF, featuresOfGenes, coordsOf } from '../../engine/analysis/body-features.mjs';
import { PLATE_W, PLATE_B } from '../../engine/analysis/plate-basis.mjs';
import { oldCoords, signatureOf as oldPlateOf, EXPRESSED } from './old-plate.mjs';
import { exeFor, LAUNCH_ARGS } from '../../test/visual/lib/browser.mjs';
import { startServer } from '../../test/visual/lib/server.mjs';
import { encode } from '../../test/visual/lib/png.mjs';

const { chromium } = createRequire(new URL('../../test/visual/package.json', import.meta.url))('playwright-core');
const OUT = join(jobsDir(), 'plate-validation'), FACES = join(OUT, 'faces'); mkdirSync(FACES, { recursive: true });
const MIN_SPECIES = 5, PER_POOL = 6, FRAMES = 8, EVERY = 6, ZOOM = 14;
let rs = 0xbeef; const rnd = () => ((rs = (Math.imul(rs ^ (rs >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0) / 4294967296);

// ---- held-out species ----
const nj = NJ - 1, species = [];
const champ = join(jobsDir(), 'champions');
for (const f of readdirSync(champ).filter((x) => /^seed-\d+\.pool$/.test(x))) {
  const p = JSON.parse(readFileSync(join(champ, f), 'utf8'));
  if (p.seed % 10 >= 3) continue;
  const reps = [];
  for (const s of p.data.swimbots) {
    if (s.alive === false) continue;
    const jg = new Float64Array(nj); for (let k = 0; k < nj; k++) jg[k] = s.genes[USED + k];
    let best = null, bs = SPECIES_ISO; for (const r of reps) { const v = junkSim(jg, r.seed); if (v > bs) { bs = v; best = r; } }
    if (!best) reps.push(best = { seed: jg, members: [] });
    best.members.push(s);
  }
  reps.filter((r) => r.members.length >= MIN_SPECIES).sort((a, b) => b.members.length - a.members.length).slice(0, PER_POOL).forEach((r, i) => {
    const feats = r.members.map((m) => featuresOfGenes(m.genes));
    const mean = new Float64Array(NF); for (const x of feats) for (let k = 0; k < NF; k++) mean[k] += x[k]; for (let k = 0; k < NF; k++) mean[k] /= feats.length;
    const genesMean = new Array(EXPRESSED).fill(0); for (const m of r.members) for (let k = 0; k < EXPRESSED; k++) genesMean[k] += m.genes[k] / r.members.length;
    const nc = Array.from(coordsOf(mean, PLATE_W, PLATE_B));
    let face = r.members[0], bd = Infinity;
    r.members.forEach((m, j) => { if ((m.growthScale ?? 1) < 0.9) return; const c = coordsOf(feats[j], PLATE_W, PLATE_B); let d = 0; for (let k = 0; k < 5; k++) d += (c[k] - nc[k]) ** 2; if (d < bd) { bd = d; face = m; } });
    species.push({ id: `${p.seed}-${i}`, pool: p.seed, n: r.members.length, newC: nc, newSig: plateOf(mean), oldC: oldCoords(genesMean), oldSig: oldPlateOf(genesMean), face });
  });
}
console.log(`held-out species: ${species.length} from ${new Set(species.map((s) => s.pool)).size} pools`);

// ---- render: fixed-zoom frames for descriptors + fitted stills for display ----
const server = await startServer();
const browser = await chromium.launch({ executablePath: exeFor({}).exe, headless: true, args: LAUNCH_ARGS });
const page = await browser.newPage({ viewport: { width: 940, height: 800 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForFunction(() => typeof window.__specimenNext === 'function', { timeout: 10000 });
const spec = (s) => ({ genes: s.face.genes, age: s.face.age, angle: s.face.angle, energy: s.face.energy });

function descriptor(frames) {   // frames: array of RGBA Buffers (256x256, bottom-up -- orientation irrelevant here)
  const W = 256, masks = [];
  const acc = { area: 0, comp: 0, elong: 0, rad: new Float64Array(8), r: 0, g: 0, b: 0 };
  for (const px of frames) {
    const border = []; for (let i = 0; i < W; i++) for (const [x, y] of [[i, 0], [i, W - 1], [0, i], [W - 1, i]]) { const o = (y * W + x) * 4; border.push(px[o] + px[o + 1] + px[o + 2]); }
    border.sort((a, b) => a - b); const bgL = border[border.length >> 1] / 3;
    let bo = null; for (let i = 0; i < W * W; i++) { const o = i * 4; if (Math.abs((px[o] + px[o + 1] + px[o + 2]) / 3 - bgL) < 2) { bo = o; break; } }
    const bR = bo != null ? px[bo] : bgL, bG = bo != null ? px[bo + 1] : bgL, bB = bo != null ? px[bo + 2] : bgL;
    const m = new Uint8Array(W * W); let area = 0, sx = 0, sy = 0, cr = 0, cg = 0, cb = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4, d = Math.abs(px[o] - bR) + Math.abs(px[o + 1] - bG) + Math.abs(px[o + 2] - bB);
      if (d > 24) { m[y * W + x] = 1; area++; sx += x; sy += y; cr += px[o]; cg += px[o + 1]; cb += px[o + 2]; } }
    masks.push(m);
    if (!area) continue;
    const cx = sx / area, cy = sy / area; let per = 0, sxx = 0, syy = 0, sxy = 0;
    for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (!m[i]) continue;
      if (!m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W]) per++;
      const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; acc.rad[Math.min(7, Math.floor(Math.sqrt(dx * dx + dy * dy) / 14))]++; }
    const tr = (sxx + syy) / area, det = (sxx * syy - sxy * sxy) / (area * area), l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = Math.max(1e-6, tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det)));
    acc.area += area; acc.comp += per * per / area; acc.elong += Math.sqrt(l1 / l2); acc.r += cr / area; acc.g += cg / area; acc.b += cb / area;
  }
  let mot = 0; for (let i = 1; i < masks.length; i++) { let inter = 0, uni = 0; for (let j = 0; j < masks[i].length; j++) { const a = masks[i][j], b = masks[i - 1][j]; if (a && b) inter++; if (a || b) uni++; } mot += uni ? 1 - inter / uni : 0; }
  const n = frames.length, radTot = acc.rad.reduce((a, b) => a + b, 0) || 1;
  return [Math.sqrt(acc.area / n), acc.comp / n, acc.elong / n, ...Array.from(acc.rad, (v) => v / radTot), acc.r / n, acc.g / n, acc.b / n, mot / (n - 1)];
}

const t0 = Date.now();
for (const s of species) {
  const frames = [];
  const r0 = await page.evaluate(([sp, o]) => window.__specimen(sp, o), [spec(s), { seed: s.pool, zoom: ZOOM, ticks: 240 }]);
  if (!r0) { s.desc = null; continue; }
  frames.push(Buffer.from(r0.b64, 'base64'));
  for (let f = 1; f < FRAMES; f++) { const b = await page.evaluate(([t]) => window.__specimenNext(t), [EVERY]); if (b) frames.push(Buffer.from(b, 'base64')); }
  s.desc = descriptor(frames);
}
const V = species.filter((s) => s.desc);
console.log(`descriptors: ${V.length} species in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- 1. Spearman over cross-pool pairs ----
const D = V[0].desc.length, dm = new Float64Array(D), dsd = new Float64Array(D);
for (const s of V) for (let k = 0; k < D; k++) dm[k] += s.desc[k] / V.length;
for (const s of V) for (let k = 0; k < D; k++) dsd[k] += (s.desc[k] - dm[k]) ** 2 / V.length;
for (let k = 0; k < D; k++) dsd[k] = Math.sqrt(dsd[k]) || 1;
const dz = (s) => s.desc.map((v, k) => (v - dm[k]) / dsd[k]);
V.forEach((s) => { s.dz = dz(s); });
const euc = (a, b) => { let t = 0; for (let k = 0; k < a.length; k++) t += (a[k] - b[k]) ** 2; return Math.sqrt(t); };
const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const l1 = (a, b) => { let t = 0; for (let k = 0; k < 5; k++) t += Math.abs(ALPHA.indexOf(a[k]) - ALPHA.indexOf(b[k])); return t; };
const pairs = []; for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) if (V[i].pool !== V[j].pool) pairs.push([i, j]);
const rank = (xs) => { const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = new Float64Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = ra[i] - ma, y = rb[i] - ma; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt(saa * sbb); };
const pic = pairs.map(([i, j]) => euc(V[i].dz, V[j].dz));
const rho = {
  newCoords: spearman(pairs.map(([i, j]) => euc(V[i].newC, V[j].newC)), pic),
  oldCoords: spearman(pairs.map(([i, j]) => euc(V[i].oldC, V[j].oldC)), pic),
  newLetters: spearman(pairs.map(([i, j]) => l1(V[i].newSig, V[j].newSig)), pic),
  oldLetters: spearman(pairs.map(([i, j]) => l1(V[i].oldSig, V[j].oldSig)), pic),
};

// ---- 3. uniformity ----
const hist = [0, 1, 2, 3, 4].map((pos) => { const h = new Array(36).fill(0); for (const s of V) h[ALPHA.indexOf(s.newSig[pos])]++; return h; });
const distinct = new Set(V.map((s) => s.newSig)).size;

// ---- display stills (fitted) for sheets + triplets ----
const shown = new Set();
async function still(s) { if (shown.has(s.id)) return; shown.add(s.id);
  const r = await page.evaluate(([sp, o]) => window.__specimen(sp, o), [spec(s), { seed: s.pool, fitPx: 78 }]);
  if (r) writeFileSync(join(FACES, s.id + '.png'), encode(Buffer.from(r.b64, 'base64'), r.w, r.h, { flip: true })); }

// ---- 2. contact sheets: 12 random species + 3 nearest-plate species from other pools ----
const anchors = []; const pool = [...V]; for (let i = 0; i < 12 && pool.length; i++) anchors.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
const nearest = (a, key, cont) => V.filter((s) => s.pool !== a.pool).map((s) => [s, l1(a[key], s[key]) + 1e-3 * euc(a[cont], s[cont])]).sort((x, y) => x[1] - y[1]).slice(0, 3).map((x) => x[0]);
const plateCells = (sig) => `<span class="plate">${[...sig].map((c) => `<i style="background:oklch(0.78 0.13 ${(29 + ALPHA.indexOf(c) / 35 * 235).toFixed(1)})">${c}</i>`).join('')}</span>`;
const CSS = `body{margin:0;padding:18px;background:#f4f3ef;font:13px -apple-system,sans-serif;color:#1f2328}h1{font-size:18px;margin:0 0 4px}.sub{color:#6b6f76;margin-bottom:14px}
.row{display:flex;gap:8px;align-items:flex-start;margin-bottom:10px}.row figure{margin:0;width:150px}.row img{width:150px;height:150px;border-radius:6px;display:block;background:#cfccc4}
.row figure.a img{outline:3px solid #c2410c}.row figcaption{font-size:11px;color:#6b6f76;margin-top:2px}.gap{width:14px}
.plate{display:inline-flex;border-radius:3px;overflow:hidden;vertical-align:middle}.plate i{width:13px;height:16px;font:600 10px/16px ui-monospace,Menlo,monospace;text-align:center;font-style:normal;color:#111}`;
for (const [tag, key, cont, label] of [['new', 'newSig', 'newC', 'NEW body plate'], ['old', 'oldSig', 'oldC', 'OLD gene plate']]) {
  const rows = [];
  for (const a of anchors) { const nn = nearest(a, key, cont); await still(a); for (const s of nn) await still(s);
    rows.push(`<div class="row"><figure class="a"><img src="faces/${a.id}.png"><figcaption>${plateCells(a[key])} seed-${a.pool}</figcaption></figure><div class="gap"></div>${nn.map((s) => `<figure><img src="faces/${s.id}.png"><figcaption>${plateCells(s[key])} seed-${s.pool}</figcaption></figure>`).join('')}</div>`); }
  writeFileSync(join(OUT, `sheet-${tag}.html`), `<!doctype html><meta charset="utf-8"><title>Plate check ${tag}</title><style>${CSS}</style><h1>${label}: nearest plates</h1><div class="sub">Left (orange): a held-out species. Right: the 3 species from OTHER pools whose ${label} is closest. Good plates → the right three look like the left one.</div>${rows.join('')}`);
}

// ---- 4. triplets: A,B,C from 3 different pools; mostly cases where new and old plates disagree (informative) ----
const trip = [];
for (let tries = 0; trip.length < 40 && tries < 20000; tries++) {
  const [a, b, c] = [0, 0, 0].map(() => V[Math.floor(rnd() * V.length)]);
  if (new Set([a.pool, b.pool, c.pool]).size < 3) continue;
  const nNew = euc(a.newC, b.newC) < euc(a.newC, c.newC) ? 'B' : 'C', nOld = euc(a.oldC, b.oldC) < euc(a.oldC, c.oldC) ? 'B' : 'C';
  if (nNew === nOld && trip.length % 4 !== 0) continue;   // ~3/4 disagreements, 1/4 random
  trip.push({ a: a.id, b: b.id, c: c.id, nNew, nOld }); for (const s of [a, b, c]) await still(s);
}
writeFileSync(join(OUT, 'triplets.html'), `<!doctype html><meta charset="utf-8"><title>Which looks more like A?</title><style>${CSS}
.q{display:flex;gap:14px;align-items:center;justify-content:center;margin-top:30px}.q figure{margin:0;text-align:center}.q img{width:230px;height:230px;border-radius:8px;display:block;background:#cfccc4}
.q button{margin-top:8px;font:600 15px -apple-system,sans-serif;padding:8px 26px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}.q .a img{outline:4px solid #c2410c}
#res{max-width:620px;margin:30px auto;font-size:15px;line-height:1.6}</style>
<h1>Which looks more like A?</h1><div class="sub" id="prog"></div><div id="box"></div><div id="res"></div>
<script>const T=${JSON.stringify(trip)};let i=0,agNew=0,agOld=0;const ans=[];
function show(){if(i>=T.length){const n=T.length;document.getElementById('box').innerHTML='';document.getElementById('prog').textContent='done';
 document.getElementById('res').innerHTML='<b>Your eye agreed with:</b><br>NEW body plate: '+agNew+' / '+n+' ('+Math.round(100*agNew/n)+'%)<br>OLD gene plate: '+agOld+' / '+n+' ('+Math.round(100*agOld/n)+'%)<br><br>Tell Claude these two numbers.';return;}
 const t=T[i];document.getElementById('prog').textContent=(i+1)+' / '+T.length;
 document.getElementById('box').innerHTML='<div class="q"><figure><img src="faces/'+t.b+'.png"><button onclick="pick(\\'B\\')">B</button></figure><figure class="a"><img src="faces/'+t.a+'.png"><div style="margin-top:8px;font-weight:600">A</div></figure><figure><img src="faces/'+t.c+'.png"><button onclick="pick(\\'C\\')">C</button></figure></div>';}
function pick(x){const t=T[i];if(x===t.nNew)agNew++;if(x===t.nOld)agOld++;ans.push(x);i++;show();}
show();</script>`);

// ---- screenshots of the sheets for inspection ----
for (const tag of ['new', 'old']) {
  const p2 = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await p2.goto('file://' + join(OUT, `sheet-${tag}.html`)); await p2.waitForTimeout(500);
  await p2.screenshot({ path: join(OUT, `sheet-${tag}.png`), fullPage: true }); await p2.close();
}
await browser.close(); await server.close();

const report = { heldOutSpecies: V.length, pools: new Set(V.map((s) => s.pool)).size, crossPoolPairs: pairs.length, spearman: rho, distinctNewPlates: distinct,
  letterHistogram: hist, triplets: trip.length };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Spearman rho (plate distance vs PICTURE distance, cross-pool pairs, n=${pairs.length}):`);
console.log(`  continuous coords: NEW ${rho.newCoords.toFixed(3)}   OLD ${rho.oldCoords.toFixed(3)}`);
console.log(`  plate letters:     NEW ${rho.newLetters.toFixed(3)}   OLD ${rho.oldLetters.toFixed(3)}`);
console.log(`distinct new plates: ${distinct} of ${V.length} species`);
console.log(`letters used per position: ${hist.map((h) => h.filter(Boolean).length).join(' / ')} of 36`);
console.log(`-> ${OUT}`);
