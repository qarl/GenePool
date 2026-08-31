// Ingest a JSONL run file (the source of truth) into a disposable, rebuildable SQLite CATALOG (§14). The catalog
// is a SELECTIVE INDEX -- genome HASH + first-appearance locator (NOT the 256 bytes; fetch those from the JSONL),
// the birth-DAG edges (parent/mate/child genome hashes), and a per-run summary. Keyed per run_id so re-ingest is
// IDEMPOTENT (delete-then-insert this run) and first-appearance is deterministic. Content-addressing (§12)
// collapses clones by bytes. Materialized ancestry is deferred (competition-layer, §18); the full parentMask/
// mutationMask stay in the JSONL, so it can be computed exactly later.
//
//   import { ingest } from './ingest-jsonl.mjs'; const { db } = ingest('run.jsonl', 'run.db');
//   CLI:  node tools/events/ingest-jsonl.mjs run.jsonl run.db

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashGenome } from './genome-hash.mjs';
import { base64ToBytes } from '../../engine/genome.js';

export function ingest(jsonlPath, dbPath = ':memory:') {
    const lines = readFileSync(jsonlPath, 'utf8').split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    const header = JSON.parse(lines[i++]);
    if (header.type !== 'header') throw new Error('ingest: first JSONL line must be a header');
    const runId = header.runId;
    if (!runId) throw new Error('ingest: header has no runId');

    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, seed INTEGER, config TEXT, schema_version INTEGER,
            founders INTEGER, births INTEGER, deaths INTEGER, eats INTEGER, ticks INTEGER, genomes INTEGER,
            peak_pop INTEGER, final_pop INTEGER, final_food INTEGER);
        CREATE TABLE IF NOT EXISTS genomes (run_id TEXT, hash TEXT, first_tick INTEGER, first_id INTEGER, PRIMARY KEY (run_id, hash));
        CREATE TABLE IF NOT EXISTS births (run_id TEXT, tick INTEGER, child_id INTEGER, child_hash TEXT,
            parent_id INTEGER, parent_hash TEXT, mate_id INTEGER, mate_hash TEXT);
        CREATE INDEX IF NOT EXISTS births_run ON births(run_id);
    `);
    const insGenome = db.prepare('INSERT INTO genomes (run_id,hash,first_tick,first_id) VALUES (?,?,?,?)');
    const insBirth = db.prepare('INSERT INTO births (run_id,tick,child_id,child_hash,parent_id,parent_hash,mate_id,mate_hash) VALUES (?,?,?,?,?,?,?,?)');
    const idToHash = new Map();   // body id -> genome hash, built in stream order (parent precedes child)
    const seen = new Set();       // genome hashes recorded this run (first-appearance)
    const recordGenome = (h, tick, id) => { if (!seen.has(h)) { seen.add(h); insGenome.run(runId, h, tick, id); } };
    let founders = 0, births = 0, deaths = 0, eats = 0, ticks = 0, peakPop = 0, finalPop = 0, finalFood = 0;

    // ONE transaction: drop any prior ingest of THIS run, rebuild it, and write its summary -- so a crash
    // mid-ingest can't leave a run half-wiped or half-built (re-ingest stays idempotent).
    db.exec('BEGIN');
    try {
        for (const t of ['runs', 'genomes', 'births']) db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(runId);
        for (; i < lines.length; i++) {
            const line = lines[i]; if (line.trim() === '') continue;
            const e = JSON.parse(line);
            if (e.type === 'founder') {
                const h = hashGenome(base64ToBytes(e.genes));
                idToHash.set(e.id, h); recordGenome(h, e.tick, e.id); founders++;
            } else if (e.type === 'birth') {
                const h = hashGenome(base64ToBytes(e.genes));
                idToHash.set(e.id, h); recordGenome(h, e.tick, e.id); births++;
                insBirth.run(runId, e.tick, e.id, h, e.parentId, idToHash.get(e.parentId) ?? null, e.mateId, idToHash.get(e.mateId) ?? null);
            } else if (e.type === 'death') deaths++;
            else if (e.type === 'eat') eats++;
            else if (e.type === 'tick') { ticks++; if (e.pop > peakPop) peakPop = e.pop; finalPop = e.pop; finalFood = e.food; }
            // food_init: kept in the JSONL for rebuild; not indexed in the catalog (yet).
        }
        db.prepare(`INSERT INTO runs (run_id,seed,config,schema_version,founders,births,deaths,eats,ticks,genomes,peak_pop,final_pop,final_food)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(runId, header.seed ?? null, JSON.stringify(header.config ?? null), header.schemaVersion ?? null,
                founders, births, deaths, eats, ticks, seen.size, peakPop, finalPop, finalFood);
        db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }

    // NOTE (scaling TODO): the READ side is not streaming -- readFileSync + the idToHash/seen maps are O(file +
    // bodies). Fine offline at current sizes; a truly endless run would need a streaming line reader here.
    return { db, runId, founders, births, deaths, eats, ticks, genomes: seen.size };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const [jsonl, out] = process.argv.slice(2);
    if (!jsonl || !out) { console.error('usage: node tools/events/ingest-jsonl.mjs <run.jsonl> <out.db>'); process.exit(1); }
    const r = ingest(jsonl, out); r.db.close();
    console.log(`ingested ${r.runId}: ${r.founders} founders, ${r.births} births, ${r.deaths} deaths, ${r.eats} eats, ${r.ticks} ticks, ${r.genomes} distinct genomes -> ${out}`);
}
