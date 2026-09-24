'use strict';
// Portable math for the deterministic engine (epoch "pmath-1").
//
// The engine must produce BYTE-IDENTICAL results on any JS engine (any V8 version, any other engine) and any
// CPU. IEEE-754 / ECMAScript pin + - * / sqrt, decimal->double parsing, and Number::toString to the last bit
// everywhere; they do NOT pin the transcendentals (sin/cos/pow/hypot), which vary across engine versions -- that
// difference silently forks a chaotic sim. This module replaces the 9 transcendental call sites with
// implementations built ONLY from the pinned operations, so the trajectory is reproducible everywhere.
//
// Accuracy vs the real functions is explicitly NOT a goal (Karl: "we don't need the accuracy, we just need
// identical behavior run to run"). psin/pcos are a frozen lookup table + linear interpolation (~3x faster than
// native Math.sin, error ~5e-6 at N=1024). See docs/PLAN-engine-portable-math.md.

import { SIN_N, SIN_TABLE } from './pmath-table.js';

export const ENGINE_EPOCH = 'pmath-1';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const SCALE = SIN_N / TWO_PI;   // radians -> table index (one portable divide, computed once)
const MASK = SIN_N - 1;         // SIN_N is a power of two
const T = SIN_TABLE;

// psin/pcos: table lookup + linear interp. Every op here is bit-identical on every engine/CPU:
//   * (Number::multiply), floor (exact), - (Number::subtract), & (ToInt32 -- fully specified for any double).
// `i & MASK` is correct two's-complement modulo for negative i (e.g. -3 & 1023 = 1021), and `f = t - i` is
// exact (Sterbenz), so the result is the same double for the same input on every conforming engine.
function _psin(x) {
  const t = x * SCALE;
  const i = Math.floor(t);
  const f = t - i;
  const k = i & MASK;
  return T[k] + (T[k + 1] - T[k]) * f;
}
function _pcos(x) { return _psin(x + HALF_PI); }

// 2^f for f in [0,1): Taylor of e^(f*ln2). Coefficients are (ln2)^k/k! as frozen literals -> portable. c0 is
// exactly 1, so 2^0 = 1 exactly (keeps the integer-exponent contract below exact).
function _pow2frac(f) {
  return 1 + f * (0.6931471805599453 + f * (0.2402265069591007 + f * (0.05550410866482158
    + f * (0.009618129107628477 + f * (0.001333355814642844 + f * 0.00015403530393381606)))));
}
// 2^x, portable. 2^i (integer part) is EXACT via halving/doubling -> ppow2(integer) is exact
// (ppow2(0)=1, ppow2(1)=2, ppow2(-1)=0.5, ppow2(-2)=0.25), preserving the mutation-rate contract. Only the
// fractional part is approximated. Guards keep pathological exponents deterministic (over/underflow).
function _ppow2(x) {
  const i = Math.floor(x);
  if (i > 1100) return Infinity;
  if (i < -1100) return 0;
  let p = 1;
  if (i >= 0) for (let k = 0; k < i; k++) p *= 2;
  else for (let k = 0; k < -i; k++) p /= 2;
  return p * _pow2frac(x - i);
}

// hypot -> sqrt(a^2+b^2). Math.hypot is itself implementation-defined; sqrt is IEEE correctly-rounded/portable.
function _phypot(a, b) { return Math.sqrt(a * a + b * b); }

// PMATH_PASSTHROUGH (env GENEPOOL_PMATH_PASSTHROUGH): route back to native Math for the neutrality proof --
// with it on, the swapped engine must reproduce the PRE-epoch golden bit-for-bit, proving the swap changed only
// the trig VALUES and introduced no logic change. Off by default; a permanent regression guard.
const PASS = !!(globalThis.process && globalThis.process.env && globalThis.process.env.GENEPOOL_PMATH_PASSTHROUGH);

export const psin = PASS ? Math.sin : _psin;
export const pcos = PASS ? Math.cos : _pcos;
export const ppow2 = PASS ? ((x) => Math.pow(2, x)) : _ppow2;
export const phypot = PASS ? Math.hypot : _phypot;
