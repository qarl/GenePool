// render-specimens.mjs -- render every species FACE in atlas.json as a 256^2 micrograph, via the viewer's inert
// window.__specimen hook in headless Chromium (SwiftShader; the visual-goldens browser + static server). One PNG per
// face at <jobsDir>/atlas/faces/seed-<N>-<i>.png (i = species rank within the pool). Skips faces already rendered
// unless --force. Needs the opt-in visual harness: `npm --prefix test/visual install` (+ pinned headless shell).
//   node tools/atlas/render-specimens.mjs [--force] [--only 67,140]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { jobsDir } from '../scrub/gen-jobs.mjs';
import { exeFor, LAUNCH_ARGS } from '../../test/visual/lib/browser.mjs';
import { startServer } from '../../test/visual/lib/server.mjs';
import { encode } from '../../test/visual/lib/png.mjs';

const { chromium } = createRequire(new URL('../../test/visual/package.json', import.meta.url))('playwright-core');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',').map(Number)) : null; })();

const dir = join(jobsDir(), 'atlas'), faceDir = join(dir, 'faces'); mkdirSync(faceDir, { recursive: true });
const atlas = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8'));
const jobs = [];
for (const p of atlas.data) { if (only && !only.has(p.seed)) continue;
  p.species.forEach((s, i) => { const out = join(faceDir, `seed-${p.seed}-${i}.png`); if (force || !existsSync(out)) jobs.push({ seed: p.seed, i, face: s.face, out }); }); }
console.log(`rendering ${jobs.length} faces -> ${faceDir}`);
if (!jobs.length) process.exit(0);

const server = await startServer();
const browser = await chromium.launch({ executablePath: exeFor({}).exe, headless: true, args: LAUNCH_ARGS });
const radii = {};
try {
  const page = await browser.newPage({ viewport: { width: 940, height: 800 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => typeof window.__specimen === 'function', { timeout: 10000 });
  const t0 = Date.now(); let done = 0, failed = 0;
  for (const j of jobs) {
    const r = await page.evaluate(([spec, o]) => window.__specimen(spec, o), [{ genes: j.face.genes, age: j.face.age, angle: j.face.angle, energy: j.face.energy }, { seed: j.seed, fitPx: 78 }]);
    if (errs.length) { console.error(`page error on seed-${j.seed}-${j.i}: ${errs.join('; ')}`); errs.length = 0; }
    if (!r) { failed++; continue; }
    writeFileSync(j.out, encode(Buffer.from(r.b64, 'base64'), r.w, r.h, { flip: true }));   // readPixels is bottom-up
    radii[`${j.seed}-${j.i}`] = { radius: +r.radius.toFixed(1), zoom: +r.zoom.toFixed(2) };
    if (++done % 50 === 0) console.log(`  ${done}/${jobs.length}  (${((Date.now() - t0) / done).toFixed(0)} ms/face)`);
  }
  console.log(`done: ${done} rendered, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} finally { await browser.close(); await server.close(); }
const rp = join(dir, 'radii.json'); let prev = {}; try { prev = JSON.parse(readFileSync(rp, 'utf8')); } catch { /* */ }
writeFileSync(rp, JSON.stringify({ ...prev, ...radii }));
