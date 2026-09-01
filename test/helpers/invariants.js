'use strict';
// Architecture-agnostic structural invariants, checked through Gene Pool's public API.
// These hold regardless of internal representation, so they survive future refactors
// (e.g. replacing the slot arrays). Throws a tagged Error on the first violation —
// the caller stops the run (update() is not atomic, so continuing runs on corrupt state).

// opts.maxEnergy (§11): the energy-ceiling backstop is a CONFIG-DERIVED bound, not an engine constant -- a
// high-energy world (large hungerThreshold + foodBitEnergy) legitimately tops out well above the default 1000, so
// such a run passes its own bound (~ hungerThreshold + maxMealEnergy + margin). Default 1000 keeps every existing
// (default-config) caller unchanged.
function checkInvariants(gp, GP, opts = {}) {
    const fail = (msg) => { const e = new Error('INVARIANT: ' + msg); e.invariant = true; throw e; };
    const maxEnergy = opts.maxEnergy ?? 1000;

    const MAX_S = GP.MAX_SWIMBOTS;
    const MAX_F = GP.MAX_FOODBITS;
    const NG = GP.NUM_GENES;
    const BYTE = GP.BYTE_SIZE;
    const NULLI = GP.NULL_INDEX;

    const pd = gp.getPoolData();

    // --- swimbots ---
    if (pd.swimbotArray.length !== gp.getNumSwimbots()) {
        fail(`swimbotArray.length ${pd.swimbotArray.length} != getNumSwimbots() ${gp.getNumSwimbots()}`);
    }
    const seenIds = new Set();
    for (const s of pd.swimbotArray) {
        if (!(Number.isInteger(s.id) && s.id >= 0 && s.id < MAX_S)) fail(`swimbot id out of range: ${s.id}`);
        if (seenIds.has(s.id)) fail(`duplicate swimbot id ${s.id}`);
        seenIds.add(s.id);

        // Check energy's TYPE first: the string-concat bug makes it e.g. "3050", which
        // Number.isFinite would also reject below — but this gives the precise diagnosis.
        if (typeof s.energy !== 'number') fail(`swimbot ${s.id} energy is ${typeof s.energy} (string-concat bug?): ${s.energy}`);
        for (const k of ['x', 'y', 'angle', 'energy', 'age']) {
            if (!Number.isFinite(s[k])) fail(`swimbot ${s.id} ${k} not finite: ${s[k]}`);
        }
        if (s.energy <= 0) fail(`swimbot ${s.id} alive with energy <= 0: ${s.energy}`);
        // Energy CEILING (anti-injection backstop, the C2 string-concat class). A swimbot stops
        // eating once full (~hunger threshold), so it tops out around ~100 at default config and
        // ~300 in the most extreme UI config (hunger 200 + one 100-energy meal); measured max over
        // 4000 ticks x 3 seeds is 99.99. A value orders of magnitude above that (C2 injected 3050)
        // signals an energy-injection bug. 1000 is a generous bound: far above any legitimate energy,
        // far below an injection. (This is the reliable subset of "energy conservation" -- full
        // per-tick accounting needs stable IDs + per-meal/-death observation and is deferred.)
        if (s.energy > maxEnergy) fail(`swimbot ${s.id} energy ${s.energy} exceeds the ceiling ${maxEnergy} (energy-injection bug?)`);

        if (!Array.isArray(s.genes) || s.genes.length !== NG) {
            fail(`swimbot ${s.id} genes length ${s.genes && s.genes.length}, expected ${NG}`);
        }
        for (let g = 0; g < s.genes.length; g++) {
            const v = s.genes[g];
            if (!(Number.isInteger(v) && v >= 0 && v < BYTE)) fail(`swimbot ${s.id} gene[${g}]=${v} out of [0,${BYTE})`);
        }
        // slot/index identity — benign on natural runs, catches the load (C1) desync
        if (gp.getSwimbotIndex(s.id) !== s.id) {
            fail(`getSwimbotIndex(${s.id})=${gp.getSwimbotIndex(s.id)} != slot ${s.id}`);
        }
    }

    // --- food ---
    const f1 = (typeof gp.getNumFoodBits1 === 'function') ? gp.getNumFoodBits1() : 0;
    const totalFood = gp.getNumFoodBits() + f1; // getNumFoodBits() is type-0-only when numFoodTypes==2
    if (pd.foodBitArray.length !== totalFood) {
        fail(`foodBitArray.length ${pd.foodBitArray.length} != total alive food ${totalFood}`);
    }
    for (const f of pd.foodBitArray) {
        if (!(Number.isInteger(f.id) && f.id >= 0 && f.id < MAX_F)) fail(`food id out of range: ${f.id}`);
        for (const k of ['x', 'y']) if (!Number.isFinite(f[k])) fail(`food ${f.id} ${k} not finite: ${f[k]}`);
        if (!(f.type === 0 || f.type === 1)) fail(`food ${f.id} type invalid (must be 0 or 1): ${f.type}`);
    }

    // --- camera present + finite (its VALUE is nondeterministic, but must not be NaN/Inf) ---
    for (const k of ['cameraX', 'cameraY', 'cameraScale']) {
        if (!Number.isFinite(pd[k])) fail(`${k} not finite: ${pd[k]}`);
    }

    // --- lineage: no node is its own parent (non-NULL parents only; founders are NULL) ---
    // + lineage-time sanity: no birth stamped in the future; a recorded death is within [birth, now].
    // (deathTime 0 = alive / not recorded.) Guards the M-clock class of stale-timestamp bugs.
    const ft = gp.getFamilyTree();
    const now = gp.getTimeStep();
    for (let n = 0; n < ft.getNumNodes(); n++) {
        const self = ft.getNodePoolIndex(n);
        const p1 = ft.getNodeParent1PoolIndex(n);
        const p2 = ft.getNodeParent2PoolIndex(n);
        if (p1 !== NULLI && p1 === self) fail(`family node ${n} is its own parent1 (poolIndex ${self})`);
        if (p2 !== NULLI && p2 === self) fail(`family node ${n} is its own parent2 (poolIndex ${self})`);

        const bt = ft.getNodeBirthTime(n);
        const dt = ft.getNodeDeathTime(n);
        if (!(Number.isFinite(bt) && bt >= 0 && bt <= now)) fail(`family node ${n} birthTime ${bt} not in [0, ${now}]`);
        if (dt !== 0 && !(Number.isFinite(dt) && dt >= bt && dt <= now)) fail(`family node ${n} deathTime ${dt} not in [${bt}, ${now}]`);
    }
}

module.exports = { checkInvariants };
