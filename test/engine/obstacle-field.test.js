'use strict';
// §8 — the physical environment is a per-pool FIELD of masked obstacles (obstacle-field.js). These prove the NEW
// capabilities the single-Obstacle path didn't have: an EMPTY field is inert (no engine-forced obstacle), MULTIPLE
// obstacles accumulate movement force + OR line-of-sight, per-obstacle MASK selects movement vs vision, per-obstacle
// THICKNESS changes collision reach, and building via `config.obstacles` yields the same field as setObstacle.

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    const { ObstacleField } = await import('../../engine/obstacle-field.js');
    const { Obstacle } = await import('../../engine/obstacle.js');
    const { Vector2D } = await import('../../engine/vector2d.js');
    return { ObstacleField, Obstacle, Vector2D };
}

const POOL = { left: 0, top: 0, right: 8000, bottom: 8000 };
const seg = (ax, ay, bx, by, extra = {}) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, ...extra });
// getObstruction delegates to p1.getSegmentsCrossing, so p1 must be a Vector2D (perception passes body-part vectors).
const vec = (V, x, y) => { const v = new V(); v.set({ x, y }); return v; };

test('empty field is inert — no engine-forced obstacle (§8)', async () => {
    const { ObstacleField, Vector2D } = await load();
    const f = new ObstacleField();
    f.setPoolBounds(POOL);
    f.setObstacles([]);
    assert.equal(f.length, 0);
    assert.equal(f.getCollision({ x: 4000, y: 4000 }, 20), false);
    assert.equal(f.getObstruction(vec(Vector2D, 0, 0), { x: 8000, y: 8000 }), false);
    assert.equal(new ObstacleField().getCollision({ x: 1, y: 1 }, 20), false); // absent list is also legal
});

test('two obstacles ACCUMULATE collision force (sum of the individuals)', async () => {
    const { ObstacleField, Obstacle } = await load();
    const specs = [seg(3900, 4000, 4100, 4000), seg(3900, 4000, 4100, 4000)]; // identical -> a point collides with both
    const field = new ObstacleField(); field.setPoolBounds(POOL); field.setObstacles(specs);
    const one = new Obstacle(); one.setPoolBounds(POOL); one.setEndpointPositions(specs[0].a, specs[0].b);

    const p = { x: 4000, y: 4010 };
    assert.equal(one.getCollision(p, 20), true);
    const f1 = { x: one.getCurrentCollisionForce().x, y: one.getCurrentCollisionForce().y };
    assert.ok(Math.abs(f1.x) + Math.abs(f1.y) > 0, 'single obstacle should push');
    assert.equal(field.getCollision(p, 20), true);
    const ff = field.getCurrentCollisionForce();
    assert.equal(ff.x + 0, f1.x * 2 + 0); // exact: 0 + f + f  (+0 normalizes signed zero for Object.is-strict equal)
    assert.equal(ff.y + 0, f1.y * 2 + 0);
});

test('line-of-sight is obstructed if ANY vision obstacle blocks', async () => {
    const { ObstacleField, Vector2D } = await load();
    const field = new ObstacleField(); field.setPoolBounds(POOL);
    field.setObstacles([seg(4000, 3000, 4000, 5000), seg(1000, 1000, 1000, 1200)]); // a tall wall + a short one elsewhere
    assert.equal(field.getObstruction(vec(Vector2D, 3800, 4000), { x: 4200, y: 4000 }), true);  // crosses the wall
    assert.equal(field.getObstruction(vec(Vector2D, 5000, 4000), { x: 6000, y: 4000 }), false); // misses both
});

test('mask selects movement vs vision independently', async () => {
    const { ObstacleField, Vector2D } = await load();
    const wall = (mask) => { const f = new ObstacleField(); f.setPoolBounds(POOL); f.setObstacles([seg(4000, 3000, 4000, 5000, { mask })]); return f; };
    const p = { x: 4000, y: 4000 };

    const visionOnly = wall({ movement: false, vision: true });
    assert.equal(visionOnly.getCollision(p, 20), false, 'movement:false -> no collision');
    assert.equal(visionOnly.getObstruction(vec(Vector2D, 3800, 4000), { x: 4200, y: 4000 }), true, 'vision:true -> blocks sight');

    const moveOnly = wall({ movement: true, vision: false });
    assert.equal(moveOnly.getCollision(p, 20), true, 'movement:true -> collides');
    assert.equal(moveOnly.getObstruction(vec(Vector2D, 3800, 4000), { x: 4200, y: 4000 }), false, 'vision:false -> sight passes');
});

test('per-obstacle thickness changes collision reach', async () => {
    const { Obstacle } = await load();
    const mk = (th) => { const o = new Obstacle(th); o.setPoolBounds(POOL); o.setEndpointPositions({ x: 3900, y: 4000 }, { x: 4100, y: 4000 }); return o; };
    const p = { x: 4000, y: 4040 }; // 40 above the segment; tester radius 5
    assert.equal(mk(20).getCollision(p, 5), false); // half-width 20 doesn't reach 40
    assert.equal(mk(60).getCollision(p, 5), true);  // half-width 60 does
});

test('config.obstacles builds the same field as setObstacle', async () => {
    const { World } = await import('../../engine/world.js');
    const cfg = { poolSize: 8000, pool: POOL, numFoodTypes: 1, crossoverRate: 0.2, mutationRate: 0.01 };
    const a = { x: 40, y: 40 }, b = { x: 80, y: 40 };
    const viaConfig = new World({ ...cfg, obstacles: [{ a, b }] }, 7);
    const viaSetter = new World({ ...cfg }, 7); viaSetter.setObstacle(a, b);
    assert.deepEqual(viaConfig._obstacleField.toSpecs(), viaSetter._obstacleField.toSpecs());
    // and a config with no obstacles is an empty field
    assert.equal(new World({ ...cfg }, 7)._obstacleField.length, 0);
});
