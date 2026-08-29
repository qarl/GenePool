'use strict';
// Parallelism S1b: FrozenSwimbot is the tick-start-frozen view OTHER bots perceive in snapshot mode. Its
// getAttractiveness must equal the LIVE Swimbot.getAttractiveness for every criterion (it just wires the
// parity-proven attraction.js#attractivenessOf around frozen candidate metrics + the live judge). Plus the
// stable-identity contract: refresh() re-captures state in place; markDead() ghosts it (not-alive, last pos kept).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { mulberry32 } = require('../helpers/prng');
const { Swimbot } = require('../../engine/swimbot.js');
const { Genotype } = require('../../engine/genotype.js');
const { Embryology } = require('../../engine/embryology.js');
const { FrozenSwimbot } = require('../../engine/snapshotView.js');

const emb = new Embryology();
const config = { maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5 };
const VIEW_RADIUS = 300; // config default -> Swimbot._viewRadius (must match FrozenSwimbot's normalizer)
const NUM_CRITERIA = 17;

const matePref = (l, c, t, i) => { const h = (Math.imul(l, 73856093) ^ Math.imul(c, 19349663) ^ Math.imul(t, 83492791) ^ Math.imul(i + 1, 2654435761)) >>> 0; return h / 4294967296; };

function makeBot(id, genes, x, y, angle, seed) {
    const g = new Genotype(); g.setGenes(genes);
    const sb = new Swimbot({ life: { next: mulberry32(seed) }, matePref, config, embryology: emb });
    sb.create(id, 5000, { x, y }, angle, 80, g);
    for (let t = 0; t < 60; t++) sb.update(); // develop dynamic body metrics
    return sb;
}

test('FrozenSwimbot.getAttractiveness == live Swimbot.getAttractiveness for every criterion', () => {
    const pool = boot(42).getPoolData().swimbotArray;
    const genesOf = (i) => Array.from(pool[i].genes);
    const pairs = [[0, 1], [2, 5], [7, 3], [10, 20]];
    const tick = 1234;

    let checks = 0;
    for (const [ci, ji] of pairs) {
        const cand = makeBot(100 + ci, genesOf(ci), 4000, 4000, 30, 11 + ci);
        const judge = makeBot(200 + ji, genesOf(ji), 4180, 4050, -90, 22 + ji);
        for (let criterion = 0; criterion < NUM_CRITERIA; criterion++) {
            cand.setAttraction(criterion); // candidate's own brain criterion, which getAttractiveness reads
            const view = new FrozenSwimbot(matePref, VIEW_RADIUS);
            view.refresh(cand); // captures the criterion + metrics AFTER setAttraction
            const live = cand.getAttractiveness(judge, tick);
            const frozen = view.getAttractiveness(judge, tick);
            assert.equal(frozen, live, `criterion ${criterion} (cand ${ci}, judge ${ji}): frozen ${frozen} != live ${live}`);
            checks++;
        }
    }
    assert.equal(checks, pairs.length * NUM_CRITERIA);
});

test('FrozenSwimbot captures the frozen fields the perception path reads', () => {
    const cand = makeBot(7, Array.from(boot(1).getPoolData().swimbotArray[0].genes), 1000, 2000, 45, 9);
    const view = new FrozenSwimbot(matePref, VIEW_RADIUS);
    view.refresh(cand);
    assert.equal(view.getIndex(), cand.getIndex());
    assert.equal(view.getAlive(), true);
    assert.equal(view.getAge(), cand.getAge());
    assert.equal(view.getEnergy(), cand.getEnergy());
    const gp = cand.getGenitalPosition();
    assert.equal(view.getGenitalPosition().x, gp.x);
    assert.equal(view.getGenitalPosition().y, gp.y);
    assert.equal(view.getGenotype(), cand.getGenotype());
});

test('refresh() re-captures in place; the view object identity is stable across ticks', () => {
    const cand = makeBot(3, Array.from(boot(1).getPoolData().swimbotArray[0].genes), 1000, 1000, 0, 4);
    const view = new FrozenSwimbot(matePref, VIEW_RADIUS);
    view.refresh(cand);
    const g0 = { x: view.getGenitalPosition().x, y: view.getGenitalPosition().y };
    for (let t = 0; t < 30; t++) cand.update(); // the live bot moves on
    view.refresh(cand);
    const g1 = view.getGenitalPosition();
    assert.ok(g1.x !== g0.x || g1.y !== g0.y, 'refresh() should re-capture the moved position');
    assert.equal(g1.x, cand.getGenitalPosition().x);
    assert.equal(g1.y, cand.getGenitalPosition().y);
});

test('markDead() ghosts the view: not-alive, but last frozen position preserved', () => {
    const cand = makeBot(5, Array.from(boot(1).getPoolData().swimbotArray[0].genes), 3000, 3000, 10, 6);
    const view = new FrozenSwimbot(matePref, VIEW_RADIUS);
    view.refresh(cand);
    const gp = { x: view.getGenitalPosition().x, y: view.getGenitalPosition().y };
    view.markDead();
    assert.equal(view.getAlive(), false);
    assert.equal(view.getGenitalPosition().x, gp.x); // position frozen at last-known (ghost steering reads it)
    assert.equal(view.getGenitalPosition().y, gp.y);
});
