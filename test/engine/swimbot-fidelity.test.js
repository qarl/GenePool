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

// The world params the isolated OLD swimbot reads off globalTweakers/POOL_* defaults; the new engine
// takes them as config. (maximumLifeSpan = DEFAULT_MAXIMUM_AGE, numFoodTypes/childEnergyRatio defaults.)
const CONFIG = { maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5 };

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

// Drive the OLD swimbot through `ticks` pure-wander ticks (no stimuli, no eating), recording per-tick
// state + the exact draw sequence with per-tick counts.
function runOld(genes, age, x, y, angle, energy, ticks, srcSeed) {
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
        perTickCount.push(draws.length - before);
        states.push(snapshot(sb));
    }
    return { states, draws, perTickCount };
}

// Drive the NEW swimbot identically, replaying the recorded draws. Asserts the draw sequence is consumed
// exactly (no under/over-run) and records per-tick draw counts for comparison.
function runNew(genes, age, x, y, angle, energy, ticks, draws) {
    let di = 0;
    const perTickCount = [];
    const rng = () => {
        if (di >= draws.length) throw new Error('new Swimbot drew PAST the recorded sequence (extra draw)');
        return draws[di++];
    };

    const geno = new Genotype();
    geno.setGenes(genes.slice());
    const pos = { x, y };
    const sb = new Swimbot({ rng, config: CONFIG, embryology: newEmb });
    sb.create(0, age, pos, angle, energy, geno);

    const states = [];
    for (let t = 0; t < ticks; t++) {
        const before = di;
        sb.update();
        perTickCount.push(di - before);
        states.push(snapshot(sb));
    }
    return { states, perTickCount, drawsUsed: di };
}

// One scenario: run old (recording), run new (replaying), assert identical every tick + draw accounting.
function assertScenario(name, { genes, age, x, y, angle, energy, ticks, srcSeed }) {
    const oldRun = runOld(genes, age, x, y, angle, energy, ticks, srcSeed);
    const newRun = runNew(genes, age, x, y, angle, energy, ticks, oldRun.draws);

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
