// Part & Phenotype — forked from JJ's SwimbotTypes.js as ES modules (PLAN-restructure.md §15).
//
// Field-for-field faithful to the originals (the decode + downstream physics/render depend on the exact
// shape). "dynamic" fields are set by the sim at run time, NOT by the decode; the decode writes the
// morphology/color/motion scalars. Kept as classes; behavior identical.

import { ZERO, NULL_PART, MAX_PARTS } from './constants.js';
import { Vector2D } from './vector2d.js';

export class Part {
    constructor() {
        this.category = 0;
        this.position = new Vector2D();      // dynamic
        this.velocity = new Vector2D();      // dynamic
        this.axis = new Vector2D();          // dynamic
        this.previousMid = new Vector2D();   // dynamic
        this.midPosition = new Vector2D();   // dynamic
        this.perpendicular = new Vector2D(); // dynamic
        this.bendingAngle = ZERO;            // dynamic
        this.currentAngle = ZERO;            // dynamic
        this.parent = NULL_PART;
        this.child = NULL_PART;              // valid only if it is the continuation of a single-category section
        this.mass = ZERO;
        this.length = ZERO;
        this.width = ZERO;
        this.angle = ZERO;
        this.frequency = ZERO;
        this.phase = ZERO;
        this.amp = ZERO;
        this.turnAmp = ZERO;
        this.turnPhase = ZERO;
        this.momentFactor = ZERO;
        this.red = ZERO;
        this.green = ZERO;
        this.blue = ZERO;
        this.endCapSpline = ZERO;
        this.branch = false;
        this.splined = false;
        this.numDecendents = 0;
        this.decendent = new Array(MAX_PARTS).fill(0);
    }
}

export class Phenotype {
    constructor() {
        this.numParts = 0;
        this.frequency = ZERO;
        this.parts = new Array(MAX_PARTS);
        this.sumPartLengths = ZERO;
        this.mass = ZERO;
        this.preferredFoodType = 0;
        this.digestibleFoodType = 0;
        for (let p = 0; p < MAX_PARTS; p++) this.parts[p] = new Part();
    }
}
