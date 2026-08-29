// SQLite event sink (P5: events -> a real DB) using Node's built-in node:sqlite (no dependency). Turns the
// engine's opt-in event stream (options.onEvent) into a queryable database: one table per event type, so a
// finished run can be analysed with plain SQL -- population over time, lineages, foraging, lifespans.
//
//   import { createSqliteSink } from './sqlite-sink.mjs';
//   const sink = createSqliteSink('run.db');            // or ':memory:'
//   const world = new World(config, seed, { onEvent: sink.onEvent });
//   ... run ...; sink.close();
//   sink.db.prepare('SELECT tick, pop FROM ticks WHERE tick % 100 = 0').all();
//
// The sink is a pure observer (never mutates the world), so an instrumented run stays byte-identical.
// Inserts are batched inside transactions for throughput.

import { DatabaseSync } from 'node:sqlite';

export function createSqliteSink(path = ':memory:', { batchSize = 5000 } = {}) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS births (tick INTEGER, id INTEGER, parentId INTEGER, mateId INTEGER, x REAL, y REAL);
        CREATE TABLE IF NOT EXISTS deaths (tick INTEGER, id INTEGER);
        CREATE TABLE IF NOT EXISTS eats   (tick INTEGER, id INTEGER, foodId INTEGER);
        CREATE TABLE IF NOT EXISTS ticks  (tick INTEGER PRIMARY KEY, pop INTEGER, food INTEGER);
    `);
    const stmt = {
        birth: db.prepare('INSERT INTO births (tick,id,parentId,mateId,x,y) VALUES (?,?,?,?,?,?)'),
        death: db.prepare('INSERT INTO deaths (tick,id) VALUES (?,?)'),
        eat: db.prepare('INSERT INTO eats (tick,id,foodId) VALUES (?,?,?)'),
        tick: db.prepare('INSERT INTO ticks (tick,pop,food) VALUES (?,?,?)'),
    };

    let buf = [];
    function flush() {
        if (buf.length === 0) return;
        db.exec('BEGIN');
        try {
            for (const e of buf) {
                if (e.type === 'birth') stmt.birth.run(e.tick, e.id, e.parentId, e.mateId, e.x, e.y);
                else if (e.type === 'death') stmt.death.run(e.tick, e.id);
                else if (e.type === 'eat') stmt.eat.run(e.tick, e.id, e.foodId);
                else if (e.type === 'tick') stmt.tick.run(e.tick, e.pop, e.food);
            }
            db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
        buf = [];
    }

    return {
        db,
        onEvent(e) { buf.push(e); if (buf.length >= batchSize) flush(); },
        flush,
        close() { flush(); db.close(); },
    };
}

// Convenience: store a run's meta (seed, config) so a DB is self-describing.
export function writeRunMeta(db, meta) {
    db.exec('CREATE TABLE IF NOT EXISTS run_meta (key TEXT PRIMARY KEY, value TEXT)');
    const ins = db.prepare('INSERT OR REPLACE INTO run_meta (key,value) VALUES (?,?)');
    for (const [k, v] of Object.entries(meta)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
}
