// Embryology — the genome->body DECODE, forked from JJ's Embryology.js as an ES module (PLAN §15).
//
// The decode SCIENCE is preserved bit-for-bit (frozen by the E1 oracle). It is RNG-free and
// transcendental-free (only + - * / floor round), so its output is a bit-exact portable function of the
// input bytes. Two changes from JJ, per the plan:
//   - `globalTweakers.numFoodTypes` -> injected `config.numFoodTypes` (§3/§15).
//   - globals (constants, Part/Phenotype, assert) -> explicit imports (§15).
// Pure-debug bits (gene-name labels, console logs, the dead fixPartOrdering) are dropped; they never
// affected the phenotype. Everything the decode WRITES is unchanged.

import {
    ZERO, ONE, BYTE_SIZE, NUM_GENES, MIN_PARTS, MAX_PARTS, ROOT_PART, NULL_INDEX,
} from './constants.js';
import { Phenotype } from './bodyTypes.js';
import { assert } from './assert.js';

const NUM_CATEGORIES = 4;

// gene limits (identical to JJ)
const MIN_LENGTH = 3.0, MAX_LENGTH = 27.0;
const MIN_WIDTH = 0.5, MAX_WIDTH = 7.0;
const MIN_SPLINED = 0, MAX_SPLINED = 1;
const MIN_END_CAP_SPLINE = 0.5, MAX_END_CAP_SPLINE = 4.0;
const MIN_FREQUENCY = 0.02, MAX_FREQUENCY = 0.2;
const MIN_AMP = -60.0, MAX_AMP = 60.0;
const MIN_PHASE = -1.0, MAX_PHASE = 1.0;
const MIN_COLOR = ZERO, MAX_COLOR = ONE;
const MIN_BRANCH_PERIOD = 1, MAX_BRANCH_PERIOD = 4;
const MIN_BRANCH_ANGLE = -90.0, MAX_BRANCH_ANGLE = 90.0;
const MIN_BRANCH_NUMBER = 0, MAX_BRANCH_NUMBER = 3;
const MIN_BRANCH_SHIFT = 0, MAX_BRANCH_SHIFT = 6;
const MIN_BRANCH_REFLECT = 0, MAX_BRANCH_REFLECT = 3;
const MIN_BRANCH_CATEGORY = 0, MAX_BRANCH_CATEGORY = NUM_CATEGORIES - 1;
const MIN_CUT_OFF = MIN_PARTS, MAX_CUT_OFF = MAX_PARTS - 1;
const MIN_SEQUENCE_COUNT = MIN_PARTS, MAX_SEQUENCE_COUNT = 5;

function makeCategoryValues() {
    return {
        sequenceCount: ZERO,
        startWidth: ZERO, endWidth: ZERO, startLength: ZERO, endLength: ZERO,
        startRed: ZERO, startGreen: ZERO, startBlue: ZERO, endRed: ZERO, endGreen: ZERO, endBlue: ZERO,
        splined: ZERO, endCapSpline: ZERO,
        amp: ZERO, phase: ZERO, turnAmp: ZERO, turnPhase: ZERO,
        branchAmp: ZERO, branchPhase: ZERO, branchTurnAmp: ZERO, branchTurnPhase: ZERO,
        branchPeriod: ZERO, branchAngle: ZERO, branchNumber: ZERO, branchShift: ZERO,
        branchCategory: ZERO, branchReflect: ZERO,
    };
}

export class Embryology {
    constructor() {
        this._normalizedGenes = new Array(NUM_GENES);
        this._branchStatus = new Array(MAX_PARTS);
        this._categoryValues = new Array(NUM_CATEGORIES);
        this._partIndex = ZERO;
        this._generating = false;
        this._frequency = ZERO;
        this._numGenesUsed = 0;
        this._cutOff = 0;
        this._testNoEel = true;
    }

    // genes -> phenotype. `config` supplies numFoodTypes (injected; was globalTweakers.numFoodTypes).
    generatePhenotypeFromGenotype(genotype, config) {
        const numFoodTypes = config.numFoodTypes;
        const phenotype = new Phenotype();

        for (let c = 0; c < NUM_CATEGORIES; c++) this._categoryValues[c] = makeCategoryValues();
        for (let p = 0; p < MAX_PARTS; p++) this._branchStatus[p] = false;

        for (let g = 0; g < NUM_GENES; g++) {
            this._normalizedGenes[g] = genotype.getGeneValue(g) / BYTE_SIZE;
            assert(this._normalizedGenes[g] >= ZERO, 'normalizedGenes[g] >= ZERO');
            assert(this._normalizedGenes[g] <= ONE, 'normalizedGenes[g] <= ONE');
        }

        const sequenceCountRange = MAX_SEQUENCE_COUNT - MIN_SEQUENCE_COUNT;
        const widthRange = MAX_WIDTH - MIN_WIDTH;
        const lengthRange = MAX_LENGTH - MIN_LENGTH;
        const ampRange = MAX_AMP - MIN_AMP;
        const frequencyRange = MAX_FREQUENCY - MIN_FREQUENCY;
        const phaseRange = MAX_PHASE - MIN_PHASE;
        const colorRange = MAX_COLOR - MIN_COLOR;
        const periodRange = MAX_BRANCH_PERIOD - MIN_BRANCH_PERIOD;
        const branchAngleRange = MAX_BRANCH_ANGLE - MIN_BRANCH_ANGLE;
        const branchNumberRange = MAX_BRANCH_NUMBER - MIN_BRANCH_NUMBER;
        const branchShiftRange = MAX_BRANCH_SHIFT - MIN_BRANCH_SHIFT;
        const branchCategoryRange = MAX_BRANCH_CATEGORY - MIN_BRANCH_CATEGORY;
        const branchReflectRange = MAX_BRANCH_REFLECT - MIN_BRANCH_REFLECT;
        const cutOffRange = MAX_CUT_OFF - MIN_CUT_OFF;
        const splinedRange = MAX_SPLINED - MIN_SPLINED;
        const endCapSplineRange = MAX_END_CAP_SPLINE - MIN_END_CAP_SPLINE;

        const ng = this._normalizedGenes;
        let g = -1;

        g++; this._frequency = MIN_FREQUENCY + frequencyRange * ng[g];
        g++; this._cutOff = MIN_CUT_OFF + cutOffRange * ng[g];

        for (let c = 0; c < NUM_CATEGORIES; c++) {
            const cv = this._categoryValues[c];
            g++; cv.startRed = MIN_COLOR + colorRange * ng[g];
            g++; cv.startGreen = MIN_COLOR + colorRange * ng[g];
            g++; cv.startBlue = MIN_COLOR + colorRange * ng[g];
            g++; cv.endRed = MIN_COLOR + colorRange * ng[g];
            g++; cv.endGreen = MIN_COLOR + colorRange * ng[g];
            g++; cv.endBlue = MIN_COLOR + colorRange * ng[g];
            g++; cv.startWidth = MIN_WIDTH + widthRange * ng[g];
            g++; cv.endWidth = MIN_WIDTH + widthRange * ng[g];
            g++; cv.startLength = MIN_LENGTH + lengthRange * ng[g];
            g++; cv.endLength = MIN_LENGTH + lengthRange * ng[g];

            g++; cv.amp = MIN_AMP + ampRange * ng[g];
            g++; cv.phase = MIN_PHASE + phaseRange * ng[g];
            g++; cv.turnAmp = MIN_AMP + ampRange * ng[g];
            g++; cv.turnPhase = MIN_PHASE + phaseRange * ng[g];
            g++; cv.branchAmp = MIN_AMP + ampRange * ng[g];
            g++; cv.branchPhase = MIN_PHASE + phaseRange * ng[g];
            g++; cv.branchTurnAmp = MIN_AMP + ampRange * ng[g];
            g++; cv.branchTurnPhase = MIN_PHASE + phaseRange * ng[g];

            g++; cv.sequenceCount = MIN_SEQUENCE_COUNT + sequenceCountRange * ng[g];
            g++; cv.branchPeriod = MIN_BRANCH_PERIOD + periodRange * ng[g];
            g++; cv.branchAngle = MIN_BRANCH_ANGLE + branchAngleRange * ng[g];
            g++; cv.branchNumber = MIN_BRANCH_NUMBER + branchNumberRange * ng[g];
            g++; cv.branchShift = MIN_BRANCH_SHIFT + branchShiftRange * ng[g];
            g++; cv.branchCategory = MIN_BRANCH_CATEGORY + branchCategoryRange * ng[g];
            g++; cv.branchReflect = MIN_BRANCH_REFLECT + branchReflectRange * ng[g];

            g++; cv.splined = MIN_SPLINED + splinedRange * ng[g];
            g++; cv.endCapSpline = MIN_END_CAP_SPLINE + endCapSplineRange * ng[g];

            // discrete "1 of N" decodes -- preserved EXACTLY as JJ (the off-by-one is intentional; a fix
            // would change how bodies grow, i.e. evolution). See the note in JJ's Embryology.js.
            cv.sequenceCount = Math.floor(ZERO + cv.sequenceCount);
            cv.branchPeriod = Math.floor(ZERO + cv.branchPeriod);
            cv.branchNumber = Math.floor(ONE + cv.branchNumber);
            cv.branchShift = Math.floor(ZERO + cv.branchShift);
            cv.branchCategory = Math.floor(ZERO + cv.branchCategory);
            cv.branchReflect = Math.floor(ONE + cv.branchReflect);
            cv.splined = Math.round(ZERO + cv.splined);
        }

        // food-type preference/digestibility genes (default 0; genetically set only when numFoodTypes===2)
        phenotype.preferredFoodType = 0;
        phenotype.digestibleFoodType = 0;
        g++;
        if (numFoodTypes === 2) phenotype.preferredFoodType = Math.floor(ng[g] * 2);
        g++;
        if (numFoodTypes === 2) phenotype.digestibleFoodType = Math.floor(ng[g] * 2);

        this._numGenesUsed = g + 1;
        assert(this._numGenesUsed < NUM_GENES, 'embryology: _numGenesUsed < NUM_GENES');

        phenotype.frequency = this._frequency;

        this._partIndex = ROOT_PART;
        const startCategory = 0;
        this._testNoEel = true;
        this.generateBodySequence(phenotype, this._partIndex, ZERO, startCategory, ONE);
        this._testNoEel = false;

        this._generating = true;
        while (this._generating) {
            for (let p = 0; p < MAX_PARTS; p++) {
                this._generating = false; // may be set back to true in generateBodySequence

                if (this._branchStatus[p]) {
                    this._branchStatus[p] = false; // may be set back to true in generateBodySequence

                    const partCategory = phenotype.parts[p].category;
                    const c = this._categoryValues[partCategory].branchCategory;
                    let reflect = ONE;

                    if (this._categoryValues[c].branchNumber === 1) {
                        reflect = ONE;
                        this.generateBodySequence(phenotype, p, this._categoryValues[c].branchAngle, c, reflect);
                    } else {
                        for (let b = 0; b < this._categoryValues[c].branchNumber; b++) {
                            reflect = ONE;
                            if (b % this._categoryValues[c].branchReflect === 0) reflect = -ONE;
                            const f = -ONE + (b / (this._categoryValues[c].branchNumber - 1)) * 2;
                            this.generateBodySequence(phenotype, p, this._categoryValues[c].branchAngle * f, c, reflect);
                        }
                    }
                }
            }
        }

        phenotype.numParts = this._partIndex + 1;
        assert(phenotype.numParts > 1, 'phenotype.numParts > 1');
        return phenotype;
    }

    generateBodySequence(phenotype, parent, branchAngle, c, reflect) {
        const cv = this._categoryValues[c];
        for (let i = 0; i < cv.sequenceCount; i++) {
            if (this._partIndex < this._cutOff) {
                this._partIndex++;
                assert(this._partIndex < MAX_PARTS, '_partIndex < MAX_PARTS');

                const part = phenotype.parts[this._partIndex];
                part.child = NULL_INDEX;

                if (i === 0) {
                    part.branch = true;
                    part.parent = parent;
                    part.angle = branchAngle;
                    part.amp = cv.branchAmp;
                    part.phase = cv.branchPhase * this._partIndex;
                    part.turnAmp = cv.branchTurnAmp;
                    part.turnPhase = cv.branchTurnPhase * this._partIndex;
                } else {
                    const p = this._partIndex - 1;
                    phenotype.parts[p].child = this._partIndex;
                    part.branch = false;
                    part.parent = p;
                    part.angle = ZERO;
                    part.amp = cv.amp;
                    part.phase = cv.phase * this._partIndex;
                    part.turnAmp = cv.turnAmp;
                    part.turnPhase = cv.turnPhase;
                }

                if (this._testNoEel) {
                    part.turnAmp = ZERO;
                    part.turnPhase = ZERO;
                }

                part.amp *= reflect;

                part.category = c;
                part.frequency = phenotype.frequency;
                part.splined = cv.splined;
                part.endCapSpline = cv.endCapSpline;

                let fraction = ZERO;
                if (cv.sequenceCount > 1) fraction = i / (cv.sequenceCount - 1);

                part.width = cv.startWidth + fraction * (cv.endWidth - cv.startWidth);
                part.length = cv.startLength + fraction * (cv.endLength - cv.startLength);
                part.red = cv.startRed + fraction * (cv.endRed - cv.startRed);
                part.green = cv.startGreen + fraction * (cv.endGreen - cv.startGreen);
                part.blue = cv.startBlue + fraction * (cv.endBlue - cv.startBlue);

                assert(part.length > ZERO, 'Embryology: part.length > ZERO');
                assert(part.width > ZERO, 'Embryology: part.width > ZERO');

                const mod = (i + cv.branchShift) % cv.branchPeriod;
                if (mod === 0) {
                    this._generating = true;
                    this._branchStatus[this._partIndex] = true;
                }
            }
        }
    }
}
