'use strict';
// Rung 3a of P1a: the engine/ Obstacle reproduces JJ's Obstacle bit-for-bit (PLAN-restructure.md §19).
// RNG-free geometry, so a direct old-vs-new comparison across many endpoint configs + probe points:
//   - getCollision (movement bounce) -- boolean AND the resulting collision-force vector,
//   - getObstruction (line-of-sight / access blocking) -- the segment-crossing boolean.
// Covers the golden's obstacle (40,40)-(80,40), a near-wall config (endpoint clamping), and a short
// segment (the length<2*END_RADIUS endpoint-separation branch).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/load-sim');
const { Obstacle } = require('../../engine/obstacle.js');
const { Vector2D } = require('../../engine/vector2d.js');

const GP = loadSim();

function mkOld(e1, e2) {
    const o = new GP.Obstacle();
    const a = new GP.Vector2D(); a.setXY(e1[0], e1[1]);
    const b = new GP.Vector2D(); b.setXY(e2[0], e2[1]);
    o.setEndpointPositions(a, b);
    return o;
}
function mkNew(e1, e2) {
    const o = new Obstacle();
    o.setEndpointPositions({ x: e1[0], y: e1[1] }, { x: e2[0], y: e2[1] });
    return o;
}

const CONFIGS = [
    { name: 'golden', e1: [40, 40], e2: [80, 40] },      // the golden's obstacle (length 40 = minLength, no shift)
    { name: 'mid-pool', e1: [3000, 4000], e2: [5000, 4200] },
    { name: 'short', e1: [4000, 4000], e2: [4010, 4005] }, // length < 2*END_RADIUS -> endpoint-separation branch
    { name: 'near-wall', e1: [5, 5], e2: [30, 100] },      // endpoint clamping to walls
    { name: 'vertical', e1: [2000, 1000], e2: [2000, 3000] },
];

// a spread of probe points + radii around each obstacle
const PROBE_POINTS = [];
for (let gx = 0; gx <= 8000; gx += 800) {
    for (let gy = 0; gy <= 8000; gy += 800) PROBE_POINTS.push([gx + 37, gy + 61]);
}
const RADII = [0, 5, 15, 20, 40, 100];

test('rung3a: Obstacle.getCollision matches JJ (boolean + collision force) across configs/points/radii', () => {
    let totalHits = 0;
    for (const cfg of CONFIGS) {
        const oldO = mkOld(cfg.e1, cfg.e2);
        const newO = mkNew(cfg.e1, cfg.e2);
        // endpoints must agree after calculateStuff (shift + wall clamp)
        assert.deepEqual(
            { x: newO.getEnd1Position().x, y: newO.getEnd1Position().y },
            { x: oldO.getEnd1Position().x, y: oldO.getEnd1Position().y }, `${cfg.name}: end1 drift`);
        assert.deepEqual(
            { x: newO.getEnd2Position().x, y: newO.getEnd2Position().y },
            { x: oldO.getEnd2Position().x, y: oldO.getEnd2Position().y }, `${cfg.name}: end2 drift`);

        for (const [px, py] of PROBE_POINTS) {
            for (const r of RADII) {
                const oldPos = new GP.Vector2D(); oldPos.setXY(px, py);
                const oldHit = oldO.getCollision(oldPos, r);
                const oldF = oldO.getCurrentCollisionForce();
                const newHit = newO.getCollision({ x: px, y: py }, r);
                const newF = newO.getCurrentCollisionForce();
                assert.equal(newHit, oldHit, `${cfg.name}: getCollision boolean drift at (${px},${py}) r=${r}`);
                if (oldHit) {
                    totalHits++;
                    assert.deepEqual({ x: newF.x, y: newF.y }, { x: oldF.x, y: oldF.y },
                        `${cfg.name}: collision force drift at (${px},${py}) r=${r}`);
                }
            }
        }
    }
    assert.ok(totalHits > 0, 'the probe set must produce real collisions (else the force check is vacuous)');
});

test('rung3a: Obstacle.getObstruction matches JJ (segment crossing) across configs/point-pairs', () => {
    // Pairs chosen to straddle / miss each obstacle.
    const PAIRS = [];
    for (let i = 0; i < PROBE_POINTS.length; i++) {
        const a = PROBE_POINTS[i];
        const b = PROBE_POINTS[(i * 7 + 3) % PROBE_POINTS.length];
        PAIRS.push([a, b]);
    }
    // plus pairs deliberately crossing the golden obstacle
    PAIRS.push([[60, 0], [60, 200]]);   // vertical line through (60,40)
    PAIRS.push([[0, 40], [200, 40]]);    // collinear-ish
    PAIRS.push([[50, 30], [70, 50]]);    // diagonal across

    for (const cfg of CONFIGS) {
        const oldO = mkOld(cfg.e1, cfg.e2);
        const newO = mkNew(cfg.e1, cfg.e2);
        let crossings = 0;
        for (const [a, b] of PAIRS) {
            const oa = new GP.Vector2D(); oa.setXY(a[0], a[1]);
            const ob = new GP.Vector2D(); ob.setXY(b[0], b[1]);
            const oldR = oldO.getObstruction(oa, ob);
            const na = new Vector2D(a[0], a[1]);
            const nb = new Vector2D(b[0], b[1]);
            const newR = newO.getObstruction(na, nb);
            assert.equal(newR, oldR, `${cfg.name}: getObstruction drift for (${a})->(${b})`);
            if (oldR) crossings++;
        }
        if (cfg.name === 'golden') {
            assert.ok(crossings > 0, 'the golden-obstacle pairs must include at least one real crossing');
        }
    }
});
