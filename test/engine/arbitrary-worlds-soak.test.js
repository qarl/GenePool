'use strict';
// Long-horizon SOAK of the arbitrary-worlds features (torus, obstacle field, §10 schedules, isolation, sizes).
// The integration suite (arbitrary-worlds.test.js) checks 200 ticks; this runs thousands, asserting the cross-phase
// invariants HOLD THROUGHOUT (finite state, unique never-reused ids, living => energy > 0) and the run stays
// DETERMINISTIC (same seed -> identical final dump). GP_SLOW=1 runs the long horizon (4000 ticks, crossing schedule
// steps + boom/bust churn); the default runs a shorter but still multi-step horizon so it guards on every `node --test`.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SLOW = process.env.GP_SLOW === '1';
const TICKS = SLOW ? 4000 : 900;

async function loadWorld() { return (await import('../../engine/world.js')).World; }
const FIX = require('../fixtures/jj-macro-seed42.json');
const GENES = FIX.init.swimbots.map(s => Array.from(Buffer.from(s.genes, 'base64')));
const genesOf = (i) => GENES[i % GENES.length];

function assertHealthy(bots, label, tick) {
    const ids = new Set();
    for (const s of bots) {
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.angle) && Number.isFinite(s.energy), `${label} @${tick}: non-finite state in swimbot ${s.id}`);
        assert.ok(Number.isInteger(s.id) && s.id >= 0, `${label} @${tick}: bad id ${s.id}`);
        assert.ok(!ids.has(s.id), `${label} @${tick}: duplicate id ${s.id}`);
        ids.add(s.id);
        assert.ok(s.energy > 0, `${label} @${tick}: living swimbot ${s.id} has energy ${s.energy}`);
    }
}

// dense breeding-age founders + food inside [cx±r]^2, so there is real birth/death churn over the horizon.
function seed(World, config) {
    const { cx, cy, r } = config._at;
    const w = new World(config, 20260831);
    for (let i = 0; i < 120; i++) w.loadSwimbot(i, { age: 2000 + i * 11, x: cx + ((i * 53) % (2 * r)) - r, y: cy + ((i * 71) % (2 * r)) - r, angle: (i * 29) % 360, energy: 85, genes: genesOf(i) });
    for (let i = 0; i < 500; i++) w.loadFood(i, { x: cx + ((i * 137) % (2 * r)) - r, y: cy + ((i * 89) % (2 * r)) - r, type: 0, energy: 50 });
    return w;
}

const WORLDS = [
    { name: 'torus soak', _at: { cx: 1500, cy: 1500, r: 800 }, pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, topology: 'torus', maxPopulation: 2000, maxFood: 1500 },
    { name: 'obstacle-field soak', _at: { cx: 1500, cy: 1500, r: 1000 }, pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, maxPopulation: 2000, maxFood: 1500,
        obstacles: [{ a: { x: 1000, y: 400 }, b: { x: 1000, y: 2600 }, thickness: 30 }, { a: { x: 2000, y: 400 }, b: { x: 2000, y: 2600 } }, { a: { x: 500, y: 1500 }, b: { x: 2500, y: 1500 }, thickness: 40 }] },
    { name: 'scheduled-drought soak', _at: { cx: 1500, cy: 1500, r: 900 }, pool: { left: 0, top: 0, right: 3000, bottom: 3000 }, maxPopulation: 2000,
        foodRegenerationPeriod: { schedule: [[0, 20], [Math.floor(TICKS / 2), 400]] }, reproductiveIsolation: { schedule: [[0, 0.9], [Math.floor(TICKS * 0.75), 1.0]] } },
];

for (const wd of WORLDS) {
    test(`soak (${TICKS} ticks): ${wd.name} stays healthy + deterministic`, async () => {
        const World = await loadWorld();
        const run = () => {
            const w = seed(World, wd);
            for (let t = 0; t < TICKS; t++) {
                w.tick();
                if (t % 500 === 0) assertHealthy(w.dumpSwimbots(), wd.name, t); // invariants hold THROUGHOUT
            }
            return w.dumpSwimbots();
        };
        const a = run();
        assertHealthy(a, wd.name, TICKS);
        assert.deepEqual(run(), a, `${wd.name}: same seed must reproduce the long run bit-for-bit`);
    });
}
