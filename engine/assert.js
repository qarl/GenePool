// Throw-based assertions for the engine.
//
// JJ's Utility.assert/assertInteger call the browser alert() and then CONTINUE (a no-op in Node), so they
// never actually enforced anything (the "S1 blind spot"). The engine's versions THROW -- a real
// computation guarantee, and legitimate input-form validation (PLAN-restructure.md §11/§15). No alert,
// no globals.

export function assert(condition, message) {
    if (!condition) throw new Error('assert failed: ' + (message || '(no message)'));
}

export function assertInteger(value, message) {
    if (!Number.isInteger(value)) {
        throw new Error('assertInteger failed: ' + (message || '(no message)') + ' (got ' + String(value) + ')');
    }
}

// INPUT-BOUNDARY validation (distinct from the compute-invariant assert()s above). The engine's internal assert()s
// encode true computation guarantees that hold for any VALID input (canonicalized genes 0..255, finite numeric
// state) -- an L4 audit + a 1000-genome soak confirmed valid inputs never trip them. But a caller can hand
// loadSwimbot/loadFood a MALFORMED value (a negative age, a NaN position) that would otherwise surface much later
// as an obscure mid-tick assert abort (e.g. `_growthScale >= 0.0`) or silently corrupt the sim (NaN propagation).
// requireFinite fails FAST, at the door, naming the field + value -- form validation, not an engine-imposed limit.
export function requireFinite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number (got ${value === undefined ? 'undefined' : String(value)})`);
    }
}
