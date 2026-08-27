'use strict';
// Regenerate the P1a A/B golden -- the frozen construct+tick baseline the fresh engine/ must reproduce
// when it kills the slots (PLAN-restructure.md §17, §19). Run deliberately on the pinned environment:
//   node test/tools/gen-p1a-golden.js
// Writes test/fixtures/golden/p1a-tick-baseline-seed<SEED>-t<TICKS>.json. Committing the result is a
// reviewed change -- it is the behavioral contract for P1a. SINGLE-ENGINE: valid only for the recorded
// Node build (the per-tick hashes are float-last-bit sensitive); see test/helpers/p1a-golden.js.

const fs = require('node:fs');
const path = require('node:path');
const { captureRun, hashSnapshot, SEED, TICKS, goldenPath } = require('../helpers/p1a-golden');

const run = captureRun(SEED, TICKS);
const fixture = {
    _comment: 'P1a A/B golden: the OLD engine construct+tick baseline (kill-the-slots target). The fresh '
        + 'engine/ loads `initial` (the CANONICAL shape used here -- content-sorted, genes as a joined '
        + 'string, food carrying only type/id -- NOT the old setPoolData format) and must reproduce every '
        + 'entry of `tickHashes` bit-for-bit on the recorded Node build. Regenerate ONLY deliberately: '
        + 'node test/tools/gen-p1a-golden.js',
    node: run.node,
    seed: run.seed,
    ticks: run.ticks,
    scalars: run.scalars,
    aba: run.aba,
    initialHash: hashSnapshot(run.initial),
    // finalHash === tickHashes[last]; kept as a named, human-checkable anchor. The full `final` snapshot
    // is intentionally NOT committed (it is derivable by replaying `initial` and is pinned by finalHash).
    finalHash: hashSnapshot(run.final),
    tickHashes: run.tickHashes,
    initial: run.initial,
};

const out = goldenPath();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out);
console.log(JSON.stringify({
    node: run.node, seed: run.seed, ticks: run.ticks,
    scalars: run.scalars, aba: run.aba,
    initialHash: fixture.initialHash, finalHash: fixture.finalHash,
    lastTickHash: run.tickHashes[run.tickHashes.length - 1],
}, null, 2));
