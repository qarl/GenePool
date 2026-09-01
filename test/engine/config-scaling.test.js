'use strict';
// P3/§6 — the world-config schema fills complete defaults with a declared absolute-vs-×poolSize scaling policy,
// so a MINIMAL config yields a working, correctly-scaled world at ANY pool size (no per-size tuning, no NaN from
// unset ecology params). Also asserts the byte-identity property: a fully-specified config is returned unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    const { resolveWorldConfig } = await import('../../engine/config.js');
    const { World } = await import('../../engine/world.js');
    return { resolveWorldConfig, World };
}
const FIX = require('../fixtures/jj-macro-seed42.json');
const GENES = FIX.init.swimbots.map(s => Array.from(Buffer.from(s.genes, 'base64'))); // junk-zeroed founders -> interbreed
const genesOf = (i) => GENES[i % GENES.length];

test('resolveWorldConfig: minimal config gets complete defaults; foodSpread scales ×poolSize', async () => {
    const { resolveWorldConfig } = await load();
    const def = resolveWorldConfig({}); // no fields at all -> the default 8000 pool
    assert.equal(def.foodSpread, 4000);          // ×poolSize: W/2 = 8000/2 (JJ's "secret" spawn radius)
    assert.equal(def.viewRadius, 300);           // absolute
    assert.equal(def.foodRegenerationPeriod, 20);
    assert.equal(def.maximumLifeSpan, 40000);
    assert.equal(def.childEnergyRatio, 0.5);
    assert.equal(def.crossoverRate, 0.2);
    assert.equal(def.mutationRate, 0.01);
    assert.equal(def.numFoodTypes, 1);
    assert.equal(def.reproductiveIsolation, 0.9); // §11: JJ's junk-DNA gate, now per-pool config
    assert.equal(def.maxPopulation, Infinity);   // opt-in cap: no engine-imposed ceiling
    assert.equal(def.maxFood, Infinity);

    const small = resolveWorldConfig({ pool: { left: 0, top: 0, right: 2000, bottom: 2000 } });
    assert.equal(small.foodSpread, 1000);        // ×poolSize: 2000/2 -- scales with the world
    assert.equal(small.viewRadius, 300);         // absolute: unchanged by pool size
    const big = resolveWorldConfig({ pool: { left: 0, top: 0, right: 40000, bottom: 40000 } });
    assert.equal(big.foodSpread, 20000);         // ×poolSize: 40000/2
});

test('resolveWorldConfig: a fully-specified config is returned unchanged (the ?? no-op / byte-identity property)', async () => {
    const { resolveWorldConfig } = await load();
    const full = {
        pool: { left: 0, top: 0, right: 5000, bottom: 5000 }, foodSpread: 777, viewRadius: 123,
        foodRegenerationPeriod: 7, maximumLifeSpan: 999, childEnergyRatio: 0.3,
        // FALSY-but-valid overrides: 0 must survive (?? keeps it; a `||` regression would clobber it to the default).
        crossoverRate: 0, mutationRate: 0, maxPopulation: 0,
        numFoodTypes: 2, maxFood: 800, maxFoodBitsPerType: 400,
        obstacles: [], topology: 'walls', perceptionMode: 'snapshot',
    };
    const r = resolveWorldConfig(full);
    for (const k of Object.keys(full)) assert.deepEqual(r[k], full[k], `field ${k} was altered`);
    assert.equal(r.crossoverRate, 0); assert.equal(r.maxPopulation, 0); // explicit: falsy values preserved
});

test('a minimal-config World runs deterministically at a non-default pool (no NaN, no supplied ecology params)', async () => {
    const { World } = await load();
    const pool = { left: 0, top: 0, right: 2000, bottom: 2000 };
    const build = () => {
        const w = new World({ pool }, 42); // ONLY pool -- every ecology/lifecycle/spatial param comes from the resolver
        for (let i = 0; i < 30; i++) w.loadSwimbot(i, { age: 200, x: 400 + (i * 40) % 1200, y: 400 + (i * 10) % 1200, angle: (i * 12) % 360, energy: 85, genes: genesOf(i) });
        for (let i = 0; i < 120; i++) w.loadFood(i, { x: (i * 137) % 2000, y: (i * 89) % 2000, type: 0, energy: 50 });
        for (let t = 0; t < 40; t++) w.tick();
        // include food positions -> a broken (undefined/NaN) foodSpread default would show up as NaN food here
        const food = [...w._foodBits.values()].map((f) => { const p = f.getPosition(); return { x: p.x, y: p.y }; });
        return { swimbots: w.dumpSwimbots(), food };
    };
    const a = build(), b = build();
    assert.ok(a.swimbots.length > 0, 'some swimbots should still be alive');
    for (const s of a.swimbots) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.energy) && Number.isFinite(s.angle), `NaN state in swimbot ${s.id}`);
    for (const f of a.food) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), 'NaN food position (foodSpread default not applied?)');
    assert.ok(a.food.length > 30, 'food should have regenerated past the initial 120 or at least persisted'); // regen fired -> foodRegenerationPeriod default applied
    assert.deepEqual(a, b, 'same seed + minimal config -> identical run (deterministic)');
});

test('§11: reproductiveIsolation is a per-pool config gate on breeding', async () => {
    const { World } = await load();
    const pool = { left: 0, top: 0, right: 1500, bottom: 1500 };
    const run = (iso) => {
        const w = new World({ pool, reproductiveIsolation: iso }, 7);
        // founders old enough to reproduce (age > YOUNG_AGE 1000), clustered so they perceive each other as mates
        for (let i = 0; i < 50; i++) w.loadSwimbot(i, { age: 3000 + i * 7, x: 500 + (i * 13) % 500, y: 500 + (i * 11) % 500, angle: (i * 23) % 360, energy: 85, genes: genesOf(i) });
        for (let i = 0; i < 200; i++) w.loadFood(i, { x: (i * 61) % 1500, y: (i * 97) % 1500, type: 0, energy: 50 });
        for (let t = 0; t < 300; t++) w.tick();
        return w.dumpSwimbots().length;
    };
    // junk-zeroed founders have similarity 1.0. Gate: no breeding when similarity <= isolation.
    const permissive = run(0.0); // 1.0 > 0.0 -> pairs may breed
    const strict = run(1.0);     // 1.0 <= 1.0 -> NO pair may EVER breed (blocks everything)
    const byDefault = run(0.9);  // 1.0 > 0.9 -> same-species breeds (JJ's default)
    assert.ok(permissive > strict, `permissive isolation must out-breed strict (${permissive} vs ${strict})`);
    assert.ok(byDefault > strict, `the default 0.9 gate must still allow same-species breeding (${byDefault} vs ${strict})`);
});
