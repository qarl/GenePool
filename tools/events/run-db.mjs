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

import { gzipSync, gunzipSync, createGunzip } from 'node:zlib';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
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

// Cheap population/food from a snapshot WITHOUT fully decoding it: livingSwimbotCount + livingFoodCount are top-level
// scalars serialized BEFORE the big swimbots/food arrays, so we stream-inflate only the head (first ~16 KB chunk) and
// regex them out -- ~0.1 ms/snapshot vs a multi-MB gunzip+parse. Used to draw the whole-run curve from keyframes when
// the fine-grained ticks stream is absent (this app records only keyframes).
function snapHeadStats(gz) {
    return new Promise((resolve, reject) => {
        const gun = createGunzip();
        let buf = '', done = false;
        const finish = (v) => { if (done) return; done = true; gun.destroy(); resolve(v); };
        gun.on('data', (chunk) => {
            buf += chunk.toString('latin1');
            const p = /"livingSwimbotCount":(\d+)/.exec(buf), f = /"livingFoodCount":(\d+)/.exec(buf);
            if (p && f) finish({ pop: +p[1], food: +f[1] });
            else if (buf.length > 65536) finish({ pop: p ? +p[1] : 0, food: f ? +f[1] : 0 });   // safety cap: fields are near the top
        });
        gun.on('end', () => finish({ pop: 0, food: 0 }));   // fully inflated without a match (shouldn't happen) -> zeros
        gun.on('error', reject);
        Readable.from([gz]).pipe(gun);
    });
}
const downsample = (rows, maxPoints) => {
    if (rows.length <= maxPoints) return rows;
    const step = Math.ceil(rows.length / maxPoints), out = [];
    for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
    return out;
};

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

    // Keyframe budget (Karl: 500). Keyframes are just restore anchors -- any tick is reachable by restore-nearest +
    // resim -- so they can be thinned freely. Keep an EVEN SPREAD across the WHOLE timeline (Karl): keyframes live on a
    // uniform grid of KEYFRAME_BASE*stride ticks (tick 0 is always on it), plus the newest. When the count exceeds the
    // budget, DERIVE the coarsest-necessary stride FROM THE CURRENT SPAN and drop everything off that grid -- so the grid
    // is always exactly as coarse as the frontier needs and no coarser (every era keeps its keyframes; count stays ~budget).
    //
    // Bug fix (Karl, 2026-09-06): this used to `keyframeStride *= 2` -- a permanent RATCHET. It only ever coarsened and
    // never re-derived, so across many resume/relaunch cycles (each session generating a burst -> one thin -> one doubling)
    // the stride climbed far past what the frontier warranted (observed: stride 512 on a 7.6M-tick run that needs 8), which
    // deleted most keyframes and left multi-hour scrub gaps. Deriving from the span each time is self-correcting: it thins
    // ONLY when over budget, never over-coarsens, and a run that was previously over-thinned re-densifies going forward.
    const KEYFRAME_BUDGET = meta.keyframeBudget || 500;
    const KEYFRAME_BASE = meta.keyframeInterval || parseInt(getMeta('keyframeInterval') || '2000', 10) || 2000;
    if (!resuming) setMeta('keyframeBudget', KEYFRAME_BUDGET);
    let keyframeStride = parseInt(getMeta('keyframeStride') || '1', 10) || 1;   // grid coarseness (re-derived on each thin)
    const countSnaps = db.prepare('SELECT COUNT(*) c FROM snapshots');
    const maxTickStmt = db.prepare('SELECT MAX(tick) m FROM snapshots');
    const thinGridStmt = db.prepare('DELETE FROM snapshots WHERE (tick / ?) % ? != 0 AND tick != ?');   // keep grid + newest
    function thinIfNeeded() {
        if (countSnaps.get().c <= KEYFRAME_BUDGET) return;   // thin ONLY when the count actually exceeds the budget
        const maxT = maxTickStmt.get().m;
        // smallest power-of-2 stride whose uniform grid over [0,maxT] fits the budget (grid ~= floor(maxT/(BASE*stride))+1,
        // +1 for the newest). Derived from the span every time -> can't over-coarsen, and self-corrects a prior over-thin.
        let stride = 1;
        while (Math.floor(maxT / (KEYFRAME_BASE * stride)) + 2 > KEYFRAME_BUDGET) stride *= 2;
        keyframeStride = stride;
        db.exec('BEGIN');
        try { thinGridStmt.run(KEYFRAME_BASE, keyframeStride, maxT); setMetaStmt.run('keyframeStride', String(keyframeStride)); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
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
        thinIfNeeded();                                       // bound the keyframe count (own txn; safe for a concurrent WAL reader)
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
    // Wait out a brief writer lock instead of failing "database is locked". This matters for an EXTINCT run: the generator
    // resumes it, writes nothing (0 living -> loop skipped), then finish() checkpoints/closes -- a short exclusive window the
    // read-only reader would otherwise hit while opening. 5s covers it; a live run never finishes so never conflicts.
    db.exec('PRAGMA busy_timeout = 5000');
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
    // downsampled population+food curve for the slider/graph across the WHOLE run (bounded rows -- N4). Prefers the
    // fine-grained ticks stream; when it is absent (this app records only keyframes) it derives the curve from snapshot
    // heads instead, cached keyed by (frontier, snapshot count) so a repeated poll while a live run grows is cheap.
    let _snapSeries = null;   // { hi, count, series } cache of the snapshot-derived curve
    async function snapshotSeries(hi) {
        const count = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE tick <= ?').get(hi).c;
        if (!_snapSeries || _snapSeries.hi !== hi || _snapSeries.count !== count) {
            // iterate row-by-row (not .all()) -- snapshot blobs are multi-MB, so materializing the whole run at once
            // would spike to GBs; this holds one blob at a time and inflates only its head.
            const series = [];
            for (const r of db.prepare('SELECT tick, gz FROM snapshots WHERE tick <= ? ORDER BY tick').iterate(hi)) {
                const s = await snapHeadStats(r.gz); series.push({ tick: r.tick, pop: s.pop, food: s.food });
            }
            _snapSeries = { hi, count, series };
        }
        return _snapSeries.series;
    }
    async function getPopSeries({ maxPoints = 1000 } = {}) {
        const hi = frontier();
        const rows = db.prepare('SELECT tick, pop, food FROM ticks WHERE tick <= ? ORDER BY tick').all(hi);
        const base = rows.length ? rows : await snapshotSeries(hi);
        const series = downsample(base, maxPoints);
        // attach per-keyframe stats (diversity + life expectancy) written alongside snapshots -> aligned by tick. Absent
        // (older runs with an empty stats table) -> div/life null, and the graph just omits those lines. Bounded rows.
        const statsRows = db.prepare('SELECT tick, json FROM stats WHERE tick <= ? ORDER BY tick').all(hi);
        const byTick = new Map();
        for (const s of statsRows) { try { byTick.set(s.tick, JSON.parse(s.json)); } catch { /* skip a torn row */ } }
        return series.map(r => { const j = byTick.get(r.tick); return { tick: r.tick, pop: r.pop, food: r.food, div: j ? (j.div ?? null) : null, life: j ? (j.life ?? null) : null }; });
    }

    return { db, frontier, meta, runConfig, getKeyframe, getStats, getPopSeries, close() { db.close(); } };
}

// ---- parameter-timeline commit (main process) --------------------------------------------------------------------
// Apply an option-keyframe edit to a run: rewind the run to just before `tick`, write the new config, so a resume
// re-simulates forward under the new schedule. ONE atomic transaction on ONE fresh connection (I3) -- a crash leaves
// the run either fully-old (rolled back) or fully-applied-and-resumable. The CALLER must have validated newRunConfig
// with resolveWorldConfig() BEFORE calling (I4), and must ensure the generator child has exited first (I6).
//
//   newRunConfig : the full { seed, config } object to store (config already carries the edited schedules)
//   tick         : the edit tick T. Uniform rule: delete tick >= T (keyframes < T survive, computed under the OLD
//                  value, so the change lands AT T). At T=0 this deletes keyframe-0 too -> the generator re-seeds it
//                  from the edited stored config on resume, regenerating the founders under the new parameters. No
//                  special case: a tick-0 edit regenerates the founding frame exactly as any tick regenerates its frame.
// Returns { anchor } -- the newest surviving keyframe tick (= the resume point / new frontier).
export function commitParamEdit(path, { newRunConfig, tick }) {
    if (!existsSync(path)) throw new Error(`commitParamEdit: no run at ${path}`);
    if (!newRunConfig || !newRunConfig.config) throw new Error('commitParamEdit: newRunConfig must be { seed, config }');
    const T = tick >>> 0;
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000;');   // wait out any lingering lock rather than throwing SQLITE_BUSY
    try {
        const setMeta = (k, v) => db.prepare('INSERT OR REPLACE INTO run_meta (k,v) VALUES (?,?)')
            .run(k, typeof v === 'string' ? v : JSON.stringify(v));
        db.exec('BEGIN');
        try {
            // Uniform (no tick-0 special case): delete everything AT or AFTER T. Keyframes < T survive (computed under
            // the OLD value; the change lands AT T). At T=0 this deletes keyframe-0 too -> nothing survives -> the
            // generator re-seeds keyframe-0 from the (edited) stored config on resume (run-gen's fresh path). So a
            // tick-0 edit regenerates the founders under the new parameters, exactly like any other tick regenerates.
            for (const tbl of ['snapshots', 'stats', 'births', 'deaths', 'eats', 'ticks']) {
                db.prepare(`DELETE FROM ${tbl} WHERE tick >= ?`).run(T);
            }
            const newest = db.prepare('SELECT MAX(tick) AS m FROM snapshots').get().m;   // null iff T=0 (re-seed on resume)
            const anchor = newest == null ? -1 : newest;
            setMeta('runConfig', newRunConfig);          // I5: resume restores/re-seeds from runConfig().config ...
            setMeta('config', newRunConfig.config);      // ... keep the plain `config` key in sync too
            setMeta('frontier', String(anchor));         // rewind frontier to the resume anchor (-1 = pre-seed)
            setMeta('done', '0');                        // a previously-extinct/finished run is live again
            db.exec('COMMIT');
            return { anchor };
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    } finally { db.close(); }
}

// Import a foreign world state at the playhead tick T -- the "branch the run at import" edit. Like commitParamEdit
// (future ticks are invalidated + the run resumes), BUT the imported state also BECOMES the keyframe at T (rather than
// re-simulating a surviving keyframe forward). So: delete tick >= T, INSERT the imported snapshot as keyframe-T, adopt
// the imported config, rewind frontier to T. On resume the generator restores keyframe-T (the import) and ticks
// forward, and playback restores the same keyframe -- so both stay in lockstep, exactly as after any keyframe.
//   newRunConfig : { seed, config } -- the config the imported state was serialized under (governs forward sim + restore)
//   tick         : the playhead T where the import lands (>= 0)
//   snapshot     : a World.serialize() object (the imported pool frame)
// The snapshot's clock is FORCED to T so world-clock stays aligned with the DB timeline (parameter schedules, head, and
// keyframe scheduling are all keyed off the clock). Swimbot age is a relative counter (not clock-derived), so relocating
// the frame in time leaves ages/energies untouched -- only the absolute time label moves. Returns { anchor: T }.
export function commitImport(path, { newRunConfig, tick, snapshot }) {
    if (!existsSync(path)) throw new Error(`commitImport: no run at ${path}`);
    if (!newRunConfig || !newRunConfig.config) throw new Error('commitImport: newRunConfig must be { seed, config }');
    if (!snapshot || typeof snapshot !== 'object') throw new Error('commitImport: snapshot object required');
    const T = tick >>> 0;
    const snap = { ...snapshot, clock: T };   // relocate to the DB tick (see note above); age is relative so unaffected
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000;');
    try {
        const setMeta = (k, v) => db.prepare('INSERT OR REPLACE INTO run_meta (k,v) VALUES (?,?)')
            .run(k, typeof v === 'string' ? v : JSON.stringify(v));
        db.exec('BEGIN');
        try {
            for (const tbl of ['snapshots', 'stats', 'births', 'deaths', 'eats', 'ticks']) {
                db.prepare(`DELETE FROM ${tbl} WHERE tick >= ?`).run(T);   // invalidate the future (keyframes < T survive)
            }
            db.prepare('INSERT INTO snapshots (tick, gz) VALUES (?, ?)').run(T, encode(snap));   // imported state IS keyframe-T
            setMeta('runConfig', newRunConfig);          // resume restores keyframe-T under THIS config
            setMeta('config', newRunConfig.config);
            setMeta('frontier', String(T));              // T is the newest keyframe = resume anchor
            setMeta('done', '0');
            db.exec('COMMIT');
            return { anchor: T };
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    } finally { db.close(); }
}
