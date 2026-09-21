'use strict';
// Import = MERGE: the imported pool's creatures + food are added INTO the current world with fresh ids (loadSwimbot/
// loadFood), then the timeline branches at the playhead (commitImport writes the merged frame). New = an EMPTY world
// (no init) you compose by merging into. These prove: an empty world round-trips; a merge combines both populations
// with unique ids; and the merged pool forward-sims DETERMINISTICALLY (the branch keyframe is reproducible).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = async () => ({ ...(await import('../../engine/world.js')), ...(await import('../../engine/pool-seed.mjs')) });

test('empty World (New timeline): 0 entities, serialize/restore round-trips', async () => {
  const { World, poolConfig, POOL_DEFAULTS } = await load();
  const cfg = poolConfig(POOL_DEFAULTS.pool, {});
  const w = new World(cfg, 0);
  assert.equal(w.getLivingSwimbotCount(), 0, 'no founders');
  const snap = w.serialize();
  assert.equal(snap.swimbots.length, 0, 'no swimbots'); assert.equal(snap.food.length, 0, 'no food');
  const w2 = World.restore(cfg, snap);
  assert.equal(JSON.stringify(w2.serialize()), JSON.stringify(snap), 'empty world round-trips byte-for-byte');
});

test('merge import: creatures + food combined with unique ids, deterministic forward-sim', async () => {
  const { World, makeStandardWorld, poolConfig, POOL_DEFAULTS } = await load();
  const cfg = poolConfig(POOL_DEFAULTS.pool, {});
  const A = makeStandardWorld(1, { config: cfg }).world;
  const B = makeStandardWorld(2, { config: cfg }).world;
  for (let i = 0; i < 300; i++){ A.tick(); B.tick(); }

  const nA = A.dumpSwimbots().length, nB = B.dumpSwimbots().length;
  const fA = A.serialize().food.length, fB = B.serialize().food.length;

  // merge B into A -- exactly what the renderer does on Import
  for (const s of B.dumpSwimbots())
    A.loadSwimbot(A.getNextSwimbotId(), { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: s.genes, numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
  for (const f of B.serialize().food)
    A.loadFood(A.getNextFoodId(), { x: f.x, y: f.y, type: f.type, energy: f.energy });

  const merged = A.serialize();
  assert.equal(merged.swimbots.length, nA + nB, 'merged population = A + B');
  assert.equal(merged.food.length, fA + fB, 'merged food = A + B');
  const ids = merged.swimbots.map((s) => s.index);
  assert.equal(new Set(ids).size, ids.length, 'all swimbot ids unique after merge (no collision)');

  const forward = () => { const w = World.restore(cfg, merged); for (let i = 0; i < 500; i++) w.tick(); return JSON.stringify(w.serialize()); };
  assert.equal(forward(), forward(), 'merged pool forward-sims deterministically (byte-identical)');
});
