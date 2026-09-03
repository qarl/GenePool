// Compare two raw-RGBA frames. Two policies (see docs/PLAN-visual-goldens.md):
//   exact:true  -> byte-identical required (recording arch / same-run gates).
//   exact:false -> cross-arch tolerance: maxΔ ≤ 1 AND nonzero-diff-fraction ≤ ε. maxΔ≤1 ALONE would silently pass a
//                  systematic whole-frame 1-LSB shift (gamma/AA regression); the fraction cap is the real guard.
import { encode } from './png.mjs';

export const CROSS_ARCH_FRACTION = 0.0005;   // 0.05%; measured arm64↔x64 residual was 0.000% (a few pixels)

export function compare(a, b, { exact = true, maxFraction = CROSS_ARCH_FRACTION } = {}){
  if (a.length !== b.length) return { pass: false, reason: 'size mismatch', maxDelta: 255, diffPixels: a.length/4, diffFraction: 1 };
  const n = a.length / 4;
  let maxDelta = 0, diffPixels = 0;
  for (let i = 0; i < a.length; i += 4){
    let d = 0; for (let c = 0; c < 3; c++){ const v = Math.abs(a[i+c] - b[i+c]); if (v > d) d = v; }
    if (d > maxDelta) maxDelta = d; if (d > 0) diffPixels++;
  }
  const diffFraction = diffPixels / n;
  const pass = exact ? (maxDelta === 0) : (maxDelta <= 1 && diffFraction <= maxFraction);
  return { pass, maxDelta, diffPixels, diffFraction, exact, maxFraction };
}

// Amplified diff visualization (channel-max Δ × 16, clamped) as a PNG buffer (flip -> upright).
export function diffPng(a, b, w, h){
  const out = Buffer.alloc(w*h*4);
  for (let i = 0; i < w*h; i++){ let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[i*4+c] - b[i*4+c]));
    const v = Math.min(255, d*16); out[i*4] = v; out[i*4+1] = v; out[i*4+2] = v; out[i*4+3] = 255; }
  return encode(out, w, h, { flip: true });
}
