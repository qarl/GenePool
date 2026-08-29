// SPIKE — shared setup for the baseline (single-thread) and the parallel run, so both simulate the SAME bots
// and can be compared bit-for-bit. Ecology is disabled (no metabolism, no swim cost, effectively no aging) so
// population is fixed at N and the per-tick compute is a stable, repeatable perf probe.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'test', 'fixtures', 'jj-macro-seed42.json'), 'utf8'));
const GENES = FIX.init.swimbots.map(s => Array.from(Buffer.from(s.genes, 'base64'))); // junk-zeroed founder genomes

export const MASTER_SEED = 9;
export const OBSTACLE = [{ x: 40, y: 40 }, { x: 80, y: 40 }];

function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function makeConfig(poolSize) {
    return {
        ...FIX.config,
        pool: { left: 0, top: 0, right: poolSize, bottom: poolSize },
        // ecology OFF -> fixed N, stable per-tick cost (this is a perf probe, not an ecology run):
        baseMetabolism: 0, swimEnergyCost: 0, maximumLifeSpan: 1e9,
    };
}

// Deterministic per-id founder data (same regardless of how the ids are later partitioned across workers).
export function makeFounders(n, poolSize, seed = 1234) {
    const rng = mulberry32(seed);
    const founders = new Array(n);
    for (let i = 0; i < n; i++) {
        founders[i] = {
            genes: GENES[i % GENES.length], // cycle the ~240 junk-zeroed genomes -> varied body shapes/colors
            age: Math.floor(rng() * 10000),
            x: rng() * poolSize, y: rng() * poolSize,
            angle: rng() * 360 - 180, energy: 85,
        };
    }
    return founders;
}
