// pool-seed.mjs -- the STANDARD micrograph pool: World config + junk-zeroed founders + food, built IDENTICALLY by the
// live viewer (build()) and the scrub run generator, so a seed is the SAME world whether watched live or scrubbed.
// (Extracted after the scrub generator was found using the parallel-engine TEST fixtures -- a different, larger world.)
// Founders are junk-zeroed (JJ's rule -> one species that diverges over time). Fully deterministic from the seed.
import { World } from './world.js';
import { Genotype } from './genotype.js';
import { SPECIES_ISO } from './analysis/species.mjs';
import { MUTATION_RATE_GENE } from './constants.js';
import { scheduleValue } from './config.js';
import { psin, pcos } from './pmath.js';   // portable trig (epoch pmath-1)

const NUM_GENES = 256, USED = 112, YOUNG_AGE = 1000, MAX_LIFESPAN = 40000;

// The viewer's tuned defaults (P, "Save Defaults" 2026-09-02). region 3000, 220 founders, 700 food.
export const POOL_DEFAULTS = { pool: 3000, n: 220, food: 700 };

// CURRENT per-pool experiment settings baked into every NEWLY generated run's config (and thus its bodies). Shared by the
// desktop app (startRun) AND the background/CLI generators (gen-jobs.bgSpawn) so a run is app-identical no matter who
// starts it. A run keeps its OWN stored config on resume/restore, so changing this only affects FRESH runs.
export const POOL_SETTINGS = { fixBranchCategoryGene: true, evolvableMutationRate: true };

export function mulberry32(seed){ let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function diskPoint(rng, cx, cy, r){ const rad = 2 * Math.PI * rng(); const mag = r * Math.sqrt(rng()); return { x: cx + pcos(rad) * mag, y: cy + psin(rad) * mag }; }

// `settings` overrides tunable per-pool config over the standard defaults (opt-in experiments like
// fixBranchCategoryGene). Default {} -> the standard micrograph pool (goldens/browser pass none -> byte-identical).
export function poolConfig(pool, settings = {}){
  return {
    maximumLifeSpan: MAX_LIFESPAN, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: pool / 2,
    foodBitEnergy: 50, attractionCriterion: 10, maxPopulation: 2000, maxFood: 2000,
    viewRadius: 300, reproductiveIsolation: SPECIES_ISO,   // junk-DNA gate -> reproductive species emerge over time
    pool: { left: 0, top: 0, right: pool, bottom: pool },
    ...settings,   // per-pool experiment overrides (last -> wins)
  };
}

// Build the standard world for a seed. Returns { world, config, rng } -- `rng` is the seed's stream AFTER founders +
// food are drawn, so the viewer can continue it for its (cosmetic) detritus seeding and stay byte-identical.
export function makeStandardWorld(seed, { pool = POOL_DEFAULTS.pool, n = POOL_DEFAULTS.n, food = POOL_DEFAULTS.food, settings = {}, config = null } = {}){
  // `config`: seed from a pre-resolved config (the run's STORED recipe) instead of rebuilding from `settings`. This is
  // what makes a tick-0 parameter edit re-seed founders under the EDITED config -- no special case. When omitted, build
  // it from settings as before (byte-identical). Seeding geometry uses the pool WIDTH either way.
  const cfg = config ?? poolConfig(pool, settings);
  const poolW = config ? (cfg.pool.right - cfg.pool.left) : pool;
  const world = new World(cfg, seed >>> 0, {});   // no onEvent by default (the generator attaches it after)
  const rng = mulberry32((seed >>> 0) ^ 0x5eed1234);
  // evolvableMutationRate is schedulable (§10) -> resolve it AT founding (tick 0): the gene is coding (keep its random
  // byte) iff on at tick 0. scheduleValue(scalar,0)===scalar, so a constant config is byte-identical.
  const evolvableAtSeed = scheduleValue(cfg.evolvableMutationRate, 0) === true;
  for (let i = 0; i < n; i++){
    const g = new Genotype(); g.randomize(rng);
    const genes = g.getGenes().slice();
    // junk-zeroed (JJ's rule) -- but when the mutation-rate gene is active it's a CODING gene, so keep its random value.
    for (let k = USED; k < NUM_GENES; k++){ if (evolvableAtSeed && k === MUTATION_RATE_GENE) continue; genes[k] = 0; }
    const p = diskPoint(rng, poolW / 2, poolW / 2, poolW / 2.4);
    const age = YOUNG_AGE + Math.floor((MAX_LIFESPAN - YOUNG_AGE) * rng());
    world.loadSwimbot(i, { age, x: p.x, y: p.y, angle: rng() * 360 - 180, energy: 50, genes });
  }
  for (let i = 0; i < food; i++){ const p = diskPoint(rng, poolW / 2, poolW / 2, poolW / 2.2); world.loadFood(i, { x: p.x, y: p.y, type: 0, energy: 50 }); }
  return { world, config: cfg, rng };
}
