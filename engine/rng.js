// Addressed-draw RNG — the ONE randomness primitive (PLAN-restructure.md §3, decision D-d).
//
// draw(masterSeed, DOMAIN, ...address) -> a float in [0, 1). Every random value is a pure function of its
// ADDRESS, so its existence/count/value are independent of storage layout and scan order (the §0 contract
// holds by construction). A "stream" (own-decisions randomness) is just draw(...) with a monotonically
// bumped counter in the address -- one primitive, not two. Cross-entity events put the other entity in
// the address instead of a counter, so a per-neighbour draw can never couple to the neighbour-finding
// implementation (the wave-1 landmine).
//
// DOMAIN is a mandatory tag from a single disjoint enum. INPUT key spaces are disjoint by construction:
// the domain, the address arity, and each address value are folded distinctly, so two draws with a
// different (domain, address) are always different INPUTS. The 53-bit OUTPUT is a hash, so two distinct
// inputs may still coincide in value at birthday rate (~2^26 draws) -- harmless, because every consumer
// uses its draw independently or breaks ties by stableID (§5); no consumer treats a draw value as a
// unique key. Integer-lane (Math.imul / uint32) so the bits are portable across JS engines; two
// decorrelated 32-bit mixes are combined into a full-precision [0,1) double (splitmix-class output).

export const DOMAIN = Object.freeze({
    SWIMBOT_LIFE:     1,   // a swimbot's own per-life decisions (address: entityID, counter)
    OFFSPRING_GENOME: 2,   // crossover+mutation of a newborn's genome (address: newbornID, counter)
    POOL_FOUNDERS:    3,   // founder generation + placement
    POOL_FOOD_INIT:   4,   // initial food layout
    POOL_FOOD_REGEN:  5,   // per-tick food regeneration
    MATE_PREF:        6,   // random mate preference (address: lookerID, candidateID, tick)
    INTERACTIVE:      7,   // authoring draws (inject-random / zap / demo config)
});
const DOMAIN_VALUES = new Set(Object.values(DOMAIN));

// splitmix32 finalizer: strong avalanche from pure uint32 integer ops (bit-identical on every engine).
function mix32(x) {
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = (x ^ (x >>> 16)) >>> 0;
    return x;
}

// Fold a non-negative safe integer (up to 2^53) into the running hash via BOTH 32-bit halves, so entity
// IDs / ticks that eventually exceed 2^32 stay distinct.
function foldInt(h, n) {
    if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
        throw new Error('rng: address parts must be non-negative safe integers, got ' + String(n));
    }
    const lo = n >>> 0;
    const hi = Math.floor(n / 4294967296) >>> 0;
    h = mix32((h ^ mix32(lo)) >>> 0);
    h = mix32((h ^ mix32(hi)) >>> 0);
    return h >>> 0;
}

const SEED_CONST = 0x9e3779b9; // arbitrary nonzero start (golden-ratio constant)

// The primitive. `address` is a list of non-negative integers whose meaning is fixed per DOMAIN.
export function draw(masterSeed, domain, ...address) {
    if (!DOMAIN_VALUES.has(domain)) throw new Error('rng: unknown DOMAIN tag ' + String(domain));
    let h = SEED_CONST;
    h = foldInt(h, masterSeed);
    h = foldInt(h, domain);
    h = foldInt(h, address.length); // fold arity too, belt-and-suspenders against shape reuse
    for (let i = 0; i < address.length; i++) h = foldInt(h, address[i]);
    // Combine two decorrelated 32-bit mixes into a full-precision 53-bit [0,1) double: hi contributes 27
    // bits, lo 26 bits. (32-bit alone birthday-collides at ~2^16; this pushes that to ~2^26.5 and gives
    // double-resolution values -- the "splitmix-class" output the plan §3 specifies.)
    const hi = mix32(h) >>> 5;                           // 27 bits
    const lo = mix32((h ^ 0x9e3779b9) >>> 0) >>> 6;      // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;      // (hi*2^26 + lo) / 2^53  in [0, 1)
}

// A per-(entity/pool, domain) sequential stream: draw(...) with a bumped counter at the tail of the
// address. The counter is the ONLY per-stream state (one integer) -- so a checkpoint that saves it can
// resume bit-exactly (PLAN §13). Everything else is recomputed from the address.
export function makeStream(masterSeed, domain, ...prefix) {
    let counter = 0;
    return {
        next() { return draw(masterSeed, domain, ...prefix, counter++); },
        get position() { return counter; },
        set position(c) {
            if (!Number.isInteger(c) || c < 0 || c > Number.MAX_SAFE_INTEGER) {
                throw new Error('rng stream: position must be a non-negative safe integer');
            }
            counter = c;
        },
    };
}
