// run-db.mjs -- the scrub/playback RUN DATABASE. One `.db` per seed is a cached, replayable recording:
//   * event tables (births/deaths/eats/ticks) via createSqliteSink -- the fine-grained stream (ticks throttled),
//   * snapshots(tick, gz)  -- sparse KEYFRAMES: World.serialize() as gzipped JSON (D3: raw is ~4.2 KB/bot, so a
//                             high-pop snapshot is multiple MB -- gzip squashes the gene/float arrays ~2-3x),
//   * stats(tick, json)    -- the analysis panel saved at a DENSE cadence (pop EMAs + per-lineage species rows),
//                             so a scrub shows the panel + population curve instantly with no recompute,
//   * run_meta(k, v)       -- seed, config, intervals, engine/app versions, frontier (max consistent tick), done.
//
// Determinism is the codec (see test/engine/world-checkpoint.test.js): any tick is reconstructed by restoring the
// nearest keyframe <= T and re-simming the remainder. Writes are CRASH-SAFE (D4): each keyframe/stats commit is ONE
// transaction that drains pending events, writes the snapshot/stats, and advances `frontier` LAST -- so a concurrent
// reader that clamps to `frontier` never sees a keyframe ahead of its events, and a mid-write kill leaves a clean
// prefix (resume deletes anything past the last durable frontier -- Phase 3).
//
// The WRITER is the generator (a Node utilityProcess); the READER is main, opening the SAME file read-only in WAL
// (Phase 3/4). Both live here so the schema has exactly one definition.

import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSink } from './sqlite-sink.mjs';

export const SCRUB_SCHEMA_VERSION = 1;

// Create the scrub tables (idempotent). snapshots.gz is a BLOB (gzipped JSON); stats.json is TEXT.
function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (tick INTEGER PRIMARY KEY, gz BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS stats     (tick INTEGER PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS run_meta  (k TEXT PRIMARY KEY, v TEXT);
    `);
}

const encode = (obj) => gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
const decode = (gz) => JSON.parse(gunzipSync(gz).toString('utf8'));

// ---- WRITER (the generator) --------------------------------------------------------------------------------------
// meta: { seed, config, keyframeInterval, statsInterval, engineVersion?, appVersion?, perceptionMode? }
export function openRunWriter(path, meta = {}, { batchSize = 5000, resume = false } = {}) {
    // Resume iff the file already has committed keyframes (a partial run to continue), else it's a fresh run.
    const resuming = resume && existsSync(path);
    const sink = createSqliteSink(path, { batchSize });   // creates births/deaths/eats/ticks + sets WAL
    const db = sink.db;
    ensureSchema(db);

    const insSnap = db.prepare('INSERT OR REPLACE INTO snapshots (tick, gz)   VALUES (?, ?)');
    const insStat = db.prepare('INSERT OR REPLACE INTO stats     (tick, json) VALUES (?, ?)');
    const setMetaStmt = db.prepare('INSERT OR REPLACE INTO run_meta (k, v) VALUES (?, ?)');
    const setMeta = (k, v) => setMetaStmt.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    const getMeta = (k) => { const r = db.prepare('SELECT v FROM run_meta WHERE k = ?').get(k); return r ? r.v : null; };

    let resumedFrom = null;   // { tick, snapshot } the caller restores + resimes from, or null for a fresh run
    if (resuming) {
        // S4: the last COMMITTED keyframe is always whole (writeKeyframe is one atomic txn -> a torn one rolled back).
        // Truncate everything after it -- a stats-only/event batch may have advanced the frontier past the last
        // keyframe, and those rows can't be resumed from -- then rewind frontier + clear the done flag.
        const kf = db.prepare('SELECT tick, gz FROM snapshots ORDER BY tick DESC LIMIT 1').get();
        if (kf) {
            const lastKf = kf.tick;
            db.exec('BEGIN');
            try {
                for (const tbl of ['snapshots', 'stats', 'births', 'deaths', 'eats', 'ticks']) {
                    db.prepare(`DELETE FROM ${tbl} WHERE tick > ?`).run(lastKf);
                }
                setMetaStmt.run('frontier', String(lastKf));
                setMetaStmt.run('done', '0');
                db.exec('COMMIT');
            } catch (err) { db.exec('ROLLBACK'); throw err; }
            resumedFrom = { tick: lastKf, snapshot: decode(kf.gz) };
        }
        // do NOT rewrite seed/config/intervals on resume -- keep the original run's metadata (S2).
    } else {
        // Initial metadata (frontier starts at -1 = nothing consistent yet; done=0).
        setMeta('scrubSchemaVersion', SCRUB_SCHEMA_VERSION);
        for (const k of ['seed', 'keyframeInterval', 'statsInterval', 'engineVersion', 'appVersion', 'perceptionMode']) {
            if (meta[k] !== undefined && meta[k] !== null) setMeta(k, meta[k]);
        }
        if (meta.config !== undefined) setMeta('config', meta.config);
        // The reconstruct-anything config the reader must restore() with (D2/S2): seed + config together.
        if (meta.seed !== undefined && meta.config !== undefined) setMeta('runConfig', { seed: meta.seed, config: meta.config });
        setMeta('frontier', '-1');
        setMeta('done', '0');
    }

    // ONE-TRANSACTION keyframe write (D4): pending events -> snapshot -> stats -> frontier LAST.
    function writeKeyframe(tick, snapshot, stats = null) {
        db.exec('BEGIN');
        try {
            sink.drainWithin();                              // fold buffered births/deaths/eats/ticks into this txn
            insSnap.run(tick, encode(snapshot));
            if (stats != null) insStat.run(tick, JSON.stringify(stats));
            setMetaStmt.run('frontier', String(tick));        // advanced LAST -> readers clamp to it
            db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
    }

    // Dense stats-only write (no snapshot) -- same one-transaction discipline, advances frontier too.
    function writeStats(tick, stats) {
        db.exec('BEGIN');
        try {
            sink.drainWithin();
            insStat.run(tick, JSON.stringify(stats));
            setMetaStmt.run('frontier', String(tick));
            db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
    }

    function finish() {
        db.exec('BEGIN');
        try { sink.drainWithin(); setMetaStmt.run('done', '1'); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
    }

    // The run's stored {seed, config} (S2) -- callers restore() with THIS on resume, not recomputed defaults.
    const runConfig = () => { const v = getMeta('runConfig'); return v ? JSON.parse(v) : null; };

    return {
        db, sink,
        resumedFrom,                    // { tick, snapshot } | null -- restore + resim from here to continue a partial run
        onEvent: sink.onEvent,          // the generator wires world's onEvent here
        writeKeyframe, writeStats, setMeta, getMeta, runConfig, finish,
        close() { sink.close(); },      // flushes remaining buffer (own txn) + closes
    };
}

// ---- READER (main; Phase 3/4 opens this read-only) ---------------------------------------------------------------
export function openRunReader(path, { readOnly = true } = {}) {
    const db = new DatabaseSync(path, { readOnly });
    const qFrontier = db.prepare(`SELECT v FROM run_meta WHERE k = 'frontier'`);
    const qMeta = db.prepare('SELECT v FROM run_meta WHERE k = ?');
    // nearest keyframe / stats at or before a tick (clamped to frontier by the callers below)
    const qSnapLE = db.prepare('SELECT tick, gz FROM snapshots WHERE tick <= ? ORDER BY tick DESC LIMIT 1');
    const qStatLE = db.prepare('SELECT tick, json FROM stats WHERE tick <= ? ORDER BY tick DESC LIMIT 1');

    const frontier = () => { const r = qFrontier.get(); return r ? parseInt(r.v, 10) : -1; };
    const meta = (k) => { const r = qMeta.get(k); return r ? r.v : null; };
    const runConfig = () => { const r = qMeta.get('runConfig'); return r ? JSON.parse(r.v) : null; };
    const clamp = (t) => Math.min(t, frontier());

    function getKeyframe(t) {                      // -> { tick, snapshot } | null   (snapshot = restore-ready object)
        const r = qSnapLE.get(clamp(t));
        return r ? { tick: r.tick, snapshot: decode(r.gz) } : null;
    }
    function getStats(t) {                         // -> { tick, stats } | null
        const r = qStatLE.get(clamp(t));
        return r ? { tick: r.tick, stats: JSON.parse(r.json) } : null;
    }
    // downsampled population curve for the slider/graph (bounded rows, never the whole ticks table -- N4)
    function getPopSeries({ maxPoints = 1000 } = {}) {
        const hi = frontier();
        const rows = db.prepare('SELECT tick, pop, food FROM ticks WHERE tick <= ? ORDER BY tick').all(hi);
        if (rows.length <= maxPoints) return rows;
        const step = Math.ceil(rows.length / maxPoints), out = [];
        for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
        return out;
    }

    return { db, frontier, meta, runConfig, getKeyframe, getStats, getPopSeries, close() { db.close(); } };
}
