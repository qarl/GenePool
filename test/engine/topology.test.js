'use strict';
// Topology abstraction (PLAN-restructure.md §7): FLAT (walls, plain subtraction) and TORUS (edges wrap,
// per-axis minimum-image displacement + mod wrap). These unit-test the geometry directly; the engine-level
// behavior (movement wrap, seam-crossing continuity, grid edge-wrap) is P4b+.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FLAT, FlatTopology, TorusTopology, makeTopology } = require('../../engine/topology.js');

const out = { x: 0, y: 0 };

test('FLAT: displacement is b-a, distance is plain hypot', () => {
    assert.deepEqual(FLAT.displacement(10, 20, 13, 24, out), { x: 3, y: 4 });
    assert.equal(FLAT.distance(10, 20, 13, 24), 5);
    assert.equal(FLAT.distanceSquared(10, 20, 13, 24), 25);
    assert.equal(FLAT.isToroidal(), false);
    // flat wrap is identity
    assert.deepEqual(FLAT.wrap(99999, -5, out), { x: 99999, y: -5 });
});

test('TORUS displacement: minimum image picks the SHORT way across a seam', () => {
    const t = new TorusTopology({ left: 0, top: 0, right: 1000, bottom: 1000 });
    // a near the right edge, b near the left edge: the short path is 20 to the LEFT (across the seam), not 980 right
    t.displacement(990, 500, 10, 500, out);
    assert.equal(out.x, -980 + 1000, 'x should min-image to +20 (wrap), not -980'); // 10-990 = -980; -980 - 1000*round(-0.98)= -980+1000 = 20
    assert.equal(out.y, 0);
    assert.equal(t.distance(990, 500, 10, 500), 20, 'wrapped distance is 20, not 980');
    // interior points: no wrap, identical to flat
    t.displacement(100, 100, 130, 140, out);
    assert.deepEqual(out, { x: 30, y: 40 });
    assert.equal(t.distance(100, 100, 130, 140), 50);
    assert.equal(t.isToroidal(), true);
});

test('TORUS distance is symmetric and distanceSquared == distance^2', () => {
    const t = new TorusTopology({ left: 0, top: 0, right: 800, bottom: 600 });
    const pairs = [[10, 10, 790, 590], [400, 300, 401, 301], [0, 0, 799, 599], [750, 50, 40, 560]];
    for (const [ax, ay, bx, by] of pairs) {
        assert.equal(t.distance(ax, ay, bx, by), t.distance(bx, by, ax, ay), 'distance must be symmetric');
        const d = t.distance(ax, ay, bx, by);
        assert.ok(Math.abs(t.distanceSquared(ax, ay, bx, by) - d * d) < 1e-9, 'distanceSquared == distance^2');
        // wrapped distance never exceeds the half-diagonal of the pool
        assert.ok(d <= Math.hypot(400, 300) + 1e-9, 'no wrapped distance exceeds the half-diagonal');
    }
});

test('TORUS wrap: folds any position back into the pool rectangle (handles negatives)', () => {
    const t = new TorusTopology({ left: 0, top: 0, right: 1000, bottom: 1000 });
    assert.deepEqual(t.wrap(1010, 500, out), { x: 10, y: 500 });
    assert.deepEqual(t.wrap(-5, 500, out), { x: 995, y: 500 });
    assert.deepEqual(t.wrap(500, 2500, out), { x: 500, y: 500 }); // multiple wraps
    assert.deepEqual(t.wrap(500, 500, out), { x: 500, y: 500 });  // in-bounds unchanged
    // non-zero origin
    const t2 = new TorusTopology({ left: 100, top: 200, right: 1100, bottom: 1200 });
    assert.deepEqual(t2.wrap(1105, 205, out), { x: 105, y: 205 }); // 1105 -> 100 + ((1005)%1000) = 105
    assert.deepEqual(t2.wrap(95, 205, out), { x: 1095, y: 205 });  // 95 -> 100 + ((-5)%1000+1000)%1000 = 1095
});

test('makeTopology: walls->FLAT, torus->TorusTopology over config.pool', () => {
    assert.equal(makeTopology({}), FLAT);
    assert.equal(makeTopology({ topology: 'walls' }), FLAT);
    assert.equal(makeTopology(undefined), FLAT);
    const t = makeTopology({ topology: 'torus', pool: { left: 0, top: 0, right: 500, bottom: 500 } });
    assert.ok(t instanceof TorusTopology);
    assert.equal(t.getWidth(), 500);
    assert.equal(t.getHeight(), 500);
    // torus with no pool -> resolvePoolBounds default (JJ 8000x8000)
    const td = makeTopology({ topology: 'torus' });
    assert.equal(td.getWidth(), 8000);
});
