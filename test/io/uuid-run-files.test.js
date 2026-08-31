'use strict';
// The "UUID thing" in run files (docs/DESIGN-DECISIONS.md §"INDIVIDUAL ID"): a per-body UUID that is
// REPRODUCIBLE, not random (Karl, 2026-08-29) -- replaying a seed must reproduce the exact same UUIDs so run
// files stay auditable. runId content-addresses the initial conditions; bodyUuid = UUIDv5(runId, integer id),
// stamped in the observer so the engine stays bit-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');
const { createSqliteSink } = require('../../tools/events/sqlite-sink.mjs');
const { computeRunId, bodyUuid } = require('../../tools/events/run-identity.mjs');

const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10, pool: { left: 0, top: 0, right: 8000, bottom: 8000 },
};
const NUM_GENES = 256, USED = 112;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Record one run into an in-memory DB and return the sink (kept open for querying). Mirrors run-recorder's
// seed-derived founders so the run is fully defined by (seed, founders, food).
function record({ seed = 1, runId, founders = 300, food = 900, ticks = 1200 } = {}) {
    const sink = createSqliteSink(':memory:', { runId });
    const world = new World(CONFIG, seed, { onEvent: sink.onEvent });
    const rng = mulberry32((seed >>> 0) ^ 0x5eed1234);
    for (let i = 0; i < founders; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        // ages across the FULL lifespan (faithful to JJ's init) so the oldest founders age out during the run -> deaths occur
        world.loadSwimbot(i, { age: Math.floor(rng() * CONFIG.maximumLifeSpan), x: rng() * 8000, y: rng() * 8000, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < food; i++) world.loadFood(i, { x: rng() * 8000, y: rng() * 8000, type: 0, energy: 50 });
    world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    for (let t = 0; t < ticks; t++) world.tick();
    sink.flush();
    return sink;
}

test('computeRunId: deterministic, key-order-independent, and input-sensitive', () => {
    const a = computeRunId({ seed: 1, config: CONFIG, founders: 60 });
    const b = computeRunId({ founders: 60, config: CONFIG, seed: 1 }); // keys reordered
    assert.equal(a, b, 'runId must be canonical (key-order-independent)');
    assert.match(a, V8, 'runId should be a v8 UUID');
    assert.notEqual(a, computeRunId({ seed: 2, config: CONFIG, founders: 60 }), 'different seed -> different runId');
    assert.notEqual(a, computeRunId({ seed: 1, config: CONFIG, founders: 61 }), 'different founders -> different runId');
});

test('computeRunId folds founder GENOMES: a single changed founder byte changes the runId (§14 rebuildability)', () => {
    // run-recorder folds the actual founder genomes into the runId, so two DIFFERENT uploaded/seeded founder
    // sets can't content-address to the same run (which would collide their catalogs / break rebuild).
    const mkFounders = () => [{ genes: Array.from({ length: 256 }, (_, g) => g % 256), age: 5, x: 1, y: 2, angle: 3, energy: 80 }];
    const base = mkFounders();
    const changed = mkFounders(); changed[0].genes[100] = (changed[0].genes[100] + 1) % 256; // flip ONE gene
    const idA = computeRunId({ seed: 1, config: CONFIG, founders: base });
    assert.equal(idA, computeRunId({ seed: 1, config: CONFIG, founders: mkFounders() }), 'same founder genomes -> same runId');
    assert.notEqual(idA, computeRunId({ seed: 1, config: CONFIG, founders: changed }), 'one changed founder gene -> different runId');
});

test('bodyUuid: valid v5, deterministic, namespaced by runId, NULL for sentinel ids', () => {
    const r1 = computeRunId({ seed: 1 });
    const r2 = computeRunId({ seed: 2 });
    assert.match(bodyUuid(r1, 5), V5, 'bodyUuid should be a v5 UUID');
    assert.equal(bodyUuid(r1, 5), bodyUuid(r1, 5), 'same (runId,id) -> same uuid');
    assert.notEqual(bodyUuid(r1, 5), bodyUuid(r1, 6), 'different id -> different uuid');
    assert.notEqual(bodyUuid(r1, 5), bodyUuid(r2, 5), 'different runId -> different uuid (no cross-run collision)');
    assert.equal(bodyUuid(r1, -1), null, 'sentinel/negative id -> NULL, not a bogus uuid');
    // a malformed runId must THROW, not silently collapse to a shared namespace (would collide across runs)
    assert.throws(() => bodyUuid('not-a-uuid', 5), /runId must be a UUID/, 'malformed runId should throw');
    assert.throws(() => bodyUuid('', 5), /runId must be a UUID/, 'empty runId should throw');
});

test('computeRunId: rejects non-finite / non-JSON-safe inputs (would content-address collide)', () => {
    assert.throws(() => computeRunId({ pool: { bottom: NaN } }), /non-finite/, 'NaN input should throw');
    assert.throws(() => computeRunId({ x: Infinity }), /non-finite/, 'Infinity input should throw');
    assert.throws(() => computeRunId({ n: 5n }), /bigint/, 'bigint input should throw');
});

test("a body's UUID is stable across every event it emits (birth, eats, death)", () => {
    const runId = computeRunId({ seed: 7 });
    const sink = record({ seed: 7, runId });
    const db = sink.db;
    // Airtight: every stored uuid, in EVERY table, must equal bodyUuid(runId, id) -- so the same body carries
    // the identical uuid wherever it appears. Sample the head of each table.
    for (const tbl of ['births', 'eats', 'deaths']) {
        const rows = db.prepare(`SELECT id, uuid FROM ${tbl} ORDER BY id LIMIT 50`).all();
        assert.ok(rows.length > 0, `expected rows in ${tbl}`);
        for (const r of rows) {
            assert.match(r.uuid, V5, `${tbl}.uuid should be v5`);
            assert.equal(r.uuid, bodyUuid(runId, r.id), `${tbl}: uuid for id ${r.id} not the canonical body uuid`);
        }
    }
    // an id that appears in two tables must carry the SAME uuid in both (made explicit via a join)
    const cross = db.prepare('SELECT b.id id, b.uuid bu, e.uuid eu FROM births b JOIN eats e ON e.id = b.id LIMIT 1').get();
    if (cross) assert.equal(cross.bu, cross.eu, 'a born body that later ate must keep the same uuid');
    // a birth's parent/mate uuids equal those parents' own body uuids
    const bp = db.prepare('SELECT parentId, parentUuid, mateId, mateUuid FROM births WHERE parentUuid IS NOT NULL LIMIT 1').get();
    assert.equal(bp.parentUuid, bodyUuid(runId, bp.parentId), 'parentUuid must equal the parent body uuid');
    assert.equal(bp.mateUuid, bodyUuid(runId, bp.mateId), 'mateUuid must equal the mate body uuid');
    sink.close();
});

test('reproducible: same seed+runId -> identical (id,uuid) run file; different runId -> different uuids', () => {
    const runId = computeRunId({ seed: 3 });
    const s1 = record({ seed: 3, runId });
    const s2 = record({ seed: 3, runId }); // replay
    const rows = (s) => s.db.prepare('SELECT id, uuid FROM births ORDER BY id').all();
    assert.ok(rows(s1).length > 0, 'fixture must produce births (else the reproducibility check is vacuous)');
    assert.deepEqual(rows(s1), rows(s2), 'replaying the same seed+runId must reproduce identical births incl. uuids');

    const s3 = record({ seed: 3, runId: computeRunId({ seed: 3, salt: 'other-run' }) });
    const a = rows(s1), c = rows(s3);
    assert.equal(a.length, c.length, 'same seed -> same integer ids');
    assert.equal(a[0].id, c[0].id, 'same seed -> same first id');
    assert.notEqual(a[0].uuid, c[0].uuid, 'a different runId must namespace the uuids differently');
    s1.close(); s2.close(); s3.close();
});

test('back-compat: no runId -> uuid columns are NULL (existing callers unaffected)', () => {
    const sink = record({ seed: 9, runId: null });
    const row = sink.db.prepare('SELECT uuid FROM births LIMIT 1').get();
    assert.ok(row, 'expected births');
    assert.equal(row.uuid, null, 'without a runId the uuid column should be NULL');
    sink.close();
});
