'use strict';
// Unit tests for Vector2D (GenePool/simulation/Vector2D.js) -- the pure 2D math that underlies all
// swimbot physics, sensing, and geometry. Deterministic, no RNG. Values are hand-computed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/boot');

const GP = loadSim();
const V = () => new GP.Vector2D();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !~= ${b}`);

test('Vector2D: construct/setXY/set/copyFrom/addXY', () => {
    const a = V();
    assert.equal(a.x, 0); assert.equal(a.y, 0);
    a.setXY(3, -4);
    assert.equal(a.x, 3); assert.equal(a.y, -4);

    const b = V();
    b.set(a);
    assert.equal(b.x, 3); assert.equal(b.y, -4);

    const c = V();
    c.copyFrom({ x: 1, y: 2 });
    assert.equal(c.x, 1); assert.equal(c.y, 2);
    c.addXY(10, 20);
    assert.equal(c.x, 11); assert.equal(c.y, 22);
});

test('Vector2D: setToDifference', () => {
    // NB: setToSum and setToAverage are commented out in Vector2D.js (dead API) -- only
    // setToDifference is live, so only it is tested here.
    const a = V(); a.setXY(1, 2);
    const b = V(); b.setXY(4, 8);
    const d = V(); d.setToDifference(a, b);
    assert.equal(d.x, -3); assert.equal(d.y, -6);
});

test('Vector2D: add/subtract/scale/addScaled/subtractScaled', () => {
    const a = V(); a.setXY(2, 3);
    const b = V(); b.setXY(1, 1);
    a.add(b); assert.equal(a.x, 3); assert.equal(a.y, 4);
    a.subtract(b); assert.equal(a.x, 2); assert.equal(a.y, 3);
    a.scale(2); assert.equal(a.x, 4); assert.equal(a.y, 6);
    a.addScaled(b, 3); assert.equal(a.x, 7); assert.equal(a.y, 9);
    a.subtractScaled(b, 5); assert.equal(a.x, 2); assert.equal(a.y, 4);
});

test('Vector2D: magnitude/magnitudeSquared/dot/distance', () => {
    const a = V(); a.setXY(3, 4);
    assert.equal(a.getMagnitudeSquared(), 25);
    near(a.getMagnitude(), 5, 'magnitude 3,4');
    const b = V(); b.setXY(2, 1);
    assert.equal(a.dotWith(b), 3 * 2 + 4 * 1); // 10
    const p = V(); p.setXY(0, 0);
    assert.equal(a.getDistanceSquaredTo(p), 25);
    near(a.getDistanceTo(p), 5, 'distance 3,4 to origin');
});

test('Vector2D: clear/scale-by-zero', () => {
    const a = V(); a.setXY(7, -9);
    a.clear(); assert.equal(a.x, 0); assert.equal(a.y, 0);
    const b = V(); b.setXY(5, 5); b.scale(0);
    assert.equal(b.x, 0); assert.equal(b.y, 0);
});

test('Vector2D: setToPerpendicular rotates 90 degrees (dot == 0, magnitude preserved)', () => {
    const a = V(); a.setXY(3, 4);
    const orig = V(); orig.set(a);
    a.setToPerpendicular(); // (x,y) -> (y,-x)
    assert.equal(a.x, 4); assert.equal(a.y, -3);
    assert.equal(orig.dotWith(a), 0); // perpendicular
    near(a.getMagnitude(), orig.getMagnitude(), 'perp preserves length');
});

test('Vector2D: normalize produces a unit vector', () => {
    const a = V(); a.setXY(3, 4);
    a.normalize();
    near(a.x, 0.6, 'normalized x'); near(a.y, 0.8, 'normalized y');
    near(a.getMagnitude(), 1, 'unit length');
});

test('Vector2D: normalize of the zero vector is guarded to (1,0), not NaN', () => {
    const z = V(); // (0,0)
    z.normalize();
    assert.ok(Number.isFinite(z.x) && Number.isFinite(z.y), 'must not be NaN');
    assert.equal(z.x, 1); assert.equal(z.y, 0);
});

// getSegmentsCrossing(a0,a1,b0,b1) -> true iff segment a properly crosses segment b. It's the one
// live segment-geometry method (getClosestPointOnLineSegment / getDistanceToLineSegment are commented
// out in the source) and it backs Obstacle.getObstruction (line-of-sight / access blocking).
const P = (x, y) => { const v = V(); v.setXY(x, y); return v; };
const crosses = (a0, a1, b0, b1) => V().getSegmentsCrossing(a0, a1, b0, b1);

test('Vector2D.getSegmentsCrossing: an X of two segments crosses', () => {
    assert.equal(crosses(P(0, 0), P(10, 10), P(0, 10), P(10, 0)), true);
});

test('Vector2D.getSegmentsCrossing: parallel segments do not cross', () => {
    assert.equal(crosses(P(0, 0), P(10, 0), P(0, 5), P(10, 5)), false);
});

test('Vector2D.getSegmentsCrossing: disjoint off-axis segments do not cross', () => {
    // non-parallel, non-collinear, and nowhere near each other
    assert.equal(crosses(P(0, 0), P(1, 1), P(3, 0), P(4, 0)), false);
});

test('Vector2D.getSegmentsCrossing: segments cross only where they overlap, not on extensions', () => {
    // a is a short horizontal stub near the origin; b is a vertical line at x=5 -- their infinite
    // lines would meet at (5,0), but segment a stops at x=1, so they do not actually cross.
    assert.equal(crosses(P(0, 0), P(1, 0), P(5, -5), P(5, 5)), false);
    // move a so it reaches x=5 -> now they cross
    assert.equal(crosses(P(0, 0), P(10, 0), P(5, -5), P(5, 5)), true);
});
