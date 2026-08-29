'use strict';
// GENERATOR (run manually; NOT a test) for the swimbot-motion goldens. It drives JJ's ORIGINAL Swimbot
// through a spread of motion scenarios (body shapes x conditions: mate/food mode, growing infant, wall/
// corner bounce, starve-to-death) and FREEZES, per scenario, JJ's per-tick observable state + per-tick
// draw COUNT to test/fixtures/swimbot-motion-seed*.json. The committed test (swimbot-motion-golden.test.js)
// then drives OUR Swimbot through the same scenarios and asserts it reproduces JJ's frozen motion -- WITHOUT
// loading JJ's sim on every run. (The live differential A/B in swimbot-fidelity.test.js remains the
// bit-for-bit authority; these frozen goldens are the portable, JJ-independent regression guard.)
//
// The rng is mulberry32(srcSeed): JJ and ours draw the SAME stream in the SAME order IF faithful, so we
// store only the per-tick draw COUNT (integers, platform-independent) -- a count drift is caught exactly,
// and the state comparison catches value/physics drift. Re-run to refresh:
//   node test/helpers/gen-swimbot-motion-fixtures.cjs

const fs = require('node:fs');
const path = require('node:path');
const { loadSim } = require('./load-sim');
const { mulberry32 } = require('./prng');
const GP = loadSim();

const oldEmb = new GP.Embryology();
const DEATH_SINK = { notifySwimbotDeathTime() {} };

function readGenes(g) { const out = new Array(256); for (let i = 0; i < 256; i++) out[i] = g.getGeneValue(i); return out; }
function presetGenes(i) { const g = new GP.Genotype(); g.setToPreset(i); return readGenes(g); }
function seededGenes(seed) { globalThis.gpRandom = mulberry32(seed); const g = new GP.Genotype(); g.randomize(); return readGenes(g); }

// Full-precision per-tick snapshot of the OBSERVABLE swimbot state (same fields as swimbot-fidelity).
function snapshot(sb) {
    return {
        x: sb.getPosition().x, y: sb.getPosition().y, angle: sb.getAngle(), energy: sb.getEnergy(),
        age: sb.getAge(), alive: sb.getAlive(), brain: sb.getBrainState(),
        eat: sb.getIsTryingToEat(), mate: sb.getIsTryingToMate(),
        eff: sb.getEnergyEfficiency(), sel: sb.getSelectRadius(),
        nEat: sb.getNumFoodBitsEaten(), nOff: sb.getNumOffspring(),
    };
}

// Drive JJ's swimbot, recording per-tick state + per-tick draw count.
function runOld(scn) {
    const { genes, age, x, y, angle, energy, ticks, srcSeed, food } = scn;
    const numFoodTypes = scn.numFoodTypes || 1;
    GP.globalTweakers.numFoodTypes = numFoodTypes;

    let foodBit = null;
    if (food) { // build BEFORE the recording rng: FoodBit.initialize() draws must not pollute the stream
        foodBit = new GP.FoodBit(); foodBit.initialize(1);
        const fpos = new GP.Vector2D(); fpos.setXY(food.x, food.y);
        foodBit.setPosition(fpos); foodBit.setEnergy(food.energy); foodBit.setType(food.type);
    }

    let count = 0;
    const src = mulberry32(srcSeed);
    globalThis.gpRandom = () => { count++; return src(); };

    const geno = new GP.Genotype(); geno.setGenes(genes.slice());
    const pos = new GP.Vector2D(); pos.setXY(x, y);
    const sb = new GP.Swimbot(); sb.setParent(DEATH_SINK);
    sb.create(0, age, pos, angle, energy, geno, oldEmb);

    const states = [], perTickCount = [];
    for (let t = 0; t < ticks; t++) {
        const before = count;
        sb.update();
        if (foodBit && sb.getIsLookingForSensoryInput()) sb.setEnvironmentalStimuli(0, [], foodBit.getAlive(), foodBit);
        if (sb.getIsTryingToEat()) sb.eatChosenFoodBit();
        perTickCount.push(count - before);
        states.push(snapshot(sb));
    }
    GP.globalTweakers.numFoodTypes = 1;
    return { states, perTickCount };
}

const DARWIN = presetGenes(0);
const WILSON = presetGenes(5);
const RANDO = seededGenes(12345);

// The scenarios mirror swimbot-fidelity's (body shapes x conditions). genes are base64'd in the fixture.
const SCENARIOS = [
    { name: 'mature-mate',    genes: DARWIN, age: 5000, x: 4000, y: 4000, angle: 30,  energy: 80,  ticks: 400, srcSeed: 11 },
    { name: 'mature-food',    genes: DARWIN, age: 5000, x: 4000, y: 4000, angle: 30,  energy: 40,  ticks: 400, srcSeed: 22 },
    { name: 'infant-growing', genes: WILSON, age: 500,  x: 4000, y: 4000, angle: 200, energy: 60,  ticks: 700, srcSeed: 33 },
    { name: 'left-wall',      genes: WILSON, age: 6000, x: 60,   y: 4000, angle: 90,  energy: 60,  ticks: 300, srcSeed: 44 },
    { name: 'corner',         genes: RANDO,  age: 6000, x: 7950, y: 60,   angle: 300, energy: 55,  ticks: 300, srcSeed: 55 },
    { name: 'starve-die',     genes: RANDO,  age: 8000, x: 4000, y: 4000, angle: 0,   energy: 0.3, ticks: 200, srcSeed: 66 },
];

const OUT = path.join(__dirname, '..', 'fixtures', 'swimbot-motion.json');
const scenarios = SCENARIOS.map((scn) => {
    const run = runOld(scn);
    return {
        name: scn.name,
        genes: Buffer.from(scn.genes).toString('base64'),
        age: scn.age, x: scn.x, y: scn.y, angle: scn.angle, energy: scn.energy,
        ticks: scn.ticks, srcSeed: scn.srcSeed, numFoodTypes: scn.numFoodTypes || 1, food: scn.food || null,
        perTickCount: run.perTickCount,
        states: run.states,
    };
});

const fixture = {
    _comment: 'JJ original-Swimbot motion goldens. Generated by test/helpers/gen-swimbot-motion-fixtures.cjs from JJ\'s unmodified sim. swimbot-motion-golden.test.js drives OUR Swimbot through the same scenarios and asserts it reproduces this frozen motion. Discrete fields + per-tick draw counts are compared EXACTLY (platform-independent); float fields with a tight tolerance (cross-platform trig last-bits). The live A/B in swimbot-fidelity.test.js is the bit-for-bit authority.',
    node: process.version,
    scenarios,
};
fs.writeFileSync(OUT, JSON.stringify(fixture));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB), ${scenarios.length} scenarios`);
for (const s of scenarios) console.log(`  ${s.name.padEnd(16)} ticks=${s.ticks} finalAlive=${s.states[s.states.length - 1].alive} draws=${s.perTickCount.reduce((a, b) => a + b, 0)}`);
