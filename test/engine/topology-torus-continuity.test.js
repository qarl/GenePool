'use strict';
// P4b rigid-shift TEETH (white-box). §7:102: wrapping a body across a torus seam must shift its WHOLE carried
// history by the same delta, or per-part velocity (midPosition - previousMid) spikes by ~pool-width on the
// crossing tick. The behavioral tests can't see this (geometry self-heals in ~1 tick), so assert it DIRECTLY:
// drive a torus world, and across every seam crossing the max per-part velocity must stay near its normal
// stroke magnitude (~hundreds), NOT jump toward pool-width (~thousands). A broken shift separates by ~10x+.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const NUM_GENES = 256, USED = 112, POOL = 4000, NF = 150, NFOOD = 450, TICKS = 2000;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('rigid seam-wrap keeps per-part velocity continuous (no ~pool-width spike on a crossing)', () => {
    const config = {
        maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
        crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
        foodBitEnergy: 50, attractionCriterion: 10, topology: 'torus',
        pool: { left: 0, top: 0, right: POOL, bottom: POOL },
    };
    const world = new World(config, 1, {});
    const rng = mulberry32(1 ^ 0x5eed1234);
    for (let i = 0; i < NF; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        world.loadSwimbot(i, { age: Math.floor(rng() * 40000), x: rng() * POOL, y: rng() * POOL, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < NFOOD; i++) world.loadFood(i, { x: rng() * POOL, y: rng() * POOL, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });

    // Measure ESTABLISHED bots only (age>50): a newborn's parts snap into place on tick 0, a large birth
    // transient that exists on walls too and has nothing to do with seam continuity. Established bots still
    // cross seams plenty (verified ~40 crossings/run), and a broken rigid shift spikes THEM at the crossing.
    const prevPos = new Map();          // id -> {x,y} last tick (to detect a wrap = a big _position jump)
    let crossings = 0, maxPartVel = 0;  // established-bot seam crossings + max established-bot part velocity
    const HALF = POOL / 2;
    for (let t = 0; t < TICKS; t++) {
        world.tick();
        for (const sb of world._swimbots.values()) {
            if (!sb.getAlive()) continue;
            const id = sb.getIndex();
            const p = sb.getPosition();
            const prev = prevPos.get(id);
            const crossed = prev && (Math.abs(p.x - prev.x) > HALF || Math.abs(p.y - prev.y) > HALF);
            prevPos.set(id, { x: p.x, y: p.y });
            if (sb.getAge() <= 50) continue; // skip the birth/init transient (unrelated to wrapping)
            if (crossed) crossings++;
            const parts = sb._phenotype.parts;
            for (let q = 1; q < sb._phenotype.numParts; q++) {
                const v = Math.hypot(parts[q].velocity.x, parts[q].velocity.y);
                if (v > maxPartVel) maxPartVel = v;
            }
        }
    }

    // Non-vacuous: established bots actually crossed seams, so the wrap path was exercised by the bots we measure.
    assert.ok(crossings > 0, `expected established-bot seam crossings to exercise the wrap (got ${crossings})`);
    // Teeth: a correct rigid shift keeps established stroke velocity ~127 (measured); a broken shift (a missed
    // carried-history field) spikes it toward POOL (~4000) at each crossing. 800 is ~6x over normal, ~5x under
    // a broken spike -> tight but non-flaky.
    assert.ok(maxPartVel < 800, `established-bot per-part velocity spiked to ${Math.round(maxPartVel)} across ${crossings} crossings -> rigid seam-shift is INCOMPLETE (a carried-history field isn't being shifted)`);
});
