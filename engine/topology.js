// Topology (PLAN-restructure.md §7): the ONE seam every INTER-entity Euclidean route goes through --
// perception distance, food proximity, direction-to-goal, closeness. This is the "genuinely-expensive-to-
// retrofit" P1 commitment: centralize it now so P4 (torus) is a LOCALIZED swap (override displacement/wrap
// here) instead of hunting every raw subtraction, and lock it with the global-offset-invariance golden.
//
// Walls == FLAT: displacement is plain subtraction, distance is hypot, wrap is identity (the mover already
// clamps/bounces off the config bounds). Because flat displacement IS the raw subtraction these call sites
// did before, routing through here is bit-for-bit -- the whole golden battery (incl. the parallel G1 gate,
// which keeps using the shared FLAT default) stays frozen.
//
// SCOPE: only INTER-entity routes use this. A swimbot's OWN geometry -- part-to-part distances, per-part
// velocity across its position history, its own travelled-distance -- stays raw subtraction in one locally-
// continuous frame; it never wraps (§7: on a torus only the reference node is canonicalized, the body's
// history shifts with it). Distance/distanceSquared are order-independent (squared); displacement is
// directional (from a to b, i.e. b - a), matching `dir = goal; dir.subtract(self)`.

// Scalar (ax,ay,bx,by) API -- allocation-free, so it fits the mate-selection / perception hot loops (which
// hold positions as Vector2D .x/.y or SoA rootX/rootY scalars alike) without wrapping objects.
class FlatTopology {
    // shortest displacement from a to b (b - a). Writes into `out` (a Vector2D-like {x,y}) to avoid allocation.
    displacement(ax, ay, bx, by, out) { out.x = bx - ax; out.y = by - ay; return out; }

    // squared distance a<->b. Sign-agnostic, so this is bit-identical to Vector2D.getDistanceSquaredTo.
    distanceSquared(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

    // distance a<->b = sqrt(dx^2 + dy^2), bit-identical to Vector2D.getDistanceTo (same squared -> same sqrt).
    distance(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }

    // walls: no wrap (the mover clamps/bounces). Present as the P4 seam. Identity here.
    wrap(x, y, out) { out.x = x; out.y = y; return out; }

    isToroidal() { return false; }
}

// Shared default so callers that don't inject one (the parallel path, standalone Swimbots) behave EXACTLY as
// before this seam existed -- flat everywhere = the pre-topology engine.
export const FLAT = new FlatTopology();

// Pick a topology from pool config. Walls (default) -> FLAT. Torus is P4 (a new TorusTopology overriding
// displacement with per-axis minimum image + wrap with mod) -- deliberately not built yet.
export function makeTopology(config) {
    if (config && config.topology === 'torus') {
        throw new Error('topology "torus" is not implemented yet (P4)');
    }
    return FLAT;
}

export { FlatTopology };
