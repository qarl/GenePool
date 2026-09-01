// Pool config — the world definition (a minimal slice for P0).
//
// A Pool is self-contained on its own masterSeed + config (PLAN-restructure.md §13/D-f), so the engine can
// host N independent, reproducible pools. P0 needs only the few fields that construction + decode read;
// dims/topology/obstacles/food-ecology/schedules join the schema in later phases (§6/§7/§8/§9). Everything
// here is world CONFIG the user supplies -- the engine imposes no bounds (§ Design Principle).

import {
    resolvePoolBounds, SWIMBOT_VIEW_RADIUS, MAX_FOODBITS_PER_TYPE,
    DEFAULT_MAXIMUM_AGE, DEFAULT_CHILD_ENERGY_RATIO, NON_REPRODUCING_JUNK_DNA_LIMIT,
    DEFAULT_FOOD_REGENERATION_PERIOD, DEFAULT_CROSSOVER_RATE, DEFAULT_MUTATION_RATE,
} from './constants.js';

const DEFAULTS = Object.freeze({
    masterSeed: 0,
    poolSize: 0,
    numFoodTypes: 1,
    // genetics rates (injected into Genotype.setAsOffspring; not used by P0 construction, which only
    // randomizes founders, but part of the config surface -- decision #4 / §11).
    crossoverRate: 0.2,
    mutationRate: 0.01,
});

export function makeConfig(overrides = {}) {
    const cfg = { ...DEFAULTS, ...overrides };
    // masterSeed must be within the RNG's addressable safe-integer range (mirrors rng.foldInt's contract,
    // so an out-of-range seed fails at the config boundary rather than deep in a draw).
    if (!Number.isInteger(cfg.masterSeed) || cfg.masterSeed < 0 || cfg.masterSeed > Number.MAX_SAFE_INTEGER) {
        throw new Error('config: masterSeed must be a non-negative safe integer');
    }
    // poolSize is UNBOUNDED above (no carrying-capacity cap -- § Design Principle); only input-form validated.
    if (!Number.isInteger(cfg.poolSize) || cfg.poolSize < 0) {
        throw new Error('config: poolSize must be a non-negative integer');
    }
    // numFoodTypes is also unbounded above; note that the decode currently honors only ===2 (JJ-faithful) --
    // numFoodTypes>2 constructs a valid (mono-type) world today and gains distinct traits when the
    // food-ecology phase generalizes the decode to N types (§9). Reserved, not capped.
    if (!Number.isInteger(cfg.numFoodTypes) || cfg.numFoodTypes < 1) {
        throw new Error('config: numFoodTypes must be an integer >= 1');
    }
    // genetics rates are part of the config surface (injected into setAsOffspring in P1) -- validate now so a
    // bad rate can't silently disable crossover/mutation later (rng() < NaN is always false).
    for (const r of ['crossoverRate', 'mutationRate']) {
        if (typeof cfg[r] !== 'number' || !Number.isFinite(cfg[r]) || cfg[r] < 0 || cfg[r] > 1) {
            throw new Error(`config: ${r} must be a number in [0,1]`);
        }
    }
    return Object.freeze(cfg);
}

// P3/§6 — the FULL world-config schema `World` reads: fill every ecology/lifecycle/spatial default so a MINIMAL
// config (even just `{}` or `{pool}`) yields a working, correctly-scaled world at ANY pool size, and DECLARE the
// scaling policy per quantity. This is the §6 "absolute-vs-×poolSize table". Only UNDEFINED fields are filled
// (`??`), so a fully-specified config (every golden / gate) is returned unchanged -> byte-identical. Any field
// not named here (masterSeed, pool, obstacles, topology, perceptionMode, maxFoodBitsPerType overrides, ...) is
// preserved verbatim via the spread. The engine imposes no world-scale limits (North Star): the "max" knobs
// default to Infinity (opt-in caps), never a built-in ceiling.
export function resolveWorldConfig(config = {}) {
    const pool = resolvePoolBounds(config.pool);
    return Object.freeze({
        ...config, // preserve pool/obstacles/topology/perceptionMode/masterSeed + any extra fields verbatim

        // --- ×poolSize (scales with world width) --- a spatial EXTENT that should track the world's size, so an
        // arbitrary-size pool behaves sensibly with no per-size tuning. foodSpread is JJ's "secret" W/2 spawn radius.
        foodSpread: config.foodSpread ?? pool.width / 2,

        // --- ABSOLUTE (independent of world size) --- rates, periods, thresholds, and the sensory RANGE (a body's
        // reach doesn't grow with the pool -- a world-design choice; the user overrides with any absolute value).
        viewRadius: config.viewRadius ?? SWIMBOT_VIEW_RADIUS,
        foodRegenerationPeriod: config.foodRegenerationPeriod ?? DEFAULT_FOOD_REGENERATION_PERIOD,
        maximumLifeSpan: config.maximumLifeSpan ?? DEFAULT_MAXIMUM_AGE,
        childEnergyRatio: config.childEnergyRatio ?? DEFAULT_CHILD_ENERGY_RATIO,
        crossoverRate: config.crossoverRate ?? DEFAULT_CROSSOVER_RATE,
        mutationRate: config.mutationRate ?? DEFAULT_MUTATION_RATE,
        numFoodTypes: config.numFoodTypes ?? 1,
        // §11: the junk-DNA reproductive-isolation gate is a per-pool WORLD RULE, not an engine constant. Default =
        // JJ's 0.9 (byte-identical); a pool can loosen it (more gene flow) or tighten it (stricter speciation).
        reproductiveIsolation: config.reproductiveIsolation ?? NON_REPRODUCING_JUNK_DNA_LIMIT,

        // --- opt-in world-scale caps (Infinity = no engine-imposed limit; North Star) ---
        maxPopulation: config.maxPopulation ?? Infinity,
        maxFood: config.maxFood ?? Infinity,
        maxFoodBitsPerType: config.maxFoodBitsPerType ?? MAX_FOODBITS_PER_TYPE,
    });
}
