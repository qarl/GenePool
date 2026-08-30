// Run + body identity for run files (the "UUID thing" from docs/DESIGN-DECISIONS.md §"INDIVIDUAL ID").
//
// A per-body UUID that DISTINGUISHES individuals (clones share a genome, but each BODY is its own thing) --
// but made REPRODUCIBLE rather than random (Karl's call, 2026-08-29): replaying a run must yield the SAME run
// file, UUIDs and all, because the whole engine was built to be bit-reproducible/auditable. A random UUIDv4
// (what DESIGN-DECISIONS.md literally proposed) would break that. So instead:
//
//   runId    = content-address of the run's INITIAL CONDITIONS (v8 UUID = sha256 of the inputs). Same inputs
//              -> same runId (replay reproduces); ANY difference (different seed, config, or uploaded genomes)
//              -> different runId (no cross-run collision, even for two pools sharing an env seed). It EXCLUDES
//              the run LENGTH, so a short run is a true prefix of a longer one (same bodies -> same UUIDs).
//   bodyUuid = UUIDv5(namespace = runId, name = the engine's never-reused integer id). Deterministic, stable
//              across every event a body emits, globally unique across runs.
//
// This lives in the OBSERVER layer, never in the engine: the engine keeps emitting integer ids and stays
// bit-identical. If a future loader takes explicit uploaded genomes (not seed-derived founders), fold those
// genomes into `computeRunId`'s inputs so the content-address stays honest.

import { createHash } from 'node:crypto';

function formatUuid(buf16, version) {
    const b = Buffer.from(buf16.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | (version << 4);   // version nibble
    b[8] = (b[8] & 0x3f) | 0x80;             // RFC 4122 variant
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Canonical, key-order-independent JSON so {a,b} and {b,a} content-address identically.
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    // Guard silent content-address collisions: JSON.stringify maps NaN/Infinity/-Infinity all to "null" (so
    // distinct malformed inputs would share a runId), and bigint throws unhelpfully. Inputs must be finite & JSON-safe.
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`computeRunId: non-finite number in run inputs (${v}) -- inputs must be finite & JSON-safe`);
    if (typeof v === 'bigint') throw new Error('computeRunId: bigint in run inputs -- inputs must be JSON-safe');
    return JSON.stringify(v);
}

// runId = deterministic v8 UUID over the run's initial conditions. Pass the things that DEFINE the run's
// starting state (seed, config, founder/food setup, pool) -- NOT the tick count.
export function computeRunId(inputs) {
    const digest = createHash('sha256').update(canonical(inputs)).digest();
    return formatUuid(digest, 8);
}

// bodyUuid = UUIDv5(runId, integer id). Returns null for a sentinel/negative id (e.g. NULL_INDEX) so a birth
// with no real mate stores NULL rather than a bogus identity.
export function bodyUuid(runId, id) {
    if (id == null || id < 0) return null;
    const hex = String(runId).replace(/-/g, '');
    // Reject a malformed runId LOUDLY: Buffer.from(str,'hex') silently stops at the first non-hex char (empty
    // buffer if the first char is bad), which would collapse every bad runId to ONE namespace -> cross-run
    // UUID collisions with no error. A real UUID is 32 hex chars.
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`bodyUuid: runId must be a UUID (32 hex chars), got ${JSON.stringify(runId)}`);
    const ns = Buffer.from(hex, 'hex'); // 16 bytes
    const digest = createHash('sha1').update(ns).update(String(id)).digest();
    return formatUuid(digest, 5);
}
