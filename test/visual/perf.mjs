// Frame-rate regression bench for viewer-micrograph-gl.html. Renders a fixed ZOOMED-OUT whole-pool scene (the worst
// case for on-screen creature + detritus count) many times headless and reports ms/frame, comparing to a stored
// baseline so you can see how a commit changed perf. Headless SwiftShader != your GPU's fps, but it's a CONSISTENT
// relative yardstick (same machine/arch) for catching regressions.
//   node perf.mjs             # measure + compare to perf/baseline.json
//   node perf.mjs --update    # record the current result as the new baseline
//   node perf.mjs --junk 0.4  # override detritus load (frac of MAX_JUNK) -- for A/B-ing the junk cost
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exeFor, LAUNCH_ARGS } from './lib/browser.mjs';

const DIR = dirname(fileURLToPath(import.meta.url)), REPO = join(DIR, '..', '..'), BASE = join(DIR, 'perf', 'baseline.json');
const PORT = 8161;
const args = process.argv.slice(2);
const update = args.includes('--update');
const junk = args.includes('--junk') ? Number(args[args.indexOf('--junk') + 1]) : null;
const REGRESS = 8;   // % median change beyond which we flag (headless timing is noisy -> keep the band generous)

// Two scenes: 'wide' = zoomed-OUT whole pool (max creature+detritus count, hairs LOD'd OFF) -> the classic regression
// yardstick + the baseline. 'hairy' = medium zoom where hairs are ON (lod>=0.5) -> the scene that actually measures
// hair cost (the wide scene draws ZERO hairs). __bench returns a CPU/GPU split (cpuMedian before gl.finish, gpuMedian
// the SwiftShader raster -> pessimistic proxy) + nHairs; SwiftShader fps is a relative yardstick, not real-GPU fps.
const SCENES = [
  { name: 'wide',  seed: 1, ticks: 60000, cam: { zoom: 1 }, frames: 90 },   // baseline scene (must stay first)
  { name: 'hairy', seed: 1, ticks: 60000, cam: { zoom: 8 }, frames: 90 },   // hairs on -> the metric that matters for hair work
];

const srv = spawn('node', ['engine/parallel/serve.mjs'], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await sleep(600);
const browser = await chromium.launch({ executablePath: exeFor().exe, headless: true, args: LAUNCH_ARGS });
let results = [], chrome;
try {
  const page = await browser.newPage({ viewport: { width: 1060, height: 820 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => typeof window.__bench === 'function', { timeout: 10000 });
  chrome = browser.version();
  for (const S of SCENES) {
    const r = await page.evaluate(([s, t, c, f, j]) => window.__bench(s, t, c, f, j), [S.seed, S.ticks, S.cam, S.frames, junk]);
    results.push({ S, r });
  }
} finally { await browser.close(); srv.kill(); }

let git = ''; try { git = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch {}
console.log(`\nRender bench  [${git || '?'}, ${process.arch}, SwiftShader (relative yardstick, NOT real-GPU fps)]`);
for (const { S, r } of results) {
  const fps = (1000 / r.median).toFixed(1), warn = (S.name === 'hairy' && !r.nHairs) ? '  ⚠ ZERO hairs — raise the zoom!' : '';
  console.log(`  ${S.name.padEnd(6)} zoom ${String(r.zoom).padStart(2)}  ${r.median.toFixed(1)} ms/frame (${fps} fps)   ` +
    `cpu ${r.cpuMedian.toFixed(1)} · gpu ${r.gpuMedian.toFixed(1)}   ${r.living} living · ${r.nHairs} hairs · ${r.nJunk} junk${warn}`);
}

const rw = results[0].r;   // baseline compares the 'wide' scene
const cur = {
  medianMs: +rw.median.toFixed(2), meanMs: +rw.mean.toFixed(2), minMs: +rw.min.toFixed(2), p90Ms: +rw.p90.toFixed(2),
  cpuMs: +rw.cpuMedian.toFixed(2), fps: +(1000 / rw.median).toFixed(1), living: rw.living, nJunk: rw.nJunk, zoom: rw.zoom,
  scene: SCENES[0], arch: process.arch, node: process.version, chrome, git, at: new Date().toISOString(),
};
if (update) {
  mkdirSync(dirname(BASE), { recursive: true }); writeFileSync(BASE, JSON.stringify(cur, null, 2) + '\n');
  console.log(`\nrecorded baseline (wide) -> perf/baseline.json  (${cur.medianMs} ms/frame @ ${git})`);
} else if (existsSync(BASE)) {
  const b = JSON.parse(readFileSync(BASE, 'utf8'));
  const d = (cur.medianMs - b.medianMs) / b.medianMs * 100;
  const tag = d > REGRESS ? `⚠ SLOWER by ${d.toFixed(1)}%` : d < -REGRESS ? `✓ faster by ${(-d).toFixed(1)}%` : `≈ ${d >= 0 ? '+' : ''}${d.toFixed(1)}% (within noise)`;
  console.log(`\n  wide vs baseline ${b.medianMs} ms/frame (${b.git || '?'}, ${b.arch}):  ${tag}`);
  if (b.arch !== process.arch) console.log('  NOTE: baseline was recorded on a different arch -- not comparable.');
} else {
  console.log('\n  (no baseline yet -- run `node perf.mjs --update` to record one)');
}
