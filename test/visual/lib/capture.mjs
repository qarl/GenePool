// Capture one scene's deterministic frame from the viewer via window.__golden. Returns raw RGBA (bottom-up, as
// readPixels gives it) + metadata. FAILS LOUDLY on any page error or an RGBA8 (degraded) fallback.
import { chromium } from 'playwright-core';
import { exeFor, LAUNCH_ARGS } from './browser.mjs';
import { startServer } from './server.mjs';

// scene = { name, seed, ticks, frames?, cam?, opts? }.  overrides.exe / overrides.arch for the cross-arch check.
export async function capture(scene, { exe, arch } = {}){
  const resolved = exeFor({ arch });
  const executablePath = exe || resolved.exe;
  const server = await startServer();
  const browser = await chromium.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 940, height: 800 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${server.port}/viewer-micrograph-gl.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof window.__golden === 'function', { timeout: 10000 });   // deterministic ready-signal
    const r = await page.evaluate(([s, t, f, c, o]) => window.__golden(s, t, f, c, o),
      [scene.seed, scene.ticks, scene.frames ?? 1, scene.cam ?? null, scene.opts ?? null]);
    if (errs.length) throw new Error(`page errors during scene '${scene.name}':\n  ${errs.join('\n  ')}`);
    if (!r.floatRT) throw new Error(
      `scene '${scene.name}': SwiftShader fell back to ${r.thickFmt} (no float render target) — the golden would ` +
      `capture the DEGRADED, thickness-clipped pipeline, not the real one. Aborting.`);
    return {
      w: r.w, h: r.h, rgba: Buffer.from(r.b64, 'base64'),            // bottom-up; self-consistent for hashing/compare
      mini: r.mini ? { w: r.miniW, h: r.miniH, rgba: Buffer.from(r.mini, 'base64') } : null,   // largest species' 256^2 mini-view
      meta: { thickFmt: r.thickFmt, fading: r.fading, species: r.species, browserBuild: resolved.build,
              platArch: arch ? exeFor({ arch }).platArch : resolved.platArch, chrome: browser.version(), node: process.version },
    };
  } finally { await browser.close(); await server.close(); }
}
