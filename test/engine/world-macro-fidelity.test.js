'use strict';
// MACRO-FIDELITY GUARDRAIL: the CURRENT engine (main; P1b+, which deliberately diverges from JJ bit-for-bit
// -- never-reused ids, addressed RNG, closest-20, T+1 births) must still track JJ's ORIGINAL simulation at
// the WHOLE-POOL ecosystem level, from the same seed-42 pool, over 10,000 ticks.
//
// This is NOT a bit-for-bit test (impossible post-P1b; the P1a foundation's bit-for-bit match to JJ is
// proven separately at commit 1c5ee87 -- see gen-jj-macro-fixture.cjs header / build notes). It's a
// "didn't wildly drift" check that catches a future change which BREAKS behavior (e.g. a refactor that
// kills mating -> births crash -> population collapses), which would blow far past the bands below.
//
// JJ's run is FROZEN in test/fixtures/jj-macro-seed42.json (generated once by gen-jj-macro-fixture.cjs), so
// this test NEVER executes JJ's slow sim -- it runs only the current engine and compares to the fixture.
//
// TWO signals, because the runs drift with the butterfly effect over a long horizon:
//   1. EARLY POINT-IN-TIME (t=500/1000/2000): the runs share a start, so they stay tight (~1%) before RNG
//      divergence sets in -- fast, sensitive detection of immediate breakage. Bands: pop/food +/-10%,
//      eaten +/-25% (eaten is a smaller, noisier integer).
//   2. TIME-AVERAGED over 10,000 ticks: point-in-time at 10k is PHASE-sensitive (each engine runs its own
//      boom-bust cycle; out of phase -> ~10% instantaneous gap), but the time-average is phase-INsensitive
//      and stays ~5% across seeds. Band: +/-15% (~3x the measured intended divergence).
// Measured intended divergence (same pool, seed 42): early points ~1%, 10k time-avg pop +5% / food -4%.
// The bands are several x that -- loose enough never to flag the deliberate P1b divergence or a benign
// refactor, tight enough to catch real behavioral breakage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World } = require('../../engine/world.js');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'jj-macro-seed42.json'), 'utf8'));
// Per-metric bands + the minimum JJ count at which a metric is worth comparing (small integers are too noisy
// -- offspring is 4 at t=500, so a 1-off swing is 25%). The TEETH are the behavioral counters: `eaten` (a
// foraging break sends it toward 0, far below JJ) and `offspring` (a mating break sends it to 0 vs JJ's 94).
// Population is a weak signal at 10k -- long-lived founders (lifespan 40000) mask reproduction/food breakage
// over this horizon -- so pop/food are kept only as coarse ballpark backstops, not the primary guard.
const METRICS = {
    pop:       { tol: 0.10, minBase: 0 },
    food:      { tol: 0.10, minBase: 0 },
    eaten:     { tol: 0.25, minBase: 20 },   // foraging teeth
    offspring: { tol: 0.40, minBase: 50 },   // mating teeth (noisy while small; only clean by t=2000, JJ=94)
};
const AVG_TOL = 0.15;

function buildCurrentEngine() {
    const world = new World(FIX.config, FIX.seed); // masterSeed = the fixture seed
    for (const s of FIX.init.swimbots) {
        world.loadSwimbot(s.id, {
            age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy,
            genes: Array.from(Buffer.from(s.genes, 'base64')), // base64 -> byte array
            numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten,
        });
    }
    for (const f of FIX.init.food) world.loadFood(f.id, { x: f.x, y: f.y, type: f.type, energy: FIX.config.foodBitEnergy });
    world.setObstacle({ x: FIX.obstacle[0], y: FIX.obstacle[1] }, { x: FIX.obstacle[2], y: FIX.obstacle[3] });
    return world;
}

function rel(base, val) { return base === 0 ? Math.abs(val) : Math.abs(val - base) / base; }

test('macro-fidelity: current engine tracks JJ over 10k ticks (early points + time-avg) within tolerance', () => {
    const world = buildCurrentEngine();
    const maxTick = FIX.maxTick;
    const pointSet = new Set(FIX.pointCheckpoints);
    const initialCount = FIX.init.swimbots.length;

    let popSum = 0, foodSum = 0;
    for (let t = 1; t <= maxTick; t++) {
        world.tick();
        const pop = world.getLivingSwimbotCount();
        const food = world.getLivingFoodCount();
        popSum += pop;
        foodSum += food;

        if (pointSet.has(t)) {
            const jj = FIX.points[String(t)];
            const bots = world.dumpSwimbots();
            const mine = {
                pop, food,
                eaten: bots.reduce((a, b) => a + b.numFoodBitsEaten, 0),
                offspring: bots.reduce((a, b) => a + b.numOffspring, 0),
            };
            for (const [key, { tol, minBase }] of Object.entries(METRICS)) {
                if (jj[key] < minBase) continue; // too small to compare meaningfully at this checkpoint
                const r = rel(jj[key], mine[key]);
                assert.ok(r <= tol,
                    `tick ${t} ${key}: JJ=${jj[key]} current=${mine[key]} (off ${(r * 100).toFixed(1)}%, band ${tol * 100}%)`);
            }
        }
    }

    // Long-horizon phase-insensitive signal: time-averaged population and live food over the whole run.
    const avgPop = popSum / maxTick, avgFood = foodSum / maxTick;
    const rPop = rel(FIX.avgPop, avgPop), rFood = rel(FIX.avgFood, avgFood);
    assert.ok(rPop <= AVG_TOL, `avg pop over ${maxTick}: JJ=${FIX.avgPop.toFixed(1)} current=${avgPop.toFixed(1)} (off ${(rPop * 100).toFixed(1)}%, band ${AVG_TOL * 100}%)`);
    assert.ok(rFood <= AVG_TOL, `avg food over ${maxTick}: JJ=${FIX.avgFood.toFixed(1)} current=${avgFood.toFixed(1)} (off ${(rFood * 100).toFixed(1)}%, band ${AVG_TOL * 100}%)`);

    // Sanity: a LIVING, REPRODUCING ecosystem, not a trivially-passing corpse.
    assert.ok(world.getLivingSwimbotCount() > 0, 'current engine went extinct -- macro comparison is meaningless');
    assert.ok(world.getNextSwimbotId() > initialCount, 'no births occurred -- mating path may be broken');
    assert.ok(world.getNumDeadSwimbots() > 0, 'no deaths occurred -- death/sweep path may be broken');
});
