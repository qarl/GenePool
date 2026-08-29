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

export class SpatialGrid {
    constructor(cellSize) {
        if (!(cellSize > 0)) throw new Error('SpatialGrid: cellSize must be > 0');
        this._cellSize = cellSize;
        this._cells = new Map();       // cellKey -> Set(entity)
        this._entityCell = new Map();  // entity -> cellKey (for move/remove)
    }

    // Integer cell coords (floor); handles negative positions (an entity nudged past a wall).
    _cellKey(x, y) {
        const cx = Math.floor(x / this._cellSize);
        const cy = Math.floor(y / this._cellSize);
        return cx + ',' + cy;
    }

    clear() {
        this._cells.clear();
        this._entityCell.clear();
    }

    insert(entity, x, y) {
        const key = this._cellKey(x, y);
        let cell = this._cells.get(key);
        if (!cell) { cell = new Set(); this._cells.set(key, cell); }
        cell.add(entity);
        this._entityCell.set(entity, key);
    }

    // Reinsert an entity at a new position (no-op if it stays in the same cell). Used when a swimbot moves.
    move(entity, x, y) {
        const newKey = this._cellKey(x, y);
        const oldKey = this._entityCell.get(entity);
        if (oldKey === newKey) return;
        if (oldKey !== undefined) {
            const oldCell = this._cells.get(oldKey);
            if (oldCell) { oldCell.delete(entity); if (oldCell.size === 0) this._cells.delete(oldKey); }
        }
        let cell = this._cells.get(newKey);
        if (!cell) { cell = new Set(); this._cells.set(newKey, cell); }
        cell.add(entity);
        this._entityCell.set(entity, newKey);
    }

    remove(entity) {
        const key = this._entityCell.get(entity);
        if (key === undefined) return;
        const cell = this._cells.get(key);
        if (cell) { cell.delete(entity); if (cell.size === 0) this._cells.delete(key); }
        this._entityCell.delete(entity);
    }

    // Call fn(entity) for every entity in the 3x3 cell neighborhood of (x,y). A SUPERSET of the entities
    // within cellSize of (x,y) -- the caller applies the exact-distance test. Order is unspecified (the
    // caller must impose its own tiebreak); it never double-visits (each entity is in exactly one cell).
    forEachNear(x, y, fn) {
        const cx = Math.floor(x / this._cellSize);
        const cy = Math.floor(y / this._cellSize);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = this._cells.get((cx + dx) + ',' + (cy + dy));
                if (cell) for (const e of cell) fn(e);
            }
        }
    }
}
