'use strict';
// Regenerate the determinism-baseline golden. Run deliberately on the pinned environment:
//   node test/tools/regen-golden.js
// Writes test/fixtures/golden/seed<SEED>-t<TICKS>.json. Committing the result is a reviewed change --
// read the reduced scalars first (population/food/familyNodes); the hash changes on ANY state drift.
// SINGLE-ENGINE: the golden is only valid for the Node build recorded in the file (see helpers/golden.js).

const fs = require('node:fs');
const path = require('node:path');
const { signature, SEED, TICKS, goldenPath } = require('../helpers/golden');

const sig = signature(SEED, TICKS);
const out = goldenPath();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sig, null, 2) + '\n');
console.log('wrote', out);
console.log(JSON.stringify(sig, null, 2));
