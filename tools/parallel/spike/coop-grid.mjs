// SPIKE — the COOPERATIVE shared spatial grid: a counting-sort CSR neighbor grid built in a SharedArrayBuffer by
// all workers together, so the build shrinks with worker count (unlike the per-worker full rebuild that capped the
// old spike at ~2x). Dense cells over the pool bounds, cellSize == viewRadius (the P2 invariant: the 3x3
// neighborhood of a query covers the whole view circle -> grid + exact-distance filter == brute force).
//
// Build is a 4-phase, barrier-separated counting sort (see worker.mjs):
//   1. zero    : each worker zeros its CELL-RANGE slice of count[] and cursor[]  (partition by cell, NOT by bot)
//   2. count   : each worker Atomics.add(count, cellOf(genital)) for its bots
//   3. prefix  : worker 0 computes start[] = exclusive prefix sum of count[]
//   4. scatter : each worker writes its bots into botIds[] at start[cell] + Atomics.add(cursor, cell)
// then query() reads the 3x3 neighbor ranges [start[c], start[c]+count[c]).
//
// DETERMINISM: the scatter order within a cell is race-determined, but perception feeds candidates into a
// closest-20 min-heap keyed on the strict total order (d2, id) -> the selected set/order are visitation-order
// independent (same reason the JS grid's iteration order never mattered). Bit-identical result. (Reviewed.)
//
// REQUIRED-FIX NOTES (from the concurrency review):
//  - query clamps only the CENTER cell and SKIPS out-of-range neighbor cells (never clamps them) -> no cell is
//    visited twice near a wall/corner (which would duplicate a candidate and break the total order).
//  - cell end is start[c] + count[c] (count[] is read-only after phase 2); start[] is sized numCells.
//  - count and scatter derive the cell from the IDENTICAL frozen genital (the caller passes the same position;
//    the bot has not moved between the two phases -> cursor[c] can never exceed count[c]).

// Allocate the shared buffers + grid dimensions from the pool bounds. Returned spec is passed in workerData and
// reconstructed into a CoopGrid in each worker (and in the single-thread reference).
export function allocCoopGrid(pool, cellSize, N) {
    const numCellsX = Math.max(1, Math.ceil((pool.right - pool.left) / cellSize));
    const numCellsY = Math.max(1, Math.ceil((pool.bottom - pool.top) / cellSize));
    const numCells = numCellsX * numCellsY;
    return {
        left: pool.left, top: pool.top, cellSize, numCellsX, numCellsY, numCells, N,
        countSab: new SharedArrayBuffer(numCells * Int32Array.BYTES_PER_ELEMENT),
        startSab: new SharedArrayBuffer(numCells * Int32Array.BYTES_PER_ELEMENT),
        cursorSab: new SharedArrayBuffer(numCells * Int32Array.BYTES_PER_ELEMENT),
        botIdsSab: new SharedArrayBuffer(N * Int32Array.BYTES_PER_ELEMENT),
    };
}

export class CoopGrid {
    constructor(spec) {
        this._left = spec.left; this._top = spec.top; this._cellSize = spec.cellSize;
        this._nx = spec.numCellsX; this._ny = spec.numCellsY; this._numCells = spec.numCells; this._N = spec.N;
        this._count = new Int32Array(spec.countSab);
        this._start = new Int32Array(spec.startSab);
        this._cursor = new Int32Array(spec.cursorSab);
        this._botIds = new Int32Array(spec.botIdsSab);
    }

    // Grow-on-near-full: only botIds scales with maxBots (N); the cell arrays (count/start/cursor) are numCells-
    // sized (pool-based) and unchanged. The grid is rebuilt every tick, so no copy -- just point at the bigger
    // botIds buffer and update N.
    rebindGrow(botIdsSab, N) {
        this._botIds = new Int32Array(botIdsSab);
        this._N = N;
    }

    // Cell index for a position. PLACEMENT clamps to the edge cell (handles the rare out-of-bounds wall-bounce
    // genital); the query below skips OOB neighbors rather than clamping them.
    _cellOf(x, y) {
        let cx = Math.floor((x - this._left) / this._cellSize);
        let cy = Math.floor((y - this._top) / this._cellSize);
        if (cx < 0) cx = 0; else if (cx >= this._nx) cx = this._nx - 1;
        if (cy < 0) cy = 0; else if (cy >= this._ny) cy = this._ny - 1;
        return cy * this._nx + cx;
    }

    // Phase 1: zero this worker's CELL-RANGE slice of count[] and cursor[]. Partitioned by cell so no two
    // workers touch the same slot (zeroing "my bots' cells" would race + miss cells).
    zeroCellRange(w, W) {
        const chunk = Math.ceil(this._numCells / W);
        const s = w * chunk;
        const e = Math.min(this._numCells, s + chunk);
        if (s < e) { this._count.fill(0, s, e); this._cursor.fill(0, s, e); }
    }

    // Phase 2: count one bot into its cell.
    countOne(x, y) { Atomics.add(this._count, this._cellOf(x, y), 1); }

    // Phase 3 (worker 0 only): exclusive prefix sum -> start[c] = base offset of cell c in botIds[].
    prefixSum() {
        const count = this._count, start = this._start, nc = this._numCells;
        let acc = 0;
        for (let c = 0; c < nc; c++) { start[c] = acc; acc += count[c]; }
    }

    // Phase 4: scatter one bot into botIds[] (unique slot via the atomic cursor). Same (x,y) as countOne.
    scatterOne(id, x, y) {
        const cell = this._cellOf(x, y);
        const pos = this._start[cell] + Atomics.add(this._cursor, cell, 1);
        this._botIds[pos] = id;
    }

    // Query: call fn(id) for every bot in the 3x3 neighborhood of (x,y). Clamp only the CENTER cell; SKIP any
    // out-of-range neighbor (do NOT clamp it -> a wall/corner query never visits the same cell twice). Plain
    // reads of count[]/start[]/botIds[] are safe here: the post-scatter barrier established happens-before, and
    // nothing writes them during the query phase.
    query(x, y, fn) {
        const cs = this._cellSize, nx = this._nx, ny = this._ny;
        let qcx = Math.floor((x - this._left) / cs); if (qcx < 0) qcx = 0; else if (qcx >= nx) qcx = nx - 1;
        let qcy = Math.floor((y - this._top) / cs); if (qcy < 0) qcy = 0; else if (qcy >= ny) qcy = ny - 1;
        const count = this._count, start = this._start, botIds = this._botIds;
        for (let dy = -1; dy <= 1; dy++) {
            const cyy = qcy + dy; if (cyy < 0 || cyy >= ny) continue;
            const rowBase = cyy * nx;
            for (let dx = -1; dx <= 1; dx++) {
                const cxx = qcx + dx; if (cxx < 0 || cxx >= nx) continue;
                const c = rowBase + cxx;
                const s = start[c], e = s + count[c];
                for (let i = s; i < e; i++) fn(botIds[i]);
            }
        }
    }
}
