// Emit the baked JS constant block for the viewer from basis.json.
//   node tools/pca/emit-const.mjs <basis.json> <out.js>
import { readFileSync, writeFileSync } from 'node:fs';
const b = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
const f = (x, p) => Number(x.toFixed(p));
const mean = '[' + b.mean.map(x => f(x, 2)).join(',') + ']';
const comps = '[\n' + b.components.map(c => '  [' + c.map(x => f(x, 5)).join(',') + ']').join(',\n') + '\n]';
const scales = '[' + b.scales.map(x => f(x, 3)).join(',') + ']';
const pct = (100 * b.varianceExplained).toFixed(1);
const lines = [
  `// PCA basis for the species plate -- see docs/pca-plate-basis.md + tools/pca/. Derived from 100 seeds (1..100) x 200k`,
  `// ticks of the viewer's exact world, extracting the most-representative individual of every species (>=5 members);`,
  `// PCA over the EXPRESSED genes [0,EXPRESSED). Top-5 components explain ${pct}% of total genome variance (the space is`,
  `// near-isotropic -- these are the best 5 axes there are). Sign convention: each vector's largest-|element| is positive.`,
  `// *** IF EXPRESSED CHANGES (JJ's dead genes re-enabled / two food types), THIS BASIS IS INVALID -- regenerate with`,
  `//     node tools/pca/run-batch.mjs 100 200000 <dir> 10 && node tools/pca/pca.mjs <dir> && node tools/pca/emit-const.mjs <dir>/basis.json <out> ***`,
  `const PCA_MEAN = ${mean};`,
  `const PCA_COMPONENTS = ${comps};`,
  `const PCA_SCALES = ${scales};   // per-component projection std -> standardise the coefficient before quantising`,
  ``,
];
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}  (${b.mean.length} dims, ${b.components.length} comps, varExpl ${pct}%)`);
console.log('scales:', b.scales.map(x => f(x, 1)));
