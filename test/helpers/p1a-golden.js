'use strict';
// P1a A/B golden — the frozen behavioral target for "kill the slots" (PLAN-restructure.md §17, §19).
//
// P1a swaps the old engine's fixed Array(2000)+backfill for a dynamic collection while keeping every
// observable IDENTICAL. This module captures the OLD engine's construct+tick behavior as a bit-exact,
// per-tick baseline so the fresh engine/ can later be asserted against it tick-for-tick.
//
// Determinism: the old engine's gpRandom() is dead-coded to Math.random(), but it reads from global
// scope, so boot() installs a seeded mulberry32 BEFORE the first draw (test/helpers/boot.js). No edit
// to legacy simulation/ code is made -- the seed is injected, exactly as the E2 oracle does.
//
// SINGLE-ENGINE by nature: the sim uses Math.sqrt/sin/cos, whose last bits differ across platforms, and
// it is chaotic -- so the exact per-tick hashes are only reproducible on ONE Node build (recorded in
// `node`). That is fine for the A/B: the old baseline and the new engine run in the SAME process, and a
// faithful port reproduces JJ's exact op-order (E1/E2 already proved decode+genetics port bit-for-bit).
//
// SLOT-INDEPENDENT, NOT ID-INDEPENDENT (§17): the signature sorts entities by CONTENT with the stable
// id as the final tiebreak -- it never hashes raw array position. In the old engine id == slot, so this
// is a strict A/B for P1a (new must reproduce the exact slot/id assignment); at P1b the ids change
// (never-reused) and the golden legitimately MOVES -- this fixture is a P1a artifact by design.

const crypto = require('node:crypto');
const { boot, step } = require('./boot');

// Normalize -0 -> 0 (decode reflects zero-amplitude parts to -0; -0 and 0 are the same value but
// stringify identically, so this only guards the sort/compare path). Same lesson as the E1 oracle.
const nz = (v) => (v === 0 ? 0 : v);

function genesToString(g) {
    // getSwimbotGenes returns the genotype's live gene buffer (Array or typed array). Join to a compact
    // "b0,b1,...,b255" string -- keeps the canonical record (and the committed fixture) small, and is a
    // faithful key for both hashing and equality (256 bytes -> one short field instead of 256 lines).
    let s = '';
    for (let i = 0; i < g.length; i++) s += (i ? ',' : '') + (g[i] | 0);
    return s;
}

const fin = (v, what) => {
    // Guards the sort/hash path: a NaN would stringify to "null" (a collision risk) and make cmpSwimbot
    // an inconsistent comparator. Living swimbots always carry finite fields, so a trip here signals a
    // real sim bug, not a harness one.
    if (!Number.isFinite(v)) throw new Error(`p1a-golden: non-finite ${what}=${v}`);
    return v;
};

// One living swimbot -> a fixed-order, full-precision, canonical record. `id` (the stable identity) is
// LAST so the sort orders by content first and only falls back to identity for genuine content ties
// (e.g. clones sharing a birth position). Full precision: JSON.stringify of a double is its shortest
// round-trip form -- bit-exact for equality within one engine. `chosenMate` and `brainState` are HIDDEN
// state getPoolData omits; including them lets a perception / mate-ranking port bug surface at the
// DECISION (and localize there) instead of only later as downstream position drift. Both are identity-
// referencing like `id`, so (like the whole signature) they legitimately move at P1b.
function swimbotRecord(s, chosenMate, brainState) {
    return {
        x: nz(fin(s.x, 'x')), y: nz(fin(s.y, 'y')), angle: nz(fin(s.angle, 'angle')), energy: nz(fin(s.energy, 'energy')),
        age: s.age | 0, numOffspring: s.numOffspring | 0, numFoodBitsEaten: s.numFoodBitsEaten | 0,
        chosenMate: chosenMate | 0, brainState: brainState | 0,
        genes: genesToString(s.genes),
        id: s.id | 0,
    };
}
function foodRecord(f) {
    return { x: nz(f.x), y: nz(f.y), type: f.type | 0, id: f.id | 0 };
}

// Deterministic element-wise comparison of two records' canonical key tuples.
function cmpSwimbot(a, b) {
    if (a.x !== b.x) return a.x < b.x ? -1 : 1;
    if (a.y !== b.y) return a.y < b.y ? -1 : 1;
    if (a.angle !== b.angle) return a.angle < b.angle ? -1 : 1;
    if (a.energy !== b.energy) return a.energy < b.energy ? -1 : 1;
    if (a.age !== b.age) return a.age - b.age;
    if (a.genes !== b.genes) return a.genes < b.genes ? -1 : 1;
    return a.id - b.id; // stable-id tiebreak (§17)
}
function cmpFood(a, b) {
    if (a.x !== b.x) return a.x < b.x ? -1 : 1;
    if (a.y !== b.y) return a.y < b.y ? -1 : 1;
    if (a.type !== b.type) return a.type - b.type;
    return a.id - b.id;
}

// The deterministic, environment-independent config the trajectory depends on (guards silent drift of a
// tweaker). Camera is stripped by poolDataNoCamera upstream; we read the tweakers straight off poolData.
function configOf(pd) {
    return {
        numFoodTypes: pd.numFoodTypes,
        foodRegenerationPeriod: pd.foodRegenerationPeriod,
        foodSpread: pd.foodSpread,
        foodBitEnergy: pd.foodBitEnergy,
        maximumLifeSpan: pd.maximumLifeSpan,
        hungerThreshold: pd.hungerThreshold,
        attractionCriterion: pd.attractionCriterion,
        childEnergyRatio: pd.childEnergyRatio,
        obstacle: [nz(pd.obstacleEnd1X), nz(pd.obstacleEnd1Y), nz(pd.obstacleEnd2X), nz(pd.obstacleEnd2Y)],
    };
}

// Full canonical snapshot of the pool: sorted swimbots + sorted food + config. Slot-independent.
// chosenMate/brainState are read per-id from the gp getters (getPoolData does not carry them).
function canonicalSnapshot(gp) {
    const pd = gp.getPoolData();
    const swimbots = pd.swimbotArray
        .map((s) => swimbotRecord(s, gp.getSwimbotChosenMate(s.id), gp.getSwimbotBrainState(s.id)))
        .sort(cmpSwimbot);
    const food = pd.foodBitArray.map(foodRecord).sort(cmpFood);
    return { config: configOf(pd), swimbots, food };
}

// A compact, portable-integer reduction for a legible diff even when the float hash can't be compared.
function scalarsOf(gp) {
    const pd = gp.getPoolData();
    return {
        population: pd.swimbotArray.length,
        food: pd.foodBitArray.length,
        familyNodes: gp.getFamilyTree().getNumNodes(),
    };
}

function hashSnapshot(snap) {
    return crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
}

// The set of living stable ids, for ABA (slot-reuse) detection.
function livingIds(gp) {
    return new Set(gp.getPoolData().swimbotArray.map((s) => s.id));
}

// Boot the OLD engine at `seed`, capture the constructed state, then step `ticks` ticks, recording a
// canonical per-tick hash and detecting ABA events -- a birth into an id that was ALIVE-then-DIED (the
// exact death-node hazard P1a removes), as distinct from a birth into a never-used slot.
//
// aba.events is a LOWER BOUND: it diffs the living-id set across tick BOUNDARIES, so a slot that both
// dies AND is reborn within one tick (possible when the freed slot index < the mating swimbot's index,
// since findLowestDeadSwimbotInArray can hand a birth a slot vacated earlier in the same tick) nets to
// "still alive" and is not separately counted -- though its content change IS captured by that tick's
// hash, so the A/B is unaffected. A positive count is what the coverage assertion needs.
function captureRun(seed, ticks) {
    const gp = boot(seed);
    const initial = canonicalSnapshot(gp);

    const everAlive = livingIds(gp);
    const tickHashes = new Array(ticks);
    const abaTicks = [];
    let deaths = 0;
    let appendBirths = 0;

    let before = new Set(everAlive);
    for (let t = 0; t < ticks; t++) {
        gp.update();
        const after = livingIds(gp);
        for (const id of after) {
            if (!before.has(id)) {
                if (everAlive.has(id)) abaTicks.push(t + 1); // reuse of an alive-then-dead id: the ABA
                else appendBirths++;
                everAlive.add(id);
            }
        }
        for (const id of before) if (!after.has(id)) deaths++;
        tickHashes[t] = hashSnapshot(canonicalSnapshot(gp));
        before = after;
    }

    return {
        node: process.version,
        seed,
        ticks,
        initial,
        final: canonicalSnapshot(gp),
        tickHashes,
        scalars: scalarsOf(gp),
        aba: { events: abaTicks.length, ticks: abaTicks, appendBirths, deaths },
    };
}

const SEED = 42;
const TICKS = 1000;
const path = require('node:path');
const goldenPath = () => path.join(__dirname, '..', 'fixtures', 'golden', `p1a-tick-baseline-seed${SEED}-t${TICKS}.json`);

module.exports = {
    captureRun, canonicalSnapshot, hashSnapshot, scalarsOf, livingIds, SEED, TICKS, goldenPath,
};
