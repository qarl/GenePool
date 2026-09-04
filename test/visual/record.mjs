// Record/update golden PNGs. REFUSES to run off the recording arch (goldens are byte-exact only there) or off the
// pinned browser build (exeFor asserts that). Writes goldens/<scene>.png + merges goldens/METADATA.json.
//   node record.mjs               # record all scenes
//   node record.mjs branchy dying # record a subset (merges into existing METADATA)
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCENES, CANVAS } from './scenes.mjs';
import { capture } from './lib/capture.mjs';
import { encode } from './lib/png.mjs';
import { isRecordingArch, RECORDING } from './lib/browser.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const GOLD = join(DIR, 'goldens');
const METAF = join(GOLD, 'METADATA.json');

if (!isRecordingArch()){
  console.error(`refusing to record: goldens are byte-exact only on the recording arch ` +
    `(${RECORDING.platform}/${RECORDING.arch}); this host is ${process.platform}/${process.arch}.`);
  process.exit(1);
}
mkdirSync(GOLD, { recursive: true });

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const scenes = only.length ? SCENES.filter(s => only.includes(s.name)) : SCENES;
if (!scenes.length){ console.error(`no matching scenes for: ${only.join(', ')}`); process.exit(1); }

const meta = existsSync(METAF) ? JSON.parse(readFileSync(METAF, 'utf8')) : { canvas: CANVAS, scenes: {} };
meta.recordedAt = new Date().toISOString();
meta.platform = process.platform; meta.arch = process.arch; meta.node = process.version; meta.canvas = CANVAS;

for (const scene of scenes){
  const r = await capture(scene);
  const sha = createHash('sha256').update(r.rgba).digest('hex');
  writeFileSync(join(GOLD, `${scene.name}.png`), encode(r.rgba, r.w, r.h, { flip: true }));
  meta.scenes[scene.name] = { w: r.w, h: r.h, sha256: sha, thickFmt: r.meta.thickFmt, fading: r.meta.fading,
    browserBuild: r.meta.browserBuild, chrome: r.meta.chrome };
  let miniNote = '';
  if (r.mini){                                                       // small-view (mini-viewer) golden
    const msha = createHash('sha256').update(r.mini.rgba).digest('hex');
    writeFileSync(join(GOLD, `${scene.name}.mini.png`), encode(r.mini.rgba, r.mini.w, r.mini.h, { flip: true }));
    meta.scenes[scene.name].mini = { w: r.mini.w, h: r.mini.h, sha256: msha };
    miniNote = `  +mini ${r.mini.w}x${r.mini.h} sha=${msha.slice(0,16)}`;
  }
  console.log(`recorded ${scene.name.padEnd(9)} ${r.w}x${r.h}  sha=${sha.slice(0,16)}  fading=${r.meta.fading}  thickFmt=${r.meta.thickFmt}${miniNote}`);
}
writeFileSync(METAF, JSON.stringify(meta, null, 2) + '\n');
console.log(`wrote ${scenes.length} golden(s) + METADATA.json (${process.platform}/${process.arch}, chrome ${meta.scenes[scenes[0].name].chrome}, node ${process.version})`);
