'use strict';
// Latent NaN guard + unit coverage for Obstacle (GenePool/simulation/Obstacle.js).
// calculateStuff() normalizes the endpoint axis via `_direction = _axis / _length`. Coincident /
// degenerate endpoints give _length = 0, so 0/0 = NaN poisons _direction and _perp (breaking
// collision detection), and -- via the "endpoints bumping into each other" block, which multiplies
// by _direction -- the endpoint positions themselves. Fix: fall back to a unit direction when
// _length is 0. (The endpoint-position corruption is the primary observable; the collision-force
// assertion below is a regression guard on the _perp path.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/boot');

const GP = loadSim();
const vec = (x, y) => { const v = new GP.Vector2D(); v.setXY(x, y); return v; };
const finite2 = (p) => Number.isFinite(p.x) && Number.isFinite(p.y);

test('Obstacle: coincident endpoints do not produce NaN endpoints or collision force', () => {
    const o = new GP.Obstacle();
    o.setEndpointPositions(vec(100, 100), vec(100, 100)); // degenerate: zero-length

    assert.ok(finite2(o.getEnd1Position()), `end1 must stay finite, got ${JSON.stringify(o.getEnd1Position())}`);
    assert.ok(finite2(o.getEnd2Position()), `end2 must stay finite, got ${JSON.stringify(o.getEnd2Position())}`);

    // regression guard on the _perp/collision path: with the fix a probe near the degenerate
    // obstacle yields a finite force (pre-fix, a NaN _perp silently short-circuited detection)
    o.getCollision(vec(105, 100), 10);
    assert.ok(finite2(o.getCurrentCollisionForce()),
        `collision force must be finite, got ${JSON.stringify(o.getCurrentCollisionForce())}`);
});

test('Obstacle: a normal (non-degenerate) obstacle still yields finite endpoints + collision force', () => {
    const o = new GP.Obstacle();
    o.setEndpointPositions(vec(100, 100), vec(300, 100)); // horizontal segment
    assert.ok(finite2(o.getEnd1Position()) && finite2(o.getEnd2Position()));
    o.getCollision(vec(200, 105), 10); // just above the segment midpoint
    assert.ok(finite2(o.getCurrentCollisionForce()));
});
