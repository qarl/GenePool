// Shared math / genome-format constants for the engine.
//
// Forked from JJ's MathConstants.js + SwimbotTypes.js (values verified identical), consolidated into one
// explicit ES-module source so the reused science files import them instead of relying on a shared global
// scope (PLAN-restructure.md §15). These are the genome FORMAT and math identities -- legitimately
// engine-fixed (PLAN §11), not world-config.

export const ZERO = 0.0;
export const ONE = 1.0;
export const ONE_HALF = 0.5;
export const PI2 = Math.PI * 2.0;
export const NULL_INDEX = -1;

// Genome format
export const BYTE_SIZE = 256;      // a gene is an integer in [0, BYTE_SIZE)
export const NUM_GENES = 256;      // genes per genome
// Single source of truth for the coding/junk boundary (JJ had this dual-sourced: Embryology's dynamic
// count vs a hardcoded NUM_GENES_USED=112 -- PLAN §12). The decode fills exactly this many; genes
// [NUM_GENES_USED, NUM_GENES) are junk DNA (reproductive-isolation markers).
export const NUM_GENES_USED = 112;

// Body/morphology format
export const NULL_PART = -1;
export const ROOT_PART = 0;
export const MIN_PARTS = 2;
export const MAX_PARTS = 16;
