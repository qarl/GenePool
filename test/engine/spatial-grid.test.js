'use strict';
// SpatialGrid equivalence (PLAN-restructure.md §19, P2). The grid is a BEHAVIOR-PRESERVING optimization
// of the O(n^2) perception scan: `forEachNear(x,y,fn)` visits every entity in the 3x3 cell neighborhood of
// (x,y); the caller filters by exact distance. The load-bearing contract is:
//
//   CONTRACT: if the query radius r <= cellSize, the 3x3 neighborhood is a SUPERSET of every entity within
//   r of the query point, so { grid candidates within r } == { ALL entities within r } (brute force).
//
// So these tests prove, on tie-heavy / edge-case fixtures and randomized clouds, that grid+filter yields
// EXACTLY the brute-force in-radius set (as a SET -- the caller imposes its own total order). We also pin
// the mechanics (no double-visit, move, remove) and the NEGATIVE case (r > cellSize can miss) so nobody
// ships a too-small cellSize thinking it is still exact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpatialGrid } = require('../../engine/spatialGrid.js');
const { mulberry32 } = require('../helpers/prng');

// --- helpers ----------------------------------------------------------------

// Brute-force reference: the set of entities within (INCLUSIVE) radius r of (qx,qy). Note the engine's
// perception filters with a STRICT `<` (world.js), a SUBSET of this inclusive `<=` ball -- so proving the
// grid is a superset for the inclusive ball implies it for the strict one too. The exact strict-`<` boundary
// is exercised end-to-end by the world-p2 A/B; keep this test inclusive (don't "fix" it to match the engine).
function bruteInRadius(entities, qx, qy, r) {
    const r2 = r * r;
    const out = new Set();
    for (const e of entities) {
        const dx = e.x - qx, dy = e.y - qy;
        if (dx * dx + dy * dy <= r2) out.add(e);
    }
    return out;
}

// Grid path: collect the 3x3 candidates, then apply the SAME exact-distance predicate.
function gridInRadius(grid, qx, qy, r) {
    const r2 = r * r;
    const out = new Set();
    grid.forEachNear(qx, qy, (e) => {
        const dx = e.x - qx, dy = e.y - qy;
        if (dx * dx + dy * dy <= r2) out.add(e);
    });
    return out;
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

function buildGrid(cellSize, entities) {
    const g = new SpatialGrid(cellSize);
    for (const e of entities) g.insert(e, e.x, e.y);
    return g;
}

// --- constructor guard ------------------------------------------------------

test('constructor rejects a non-positive cellSize', () => {
    assert.throws(() => new SpatialGrid(0), /cellSize must be > 0/);
    assert.throws(() => new SpatialGrid(-5), /cellSize must be > 0/);
    assert.throws(() => new SpatialGrid(NaN), /cellSize must be > 0/);
    assert.doesNotThrow(() => new SpatialGrid(1));
});

// --- hand-built tie-heavy / edge fixtures ----------------------------------

test('grid+filter == brute force on tie-heavy edge fixtures', () => {
    const CELL = 300; // == SWIMBOT_VIEW_RADIUS in the real engine
    // Every awkward case in one cloud: duplicate positions, on-boundary coords (integer multiples of CELL),
    // a point AT the query point, four points at EXACTLY the radius (ties), negatives, and far-away points
    // that must be excluded. Distinct objects so identity-Sets are meaningful (two share coords on purpose).
    const R = 300;
    const entities = [
        { tag: 'at-query',        x: 0,    y: 0 },
        { tag: 'dup-at-query',    x: 0,    y: 0 },   // same coords, different object
        { tag: 'east-on-radius',  x: R,    y: 0 },   // exactly r away -> INCLUDED (inclusive)
        { tag: 'west-on-radius',  x: -R,   y: 0 },
        { tag: 'north-on-radius', x: 0,    y: R },
        { tag: 'south-on-radius', x: 0,    y: -R },
        { tag: 'on-cell-bound',   x: CELL, y: 0 },   // x/CELL is an exact integer (floor boundary)
        { tag: 'neg-cell-bound',  x: -CELL,y: -CELL },
        { tag: 'just-inside',     x: 200,  y: 200 }, // d = ~282.8 < 300 -> INCLUDED
        { tag: 'just-outside',    x: 213,  y: 213 }, // d = ~301.2 > 300 -> EXCLUDED (but in the 3x3)
        { tag: 'far-ne',          x: 5000, y: 5000 },// far outside the 3x3 -> EXCLUDED
        { tag: 'far-sw',          x: -9999,y: -1 },
    ];
    // Query from several vantage points, including exact cell corners and negative space.
    const queries = [
        [0, 0], [CELL, 0], [-CELL, -CELL], [150, 150], [CELL / 2, CELL / 2], [-1, -1], [299, 299],
    ];
    for (const [qx, qy] of queries) {
        const grid = buildGrid(CELL, entities);
        for (const r of [1, 100, R, R - 1]) { // r <= CELL always
            const brute = bruteInRadius(entities, qx, qy, r);
            const viaGrid = gridInRadius(grid, qx, qy, r);
            assert.ok(setsEqual(brute, viaGrid),
                `mismatch at query (${qx},${qy}) r=${r}: brute=${[...brute].map(e => e.tag)} grid=${[...viaGrid].map(e => e.tag)}`);
        }
    }
});

// --- randomized property test: grid+filter == brute force -------------------

test('grid+filter == brute force over randomized clouds (r <= cellSize)', () => {
    const rng = mulberry32(0xC0FFEE);
    const CELLS = [50, 137, 300, 1000];
    let trials = 0;
    for (let t = 0; t < 400; t++) {
        const cellSize = CELLS[(rng() * CELLS.length) | 0];
        const n = 1 + ((rng() * 60) | 0);
        const entities = [];
        for (let i = 0; i < n; i++) {
            // Span several cells in both directions incl. negatives; occasionally snap to an exact cell
            // boundary and occasionally pile several entities onto one coordinate (tie stress).
            let x = (rng() * 8 - 4) * cellSize;
            let y = (rng() * 8 - 4) * cellSize;
            if (rng() < 0.15) x = Math.round(x / cellSize) * cellSize; // on boundary
            if (rng() < 0.15) y = Math.round(y / cellSize) * cellSize;
            if (rng() < 0.10 && entities.length) { x = entities[0].x; y = entities[0].y; } // duplicate
            entities.push({ i, x, y });
        }
        const grid = buildGrid(cellSize, entities);
        // A few queries per cloud, radius always within (0, cellSize].
        for (let q = 0; q < 5; q++) {
            const qx = (rng() * 10 - 5) * cellSize;
            const qy = (rng() * 10 - 5) * cellSize;
            const r = Math.max(1e-6, rng() * cellSize); // r in (0, cellSize]
            const brute = bruteInRadius(entities, qx, qy, r);
            const viaGrid = gridInRadius(grid, qx, qy, r);
            assert.ok(setsEqual(brute, viaGrid),
                `trial ${t} q${q}: cellSize=${cellSize} r=${r} n=${n} sizes brute=${brute.size} grid=${viaGrid.size}`);
            trials++;
        }
    }
    assert.ok(trials >= 2000, `ran ${trials} query comparisons`);
});

// --- mechanics: no double-visit, move, remove ------------------------------

test('forEachNear never double-visits an entity', () => {
    const g = new SpatialGrid(100);
    const e = { x: 10, y: 10 };
    g.insert(e, e.x, e.y);
    let count = 0;
    g.forEachNear(10, 10, (x) => { if (x === e) count++; });
    assert.equal(count, 1);
});

test('move relocates an entity to its new cell (found at new, gone from old)', () => {
    const g = new SpatialGrid(100);
    const e = { x: 10, y: 10 };
    g.insert(e, e.x, e.y);
    // Move it far away (several cells over). As in the engine, the entity's own coords move WITH it -- the
    // grid cell and the entity position always agree (the distance filter reads e.x/e.y).
    e.x = 510; e.y = 510;
    g.move(e, e.x, e.y);
    // No longer near the old spot...
    assert.ok(!gridInRadius(g, 10, 10, 99).has(e), 'still found at old position');
    // ...but found near the new spot.
    assert.ok(gridInRadius(g, 510, 510, 99).has(e), 'not found at new position');
});

test('move within the same cell is a harmless no-op (still found once)', () => {
    const g = new SpatialGrid(100);
    const e = { x: 10, y: 10 };
    g.insert(e, e.x, e.y);
    e.x = 40; e.y = 40;
    g.move(e, e.x, e.y); // same cell (0,0)
    let count = 0;
    g.forEachNear(50, 50, (x) => { if (x === e) count++; });
    assert.equal(count, 1);
});

test('remove takes an entity out; removing an unknown entity is a no-op', () => {
    const g = new SpatialGrid(100);
    const a = { x: 10, y: 10 }, b = { x: 20, y: 20 };
    g.insert(a, a.x, a.y);
    g.insert(b, b.x, b.y);
    g.remove(a);
    assert.ok(!gridInRadius(g, 10, 10, 99).has(a), 'a still present after remove');
    assert.ok(gridInRadius(g, 20, 20, 99).has(b), 'b wrongly removed');
    assert.doesNotThrow(() => g.remove({ x: 0, y: 0 })); // never inserted
    assert.doesNotThrow(() => g.remove(a));              // double-remove
});

test('clear empties the grid', () => {
    const g = new SpatialGrid(100);
    const e = { x: 10, y: 10 };
    g.insert(e, e.x, e.y);
    g.clear();
    assert.equal(gridInRadius(g, 10, 10, 99).size, 0);
});

// --- negative case: the contract's precondition actually bites -------------

test('CONTRACT: r > cellSize can miss in-radius entities (guards a too-small cellSize)', () => {
    // With cellSize=100 and r=250, an entity ~two cells away is within r but outside the 3x3 neighborhood.
    const g = new SpatialGrid(100);
    const far = { x: 250, y: 0 }; // distance 250 from origin; cells away = 2 -> outside 3x3 of cell (0,0)
    g.insert(far, far.x, far.y);
    const r = 250;
    const brute = bruteInRadius([far], 0, 0, r);   // includes `far` (250 <= 250)
    const viaGrid = gridInRadius(g, 0, 0, r);       // MISSES it (outside the 3x3)
    assert.equal(brute.size, 1);
    assert.equal(viaGrid.size, 0);
    assert.ok(!setsEqual(brute, viaGrid), 'expected the grid to miss when r > cellSize');
});
