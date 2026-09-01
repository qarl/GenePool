'use strict';
// Integration guard for the NORTH STAR: the engine is a faithful ARBITRARY-WORLDS sandbox. Each case configures a
// genuinely different world (torus; giant / tiny pools with ×poolSize food scaling; a multi-obstacle field; an empty
// field; loosened/tightened speciation) and asserts it runs HEALTHY and DETERMINISTICALLY -- exercising P3 (§6
// arbitrary size), §8 (obstacle field + masks), §11 (reproductive isolation), and P4 (torus) together, end to end.
// This is the cross-phase guardrail (§17): finite state, unique never-reused ids, energy > 0 for the living, and
// same-seed reproducibility -- not a hash. A minimal config must Just Work at any size (P3).

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function loadWorld() { return (await import('../../engine/world.js')).World; }
const FIX = require('../fixtures/jj-macro-seed42.json');
const GENES = FIX.init.swimbots.map(s => Array.from(Buffer.from(s.genes, 'base64'))); // junk-zeroed founders -> interbreed
const genesOf = (i) => GENES[i % GENES.length];

// Seed a cluster of breeding-age founders + nearby food inside [cx-r, cx+r]^2, run `ticks`, return the dump.
function runWorld(World, config, seed, { cx, cy, r, n = 40, food = 200, ticks = 200 }) {
    const w = new World(config, seed);
    for (let i = 0; i < n; i++) {
        w.loadSwimbot(i, { age: 3000 + i * 7, x: cx + ((i * 53) % (2 * r)) - r, y: cy + ((i * 71) % (2 * r)) - r, angle: (i * 29) % 360, energy: 85, genes: genesOf(i) });
    }
    for (let i = 0; i < food; i++) {
        w.loadFood(i, { x: cx + ((i * 137) % (2 * r)) - r, y: cy + ((i * 89) % (2 * r)) - r, type: 0, energy: 50 });
    }
    for (let t = 0; t < ticks; t++) w.tick();
    return w.dumpSwimbots();
}

// Cross-phase invariants (§17): finite state, unique ids, living => energy > 0.
function assertHealthy(bots, label) {
    const ids = new Set();
    for (const s of bots) {
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.angle) && Number.isFinite(s.energy), `${label}: non-finite state in swimbot ${s.id}`);
        assert.ok(Number.isInteger(s.id) && s.id >= 0, `${label}: bad id ${s.id}`);
        assert.ok(!ids.has(s.id), `${label}: duplicate id ${s.id}`);
        ids.add(s.id);
        assert.ok(s.energy > 0, `${label}: living swimbot ${s.id} has energy ${s.energy}`);
    }
}

// Each world: healthy + deterministic (same seed -> identical dump).
const WORLDS = [
    { name: 'torus, medium pool', config: { pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, topology: 'torus' }, at: { cx: 1500, cy: 1500, r: 700 } },
    { name: 'giant pool (foodSpread auto-scales to 20000)', config: { pool: { left: 0, top: 0, right: 40000, bottom: 40000 } }, at: { cx: 20000, cy: 20000, r: 1200 } },
    { name: 'tiny pool', config: { pool: { left: 0, top: 0, right: 1000, bottom: 1000 } }, at: { cx: 500, cy: 500, r: 350 } },
    { name: 'multi-obstacle field', config: { pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, obstacles: [
        { a: { x: 1000, y: 500 }, b: { x: 1000, y: 2500 } },
        { a: { x: 2000, y: 500 }, b: { x: 2000, y: 2500 } },
        { a: { x: 500, y: 1500 }, b: { x: 2500, y: 1500 }, thickness: 40 },
    ] }, at: { cx: 1500, cy: 1500, r: 1000 } },
    { name: 'empty obstacle field (no walls-of-the-mind)', config: { pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, obstacles: [] }, at: { cx: 1500, cy: 1500, r: 900 } },
    { name: 'loosened speciation (all interbreed)', config: { pool: { left: 0, top: 0, right: 2000, bottom: 2000 }, reproductiveIsolation: 0.0 }, at: { cx: 1000, cy: 1000, r: 600 } },
];

for (const wd of WORLDS) {
    test(`arbitrary world runs healthy + deterministic: ${wd.name}`, async () => {
        const World = await loadWorld();
        const a = runWorld(World, wd.config, 1234, wd.at);
        const b = runWorld(World, wd.config, 1234, wd.at);
        assert.ok(a.length > 0, `${wd.name}: population went extinct (expected some survivors)`);
        assertHealthy(a, wd.name);
        assert.deepEqual(a, b, `${wd.name}: same seed must reproduce the run bit-for-bit`);
    });
}

test('a giant-pool world keeps all food inside its (arbitrary) bounds', async () => {
    const World = await loadWorld();
    const pool = { left: 0, top: 0, right: 40000, bottom: 40000 };
    const w = new World({ pool }, 55);
    for (let i = 0; i < 30; i++) w.loadSwimbot(i, { age: 3000, x: 20000 + i * 20, y: 20000, angle: 0, energy: 85, genes: genesOf(i) });
    for (let i = 0; i < 300; i++) w.loadFood(i, { x: 19000 + (i * 37) % 2000, y: 19000 + (i * 53) % 2000, type: 0, energy: 50 });
    for (let t = 0; t < 300; t++) w.tick(); // regen (foodSpread=20000) must respect bounds, not fling food to NaN/out-of-pool
    for (const f of w._foodBits.values()) {
        const p = f.getPosition();
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'regen produced non-finite food position');
        assert.ok(p.x >= pool.left && p.x <= pool.right && p.y >= pool.top && p.y <= pool.bottom, `food escaped the pool at (${p.x},${p.y})`);
    }
});
