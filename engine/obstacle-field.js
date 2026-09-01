// ObstacleField (§8) — the pool's physical environment: a LIST of Obstacles (each a masked line segment). The
// engine imposes NO obstacle; the field is built from per-pool config, and an EMPTY field is legal. Movement
// collision ACCUMULATES the force of every movement-masked obstacle a body touches; vision/access is obstructed if
// ANY vision-masked obstacle blocks the segment. With a single obstacle both reduce exactly to the old
// single-Obstacle path, so a default (one-obstacle) world stays bit-identical (goldens + parallel G1 unchanged).
//
// BROAD-PHASE (§8): with many obstacles, a static grid buckets each segment (by its thickness-expanded AABB) into
// the cells it overlaps, so a collision/line-of-sight query tests only nearby obstacles instead of the whole list.
// This is a PURE PERF SWITCH -- the grid returns a SUPERSET of the relevant obstacles and they are tested in the
// SAME ascending-index order as the linear scan, so the result (incl. the accumulated force, first-hit-copy and
// all) is byte-identical to the linear path. Below a threshold, or on a torus (seam images complicate bucketing),
// the linear scan runs instead -- identical result either way. Correctness is fuzzed grid==linear (obstacle-broadphase.test.js).

import { Vector2D } from './vector2d.js';
import { Obstacle } from './obstacle.js';
import { FLAT } from './topology.js';
import { resolvePoolBounds } from './constants.js';

const GRID_THRESHOLD = 12; // linear is faster below this; the grid is a net win above it (result identical either way)

export class ObstacleField {
    constructor() {
        this._obstacles = [];
        this._pool = resolvePoolBounds(undefined);
        this._topology = FLAT;
        this._collisionForce = new Vector2D();
        this._grid = null;      // Map<"cx:cy", number[] of obstacle indices>, or null (linear scan)
        this._gridCell = 0;
        this._gridMaxThick = 0; // max obstacle thickness (collision query reach)
        this._seen = null;      // epoch-tagged dedup for gather (obstacle index -> last epoch it was gathered)
        this._epoch = 0;
        this._cand = [];        // reusable gathered-candidate index buffer (sorted ascending before testing)
        this._collidePos = null; this._collideR = 0; this._collideHit = false; // current getCollision query state (for _applyCollision)
    }

    setPoolBounds(pool) { this._pool = resolvePoolBounds(pool); for (const o of this._obstacles) o.setPoolBounds(pool); this._buildGrid(); }
    setTopology(topology) { this._topology = topology; for (const o of this._obstacles) o.setTopology(topology); this._buildGrid(); }

    // Build the field from a config list: [{ a:{x,y}, b:{x,y}, thickness?, mask? }]. Empty/absent -> no obstacles.
    // Pool bounds + topology are applied to each obstacle BEFORE its endpoints so the per-obstacle clamp / torus
    // logic (in _calculateStuff) sees them. Replaces any prior contents; (re)builds the broad-phase grid.
    setObstacles(list) {
        this._obstacles = [];
        for (const spec of (list || [])) {
            const o = new Obstacle(spec.thickness, spec.mask);
            o.setPoolBounds(this._pool);
            o.setTopology(this._topology);
            o.setEndpointPositions(spec.a, spec.b);
            this._obstacles.push(o);
        }
        this._buildGrid();
    }

    // Static broad-phase index. Only when it pays off (many obstacles) and on flat topology (a torus's shortest-path
    // LoS tests seam images the flat bucketing doesn't hold, so torus uses the linear scan -- correct, just O(n)).
    // Cells are pool-relative; each obstacle is bucketed into every cell its (thickness-expanded) AABB overlaps.
    _buildGrid() {
        const obs = this._obstacles;
        if (obs.length <= GRID_THRESHOLD || this._topology.isToroidal()) { this._grid = null; return; }
        let maxThick = 0;
        for (const o of obs) maxThick = Math.max(maxThick, o.getThickness());
        const cell = Math.max(300, maxThick + 20); // >= a body's reach (bounded ~216) is unnecessary: collision rings scale with r
        const grid = new Map();
        const L = this._pool.left, T = this._pool.top;
        for (let i = 0; i < obs.length; i++) {
            const o = obs[i];
            const [a, b] = o.getEndpoints();
            const t = o.getThickness();
            const cx0 = Math.floor((Math.min(a.x, b.x) - t - L) / cell), cx1 = Math.floor((Math.max(a.x, b.x) + t - L) / cell);
            const cy0 = Math.floor((Math.min(a.y, b.y) - t - T) / cell), cy1 = Math.floor((Math.max(a.y, b.y) + t - T) / cell);
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
                const k = cx + ':' + cy;
                let arr = grid.get(k);
                if (!arr) grid.set(k, arr = []);
                arr.push(i);
            }
        }
        this._grid = grid;
        this._gridCell = cell;
        this._gridMaxThick = maxThick; // for the collision query reach (see getCollision)
        this._seen = new Int32Array(obs.length).fill(-1);
        this._epoch = 0;
    }

    // Gather (into this._cand, ASCENDING, deduped) the obstacle indices bucketed in cells [cx0..cx1]x[cy0..cy1].
    _gather(cx0, cx1, cy0, cy1) {
        // Epoch-tagged dedup. _seen is an Int32Array, so reset before the tag could overflow int32 (else the stored
        // truncated value would stop matching the unbounded JS `epoch` and dedup would silently fail -> an obstacle
        // spanning multiple gathered cells would be counted once PER cell). Reset is O(obstacles) once per ~2^31 gathers.
        if (this._epoch >= 0x7ffffffe) { this._seen.fill(-1); this._epoch = 0; }
        const epoch = ++this._epoch, seen = this._seen, grid = this._grid, cand = this._cand;
        cand.length = 0;
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
            const arr = grid.get(cx + ':' + cy);
            if (!arr) continue;
            for (let j = 0; j < arr.length; j++) { const i = arr[j]; if (seen[i] !== epoch) { seen[i] = epoch; cand.push(i); } }
        }
        cand.sort((x, y) => x - y); // ascending index -> same test order as the linear scan (force accumulation is order-sensitive)
        return cand;
    }

    get length() { return this._obstacles.length; }
    getObstacles() { return this._obstacles; }

    // Checkpoint (H1): the current obstacle specs, so restore rebuilds an identical field. Endpoints are the
    // post-clamp values (setEndpointPositions re-clamps them idempotently -> exact round-trip).
    toSpecs() {
        return this._obstacles.map(o => {
            const [a, b] = o.getEndpoints();
            return { a, b, thickness: o.getThickness(), mask: { ...o.getMask() } };
        });
    }

    // Movement (§8 accumulate-force loop): sum the collision force of every MOVEMENT-masked obstacle the test
    // position touches, in ascending-index order. Returns true iff any collided; the summed force is in
    // getCurrentCollisionForce(). The FIRST hit COPIES the obstacle's force (not 0+f) so a single-obstacle field is
    // BYTE-identical to the old single-Obstacle path -- including the sign of a zero component.
    getCollision(testPosition, radius) {
        const obs = this._obstacles;
        this._collidePos = testPosition; this._collideR = radius; this._collideHit = false;
        if (this._grid) {
            const cell = this._gridCell;
            // Query reach: an obstacle collides only within ~its collision half-width of its segment; the effective
            // reach from `pos` to the NEAREST point of a colliding obstacle's (bucketed) segment is bounded by
            // hypot(thickness + rEff, rEff) with rEff = max(radius, thickness) -- the beyond-endpoint corner, where a
            // plain `radius` budget (and even radius*sqrt2) under-reaches when thickness ~ radius. Use maxThickness as
            // the per-obstacle thickness bound so the ring window is a provable superset for ANY radius (+1 for the
            // cell-boundary). For the engine's bodies (radius <= ~216) this is a small window; it grows with radius.
            const rEff = Math.max(radius, this._gridMaxThick);
            const rings = Math.ceil(Math.hypot(this._gridMaxThick + rEff, rEff) / cell) + 1;
            const pcx = Math.floor((testPosition.x - this._pool.left) / cell), pcy = Math.floor((testPosition.y - this._pool.top) / cell);
            const cand = this._gather(pcx - rings, pcx + rings, pcy - rings, pcy + rings);
            for (let k = 0; k < cand.length; k++) this._applyCollision(obs[cand[k]]);
        } else {
            for (let i = 0; i < obs.length; i++) this._applyCollision(obs[i]);
        }
        return this._collideHit;
    }

    // Test + accumulate one obstacle against the current getCollision query (fields set above). Hoisted out of
    // getCollision so no closure is allocated in that per-body-per-tick hot path.
    _applyCollision(o) {
        if (!o.blocksMovement()) return;
        if (o.getCollision(this._collidePos, this._collideR)) {
            const f = o.getCurrentCollisionForce();
            if (!this._collideHit) { this._collisionForce.setXY(f.x, f.y); this._collideHit = true; } // first hit: exact copy
            else { this._collisionForce.x += f.x; this._collisionForce.y += f.y; } // accumulate
        }
    }

    getCurrentCollisionForce() { return this._collisionForce; }

    // Vision / access: obstructed iff ANY vision-masked obstacle blocks the segment p1 -> p2 (a boolean OR, so
    // order doesn't matter -- the grid gathers a superset covering the p1->p2 span and the result is identical).
    getObstruction(p1, p2) {
        const obs = this._obstacles;
        if (this._grid) {
            const cell = this._gridCell, L = this._pool.left, T = this._pool.top;
            const cx0 = Math.floor((Math.min(p1.x, p2.x) - L) / cell) - 1, cx1 = Math.floor((Math.max(p1.x, p2.x) - L) / cell) + 1;
            const cy0 = Math.floor((Math.min(p1.y, p2.y) - T) / cell) - 1, cy1 = Math.floor((Math.max(p1.y, p2.y) - T) / cell) + 1;
            const cand = this._gather(cx0, cx1, cy0, cy1);
            for (let k = 0; k < cand.length; k++) { const o = obs[cand[k]]; if (o.blocksVision() && o.getObstruction(p1, p2)) return true; }
            return false;
        }
        for (let i = 0; i < obs.length; i++) { const o = obs[i]; if (o.blocksVision() && o.getObstruction(p1, p2)) return true; }
        return false;
    }
}
