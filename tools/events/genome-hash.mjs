// Content-address a canonical genome (§12): a stable GENOME-ID = sha256 of the 256 canonical bytes. Pure and
// deterministic, so clones collide BY CONSTRUCTION (the unit of gene-pool dominance / the catalog key). Lives in
// tools/ (Node) -- NOT engine/ -- because engine/ is browser-safe ESM (the viewer imports it) and node:crypto
// would break that. Observers emit genome BYTES to the run file; this side (ingester/analysis) hashes them.

import { createHash } from 'node:crypto';

// genes: Uint8Array(256) or a 256-length array of 0..255. Returns a 64-char lowercase hex sha256.
export function hashGenome(genes) {
    if (!genes || genes.length !== 256) throw new Error(`hashGenome: expected 256 genes, got ${genes ? genes.length : genes}`);
    const u8 = genes instanceof Uint8Array ? genes : Uint8Array.from(genes);
    return createHash('sha256').update(u8).digest('hex');
}
