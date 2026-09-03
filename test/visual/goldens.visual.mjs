// Golden-master regression tests for viewer-micrograph-gl.html. Named *.visual.mjs (NOT *.test.js) so the zero-dep
// core suite `node --test 'test/**/*.test.js'` never imports playwright-core. Run: npm --prefix test/visual test.
// Compare policy (docs/PLAN-visual-goldens.md): EXACT 0 on the recording arch; maxΔ≤1 + tiny fraction cross-arch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SCENES } from './scenes.mjs';
import { capture } from './lib/capture.mjs';
import { compare, diffPng } from './lib/compare.mjs';
import { decode } from './lib/png.mjs';
import { isRecordingArch, exeFor } from './lib/browser.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const GOLD = join(DIR, 'goldens');

// Skip cleanly (don't FAIL) if the pinned browser isn't installed on this host.
let skip = false;
try { exeFor(); } catch (e) { skip = `pinned browser not provisioned: ${e.message.split('\n')[0]}`; }

// bottom-up (readPixels) <-> top-down (stored golden) reconciliation: flip the golden to match cap's orientation.
function toBottomUp(img){ const out = Buffer.alloc(img.rgba.length);
  for (let y = 0; y < img.h; y++) img.rgba.copy(out, y*img.w*4, (img.h-1-y)*img.w*4, (img.h-y)*img.w*4); return out; }

for (const scene of SCENES){
  test(`golden: ${scene.name}`, { skip }, async () => {
    const goldPath = join(GOLD, `${scene.name}.png`);
    assert.ok(existsSync(goldPath), `missing golden ${scene.name}.png — run: npm --prefix test/visual run record`);
    const cap = await capture(scene);
    if (scene.name === 'dying')
      assert.ok(cap.meta.fading > 0, `dying scene must exercise the death-fade path, but fading=${cap.meta.fading}`);
    const gold = toBottomUp(decode(readFileSync(goldPath)));
    const res = compare(cap.rgba, gold, { exact: isRecordingArch() });
    if (!res.pass){
      const diffPath = join(GOLD, `${scene.name}.diff.png`);
      writeFileSync(diffPath, diffPng(cap.rgba, gold, cap.w, cap.h));
      assert.fail(`${scene.name} diverged: maxΔ=${res.maxDelta}, ${res.diffPixels} px ` +
        `(${(res.diffFraction*100).toFixed(4)}%), exact=${res.exact}. diff → ${diffPath}`);
    }
  });
}
