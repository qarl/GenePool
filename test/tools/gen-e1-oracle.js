'use strict';
// Regenerates the E1 decode-fidelity oracle fixture from JJ's CURRENT simulation/ code.
//   node test/tools/gen-e1-oracle.js
//
// The fixture is the FROZEN old-vs-new baseline (PLAN-restructure.md §12/§17): the fresh engine/ decode
// must reproduce these exact signatures. Only regenerate deliberately (i.e. never to paper over an
// engine divergence) -- regeneration is a change to the science baseline and needs its own review.

const fs = require('fs');
const path = require('path');
const { buildAll } = require('../oracles/e1-corpus');

const OUT = path.resolve(__dirname, '..', 'fixtures', 'oracles', 'e1-decode.json');

const fixture = {
    _comment: 'E1 decode-fidelity oracle: genome bytes -> full-precision phenotype signature, frozen ' +
        'from JJ simulation/ code. The engine/ decode must reproduce every sig byte-for-byte. ' +
        'Regenerate ONLY deliberately: node test/tools/gen-e1-oracle.js',
    node: process.version,
    entries: buildAll(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${fixture.entries.length} entries -> ${path.relative(process.cwd(), OUT)} (node ${fixture.node})`);
