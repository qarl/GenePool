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

test('species list: populate, expand, accordion (one open at a time), collapse', { skip }, async () => {
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
    // epoch pmath-1: seed 3 reaches ~10 species at 60k (seed 1's new trajectory collapses to ~2).
    await page.evaluate(() => window.__golden(3, 60000, 1));

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
      wraps: document.querySelectorAll('#species .srow.exp .miniwrap').length,
      canvases: document.querySelectorAll('#species .srow.exp canvas.mini').length,
      openIdx: [...document.querySelectorAll('#species .srow')].findIndex(r => r.classList.contains('exp')) }));

    await clickRow(0);                                   // expand the largest
    let s = await expState();
    assert.equal(s.exp, 1, 'one row expanded after first click');
    assert.equal(s.wraps, 1, 'expanded row shows its miniwrap');
    assert.equal(s.canvases, 1, 'expanded row has a mini canvas');
    assert.equal(s.openIdx, 0, 'the clicked row is the open one');

    await clickRow(1);                                   // ACCORDION: opening another closes the first
    s = await expState();
    assert.equal(s.exp, 1, 'still exactly one open (opening a second row closes the first)');
    assert.equal(s.openIdx, 1, 'the newly-clicked row is the one now open');

    await clickRow(1);                                   // click the open row -> closes it
    assert.equal((await expState()).exp, 0, 'clicking the open row closes it (none open)');

    assert.equal(errs.length, 0, `page errors during interaction:\n  ${errs.join('\n  ')}`);
  } finally { await browser.close(); await server.close(); }
});

// The K ("kConstants") live-parameter panel: toggle, row coverage (incl. the 4 new params), slider<->number sync,
// a DOM-side param taking effect live (plateBg -> --plate-l), and Model-B persistence (Save is the baseline Reset
// reverts to). Canvas-affecting params (gain/gamma) are covered byte-identically at defaults by the pixel goldens.
test('K panel: toggle, rows, slider/number sync, live plate-bg, save/reset (Model B)', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: exeFor().exe, headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__golden === 'function', { timeout: 10000 });
    await page.evaluate(() => window.__golden(1, 2000, 1));   // boot the viewer deterministically (loop stops)

    // hidden by default; K opens; K closes
    assert.equal(await page.evaluate(() => document.getElementById('kpanel').hidden), true, 'panel hidden by default');
    const pressK = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })));
    await pressK();
    assert.equal(await page.evaluate(() => document.getElementById('kpanel').hidden), false, 'K opens the panel');
    await pressK();
    assert.equal(await page.evaluate(() => document.getElementById('kpanel').hidden), true, 'K closes the panel');
    await pressK();   // reopen for the rest

    // a row per param, including the 4 new ones
    const titles = await page.evaluate(() => [...document.querySelectorAll('#kpanel .klabel')].map(e => e.title));
    for (const k of ['field','hairLen','gain','gamma','plateBg','plateInk'])
      assert.ok(titles.includes(k), `panel has a row for '${k}'`);
    assert.ok(!titles.includes('pool') && !titles.includes('n') && !titles.includes('food'), 'sim keys are excluded');

    // helper: get a row's [range,number] by param key
    const setRange = (k, v) => page.evaluate(({ k, v }) => {
      const row = [...document.querySelectorAll('#kpanel .krow')].find(r => r.querySelector('.klabel').title === k);
      const r = row.querySelector('input[type=range]'); r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true }));
    }, { k, v });
    const numVal = k => page.evaluate(k => { const row = [...document.querySelectorAll('#kpanel .krow')].find(r => r.querySelector('.klabel').title === k);
      return +row.querySelector('input[type=number]').value; }, k);
    const rangeVal = k => page.evaluate(k => { const row = [...document.querySelectorAll('#kpanel .krow')].find(r => r.querySelector('.klabel').title === k);
      return +row.querySelector('input[type=range]').value; }, k);
    const plateL = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--plate-l').trim());

    // slider -> number sync
    await setRange('gain', 1.5);
    assert.equal(await numVal('gain'), 1.5, 'moving the slider updates the number box');

    // a DOM-side param takes effect live: plateBg drives the --plate-l CSS var
    await setRange('plateBg', 0.4);
    assert.equal(await plateL(), '0.4', 'plateBg slider updates --plate-l live');

    // gamma must tone the COLLAPSED species cards too (they're a CSS gradient the shader can't reach) -> --srow-bg
    const srowBg = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--srow-bg'));
    const bgBefore = await srowBg();
    await setRange('gamma', 2.0);
    assert.notEqual(await srowBg(), bgBefore, 'gamma re-tones the collapsed card gradient (--srow-bg)');
    await setRange('gamma', 1.0);   // restore before the save/reset flow below

    // Model B: Save makes the current values the baseline; later edits + Reset revert to that baseline
    await page.evaluate(() => document.getElementById('kSave').click());
    assert.equal(await page.evaluate(() => { try { return !!localStorage.getItem('micrographParams'); } catch { return false; } }), true, 'Save writes localStorage');
    await setRange('gain', 0.5); await setRange('plateBg', 0.9);   // unsaved edits
    await page.evaluate(() => document.getElementById('kReset').click());
    assert.equal(await rangeVal('gain'), 1.5, 'Reset reverts gain to the last-saved baseline');
    assert.equal(await plateL(), '0.4', 'Reset reverts plateBg (and --plate-l) to the last-saved baseline');

    assert.equal(errs.length, 0, `page errors:\n  ${errs.join('\n  ')}`);
  } finally { await browser.close(); await server.close(); }
});
