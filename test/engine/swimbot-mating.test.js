'use strict';
// Rung 2 of P1a (kill the slots): the fresh engine/ reproduces JJ's swimbot-side MATE path bit-for-bit
// (PLAN-restructure.md §19) -- mate perception (setEnvironmentalStimuli's mate branch + getAttractiveness
// + all the attraction/similarity/color/body-metric helpers), the PURSUING_MATE steering, trying-to-mate
// proximity, and contributeToOffspring. (The pool-level birth ORCHESTRATION -- findLowestDeadSlot, the
// junk-DNA gate, setAsOffspring, child creation -- is rung 3.)
//
// Same record-then-replay A/B as rung 1: drive OLD swimbots recording gpRandom, drive NEW swimbots
// replaying, assert identical per-tick state for BOTH partners + identical draw counts. getAttractiveness
// draws ONE gpRandom per mate evaluated, so a wrong draw count in the mate scan fails as a replay drift.
//
// Two swimbots perceive EACH OTHER (numNearbySwimbots=1, the partner). Both default to ATTRACTION_
// SIMILAR_COLOR (the Brain constructor default), so the mate scan runs getColorSimilarity. A focused
// second test compares EVERY attraction helper old-vs-new (the SIMILAR_COLOR path alone doesn't reach
// getColorSaturation / the body-metric getters / the non-default criteria).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/load-sim');
const { mulberry32 } = require('../helpers/prng');
const { Swimbot } = require('../../engine/swimbot.js');
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');

const GP = loadSim();
const newEmb = new Embryology();
const oldEmb = new GP.Embryology();
const CONFIG = { maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5 };
const DEATH_SINK = { notifySwimbotDeathTime() {} };

function readGenes(g) { const out = new Array(256); for (let i = 0; i < 256; i++) out[i] = g.getGeneValue(i); return out; }
function presetGenes(i) { const g = new GP.Genotype(); g.setToPreset(i); return readGenes(g); }
function seededGenes(seed) { globalThis.gpRandom = mulberry32(seed); const g = new GP.Genotype(); g.randomize(); return readGenes(g); }

function snapshot(sb) {
    return {
        x: sb.getPosition().x, y: sb.getPosition().y, angle: sb.getAngle(), energy: sb.getEnergy(),
        age: sb.getAge(), alive: sb.getAlive(), brain: sb.getBrainState(),
        eat: sb.getIsTryingToEat(), mate: sb.getIsTryingToMate(),
        chosenMate: sb.getChosenMateIndex(), nOff: sb.getNumOffspring(),
        eff: sb.getEnergyEfficiency(), sel: sb.getSelectRadius(),
    };
}

// The pool processes swimbots one at a time in slot order: for each, update -> (if sensory-ready)
// setEnvironmentalStimuli -> (if trying-to-mate) the birth handshake. Here the "handshake" is the
// swimbot-side energy contribution of BOTH partners (rung 3 adds the gate + child). numFoodTypes and
// attractionCriterion default correctly on the isolated old swimbot's brain, so nothing extra is set.
function pairOrder(a, b) { return [[a, b], [b, a]]; }

function drivePairOld(scn) {
    const { genesA, genesB, ax, ay, aAngle, bx, by, bAngle, energy, ticks, srcSeed, contribute } = scn;
    GP.globalTweakers.numFoodTypes = 1;

    const draws = [];
    const perTickCount = [];
    const src = mulberry32(srcSeed);
    globalThis.gpRandom = () => { const v = src(); draws.push(v); return v; };

    const mk = (genes, id, x, y, angle) => {
        const g = new GP.Genotype(); g.setGenes(genes.slice());
        const pos = new GP.Vector2D(); pos.setXY(x, y);
        const sb = new GP.Swimbot(); sb.setParent(DEATH_SINK);
        sb.create(id, 5000, pos, angle, energy, g, oldEmb);
        return sb;
    };
    const A = mk(genesA, 0, ax, ay, aAngle);
    const B = mk(genesB, 1, bx, by, bAngle);

    const states = [];
    for (let t = 0; t < ticks; t++) {
        const before = draws.length;
        for (const [s, other] of pairOrder(A, B)) {
            s.update();
            if (s.getIsLookingForSensoryInput()) s.setEnvironmentalStimuli(1, [other], false, null);
            if (contribute && s.getIsTryingToMate()
                && s.getChosenMateIndex() === other.getIndex() && other.getAlive()) {
                s.contributeToOffspring();
                other.contributeToOffspring();
            }
        }
        perTickCount.push(draws.length - before);
        states.push([snapshot(A), snapshot(B)]);
    }
    return { A, B, draws, perTickCount, states };
}

function drivePairNew(scn, draws) {
    const { genesA, genesB, ax, ay, aAngle, bx, by, bAngle, energy, ticks, contribute } = scn;
    let di = 0;
    const perTickCount = [];
    const rng = () => {
        if (di >= draws.length) throw new Error('new pair drew PAST the recorded sequence (extra draw)');
        return draws[di++];
    };
    const mk = (genes, id, x, y, angle) => {
        const g = new Genotype(); g.setGenes(genes.slice());
        // Addressed rng (P1b-ii): both wander (life) and mate-pref (matePref) replay the OLD single global
        // stream in call order, so this A/B against JJ still holds.
        const sb = new Swimbot({ life: { next: rng }, matePref: () => rng(), config: CONFIG, embryology: newEmb });
        sb.create(id, 5000, { x, y }, angle, energy, g);
        return sb;
    };
    const A = mk(genesA, 0, ax, ay, aAngle);
    const B = mk(genesB, 1, bx, by, bAngle);

    const states = [];
    for (let t = 0; t < ticks; t++) {
        const before = di;
        for (const [s, other] of pairOrder(A, B)) {
            s.update();
            if (s.getIsLookingForSensoryInput()) s.setEnvironmentalStimuli(1, [other], false, null, t);
            if (contribute && s.getIsTryingToMate()
                && s.getChosenMateIndex() === other.getIndex() && other.getAlive()) {
                s.contributeToOffspring();
                other.contributeToOffspring();
            }
        }
        perTickCount.push(di - before);
        states.push([snapshot(A), snapshot(B)]);
    }
    return { A, B, states, perTickCount, drawsUsed: di };
}

function assertPair(name, scn) {
    const oldRun = drivePairOld(scn);
    const newRun = drivePairNew(scn, oldRun.draws);
    assert.equal(newRun.drawsUsed, oldRun.draws.length,
        `${name}: new consumed ${newRun.drawsUsed} draws but old recorded ${oldRun.draws.length}`);
    for (let t = 0; t < scn.ticks; t++) {
        assert.equal(newRun.perTickCount[t], oldRun.perTickCount[t], `${name}: draw count drift at tick ${t + 1}`);
        assert.deepEqual(newRun.states[t][0], oldRun.states[t][0], `${name}: swimbot A state drift at tick ${t + 1}`);
        assert.deepEqual(newRun.states[t][1], oldRun.states[t][1], `${name}: swimbot B state drift at tick ${t + 1}`);
    }
    return oldRun;
}

const WILSON = presetGenes(5);
const DENNETT = presetGenes(7);
const RANDO = seededGenes(12345);

test('rung2: two swimbots perceive, pursue, and MATE (getAttractiveness + mate steering + contribute)', () => {
    // WILSON bodies converge; both start mate-mode (energy 80) close enough to reach genital range and
    // reciprocally contribute. Assert a birth-contribution actually happened (else the mate path is unproven).
    const run = assertPair('wilson-pair', {
        genesA: WILSON, genesB: WILSON, ax: 4000, ay: 4000, aAngle: 90, bx: 4050, by: 4000, bAngle: 270,
        energy: 80, ticks: 320, srcSeed: 11, contribute: true,
    });
    const last = run.states[run.states.length - 1];
    const anyOffspring = last[0].nOff + last[1].nOff;
    assert.ok(anyOffspring > 0, `mate scenario must produce a contribution (numOffspring); got ${anyOffspring}`);
});

test('rung2: mate perception without contribute -- pursuit + chosen-mate tracking stays bit-exact', () => {
    // No handshake: just perception + pursuit. Confirms the chosen-mate bookkeeping + steering match even
    // across the sensory refreshes, over a longer run.
    assertPair('wilson-pair-nocontribute', {
        genesA: WILSON, genesB: DENNETT, ax: 4000, ay: 4000, aAngle: 45, bx: 4060, by: 4010, bAngle: 200,
        energy: 90, ticks: 200, srcSeed: 33, contribute: false,
    });
});

// --- focused: every attraction helper reproduces old-vs-new (the SIMILAR_COLOR mate path alone does not
// reach getColorSaturation, the body-metric getters, or the non-default criteria) ---

function helperBundle(s, judge) {
    const c = s.getAverageColor();
    return {
        avgColor: { red: c.red, green: c.green, blue: c.blue },
        colorSaturation: s.getColorSaturation(),
        bigness: s.getCurrentBodyBigness(),
        longness: s.getCurrentBodyLongness(),
        straightness: s.getCurrentBodyStraightness(),
        hyperness: s.getCurrentBodyHyperness(),
        colorSim: s.getColorSimilarity(judge),
        bignessSim: s.getBignessSimilarity(judge),
        hyperSim: s.getHypernessSimilarity(judge),
        lengthSim: s.getLengthSimilarity(judge),
        straightSim: s.getStraightessSimilarity(judge),
        similarity: s.getSimilarity(judge),
        closeness: s.getCloseness(judge),
    };
}

test('rung2: every attraction/similarity/body helper reproduces old-vs-new (after real motion)', () => {
    // Drive a pair for a while (via the A/B, which itself asserts identical state), then compare the full
    // helper surface between old and new -- both swimbots now carry identical runtime state, so any helper
    // arithmetic drift shows here even though the mate-choice path only used getColorSimilarity.
    const scn = {
        genesA: WILSON, genesB: RANDO, ax: 4000, ay: 4000, aAngle: 10, bx: 4080, by: 4020, bAngle: 300,
        energy: 90, ticks: 150, srcSeed: 55, contribute: false,
    };
    const oldRun = assertPair('helper-pair', scn); // also proves the pair itself is bit-exact
    const newRun = drivePairNew(scn, oldRun.draws);

    // old A judged by old B, vs new A judged by new B (and vice-versa).
    assert.deepEqual(helperBundle(newRun.A, newRun.B), helperBundle(oldRun.A, oldRun.B), 'helper drift for A (judged by B)');
    assert.deepEqual(helperBundle(newRun.B, newRun.A), helperBundle(oldRun.B, oldRun.A), 'helper drift for B (judged by A)');
});

test('rung2: getAttractiveness reproduces old-vs-new under EVERY attraction criterion', () => {
    // getAttractiveness draws one gpRandom then dispatches on the brain criterion. Set each criterion on
    // both engines, feed the SAME single draw, and compare the result (0..16). This covers the whole
    // dispatch incl. the ONE-minus variants and ATTRACTION_RANDOM (which draws a second time).
    const scn = {
        genesA: WILSON, genesB: RANDO, ax: 4000, ay: 4000, aAngle: 10, bx: 4080, by: 4020, bAngle: 300,
        energy: 90, ticks: 80, srcSeed: 77, contribute: false,
    };
    const oldRun = assertPair('criteria-pair', scn);
    const newRun = drivePairNew(scn, oldRun.draws);

    for (let criterion = 0; criterion <= 16; criterion++) {
        oldRun.A.setAttraction(criterion); oldRun.B.setAttraction(criterion);
        newRun.A.setAttraction(criterion); newRun.B.setAttraction(criterion);
        // Feed both a fixed draw sequence (ATTRACTION_RANDOM consumes two; others one) and count draws --
        // so we also pin the always-draw-one-at-the-top invariant for EVERY criterion, not just the value.
        const feed = [0.123456789, 0.987654321];
        const mkRng = () => { let i = 0; const fn = () => feed[i++ % feed.length]; fn.count = () => i; return fn; };
        const oldRng = mkRng();
        globalThis.gpRandom = oldRng; // old getAttractiveness draws from the global
        const oldVal = oldRun.B.getAttractiveness(oldRun.A);
        const newRng = mkRng();
        newRun.B._matePref = () => newRng(); // new getAttractiveness draws its mate-pref from this feed
        const newVal = newRun.B.getAttractiveness(newRun.A, 0); // tick arg (unused -- matePref ignores it)
        assert.equal(newVal, oldVal, `getAttractiveness drift at criterion ${criterion}`);
        assert.equal(newRng.count(), oldRng.count(), `getAttractiveness draw-count drift at criterion ${criterion}`);
        const expectedDraws = (criterion === 16) ? 2 : 1; // ATTRACTION_RANDOM draws twice; all else once
        assert.equal(oldRng.count(), expectedDraws, `criterion ${criterion} should consume ${expectedDraws} draw(s)`);
    }
});
