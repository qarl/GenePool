// Gate (a): the harness-determinism gate. Render the noisiest scene in TWO SEPARATE browser launches and require
// byte-identical output. This proves same-machine SwiftShader determinism (a fresh JIT each launch) BEFORE any
// golden is trusted; if it ever fails, there is same-machine nondeterminism to find first.
import { createHash } from 'node:crypto';
import { capture } from './lib/capture.mjs';
import { SCENE_BY_NAME } from './scenes.mjs';

const scene = SCENE_BY_NAME.branchy;   // zoomed grain = the most transcendental-heavy frame
const sha = async () => createHash('sha256').update((await capture(scene)).rgba).digest('hex');

console.log(`gate (a): two separate browser launches of scene '${scene.name}'…`);
const a = await sha();
const b = await sha();
console.log(`  run 1: ${a}`);
console.log(`  run 2: ${b}`);
if (a === b){ console.log('  PASS — byte-identical across processes; same-machine determinism holds.'); }
else { console.error('  FAIL — renders diverge across launches; find the same-machine nondeterminism before recording goldens.'); process.exit(1); }
