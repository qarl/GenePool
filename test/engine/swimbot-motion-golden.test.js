'use strict';
// SWIMBOT-MOTION GOLDENS: our engine/ Swimbot must reproduce JJ's ORIGINAL per-tick MOTION across a spread
// of scenarios (body shapes x conditions: mate/food mode, growing infant, wall/corner bounce, starve-to-
// death), checked against a FROZEN capture of JJ (test/fixtures/swimbot-motion.json, generated once by
// gen-swimbot-motion-fixtures.cjs) -- so JJ's sim never loads on every `node --test`. This is the portable,
// JJ-independent regression guard; the live differential A/B in swimbot-fidelity.test.js stays the
// bit-for-bit authority (single-engine, no cross-platform float concern).
//
// The rng is mulberry32(srcSeed): our Swimbot draws the SAME stream in the SAME order as JJ IF faithful.
// - per-tick DRAW COUNT: compared EXACTLY (integers, platform-independent) -- catches any wander/draw drift.
// - DISCRETE state (age, alive, brain FSM, eat/mate flags, nEat, nOff): compared EXACTLY (platform-indep).
// - FLOAT state (x, y, angle, energy, efficiency, selectRadius): compared with a tight tolerance, because a
//   frozen float can differ in the last bit across Node/CPU (trig). On the machine that cut the fixture the
//   diff is 0 (bit-for-bit); the tolerance only absorbs cross-platform jitter. A real regression moves these
//   by >>tolerance and/or flips a discrete field.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mulberry32 } = require('../helpers/prng');
const { Swimbot } = require('../../engine/swimbot.js');
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');
const { FoodBit } = require('../../engine/foodBit.js');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'swimbot-motion.json'), 'utf8'));
const newEmb = new Embryology();
const FLOAT_FIELDS = ['x', 'y', 'angle', 'energy', 'eff', 'sel'];
const DISCRETE_FIELDS = ['age', 'alive', 'brain', 'eat', 'mate', 'nEat', 'nOff'];
const FLOAT_TOL = 1e-6; // abs+rel; on the fixture's machine the diff is 0 -- this only absorbs cross-platform trig
const configFor = (numFoodTypes) => ({ maximumLifeSpan: 40000, numFoodTypes, childEnergyRatio: 0.5 });

function snapshot(sb) {
    return {
        x: sb.getPosition().x, y: sb.getPosition().y, angle: sb.getAngle(), energy: sb.getEnergy(),
        age: sb.getAge(), alive: sb.getAlive(), brain: sb.getBrainState(),
        eat: sb.getIsTryingToEat(), mate: sb.getIsTryingToMate(),
        eff: sb.getEnergyEfficiency(), sel: sb.getSelectRadius(),
        nEat: sb.getNumFoodBitsEaten(), nOff: sb.getNumOffspring(),
    };
}

// Drive OUR Swimbot through a scenario, replaying mulberry32(srcSeed), returning per-tick states + draw counts.
function runNew(scn) {
    let count = 0;
    const src = mulberry32(scn.srcSeed);
    const rng = () => { count++; return src(); };

    let foodBit = null;
    if (scn.food) {
        foodBit = new FoodBit();
        foodBit.setIndex(1); foodBit.setPosition({ x: scn.food.x, y: scn.food.y });
        foodBit.setEnergy(scn.food.energy); foodBit.setType(scn.food.type);
    }

    const geno = new Genotype(); geno.setGenes(Array.from(Buffer.from(scn.genes, 'base64')));
    const sb = new Swimbot({ life: { next: rng }, config: configFor(scn.numFoodTypes), embryology: newEmb });
    sb.create(0, scn.age, { x: scn.x, y: scn.y }, scn.angle, scn.energy, geno);

    const states = [], perTickCount = [];
    for (let t = 0; t < scn.ticks; t++) {
        const before = count;
        sb.update();
        if (foodBit && sb.getIsLookingForSensoryInput()) sb.setEnvironmentalStimuli(0, [], foodBit.getAlive(), foodBit);
        if (sb.getIsTryingToEat()) sb.eatChosenFoodBit();
        perTickCount.push(count - before);
        states.push(snapshot(sb));
    }
    return { states, perTickCount };
}

function floatClose(a, b) { return Math.abs(a - b) <= FLOAT_TOL + FLOAT_TOL * Math.abs(b); }

for (const scn of FIX.scenarios) {
    test(`swimbot-motion golden: ${scn.name} reproduces JJ's frozen motion (${scn.ticks} ticks)`, () => {
        const run = runNew(scn);
        let maxFloatDiff = 0;
        for (let t = 0; t < scn.ticks; t++) {
            assert.equal(run.perTickCount[t], scn.perTickCount[t],
                `${scn.name}: draw-count drift at tick ${t + 1} (JJ ${scn.perTickCount[t]}, ours ${run.perTickCount[t]})`);
            const jj = scn.states[t], mine = run.states[t];
            for (const f of DISCRETE_FIELDS) {
                assert.equal(mine[f], jj[f], `${scn.name}: ${f} drift at tick ${t + 1} (JJ ${jj[f]}, ours ${mine[f]})`);
            }
            for (const f of FLOAT_FIELDS) {
                maxFloatDiff = Math.max(maxFloatDiff, Math.abs(mine[f] - jj[f]));
                assert.ok(floatClose(mine[f], jj[f]),
                    `${scn.name}: ${f} drift at tick ${t + 1} (JJ ${jj[f]}, ours ${mine[f]}, tol ${FLOAT_TOL})`);
            }
        }
        // On the machine that cut the fixture this is exactly 0 -- surfaced so a nonzero value (cross-platform
        // trig) is visible and stays far under the tolerance.
        assert.ok(maxFloatDiff <= FLOAT_TOL, `${scn.name}: max float diff ${maxFloatDiff} exceeds tol ${FLOAT_TOL}`);
    });
}
