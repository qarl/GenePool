// A/B the hair render: capture the branchy scene (zoom 26, where facets show) with the CPU ribbons vs the GPU strip,
// save both PNGs. Run: node ab-hair.mjs   (I read the two PNGs to compare facets + look.)
import { chromium } from 'playwright-core';
import { exeFor, LAUNCH_ARGS } from './lib/browser.mjs';
import { startServer } from './lib/server.mjs';
import { SCENES } from './scenes.mjs';
import { encode } from './lib/png.mjs';
import { writeFileSync } from 'node:fs';

const OUT = process.env.OUT || '/tmp';
const scene = SCENES.find(s => s.name === 'branchy');

async function grab(mode){
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: exeFor().exe, headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 940, height: 800 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html?hair=${mode}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__golden === 'function', { timeout: 10000 });
    const hm = await page.evaluate(() => window.__hairMode);
    const r = await page.evaluate(([s, t, f, c, o]) => window.__golden(s, t, f, c, o),
      [scene.seed, scene.ticks, scene.frames ?? 1, scene.cam ?? null, scene.opts ?? null]);
    if (errs.length) throw new Error(`page errors (${mode}):\n  ${errs.join('\n  ')}`);
    const rgba = Buffer.from(r.b64, 'base64');
    writeFileSync(`${OUT}/hair-${mode}.png`, encode(rgba, r.w, r.h, { flip: true }));
    console.log(`${mode}: __hairMode=${hm}  ${r.w}x${r.h}  fading=${r.fading}  -> ${OUT}/hair-${mode}.png`);
  } finally { await browser.close(); await server.close(); }
}
await grab('cpu');
await grab('gpu');
