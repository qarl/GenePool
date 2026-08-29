'use strict';
// Parallelism S1a: attractivenessOf (the pure, metrics-based mirror) must be BIT-FOR-BIT identical to
// Swimbot.getAttractiveness (the live method) for EVERY attraction criterion. This is what lets snapshot
// mode score frozen candidates without changing mixed-live's getAttractiveness at all. Bots are ticked so
// the DYNAMIC metrics (hyperness=velocity, longness=midPositions, straightness=axis) are non-trivial.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { mulberry32 } = require('../helpers/prng');
const { Swimbot } = require('../../engine/swimbot.js');
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');
const { computeAttractionMetrics, attractivenessOf } = require('../../engine/attraction.js');

const emb = new Embryology();
const config = { maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5 };
const VIEW_RADIUS = 300; // config default (no config.viewRadius) -> Swimbot._viewRadius
const NUM_CRITERIA = 17; // ATTRACTION_COLORFUL(0) .. ATTRACTION_RANDOM(16)

// deterministic pairwise matePref (same fn given to the swimbot ctx and to attractivenessOf)
const matePref = (l, c, t, i) => { const h = (Math.imul(l, 73856093) ^ Math.imul(c, 19349663) ^ Math.imul(t, 83492791) ^ Math.imul(i + 1, 2654435761)) >>> 0; return h / 4294967296; };

function makeBot(id, genes, x, y, angle, seed) {
    const g = new Genotype(); g.setGenes(genes);
    const sb = new Swimbot({ life: { next: mulberry32(seed) }, matePref, config, embryology: emb });
    sb.create(id, 5000, { x, y }, angle, 80, g);
    for (let t = 0; t < 60; t++) sb.update(); // develop dynamic body metrics (velocity/midPos/axis)
    return sb;
}

test('attractivenessOf == Swimbot.getAttractiveness for every criterion (ticked bots)', () => {
    const pool = boot(42).getPoolData().swimbotArray;
    const genesOf = (i) => Array.from(pool[i].genes);
    // a few candidate/judge genome pairs so different body shapes/colors exercise every metric
    const pairs = [[0, 1], [2, 5], [7, 3], [10, 20]];
    const tick = 1234;

    let checks = 0;
    for (const [ci, ji] of pairs) {
        const cand = makeBot(100 + ci, genesOf(ci), 4000, 4000, 30, 11 + ci);
        const judge = makeBot(200 + ji, genesOf(ji), 4180, 4050, -90, 22 + ji);
        const candMetrics = computeAttractionMetrics(cand);
        const judgeMetrics = computeAttractionMetrics(judge);
        for (let criterion = 0; criterion < NUM_CRITERIA; criterion++) {
            cand.setAttraction(criterion); // getAttractiveness reads the CANDIDATE's brain criterion
            const live = cand.getAttractiveness(judge, tick);
            const pure = attractivenessOf(candMetrics, judgeMetrics, criterion, tick, matePref, cand.getIndex(), judge.getIndex(), VIEW_RADIUS);
            assert.equal(pure, live, `criterion ${criterion} (cand genome ${ci}, judge ${ji}): pure ${pure} != live ${live}`);
            checks++;
        }
    }
    assert.equal(checks, pairs.length * NUM_CRITERIA);
    // sanity: the dynamic metrics are actually non-zero (bots really moved), so this exercised them
    const m = computeAttractionMetrics(makeBot(999, genesOf(0), 4000, 4000, 30, 5));
    assert.ok(m.hyperness > 0 || m.longness > 0, 'dynamic metrics were all zero -- bots did not move; test is weak');
});
