// Interaction regression for the #species list (DOM + click-to-expand) — the browsable species column the goldens
// (canvas pixels only) can't cover. Named *.visual.mjs so the zero-dep core suite never imports playwright-core.
// Run: npm --prefix test/visual test.
//
// Determinism: __golden(seed, ticks) advances the sim and its internal render() runs computeSpecies + updateSpeciesUI,
// so the #species list is populated; __golden then STOPS the rAF loop (loopStopped=true), so the list is STATIC (no
// wobble) and rows are stable to click. The click handler reflects expand/collapse immediately (doesn't wait for a
// frame), so DOM state is observable with the loop stopped. Live-mini PIXELS are covered by the speciated mini-golden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { exeFor, LAUNCH_ARGS } from './lib/browser.mjs';
import { startServer } from './lib/server.mjs';

let skip = false;
try { exeFor(); } catch (e) { skip = `pinned browser not provisioned: ${e.message.split('\n')[0]}`; }

test('species list: populate, expand, multi-expand, collapse', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: exeFor().exe, headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__golden === 'function', { timeout: 10000 });

    // Populate the list deterministically (60k ticks -> speciation), then the loop stops (static list).
    await page.evaluate(() => window.__golden(1, 60000, 1));

    const nRows = await page.evaluate(() => document.querySelectorAll('#species .srow').length);
    assert.ok(nRows >= 3, `expected >=3 species rows after speciation, got ${nRows}`);
    assert.ok(nRows <= 50, `row count must respect the SPECIES_K cap, got ${nRows}`);

    // Collapsed rows show a 5-cell license plate.
    const cells = await page.evaluate(() => document.querySelector('#species .srow .info .plate')?.querySelectorAll('.cell').length || 0);
    assert.equal(cells, 5, 'a collapsed row shows a 5-cell plate');

    const clickRow = i => page.evaluate(i => { const r = document.querySelectorAll('#species .srow')[i];
      r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, i);
    const expState = () => page.evaluate(() => ({
      exp: document.querySelectorAll('#species .srow.exp').length,
      shownWraps: [...document.querySelectorAll('#species .srow.exp .miniwrap')].filter(w => !w.hidden).length,
      canvases: document.querySelectorAll('#species .srow.exp canvas.mini').length }));

    await clickRow(0);                                   // expand the largest
    let s = await expState();
    assert.equal(s.exp, 1, 'one row expanded after first click');
    assert.equal(s.shownWraps, 1, 'expanded row shows its miniwrap');
    assert.equal(s.canvases, 1, 'expanded row has a mini canvas');

    await clickRow(1);                                   // multi-expand
    assert.equal((await expState()).exp, 2, 'two rows expanded (multi-expand)');

    await clickRow(0);                                   // collapse the first
    assert.equal((await expState()).exp, 1, 'back to one expanded after collapsing the first');

    assert.equal(errs.length, 0, `page errors during interaction:\n  ${errs.join('\n  ')}`);
  } finally { await browser.close(); await server.close(); }
});
