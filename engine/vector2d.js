// Vector2D — forked from JJ's Vector2D.js as an ES module (PLAN-restructure.md §15).
//
// Minimal for P0: the genome->body DECODE writes only scalar part fields and never does vector math, so
// Part just needs Vector2D to CONSTRUCT its (dynamic, decode-untouched) position/velocity/etc. Physics
// methods and the rng-driven placement helpers are added when P1/later needs them; the random helpers
// will take an injected rng (never a global), per §3.

export class Vector2D {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }
    set(v) { this.x = v.x; this.y = v.y; }
    setXY(x, y) { this.x = x; this.y = y; }
    clear() { this.x = 0; this.y = 0; }
    copy() { return new Vector2D(this.x, this.y); }
}
