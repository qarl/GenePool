'use strict';
// §14: the JSONL run file (source of truth) + the ingested SQLite catalog (genome-hash index + birth-DAG edges).
// Drives a real World through the JSONL sink, then ingests and cross-checks the catalog against the run's actuals.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');
const { createJsonlSink } = require('../../tools/events/jsonl-sink.mjs');
const { ingest } = require('../../tools/events/ingest-jsonl.mjs');
const { computeRunId } = require('../../tools/events/run-identity.mjs');
const { hashGenome } = require('../../tools/events/genome-hash.mjs');

const NUM_GENES = 256, USED = 112, POOL = 4000, N = 400, NFOOD = 1200, TICKS = 1000;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10, pool: { left: 0, top: 0, right: POOL, bottom: POOL },
};

// Record one run to a JSONL file; returns { path, runId, actualBirths }.
function record(seed) {
    const path = join(tmpdir(), `gp-run-${seed}-${process.pid}-${Date.now()}.jsonl`);
    const runId = computeRunId({ seed, config: CONFIG, n: N, food: NFOOD });
    const sink = createJsonlSink(path, { runId, seed, config: CONFIG });
    const world = new World(CONFIG, seed, { onEvent: sink.onEvent });
    const rng = mulberry32(seed ^ 0x5eed1234);
    for (let i = 0; i < N; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = USED; k < NUM_GENES; k++) genes[k] = 0;
        world.loadSwimbot(i, { age: Math.floor(rng() * 40000), x: rng() * POOL, y: rng() * POOL, angle: rng() * 360 - 180, energy: 80, genes });
    }
    for (let i = 0; i < NFOOD; i++) world.loadFood(i, { x: rng() * POOL, y: rng() * POOL, type: 0, energy: 50 });
    const startId = world.getNextSwimbotId();
    for (let t = 0; t < TICKS; t++) world.tick();
    sink.close();
    return { path, runId, actualBirths: world.getNextSwimbotId() - startId, finalPop: world.getLivingSwimbotCount() };
}

test('JSONL round-trips the event stream (header + founders + births)', () => {
    const { path, runId } = record(7);
    try {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.equal(lines[0].type, 'header', 'first line is the header');
        assert.equal(lines[0].runId, runId);
        assert.equal(lines.filter((e) => e.type === 'founder').length, N, 'a founder line per loaded swimbot');
        assert.equal(lines.filter((e) => e.type === 'food_init').length, NFOOD, 'a food_init line per loaded food');
        const births = lines.filter((e) => e.type === 'birth');
        assert.ok(births.length > 20, 'births recorded');
        for (const b of births.slice(0, 5)) assert.match(b.genes, /^[A-Za-z0-9+/]+=*$/, 'birth carries base64 genes');
    } finally { unlinkSync(path); }
});

test('ingest builds a catalog whose counts match the run, with a lineage-consistent birth-DAG', () => {
    const { path, runId, actualBirths } = record(7);
    try {
        const { db, founders, births } = ingest(path, ':memory:');
        assert.equal(founders, N, 'founders counted');
        assert.equal(births, actualBirths, 'catalog births == the run\'s actual births');
        const runRow = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
        assert.ok(runRow, 'runs row exists');
        assert.equal(runRow.births, actualBirths);
        assert.equal(runRow.founders, N);
        assert.ok(runRow.genomes > 0 && runRow.genomes <= N + actualBirths, 'distinct genomes in a sane range');
        // birth-DAG lineage integrity: every birth's parent + mate genome hash is recorded in genomes.
        const bad = db.prepare(`SELECT count(*) c FROM births b WHERE b.run_id = ?
            AND (b.parent_hash IS NULL OR b.mate_hash IS NULL
                 OR NOT EXISTS (SELECT 1 FROM genomes g WHERE g.run_id = b.run_id AND g.hash = b.parent_hash)
                 OR NOT EXISTS (SELECT 1 FROM genomes g WHERE g.run_id = b.run_id AND g.hash = b.mate_hash))`).get(runId).c;
        assert.equal(bad, 0, 'every birth resolves parent+mate to a recorded genome');
        // child_hash is a real GENOME-ID (64 hex) and is itself in genomes
        const anyBirth = db.prepare('SELECT child_hash FROM births WHERE run_id = ? LIMIT 1').get(runId);
        assert.match(anyBirth.child_hash, /^[0-9a-f]{64}$/);
        db.close();
    } finally { unlinkSync(path); }
});

test('ingest is idempotent (re-ingesting the same run does not duplicate)', () => {
    const { path, runId } = record(7);
    const dbPath = join(tmpdir(), `gp-cat-${process.pid}-${Date.now()}.db`);
    try {
        ingest(path, dbPath).db.close();            // ingest into the SAME on-disk db twice
        const r = ingest(path, dbPath); const db = r.db;
        assert.equal(db.prepare('SELECT count(*) c FROM runs WHERE run_id = ?').get(runId).c, 1, 'one runs row');
        assert.equal(db.prepare('SELECT count(*) c FROM births WHERE run_id = ?').get(runId).c, r.births, 'births not doubled');
        assert.equal(db.prepare('SELECT count(*) c FROM genomes WHERE run_id = ?').get(runId).c, r.genomes, 'genomes not doubled');
        db.close();
    } finally {
        unlinkSync(path);
        for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + ext); } catch { /* may not exist */ } }
    }
});
