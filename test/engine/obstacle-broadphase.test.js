'use strict';
// §8 broad-phase gate: the ObstacleField spatial grid must be a PURE PERF SWITCH -- for MANY obstacles it must give
// byte-identical results to the linear scan, for both movement collision (boolean + accumulated force, incl. sign
// of zero) and vision line-of-sight (boolean). Fuzzed over random obstacle fields (varied thickness + masks) and
// thousands of random query points/radii/segments, plus deterministic edge cases (collinear, on-endpoint, big/tiny
// radius). This is the §4/P2 grid==brute discipline applied to obstacles.

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    const { ObstacleField } = await import('../../engine/obstacle-field.js');
    const { Vector2D } = await import('../../engine/vector2d.js');
    return { ObstacleField, Vector2D };
}
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const POOL = { left: 0, top: 0, right: 4000, bottom: 4000 };

// Linear reference (mirrors ObstacleField.getCollision's accumulate exactly: ascending index, first-hit copies).
function bruteCollision(obs, pos, r) {
    let hit = false, fx = 0, fy = 0;
    for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (!o.blocksMovement()) continue;
        if (o.getCollision(pos, r)) { const f = o.getCurrentCollisionForce(); if (!hit) { fx = f.x; fy = f.y; hit = true; } else { fx += f.x; fy += f.y; } }
    }
    return { hit, fx, fy };
}
function bruteObstruction(obs, p1, p2) {
    for (let i = 0; i < obs.length; i++) { const o = obs[i]; if (o.blocksVision() && o.getObstruction(p1, p2)) return true; }
    return false;
}

function randomField(ObstacleField, rng, n) {
    const specs = [];
    for (let i = 0; i < n; i++) {
        const ax = rng() * 4000, ay = rng() * 4000;
        // mostly short segments (like a real environment), some long
        const len = (rng() < 0.8) ? 40 + rng() * 400 : 400 + rng() * 2500;
        const ang = rng() * Math.PI * 2;
        const bx = ax + Math.cos(ang) * len, by = ay + Math.sin(ang) * len;
        const mask = { movement: rng() < 0.85, vision: rng() < 0.85 }; // some non-blocking on each axis
        specs.push({ a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 10 + rng() * 70, mask });
    }
    const f = new ObstacleField(); f.setPoolBounds(POOL); f.setObstacles(specs);
    return f;
}

test('broad-phase grid == linear scan for collision + obstruction (fuzzed, many obstacles)', async () => {
    const { ObstacleField, Vector2D } = await load();
    const rng = mulberry32(0xC0FFEE);
    let collisionsSeen = 0, obstructionsSeen = 0;
    for (let trial = 0; trial < 6; trial++) {
        const f = randomField(ObstacleField, rng, 60 + Math.floor(rng() * 80)); // > GRID_THRESHOLD -> grid active
        assert.ok(f._grid, 'grid must be active for this many obstacles (else the test is vacuous)');
        const obs = f.getObstacles();
        for (let q = 0; q < 1500; q++) {
            const pos = { x: rng() * 4200 - 100, y: rng() * 4200 - 100 }; // include just-outside-pool points
            const r = (rng() < 0.5) ? 5 + rng() * 40 : 40 + rng() * 400; // small and large (unbounded) radii
            const g = f.getCollision(pos, r);
            const gf = { x: f.getCurrentCollisionForce().x, y: f.getCurrentCollisionForce().y };
            const b = bruteCollision(obs, pos, r);
            assert.equal(g, b.hit, `collision boolean mismatch trial=${trial} q=${q}`);
            if (g) { collisionsSeen++; assert.equal(gf.x + 0, b.fx + 0, `force.x mismatch trial=${trial} q=${q}`); assert.equal(gf.y + 0, b.fy + 0, `force.y mismatch trial=${trial} q=${q}`); }

            const p1 = new Vector2D(pos.x, pos.y);
            const p2 = { x: pos.x + (rng() * 600 - 300), y: pos.y + (rng() * 600 - 300) };
            const go = f.getObstruction(p1, p2);
            const bo = bruteObstruction(obs, p1, p2);
            assert.equal(go, bo, `obstruction mismatch trial=${trial} q=${q}`);
            if (bo) obstructionsSeen++;
        }
    }
    assert.ok(collisionsSeen > 50, `the fuzz must actually produce collisions (got ${collisionsSeen})`);
    assert.ok(obstructionsSeen > 50, `the fuzz must actually produce obstructions (got ${obstructionsSeen})`);
});

test('broad-phase == linear for LARGE radii and a nonzero pool offset (rings + offset stress)', async () => {
    const { ObstacleField, Vector2D } = await load();
    const rng = mulberry32(0x5EED);
    const POOL2 = { left: -1000, top: -1000, right: 3000, bottom: 3000 }; // nonzero offset, 4000 wide
    // build directly against POOL2 so obstacles clamp/bucket relative to a nonzero origin
    const specs = [];
    for (let i = 0; i < 90; i++) {
        const ax = -1000 + rng() * 4000, ay = -1000 + rng() * 4000;
        const len = 40 + rng() * 900, ang = rng() * Math.PI * 2;
        specs.push({ a: { x: ax, y: ay }, b: { x: ax + Math.cos(ang) * len, y: ay + Math.sin(ang) * len }, thickness: 10 + rng() * 90 });
    }
    const f = new ObstacleField(); f.setPoolBounds(POOL2); f.setObstacles(specs);
    assert.ok(f._grid, 'grid active');
    const obs = f.getObstacles();
    let big = 0;
    for (let q = 0; q < 3000; q++) {
        const pos = { x: -1200 + rng() * 4400, y: -1200 + rng() * 4400 };
        // radii deep into the previously-unreachable regime (r >> the old ceil(r/cell)+1 budget)
        const r = (rng() < 0.5) ? 300 + rng() * 700 : 1000 + rng() * 2500;
        const g = f.getCollision(pos, r);
        const gf = { x: f.getCurrentCollisionForce().x, y: f.getCurrentCollisionForce().y };
        const b = bruteCollision(obs, pos, r);
        assert.equal(g, b.hit, `large-r collision boolean mismatch q=${q} r=${r.toFixed(0)}`);
        if (g) { big++; assert.ok(Object.is(gf.x, b.fx) && Object.is(gf.y, b.fy), `large-r force mismatch q=${q} r=${r.toFixed(0)}: grid(${gf.x},${gf.y}) linear(${b.fx},${b.fy})`); }
        const p1 = new Vector2D(pos.x, pos.y);
        const p2 = { x: pos.x + (rng() * 1000 - 500), y: pos.y + (rng() * 1000 - 500) };
        assert.equal(f.getObstruction(p1, p2), bruteObstruction(obs, p1, p2), `large-r obstruction mismatch q=${q}`);
    }
    assert.ok(big > 100, `large-r fuzz must produce collisions (got ${big})`);
});

test('broad-phase edge cases match the linear scan', async () => {
    const { ObstacleField, Vector2D } = await load();
    // a dense grid of parallel bars (>threshold), so points/segments land on cell boundaries and on endpoints
    const specs = [];
    for (let i = 0; i < 20; i++) specs.push({ a: { x: 200 * i + 100, y: 200 }, b: { x: 200 * i + 100, y: 3800 }, thickness: 15 + (i % 3) * 25 });
    const f = new ObstacleField(); f.setPoolBounds(POOL); f.setObstacles(specs);
    assert.ok(f._grid, 'grid active');
    const obs = f.getObstacles();
    const probes = [];
    for (let x = 50; x <= 4050; x += 37) for (let y = 150; y <= 3850; y += 311) probes.push({ x, y });
    for (const pos of probes) {
        for (const r of [0, 5, 15, 20, 100, 300]) {
            const g = f.getCollision(pos, r); const gf = { x: f.getCurrentCollisionForce().x, y: f.getCurrentCollisionForce().y };
            const b = bruteCollision(obs, pos, r);
            assert.equal(g, b.hit, `edge collision @(${pos.x},${pos.y}) r=${r}`);
            if (g) { assert.equal(gf.x + 0, b.fx + 0); assert.equal(gf.y + 0, b.fy + 0); }
        }
        const p1 = new Vector2D(pos.x, pos.y);
        for (const d of [[400, 0], [0, 400], [300, 300], [-500, 50]]) {
            const p2 = { x: pos.x + d[0], y: pos.y + d[1] };
            assert.equal(f.getObstruction(p1, p2), bruteObstruction(obs, p1, p2), `edge obstruction @(${pos.x},${pos.y})->(${p2.x},${p2.y})`);
        }
    }
});
