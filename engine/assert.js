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
