// Pool config — the world definition (a minimal slice for P0).
//
// A Pool is self-contained on its own masterSeed + config (PLAN-restructure.md §13/D-f), so the engine can
// host N independent, reproducible pools. P0 needs only the few fields that construction + decode read;
// dims/topology/obstacles/food-ecology/schedules join the schema in later phases (§6/§7/§8/§9). Everything
// here is world CONFIG the user supplies -- the engine imposes no bounds (§ Design Principle).

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
