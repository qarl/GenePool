// Canonical genome — a validated, fixed-length byte array (PLAN-restructure.md §12 / CV-3).
//
// Canonicalization is legitimate input-form validation the engine owes (not a world-bound): identity
// requires a canonical byte form, and out-of-range genes make the body decode loop unbounded (a DoS at
// import). We coerce to integers, CLAMP to [0,255] (explicitly -- NOT the Uint8Array constructor's
// silent mod-256 WRAP), and enforce length. Snapshotting into a fresh Uint8Array also fixes JJ's
// aliasing hazard (his getGenes() returns the live buffer by reference).

import { NUM_GENES } from './constants.js';

export const GENOME_LENGTH = NUM_GENES;

// Coerce arbitrary genome input to a validated Uint8Array(GENOME_LENGTH).
//   - string genes ("225" -- the M-stringgene class) are coerced to numbers
//   - non-integers are truncated toward zero
//   - values are CLAMPED to [0,255] (300 -> 255, -5 -> 0), never wrapped
//   - wrong length or non-finite genes are rejected (genuinely invalid input, not clampable)
export function canonicalizeGenome(input) {
    if (!Array.isArray(input) && !ArrayBuffer.isView(input)) {
        throw new Error('canonicalizeGenome: expected an Array or typed array (got ' + (input === null ? 'null' : typeof input) + ')');
    }
    if (input.length !== GENOME_LENGTH) {
        throw new Error(`canonicalizeGenome: expected length ${GENOME_LENGTH}, got ${input.length}`);
    }
    const out = new Uint8Array(GENOME_LENGTH);
    for (let i = 0; i < GENOME_LENGTH; i++) {
        let v = input[i];
        if (typeof v === 'string') v = Number(v);
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`canonicalizeGenome: gene ${i} is not a finite number (${String(input[i])})`);
        }
        v = Math.trunc(v);
        out[i] = v < 0 ? 0 : (v > 255 ? 255 : v); // explicit clamp
    }
    return out;
}

// True iff two canonical genomes are byte-equal.
export function genomesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
