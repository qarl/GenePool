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

import { resolvePoolBounds } from './constants.js';

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

// Positive modulo: JS `%` keeps the sign of the dividend, so a naive `x % n` breaks for x < LEFT. (§7)
function mod(a, n) { return ((a % n) + n) % n; }

// TORUS (§7): edges wrap. displacement is the per-axis MINIMUM IMAGE (shortest wrapped vector); wrap folds a
// position back into [LEFT,LEFT+W) x [TOP,TOP+H). Separable -> one round/mod per axis, zero enumeration,
// deterministic. Distance/distanceSquared are order-independent (squared); displacement is directional (b-a,
// minimum-imaged). A torus REBASELINES behavior (no walls) -- it is NOT bit-identical to FLAT, by design.
class TorusTopology {
    constructor(pool) {
        this._left = pool.left; this._top = pool.top;
        this._w = pool.right - pool.left;
        this._h = pool.bottom - pool.top;
    }

    displacement(ax, ay, bx, by, out) {
        let dx = bx - ax; dx -= this._w * Math.round(dx / this._w);
        let dy = by - ay; dy -= this._h * Math.round(dy / this._h);
        out.x = dx; out.y = dy; return out;
    }

    distanceSquared(ax, ay, bx, by) {
        let dx = bx - ax; dx -= this._w * Math.round(dx / this._w);
        let dy = by - ay; dy -= this._h * Math.round(dy / this._h);
        return dx * dx + dy * dy;
    }

    distance(ax, ay, bx, by) {
        let dx = bx - ax; dx -= this._w * Math.round(dx / this._w);
        let dy = by - ay; dy -= this._h * Math.round(dy / this._h);
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Fold (x,y) back into the pool rectangle. Used by the mover to wrap a body across a seam (P4b).
    wrap(x, y, out) {
        out.x = this._left + mod(x - this._left, this._w);
        out.y = this._top + mod(y - this._top, this._h);
        return out;
    }

    getLeft() { return this._left; }
    getTop() { return this._top; }
    getWidth() { return this._w; }
    getHeight() { return this._h; }
    isToroidal() { return true; }
}

// Shared default so callers that don't inject one (the parallel path, standalone Swimbots) behave EXACTLY as
// before this seam existed -- flat everywhere = the pre-topology engine.
export const FLAT = new FlatTopology();

// Pick a topology from pool config. Walls (default) -> FLAT. Torus -> TorusTopology over the pool bounds.
export function makeTopology(config) {
    if (config && config.topology === 'torus') {
        return new TorusTopology(resolvePoolBounds(config.pool));
    }
    return FLAT;
}

export { FlatTopology, TorusTopology };
