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

// §10 — PARAMETER SCHEDULES. Any schedulable per-pool value may be a plain scalar (the constant case) OR a
// step-schedule `{ schedule: [[tick0, v0], [tick1, v1], ...] }` (ascending ticks) so a world can CHANGE over time
// (drought, seasons, shifting carrying capacity). Resolution is a pure function of (spec, tick) -- a STEP function,
// no run-state accumulator -- so it is deterministic and adds nothing to checkpoint/restore. A scalar returns
// itself, so a world with no schedules is byte-identical.
export function scheduleValue(spec, tick) {
    if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.schedule)) return spec; // scalar -> as-is
    const s = spec.schedule;
    let v = s.length ? s[0][1] : undefined; // before the first step, the first value holds
    for (let i = 0; i < s.length; i++) { if (tick >= s[i][0]) v = s[i][1]; else break; }
    return v;
}

// Validate a schedule's FORM (not its values -- those are the author's world design). Throws at config time so a
// malformed schedule fails at the boundary, not deep in a tick. A scalar is always valid.
export function validateScheduleForm(field, spec) {
    if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.schedule)) return; // scalar
    const s = spec.schedule;
    if (s.length === 0) throw new Error(`config: ${field}.schedule must have at least one [tick, value] entry`);
    let prev = -Infinity;
    for (const e of s) {
        if (!Array.isArray(e) || e.length !== 2 || !Number.isFinite(e[0]) || e[0] < 0) {
            throw new Error(`config: ${field}.schedule entries must be [tick>=0, value]`);
        }
        if (e[0] < prev) throw new Error(`config: ${field}.schedule ticks must be ascending`);
        prev = e[0];
    }
}

// The per-pool values World resolves per tick through scheduleValue (so each may be scalar or a step-schedule).
export const SCHEDULABLE_FIELDS = Object.freeze([
    'foodRegenerationPeriod', 'reproductiveIsolation', 'crossoverRate', 'mutationRate', 'foodSpread', 'maxFood', 'maxPopulation',
]);

// P3/§6 — the FULL world-config schema `World` reads: fill every ecology/lifecycle/spatial default so a MINIMAL
// config (even just `{}` or `{pool}`) yields a working, correctly-scaled world at ANY pool size, and DECLARE the
// scaling policy per quantity. This is the §6 "absolute-vs-×poolSize table". Only UNDEFINED fields are filled
// (`??`), so a fully-specified config (every golden / gate) is returned unchanged -> byte-identical. Any field
// not named here (masterSeed, pool, obstacles, topology, perceptionMode, maxFoodBitsPerType overrides, ...) is
// preserved verbatim via the spread. The engine imposes no world-scale limits (North Star): the "max" knobs
// default to Infinity (opt-in caps), never a built-in ceiling.
export function resolveWorldConfig(config = {}) {
    const pool = resolvePoolBounds(config.pool);
    const resolved = {
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
    };
    for (const field of SCHEDULABLE_FIELDS) validateScheduleForm(field, resolved[field]); // §10: fail malformed schedules at config time

    // L4 -- config VALUE validation (form, NOT behavioral limits). resolveWorldConfig is the path World uses (makeConfig
    // is a separate entry with its own checks), so a malformed value would otherwise surface deep in a tick, on
    // ACCEPTED input: childEnergyRatio drives contributeToOffspring (parent energy*(1-ratio) must stay >= 0 -> a ratio
    // outside [0,1] trips `_energy >= 0` on every birth); a non-finite maximumLifeSpan/foodSpread breaks the timerDelta
    // bound / corrupts food positions with NaN; a NaN rate silently disables crossover/mutation. Infinity stays LEGAL
    // where it means "no limit" (immortal lifespan, global viewRadius, uncapped maxFood/maxPopulation) -- faithful
    // north-star; only NaN (always malformed), a non-finite spawn RADIUS, and out-of-[0,1] rates/ratio are rejected.
    // eachVal walks a field's EFFECTIVE value(s): a §10 schedule is validated at every STEP (its form is checked by
    // validateScheduleForm above; here we check the VALUES a step would feed the tick), a scalar validates itself.
    const eachVal = (f, fn) => {
        const v = resolved[f];
        if (v !== null && typeof v === 'object' && Array.isArray(v.schedule)) { for (const step of v.schedule) fn(step[1]); }
        else fn(v);
    };
    // NON-schedulable numeric fields are read RAW (not via _sched) -> a schedule object would become NaN arithmetic
    // mid-tick; require a plain number. Infinity stays legal (global view / immortal / uncapped-per-type).
    const plainNumber = (f) => {
        const v = resolved[f];
        if (typeof v !== 'number') throw new Error(`config: ${f} must be a plain number -- it is not schedulable (got ${v !== null && typeof v === 'object' ? 'a schedule/object' : String(v)})`);
        if (Number.isNaN(v)) throw new Error(`config: ${f} must not be NaN`);
    };
    plainNumber('viewRadius'); plainNumber('maximumLifeSpan'); plainNumber('maxFoodBitsPerType');
    if (typeof resolved.childEnergyRatio !== 'number' || !Number.isFinite(resolved.childEnergyRatio) || resolved.childEnergyRatio < 0 || resolved.childEnergyRatio > 1) {
        throw new Error(`config: childEnergyRatio must be a number in [0,1] (got ${resolved.childEnergyRatio})`); // energy*(1-ratio) must be a valid non-negative fraction
    }
    if (!Number.isInteger(resolved.numFoodTypes) || resolved.numFoodTypes < 1) {
        throw new Error(`config: numFoodTypes must be an integer >= 1 (got ${resolved.numFoodTypes})`);
    }
    // SCHEDULABLE numeric fields (scalar OR every schedule step): reject NaN. foodSpread additionally must be a FINITE
    // spawn radius >= 0 -- Infinity/NaN there yields NaN food positions that corrupt the grid (the others only degrade
    // behaviorally). crossover/mutation are probabilities -> [0,1] (Infinity is caught by the >1 bound).
    for (const f of ['foodRegenerationPeriod', 'reproductiveIsolation', 'maxFood', 'maxPopulation']) {
        eachVal(f, (v) => { if (typeof v === 'number' && Number.isNaN(v)) throw new Error(`config: ${f} must not be NaN`); });
    }
    eachVal('foodSpread', (v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`config: foodSpread must be a finite number >= 0 (got ${v}) -- it is a spawn radius, not a "no limit" field`); });
    for (const f of ['crossoverRate', 'mutationRate']) {
        eachVal(f, (v) => {
            if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`config: ${f} must not be NaN`);
            if (v < 0 || v > 1) throw new Error(`config: ${f} must be in [0,1] (got ${v})`);
        });
    }
    return Object.freeze(resolved);
}
