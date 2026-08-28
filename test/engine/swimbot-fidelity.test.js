'use strict';
// Rung 1 of P1a (kill the slots): the fresh engine/ Swimbot reproduces JJ's per-tick swimbot behavior
// BIT-FOR-BIT (PLAN-restructure.md §19). This is the single-swimbot differential A/B -- the smallest,
// most debuggable unit -- validating the trig-heavy physics (updateBodyParts, calculateFluidForces,
// wall collisions, energy efficiency), the brain FSM, wanderFocus's draws, aging/growth, and death.
//
// PRNG-agnostic, record-then-replay (the E2 method): drive the OLD Swimbot recording every gpRandom
// draw, then drive the NEW Swimbot replaying that exact draw sequence. Both must (a) produce identical
// per-tick state and (b) consume the same number of draws in the same per-tick positions -- a draw
// COUNT drift (e.g. a missed/extra wanderFocus draw) fails as a replay under/over-run, pinpointing it.
//
// SINGLE-ENGINE: the sim uses Math.sqrt/sin/cos, so this is bit-exact only within one process (old and
// new run here together) -- which is exactly the A/B. No frozen fixture: the OLD code IS the reference.
//
// This rung covers pure-wander scenarios (no stimuli). Food-pursuit + eating are a following slice.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/load-sim');
const { mulberry32 } = require('../helpers/prng');
const { Swimbot } = require('../../engine/swimbot.js');
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');

const GP = loadSim();
const { FoodBit } = require('../../engine/foodBit.js');

// The world params the isolated OLD swimbot reads off globalTweakers/POOL_* defaults; the new engine
// takes them as config. (maximumLifeSpan = DEFAULT_MAXIMUM_AGE, childEnergyRatio default.) numFoodTypes
// varies per scenario (food-type digestion), so config is built per run.
function configFor(numFoodTypes) { return { maximumLifeSpan: 40000, numFoodTypes, childEnergyRatio: 0.5 }; }

const newEmb = new Embryology();
const oldEmb = new GP.Embryology();
const DEATH_SINK = { notifySwimbotDeathTime() {} }; // old die() calls _parent.notifySwimbotDeathTime

function readGenes(g) { const out = new Array(256); for (let i = 0; i < 256; i++) out[i] = g.getGeneValue(i); return out; }
function presetGenes(i) { const g = new GP.Genotype(); g.setToPreset(i); return readGenes(g); }
function seededGenes(seed) { globalThis.gpRandom = mulberry32(seed); const g = new GP.Genotype(); g.randomize(); return readGenes(g); }

// Full-precision per-tick snapshot of the OBSERVABLE swimbot state. Position integrates every physics
// force; energy the metabolism; brain/flags the decisions -- a tight net for any divergence.
function snapshot(sb) {
    return {
        x: sb.getPosition().x, y: sb.getPosition().y, angle: sb.getAngle(), energy: sb.getEnergy(),
        age: sb.getAge(), alive: sb.getAlive(), brain: sb.getBrainState(),
        eat: sb.getIsTryingToEat(), mate: sb.getIsTryingToMate(),
        eff: sb.getEnergyEfficiency(), sel: sb.getSelectRadius(),
        nEat: sb.getNumFoodBitsEaten(), nOff: sb.getNumOffspring(),
    };
}

// The per-tick pool order for an isolated swimbot with an optional single food bit: update() FIRST,
// then (if sensory-ready) setEnvironmentalStimuli with that food bit, then (if trying-to-eat) eat.
// numNearbySwimbots is 0 (no mate perception in rung 1) -- setEnvironmentalStimuli's mate branch is a
// no-op with an empty array.

// Drive the OLD swimbot, recording the exact draw sequence with per-tick counts.
function runOld(scn) {
    const { genes, age, x, y, angle, energy, ticks, srcSeed, food } = scn;
    const numFoodTypes = scn.numFoodTypes || 1;
    // decode reads globalTweakers.numFoodTypes; set it BEFORE create so the phenotype's digestible type
    // is right for this scenario (default 1 restored for every run so order can't leak).
    GP.globalTweakers.numFoodTypes = numFoodTypes;

    // Build the old food bit BEFORE installing the recording rng -- FoodBit.initialize() draws 2 (a random
    // position we overwrite), which must NOT pollute the swimbot's recorded stream.
    let foodBit = null;
    if (food) {
        foodBit = new GP.FoodBit();
        foodBit.initialize(1);
        const fpos = new GP.Vector2D(); fpos.setXY(food.x, food.y);
        foodBit.setPosition(fpos);
        foodBit.setEnergy(food.energy);
        foodBit.setType(food.type);
    }

    const draws = [];
    const perTickCount = [];
    const src = mulberry32(srcSeed);
    globalThis.gpRandom = () => { const v = src(); draws.push(v); return v; };

    const geno = new GP.Genotype();
    geno.setGenes(genes.slice());
    const pos = new GP.Vector2D(); pos.setXY(x, y);
    const sb = new GP.Swimbot();
    sb.setParent(DEATH_SINK);
    sb.create(0, age, pos, angle, energy, geno, oldEmb);

    const states = [];
    for (let t = 0; t < ticks; t++) {
        const before = draws.length;
        sb.update();
        if (foodBit && sb.getIsLookingForSensoryInput()) {
            sb.setEnvironmentalStimuli(0, [], foodBit.getAlive(), foodBit);
        }
        if (sb.getIsTryingToEat()) {
            sb.eatChosenFoodBit();
        }
        perTickCount.push(draws.length - before);
        states.push(snapshot(sb));
    }
    GP.globalTweakers.numFoodTypes = 1; // restore
    return { states, draws, perTickCount };
}

// Drive the NEW swimbot identically, replaying the recorded draws.
function runNew(scn, draws) {
    const { genes, age, x, y, angle, energy, ticks, food } = scn;
    const numFoodTypes = scn.numFoodTypes || 1;
    let di = 0;
    const perTickCount = [];
    const rng = () => {
        if (di >= draws.length) throw new Error('new Swimbot drew PAST the recorded sequence (extra draw)');
        return draws[di++];
    };

    let foodBit = null;
    if (food) {
        foodBit = new FoodBit();
        foodBit.setIndex(1);
        foodBit.setPosition({ x: food.x, y: food.y });
        foodBit.setEnergy(food.energy);
        foodBit.setType(food.type);
    }

    const geno = new Genotype();
    geno.setGenes(genes.slice());
    const pos = { x, y };
    // Addressed rng (P1b-ii): wander draws from ctx.life. This rung replays the OLD global draws, so life
    // wraps the single replay fn (no mate scan here, so matePref is unused).
    const sb = new Swimbot({ life: { next: rng }, config: configFor(numFoodTypes), embryology: newEmb });
    sb.create(0, age, pos, angle, energy, geno);

    const states = [];
    for (let t = 0; t < ticks; t++) {
        const before = di;
        sb.update();
        if (foodBit && sb.getIsLookingForSensoryInput()) {
            sb.setEnvironmentalStimuli(0, [], foodBit.getAlive(), foodBit);
        }
        if (sb.getIsTryingToEat()) {
            sb.eatChosenFoodBit();
        }
        perTickCount.push(di - before);
        states.push(snapshot(sb));
    }
    return { states, perTickCount, drawsUsed: di };
}

// One scenario: run old (recording), run new (replaying), assert identical every tick + draw accounting.
function assertScenario(name, scn) {
    const { ticks } = scn;
    const oldRun = runOld(scn);
    const newRun = runNew(scn, oldRun.draws);

    assert.equal(newRun.drawsUsed, oldRun.draws.length,
        `${name}: new consumed ${newRun.drawsUsed} draws but old recorded ${oldRun.draws.length}`);

    for (let t = 0; t < ticks; t++) {
        assert.equal(newRun.perTickCount[t], oldRun.perTickCount[t],
            `${name}: draw COUNT drift at tick ${t + 1} (old ${oldRun.perTickCount[t]}, new ${newRun.perTickCount[t]})`);
        assert.deepEqual(newRun.states[t], oldRun.states[t], `${name}: state drift at tick ${t + 1}`);
    }
    return oldRun;
}

// Scenarios span body shapes (presets + a seeded-random genome) x conditions (energy above/below the
// hunger threshold of 50, growing infant, near a wall, starving to death).
const DARWIN = presetGenes(0);
const WILSON = presetGenes(5);
const RANDO = seededGenes(12345);

test('rung1: mature swimbot, mate-mode (energy>hunger), center pool -- physics + brain match', () => {
    assertScenario('mature-mate', { genes: DARWIN, age: 5000, x: 4000, y: 4000, angle: 30, energy: 80, ticks: 400, srcSeed: 11 });
});

test('rung1: mature swimbot, food-mode (energy<hunger), wanders looking for food', () => {
    assertScenario('mature-food', { genes: DARWIN, age: 5000, x: 4000, y: 4000, angle: 30, energy: 40, ticks: 400, srcSeed: 22 });
});

test('rung1: infant swimbot (still growing, age<1000) -- growthScale ramp', () => {
    assertScenario('infant-growing', { genes: WILSON, age: 500, x: 4000, y: 4000, angle: 200, energy: 60, ticks: 700, srcSeed: 33 });
});

test('rung1: swimbot near the left wall -- wall-collision bounce', () => {
    assertScenario('left-wall', { genes: WILSON, age: 6000, x: 60, y: 4000, angle: 90, energy: 60, ticks: 300, srcSeed: 44 });
});

test('rung1: swimbot near the top-right corner -- two-wall bounce', () => {
    assertScenario('corner', { genes: RANDO, age: 6000, x: 7950, y: 60, angle: 300, energy: 55, ticks: 300, srcSeed: 55 });
});

test('rung1: low-energy swimbot starves and DIES -- death path', () => {
    const run = assertScenario('starve-die', { genes: RANDO, age: 8000, x: 4000, y: 4000, angle: 0, energy: 0.3, ticks: 200, srcSeed: 66 });
    const finalAlive = run.states[run.states.length - 1].alive;
    assert.equal(finalAlive, false, 'starve-die scenario must actually reach death (else it proves nothing about die())');
});

test('rung1: random-genome swimbot, long run crossing a sensory period boundary', () => {
    assertScenario('rando-long', { genes: RANDO, age: 3000, x: 5000, y: 3000, angle: 123.4, energy: 65, ticks: 600, srcSeed: 77 });
});

test('rung1: energy crosses the hunger threshold -- brain switches mate-mode -> food-mode', () => {
    // Starts just above hunger (50); the metabolic drain carries it below, flipping the FSM. Verify the
    // run actually contains BOTH brain modes (else it is not exercising the transition).
    const run = assertScenario('threshold-cross', { genes: DARWIN, age: 5000, x: 4000, y: 4000, angle: 45, energy: 50.4, ticks: 500, srcSeed: 88 });
    const modes = new Set(run.states.map((s) => s.brain));
    assert.ok(modes.has(1) && modes.has(3), `expected both LOOKING_FOR_MATE(1) and LOOKING_FOR_FOOD(3); saw ${[...modes]}`);
});

test('rung1: old-age swimbot -- slow-down ramp then death of old age (age>maximumLifeSpan)', () => {
    // age passes maximumLifeSpan (40000) during the run: exercises updateBodyParts' old-age else-branch
    // (timerDelta ramp) and the old-age die().
    const run = assertScenario('old-age', { genes: WILSON, age: 39700, x: 4000, y: 4000, angle: 10, energy: 90, ticks: 600, srcSeed: 99 });
    assert.equal(run.states[run.states.length - 1].alive, false, 'old-age scenario must reach death by maximumLifeSpan');
});

// --- rung 1b: food pursuit + eating ---

// Decode a genome's digestible food type (at numFoodTypes=2) via the new engine, to place food that
// deliberately MATCHES or MISMATCHES it (exercising both eatChosenFoodBit energy branches).
function digestibleType(genes) {
    const g = new Genotype(); g.setGenes(genes.slice());
    return newEmb.generatePhenotypeFromGenotype(g, { numFoodTypes: 2 }).digestibleFoodType;
}

// WILSON's body converges on a target (DARWIN/random bodies orbit without reaching the 10-unit mouth
// range in a bounded run); food is placed close, as it effectively is in the dense real pool.
test('rung1b: food-mode swimbot pursues a food bit and EATS it (1 food type)', () => {
    const run = assertScenario('food-eat-1type', {
        genes: WILSON, age: 5000, x: 4000, y: 4000, angle: 90, energy: 30, ticks: 600, srcSeed: 111,
        numFoodTypes: 1, food: { x: 4020, y: 4000, energy: 40, type: 0 },
    });
    const ate = run.states[run.states.length - 1].nEat;
    assert.ok(ate > 0, `food-eat scenario must actually eat (else it proves nothing about eatChosenFoodBit); ate=${ate}`);
});

test('rung1b: eats DIGESTIBLE food -- full energy gain (2 food types, type matches)', () => {
    const dt = digestibleType(WILSON);
    const run = assertScenario('food-eat-2type-match', {
        genes: WILSON, age: 5000, x: 4000, y: 4000, angle: 90, energy: 30, ticks: 600, srcSeed: 222,
        numFoodTypes: 2, food: { x: 4020, y: 4000, energy: 40, type: dt },
    });
    assert.ok(run.states[run.states.length - 1].nEat > 0, 'must eat the matching-type food');
});

test('rung1b: eats INDIGESTIBLE food -- reduced energy (2 food types, type mismatches -> FOOD_TYPE_OFFSET)', () => {
    const dt = digestibleType(WILSON);
    const run = assertScenario('food-eat-2type-mismatch', {
        // same seed as the match case: food type doesn't affect the trajectory to the food (only the
        // energy gained on eating), so this reaches + eats identically, then exercises the *0.2 offset.
        genes: WILSON, age: 5000, x: 4000, y: 4000, angle: 90, energy: 30, ticks: 600, srcSeed: 222,
        numFoodTypes: 2, food: { x: 4020, y: 4000, energy: 40, type: 1 - dt },
    });
    assert.ok(run.states[run.states.length - 1].nEat > 0, 'must eat the mismatching-type food (exercises the *0.2 offset)');
});
