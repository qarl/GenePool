// SpatialGrid — a uniform grid for O(1)-ish neighbor queries, replacing the O(n^2) perception scan
// (PLAN-restructure.md §19, P2). A BEHAVIOR-PRESERVING optimization: a query returns every entity in the
// 3x3 cell neighborhood of a point; the caller then filters by exact distance, so with cellSize >= the
// query radius the grid yields EXACTLY the same in-radius set as a brute-force scan (proven by the
// grid-vs-brute-force equivalence test on tie-heavy fixtures). The caller imposes its own total order
// (e.g. sort by (d^2, id)), so per-cell iteration order does not affect results.
//
// Entities are opaque; the grid tracks each one's current cell so it can be moved (a swimbot that moved
// this tick) or removed cheaply. cellSize should be >= the largest query radius (SWIMBOT_VIEW_RADIUS),
// so a circle of that radius is fully covered by the 3x3 neighborhood of the query point's cell.
//
// PERF (P2 follow-up): cells are keyed by a PACKED NUMERIC key (was a "cx,cy" string, allocated on every
// move() -- once per bot per tick). The packed int avoids ~one string allocation per bot per tick and
// hashes faster as a Map key. Cells are plain Arrays (swap-pop removal; each entity is in exactly one cell
// so there is no dup risk) iterated with indexed loops (faster than Set/for-of in the hot query path).
// Cell assignment uses exact Math.floor division -> bit-identical membership to the string-key version.

// Pack signed cell coords into one non-negative integer key. Injective for coords in [-CELL_OFFSET,
// CELL_OFFSET): ~+/-2M cells per axis = +/-600M world units at cellSize 300 -- generous for any sane pool.
// Out-of-range coords throw (loud failure) rather than silently colliding (the arbitrary-worlds guard the
// P2/P3 notes call for; a truly unbounded pool would need a nested-Map keying instead).
const CELL_OFFSET = 1 << 21;            // 2097152
const CELL_STRIDE = 1 << 22;            // > 2*CELL_OFFSET, so (cx,cy) packs uniquely; key max ~2^44 (safe int)

// Positive modulo (JS % keeps the dividend's sign) -- fold a torus position back into the pool.
function mod(a, n) { return ((a % n) + n) % n; }

export class SpatialGrid {
    constructor(cellSize, topology = null) {
        if (!(cellSize > 0)) throw new Error('SpatialGrid: cellSize must be > 0');
        this._cellSize = cellSize;
        this._cells = new Map();       // packedKey -> Array(entity)
        this._entityCell = new Map();  // entity -> packedKey (for move/remove)
        // TORUS (P4c): bucket by WRAPPED position so an entity whose part pokes past a seam still lands in an
        // in-bounds cell, and forEachNear wraps the query + also queries the opposite-edge images. A non-
        // toroidal topology (or null) leaves every path exactly as before -> walls stay bit-identical.
        this._toroidal = !!(topology && topology.isToroidal());
        if (this._toroidal) {
            this._left = topology.getLeft(); this._top = topology.getTop();
            this._w = topology.getWidth(); this._h = topology.getHeight();
        }
    }

    _packCell(cx, cy) {
        if (cx < -CELL_OFFSET || cx >= CELL_OFFSET || cy < -CELL_OFFSET || cy >= CELL_OFFSET) {
            throw new Error('SpatialGrid: cell coord out of packable range (pool too large for the grid key)');
        }
        return (cx + CELL_OFFSET) * CELL_STRIDE + (cy + CELL_OFFSET);
    }

    // Integer cell key from a position (floor; handles negatives, e.g. an entity nudged past a wall). On a
    // torus the position is wrapped into the pool first, so every entity buckets to an in-bounds cell.
    _key(x, y) {
        if (this._toroidal) {
            x = this._left + mod(x - this._left, this._w);
            y = this._top + mod(y - this._top, this._h);
        }
        return this._packCell(Math.floor(x / this._cellSize), Math.floor(y / this._cellSize));
    }

    clear() {
        this._cells.clear();
        this._entityCell.clear();
    }

    insert(entity, x, y) {
        const key = this._key(x, y);
        let cell = this._cells.get(key);
        if (cell === undefined) { cell = []; this._cells.set(key, cell); }
        cell.push(entity);
        this._entityCell.set(entity, key);
    }

    // Remove entity from the cell at `key` via swap-pop (each entity is in exactly one cell). Deletes the
    // cell array when it empties. Assumes the entity IS in that cell.
    _removeFromCell(entity, key) {
        const cell = this._cells.get(key);
        if (cell === undefined) return;
        const i = cell.indexOf(entity);
        if (i !== -1) {
            const last = cell.pop();
            if (i < cell.length) cell[i] = last; // move the former last element into the hole
        }
        if (cell.length === 0) this._cells.delete(key);
    }

    // Reinsert an entity at a new position (no-op if it stays in the same cell). Used when a swimbot moves.
    // The same-cell fast path (99%+ of calls) does zero allocation -- just two floors, a pack, and a compare.
    move(entity, x, y) {
        const newKey = this._key(x, y);
        const oldKey = this._entityCell.get(entity);
        if (oldKey === newKey) return;
        if (oldKey !== undefined) this._removeFromCell(entity, oldKey);
        let cell = this._cells.get(newKey);
        if (cell === undefined) { cell = []; this._cells.set(newKey, cell); }
        cell.push(entity);
        this._entityCell.set(entity, newKey);
    }

    remove(entity) {
        const key = this._entityCell.get(entity);
        if (key === undefined) return;
        this._removeFromCell(entity, key);
        this._entityCell.delete(entity);
    }

    // Call fn(entity) for every entity in the 3x3 cell neighborhood of (x,y). A SUPERSET of the entities
    // within cellSize of (x,y) -- the caller applies the exact-distance test. Order is unspecified (the
    // caller must impose its own tiebreak). On a torus it also queries the opposite-edge IMAGES so cross-seam
    // neighbors are found; those image cell-sets are disjoint from the base (pool >= 3*viewRadius, enforced by
    // World) so no entity is double-visited.
    forEachNear(x, y, fn) {
        if (this._toroidal) {
            const L = this._left, T = this._top, W = this._w, H = this._h, r = this._cellSize;
            const wx = L + mod(x - L, W), wy = T + mod(y - T, H); // wrap the query into the pool
            this._near3x3(wx, wy, fn);
            // near a seam -> also query the image just past the OPPOSITE edge (lands next to the far cells)
            const xi = (wx - L) < r ? wx + W : ((L + W - wx) < r ? wx - W : null);
            const yi = (wy - T) < r ? wy + H : ((T + H - wy) < r ? wy - H : null);
            if (xi !== null) this._near3x3(xi, wy, fn);
            if (yi !== null) this._near3x3(wx, yi, fn);
            if (xi !== null && yi !== null) this._near3x3(xi, yi, fn); // opposite corner
            return;
        }
        this._near3x3(x, y, fn);
    }

    _near3x3(x, y, fn) {
        const cx = Math.floor(x / this._cellSize);
        const cy = Math.floor(y / this._cellSize);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = this._cells.get(this._packCell(cx + dx, cy + dy));
                if (cell !== undefined) {
                    for (let i = 0; i < cell.length; i++) fn(cell[i]);
                }
            }
        }
    }
}
