'use strict';
// Canonical deterministic run -> checkpoint hash vector. This is the cross-ENGINE / cross-ARCH oracle: the same
// hashes must come out under every JS engine (Node majors + the app's Electron) and every CPU. Runnable directly
// under `node` and under `ELECTRON_RUN_AS_NODE=1 electron` so CI can compare across V8 versions -- the check that
// was missing when the V8 divergence slipped through. See docs/PLAN-engine-portable-math.md.
//
//   node test/engine/canonical-run.mjs            -> prints the hash vector
//   GENEPOOL_PMATH_PASSTHROUGH=1 node ...         -> native-trig passthrough (neutrality proof vs pre-epoch)

import { createHash } from 'node:crypto';
import { makeStandardWorld, poolConfig, POOL_DEFAULTS } from '../../engine/pool-seed.mjs';

const SEED = 7;
const CHECKPOINTS = [100, 1000, 4000];

// Deterministic, NaN/Infinity-preserving serialization (JSON.stringify maps them to null, colliding broken
// states; and we want to CATCH a non-finite value, not hide it). Keys sorted for stability.
function stable(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite value in serialized state: ${v}`);
    return v === 0 ? '0' : v.toString();   // normalize -0 -> "0"
  }
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

export function canonicalHashes() {
  const cfg = poolConfig(POOL_DEFAULTS.pool, { fixBranchCategoryGene: true, evolvableMutationRate: true });
  const { world } = makeStandardWorld(SEED, { config: cfg });
  const out = {};
  let t = 0;
  for (const cp of CHECKPOINTS) {
    while (t < cp) { world.tick(); t++; }
    out[cp] = createHash('sha256').update(stable(world.serialize())).digest('hex').slice(0, 16);
  }
  return out;
}

// run directly
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('canonical-run.mjs');
if (isMain) {
  const h = canonicalHashes();
  const pass = process.env.GENEPOOL_PMATH_PASSTHROUGH ? ' (PASSTHROUGH/native)' : '';
  console.log(`canonical seed=${SEED} v8=${process.versions.v8}${pass}`);
  for (const cp of CHECKPOINTS) console.log(`  t=${String(cp).padStart(5)}  ${h[cp]}`);
  console.log(`  vector: ${CHECKPOINTS.map((c) => h[c]).join(' ')}`);
}
