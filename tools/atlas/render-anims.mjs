// render-anims.mjs -- short swimming loops of each pool's MAIN species for the atlas (<jobsDir>/atlas/anim/seed-N.mp4).
// Uses the viewer's inert __specimen (set up + fit zoom) and __specimenNext (advance + follow-cam frame) hooks in
// headless Chromium, piping raw frames into ffmpeg (H.264, yuv420p, faststart -> tiny files Safari plays natively).
// FRAMES x TICKS_PER_FRAME sim ticks at FPS = the app's 1x feel (~1-2 ticks per displayed frame).
//   node tools/atlas/render-anims.mjs [--force] [--only 67,140] [--frames 90] [--every 2]
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { jobsDir } from '../scrub/gen-jobs.mjs';
import { exeFor, LAUNCH_ARGS } from '../../test/visual/lib/browser.mjs';
import { startServer } from '../../test/visual/lib/server.mjs';

const { chromium } = createRequire(new URL('../../test/visual/package.json', import.meta.url))('playwright-core');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const force = args.includes('--force');
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;
const FRAMES = Number(opt('frames', 90)), EVERY = Number(opt('every', 2)), FPS = 30, FIT_PX = 64;   // smaller fit than stills: room to bend/swim

const dir = join(jobsDir(), 'atlas'), animDir = join(dir, 'anim'); mkdirSync(animDir, { recursive: true });
const atlas = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8'));
const jobs = atlas.data.filter((p) => p.species.length && (!only || only.has(p.seed)))
  .map((p) => ({ seed: p.seed, face: p.species[0].face, out: join(animDir, `seed-${p.seed}.mp4`) }))
  .filter((j) => force || !existsSync(j.out));
console.log(`animating ${jobs.length} main species (${FRAMES} frames x ${EVERY} ticks @ ${FPS}fps) -> ${animDir}`);
if (!jobs.length) process.exit(0);

function encoder(out, w, h) {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(FPS), '-i', '-',
    '-vf', 'vflip', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c} for ${out}`)))));
  const write = (buf) => new Promise((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res)));
  return { write, end: () => { ff.stdin.end(); return done; } };
}

const server = await startServer();
const browser = await chromium.launch({ executablePath: exeFor({}).exe, headless: true, args: LAUNCH_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: 940, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => typeof window.__specimenNext === 'function', { timeout: 10000 });
  const t0 = Date.now(); let done = 0, failed = 0;
  for (const j of jobs) {
    const first = await page.evaluate(([spec, o]) => window.__specimen(spec, o),
      [{ genes: j.face.genes, age: j.face.age, angle: j.face.angle, energy: j.face.energy }, { seed: j.seed, fitPx: FIT_PX }]);
    if (!first) { failed++; continue; }
    const enc = encoder(j.out, first.w, first.h);
    await enc.write(Buffer.from(first.b64, 'base64'));
    for (let f = 1; f < FRAMES; f++) {
      const b64 = await page.evaluate(([t]) => window.__specimenNext(t), [EVERY]);
      if (!b64) break;                                          // died mid-loop (rare) -> keep the frames we have
      await enc.write(Buffer.from(b64, 'base64'));
    }
    await enc.end();
    // poster = the loop's own first frame (no scale jump when playback starts; stills use a tighter fit)
    await new Promise((res) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', j.out, '-frames:v', '1', '-q:v', '4', j.out.replace(/\.mp4$/, '.jpg')], { stdio: 'ignore' }).on('close', res));
    if (++done % 10 === 0) console.log(`  ${done}/${jobs.length}  (${((Date.now() - t0) / done / 1000).toFixed(1)} s/anim)`);
  }
  console.log(`done: ${done} animated, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} finally { await browser.close(); await server.close(); }
