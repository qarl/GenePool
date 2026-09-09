// Swimmer-selection interaction regression (DOM + click picking + camera state), browser path. Named *.visual.mjs so
// the zero-dep core suite never imports playwright-core. The camera FEEL (smoothness, framing) is a visual check on the
// real GPU; here we assert the deterministic STATE: click picks a bot, opens its species mini, arms the camera; Esc /
// empty-click deselect; a mini-canvas click re-selects (cross-viewer); the camera tween advances zoom->track.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { exeFor, LAUNCH_ARGS } from './lib/browser.mjs';
import { startServer } from './lib/server.mjs';

let skip = false;
try { exeFor(); } catch (e) { skip = `pinned browser not provisioned: ${e.message.split('\n')[0]}`; }

test('swimmer selection: click picks + opens species mini + arms camera; Esc + mini-click; camera advances', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: exeFor().exe, headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__golden === 'function' && window.__selTest, { timeout: 10000 });
    await page.evaluate(() => window.__golden(1, 60000, 1));   // populate a static, deterministic world (loop stopped)

    // locate an on-screen living, multi-part bot (backing px == CSS px: 768 canvas, DPR 1)
    const bot = await page.evaluate(() => window.__selTest.aliveBotScreen());
    assert.ok(bot, 'expected a clickable on-screen swimmer after speciation');

    // synthesize a real click (mousedown+mouseup, no move) on the canvas at the bot
    const clickCanvas = (bx, by) => page.evaluate(({ bx, by }) => {
      const cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      const clientX = r.left + bx * r.width / cv.width, clientY = r.top + by * r.height / cv.height;
      cv.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, bubbles: true }));
      cv.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, bubbles: true }));
    }, { bx, by });

    await clickCanvas(bot.x, bot.y);
    let s = await page.evaluate(() => window.__selTest.sel());
    assert.equal(s.has, true, 'a swimmer is selected after clicking it');
    assert.notEqual(s.sid, null, 'the selected swimmer has a species row');
    assert.equal(s.phase, 'zoom', 'the camera zoom-to animation is armed on select');
    let expRows = await page.evaluate(() => document.querySelectorAll('#species .srow.exp').length);
    assert.equal(expRows, 1, 'the selected swimmer\'s species mini is open');

    // selection ring: shown, ~10% larger than the swimmer (frozen world radius > 0), positioned by the camera
    const ring = await page.evaluate(() => window.__selTest.ring());
    assert.equal(ring.hidden, false, 'the selection ring is shown while a swimmer is selected');
    assert.ok(ring.worldR > 0, 'the selection ring has a frozen world radius');
    assert.ok(ring.w > 0, 'the selection ring has an on-screen diameter');
    const recSel = await page.evaluate(() => window.__selTest.recFrame());   // ring is composited into the recording frame (cam still at select pos)

    // camera tween advances: zoom-to (~0.8s) then hands off to track
    const after = await page.evaluate(() => window.__stepCamera(60, 1/60));
    assert.equal(after.phase, 'track', 'after ~1s the camera hands off to tracking');

    // Esc deselects (closes the selection-opened mini)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    s = await page.evaluate(() => window.__selTest.sel());
    assert.equal(s.has, false, 'Esc deselects');
    expRows = await page.evaluate(() => document.querySelectorAll('#species .srow.exp').length);
    assert.equal(expRows, 0, 'the selection-opened mini closed on deselect');
    assert.equal((await page.evaluate(() => window.__selTest.ring())).hidden, true, 'the selection ring hides on deselect');
    const recDesel = await page.evaluate(() => window.__selTest.recFrame());   // no selection -> ring not drawn
    assert.equal(recSel.drew, true, 'the ring is drawn into the recording composite while selected');
    assert.ok(recSel.darkPx > 50, `the recording ring left visible pixels (${recSel.darkPx})`);
    assert.equal(recDesel.drew, false, 'no ring drawn into the recording after deselect');

    // re-select, then CROSS-VIEWER: clicking the mini canvas re-arms selection (tracks the shown bot)
    await clickCanvas(bot.x, bot.y);
    assert.equal((await page.evaluate(() => window.__selTest.sel())).has, true, 're-selected');
    await page.evaluate(() => window.__stepCamera(60, 1/60));   // settle to track so a mini-click's re-arm is observable
    await page.evaluate(() => { const c = document.querySelector('#species .srow.exp canvas.mini'); c && c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    s = await page.evaluate(() => window.__selTest.sel());
    assert.equal(s.has, true, 'mini-canvas click keeps a swimmer selected (cross-viewer track)');
    assert.equal(s.phase, 'zoom', 'mini-canvas click re-arms the zoom-to (main view tracks the shown bot)');

    // empty-ish click near a corner deselects when it misses (same deselect path as Esc); tolerate a stray hit
    await clickCanvas(4, 4);
    // no assertion on the corner hit/miss (position-dependent) -- Esc above already proves deselect; this just must not throw.

    assert.equal(errs.length, 0, `page errors during selection:\n  ${errs.join('\n  ')}`);
  } finally { await browser.close(); await server.close(); }
});
