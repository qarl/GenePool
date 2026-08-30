'use strict';
// An EMPTY/degenerate obstacle is a genuine no-op (PLAN-restructure.md §8: "empty list is legal"). The engine
// always holds one Obstacle object; an unset or zero-length one must neither collide (movement) nor obstruct
// (line-of-sight), so a pool can run obstacle-free. Real obstacles are unaffected (the guard is length-gated).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Obstacle } = require('../../engine/obstacle.js');
const { Vector2D } = require('../../engine/vector2d.js');

const POOL = { left: 0, top: 0, right: 8000, bottom: 8000 };
const pt = (x, y) => { const v = new Vector2D(); v.setXY(x, y); return v; };

test('an UNSET obstacle never collides and never obstructs', () => {
    const ob = new Obstacle(); ob.setPoolBounds(POOL); // never setEndpointPositions -> length 0
    assert.equal(ob.getCollision({ x: 4000, y: 4000 }, 40), false, 'unset obstacle must not collide');
    assert.equal(ob.getObstruction(pt(3000, 4000), pt(5000, 4000)), false, 'unset obstacle must not obstruct');
});

test('a DEGENERATE (zero-length) obstacle never collides and never obstructs', () => {
    const ob = new Obstacle(); ob.setPoolBounds(POOL);
    ob.setEndpointPositions({ x: 500, y: 500 }, { x: 500, y: 500 }); // coincident endpoints
    assert.equal(ob.getCollision({ x: 500, y: 500 }, 40), false, 'degenerate obstacle must not collide even AT the point');
    assert.equal(ob.getObstruction(pt(400, 500), pt(600, 500)), false, 'degenerate obstacle must not obstruct');
});

test('a REAL obstacle still collides + obstructs (the no-op guard is length-gated, not global)', () => {
    const ob = new Obstacle(); ob.setPoolBounds(POOL);
    ob.setEndpointPositions({ x: 500, y: 400 }, { x: 500, y: 600 }); // a real vertical bar
    assert.equal(ob.getCollision({ x: 510, y: 500 }, 20), true, 'a bot next to a real bar must collide');
    assert.equal(ob.getObstruction(pt(400, 500), pt(600, 500)), true, 'a sightline through a real bar must be blocked');
});
