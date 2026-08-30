'use strict';
// P4d — torus FOOD-spawn wrap + wrap-aware obstacle LINE-OF-SIGHT. Precise geometry units (deterministic).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FoodBit } = require('../../engine/foodBit.js');
const { Obstacle } = require('../../engine/obstacle.js');
const { Vector2D } = require('../../engine/vector2d.js');
const { makeTopology, FLAT } = require('../../engine/topology.js');

const POOL = { left: 0, top: 0, right: 1000, bottom: 1000 };
const torus = makeTopology({ topology: 'torus', pool: POOL });

// rng stub: xx=rng*rng, yy=rng*rng, then a sign draw each (6 draws). [.99,.99,.1,.1,.99,.99] -> +x ~+196, +y ~+2.
function stubRng(seq) { let i = 0; return () => seq[i++]; }

test('food spawn WRAPS across a torus seam instead of reflecting', () => {
    const parent = new FoodBit(); parent.setPosition({ x: 950, y: 500 });
    const child = new FoodBit();
    child.setMaxSpawnRadius(200); child.setPoolBounds(POOL); child.setTopology(torus);
    child.spawnFromParent(parent, 1, 0, stubRng([0.99, 0.99, 0.1, 0.1, 0.99, 0.99]));
    const p = child.getPosition();
    // 950 + 0.99*0.99*200 = 1146 -> wraps to 146; y ~ 502
    assert.ok(p.x >= 0 && p.x < 1000, `wrapped x must be in-bounds (got ${p.x})`);
    assert.ok(p.x < 950, `x should have wrapped to the FAR side, not reflected back near the parent (got ${p.x})`);
    assert.ok(Math.abs(p.x - 146) < 1, `expected wrapped x ~146 (got ${p.x})`);

    // FLAT: same draws REFLECT off the boundary margin -> stays on the near (right) side, != wrap.
    const wchild = new FoodBit();
    wchild.setMaxSpawnRadius(200); wchild.setPoolBounds(POOL); wchild.setTopology(FLAT);
    wchild.spawnFromParent(parent, 1, 0, stubRng([0.99, 0.99, 0.1, 0.1, 0.99, 0.99]));
    assert.ok(wchild.getPosition().x > 500, `walls should reflect (stay near the right edge), got ${wchild.getPosition().x}`);
    assert.notEqual(wchild.getPosition().x, p.x, 'walls-reflect and torus-wrap must differ');
});

test('obstacle line-of-sight follows the SHORTEST wrapped path (mid-pool obstacle ignored across a seam)', () => {
    const p1 = new Vector2D(); p1.setXY(950, 500);
    const p2 = new Vector2D(); p2.setXY(50, 500); // wrapped-close (100 across the right seam); raw-far (900 through mid)
    const ob = new Obstacle(); ob.setPoolBounds(POOL);

    // A mid-pool vertical bar at x=500: on the RAW path (950->50 through x=500) but NOT the short wrapped path.
    ob.setEndpointPositions({ x: 500, y: 400 }, { x: 500, y: 600 });
    ob.setTopology(FLAT);
    assert.equal(ob.getObstruction(p1, p2), true, 'walls: the raw segment crosses the mid bar -> blocked');
    ob.setTopology(torus);
    assert.equal(ob.getObstruction(p1, p2), false, 'torus: the SHORT wrapped path does not pass the mid bar -> NOT blocked');

    // A bar right at the seam (x=990): ON the short wrapped path -> blocked on the torus.
    ob.setEndpointPositions({ x: 990, y: 400 }, { x: 990, y: 600 });
    ob.setTopology(torus);
    assert.equal(ob.getObstruction(p1, p2), true, 'torus: a seam-adjacent bar on the short path -> blocked');

    // Sanity: an interior pair (no seam crossing) is unaffected by the torus path.
    const a = new Vector2D(); a.setXY(300, 500); const b = new Vector2D(); b.setXY(700, 500);
    ob.setEndpointPositions({ x: 500, y: 400 }, { x: 500, y: 600 });
    assert.equal(ob.getObstruction(a, b), true, 'torus interior pair: mid bar between them still blocks');
});

test('obstacle LoS: a seam-STRADDLING p1 (out-of-bounds body part) still sees the obstruction', () => {
    // Perception passes RAW genital/mouth positions, which overhang a seam when a body straddles it (only the
    // root _position is canonicalized). Here p1's genital is at x=-30 (root wrapped near the right edge, true
    // pos 970); partner at x=100. The shortest wrapped path 970->1000->wrap->100 crosses an edge-hugging bar.
    // Before the p1-canonicalization fix this returned false (image set chosen from a non-canonical start).
    const p1 = new Vector2D(); p1.setXY(-30, 500);
    const p2 = new Vector2D(); p2.setXY(100, 500);
    const ob = new Obstacle(); ob.setPoolBounds(POOL); ob.setTopology(torus);
    ob._end1.setXY(980, 400); ob._end2.setXY(980, 600);
    assert.equal(ob.getObstruction(p1, p2), true, 'canonicalized p1 -> short path via the right seam crosses the edge obstacle');
});

test('obstacle LoS: a CORNER crossing (both seams) uses the diagonal image', () => {
    // p1->p2 shortest path crosses BOTH the right and bottom seams: disp = (+200,+200), b' = (1100,1100),
    // so the short path is the diagonal y=x for x in [900,1100]. Endpoints set directly to bypass clamping.
    const p1 = new Vector2D(); p1.setXY(900, 900);
    const p2 = new Vector2D(); p2.setXY(100, 100);
    const ob = new Obstacle(); ob.setPoolBounds(POOL); ob.setTopology(torus);
    // A bar near the (0,0) corner whose (+W,+H) diagonal image (1050..1090, y=1070) sits ON the diagonal path;
    // its base + single-axis images do NOT -> only the corner image can catch it.
    ob._end1.setXY(50, 70); ob._end2.setXY(90, 70);
    assert.equal(ob.getObstruction(p1, p2), true, 'corner path blocked ONLY via the diagonal (+W,+H) image');
    // Move it off the diagonal image -> not blocked (no false positive from base/single-axis images).
    ob._end1.setXY(50, 300); ob._end2.setXY(90, 300);
    assert.equal(ob.getObstruction(p1, p2), false, 'off-path corner bar -> not blocked');
});
