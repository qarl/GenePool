// Peek at the evolvable mutation-rate gene (byte 255, read as int8) across a run's keyframes.
// Reports the distribution over LIVING swimbots at the earliest, a few middle, and the latest keyframe,
// so we can see the trajectory (did selection push it down toward -128?). Read-only; safe on a live run.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RUNS = join(homedir(), 'Library/Application Support/genepool-desktop/runs');
const MUT = 255, K = 64, BASE = 0.01;
const i8 = (b) => (b < 128 ? b : b - 256);
const mult = (s) => Math.pow(2, s / K);

function stats(vals) {
    const n = vals.length; if (!n) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const med = sorted[n >> 1];
    return { n, mean, med, min: sorted[0], max: sorted[n - 1] };
}

// coarse histogram over the int8 range in 8 buckets of 32
function histo(vals) {
    const b = new Array(8).fill(0);
    for (const v of vals) b[Math.min(7, Math.floor((v + 128) / 32))]++;
    return b;
}

function fmtRow(label, tick, st, vals) {
    if (!st) { console.log(`  ${label} @tick ${tick}: (no living swimbots)`); return; }
    const h = histo(vals).map(c => String(c).padStart(4)).join(' ');
    console.log(`  ${label} @tick ${String(tick).padStart(9)}  n=${String(st.n).padStart(4)}  ` +
        `gene int8 mean ${st.mean.toFixed(1).padStart(6)}  med ${String(st.med).padStart(4)}  [${st.min}..${st.max}]  ` +
        `rate x${mult(st.mean).toFixed(3)} (eff ${(BASE * mult(st.mean)).toExponential(2)})`);
    console.log(`             histo[-128..127 /32]: ${h}`);
}

function peek(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    const ticks = db.prepare('SELECT tick FROM snapshots ORDER BY tick').all().map(r => r.tick);
    if (!ticks.length) { console.log(`${path}: no keyframes yet`); db.close(); return; }
    const frontierRow = db.prepare("SELECT v FROM run_meta WHERE k='frontier'").get();
    const frontier = frontierRow ? Number(frontierRow.v) : ticks[ticks.length - 1];
    const cfgRow = db.prepare("SELECT v FROM run_meta WHERE k='config'").get();
    const emr = cfgRow ? (JSON.parse(cfgRow.v).evolvableMutationRate === true) : null;
    // earliest, three evenly-spaced middles, latest
    const pick = [ticks[0]];
    for (const f of [0.25, 0.5, 0.75]) pick.push(ticks[Math.floor(f * (ticks.length - 1))]);
    pick.push(ticks[ticks.length - 1]);
    const uniq = [...new Set(pick)];
    console.log(`\n${path.split('/').pop()}  (${ticks.length} keyframes, frontier tick ${frontier}, evolvableMutationRate=${emr})`);
    const get = db.prepare('SELECT gz FROM snapshots WHERE tick=?');
    for (const t of uniq) {
        const row = get.get(t); if (!row) continue;
        const snap = JSON.parse(gunzipSync(row.gz).toString('utf8'));
        const vals = [];
        for (const sb of (snap.swimbots || [])) if (sb.alive && sb.genes) vals.push(i8(sb.genes[MUT]));
        fmtRow(t === ticks[0] ? 'FIRST ' : t === ticks[ticks.length - 1] ? 'LAST  ' : 'mid   ', t, stats(vals), vals);
    }
    db.close();
}

const arg = process.argv[2];
const files = arg
    ? [arg.includes('/') ? arg : join(RUNS, arg)]
    : readdirSync(RUNS).filter(f => /^run-\d+\.db$/.test(f)).sort((a, b) => (+a.match(/\d+/)) - (+b.match(/\d+/))).map(f => join(RUNS, f));
for (const f of files) { try { peek(f); } catch (e) { console.log(`${f}: ${e.message}`); } }
