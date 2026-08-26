'use strict';
// Loads J.J. Ventrella's UNMODIFIED Gene Pool simulation into Node for testing.
//
// The sim is plain browser JS: index.html loads simulation/*.js via <script> tags,
// which share one global scope. Node's per-file module scope doesn't reproduce that,
// so we concatenate the sim files (in index.html order) into ONE script and run it
// once via vm.runInThisContext — recreating the shared-scope semantics. The bundle's
// const enums/constructors are bridged out through globalThis.__GP.
//
// Notes (all verified against the code):
//  - MEMOIZED: a second vm.runInThisContext of the bundle throws (top-level const
//    redeclaration), so we cache and return the same __GP.
//  - Browser stubs (window/document/canvas/alert/setTimeout) are installed first;
//    they are only touched by the render path (which tests keep off) except alert,
//    which JJ's assert()/assertInteger() call — we make that a tagged, catchable throw.
//  - JJ schedules its loop via setTimeout("genePool.update()", ms) — a STRING callback
//    Node rejects. We swallow string callbacks and pass real functions through, so
//    node:test's own timers keep working.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.resolve(__dirname, '..', '..', 'GenePool'); // ~/src/GenePool/GenePool
const INDEX_HTML = path.join(APP_DIR, 'index.html');

let __GP = null; // memoized bundle exports

function installStubs() {
    const g = globalThis;
    if (!g.window) g.window = g;
    if (!g.document) {
        g.document = {
            getElementById: () => ({
                innerHTML: '', value: '', style: {}, appendChild() {}, focus() {},
            }),
        };
    }
    if (!g.canvas) {
        const noop = () => {};
        g.canvas = new Proxy({}, { get: () => noop, set: () => true });
    }
    // assert()/assertInteger() (Utility.js) call alert() and CONTINUE in the browser.
    // Make it a tagged throw so a tripped invariant surfaces (harness stops the run).
    g.alert = (msg) => { const e = new Error('Gene Pool assert: ' + msg); e.gpAssert = true; throw e; };
    // Swallow string setTimeout callbacks (JJ's loop scheduler); pass functions through.
    const real = g.__realSetTimeout || g.setTimeout;
    g.__realSetTimeout = real;
    g.setTimeout = (fn, ...rest) => (typeof fn === 'function' ? real(fn, ...rest) : 0);
}

function readLoadOrder() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    // index.html uses spaced attributes: src = "simulation/Foo.js"
    const re = /src\s*=\s*"(simulation\/[^"]+\.js)"/g;
    const files = [];
    let m;
    while ((m = re.exec(html)) !== null) files.push(m[1]);
    if (files.length === 0) throw new Error('load-sim: no simulation/*.js <script> tags found in index.html');
    return files;
}

function loadSim() {
    if (__GP) return __GP;
    installStubs();

    const files = readLoadOrder();
    // Prepend one real "use strict" directive. 16/19 sim files carry their own, but once
    // concatenated those become inert (non-prologue) statements — this restores their
    // browser-matching strict semantics (verified safe for the 3 otherwise-sloppy files).
    let src = '"use strict";\n';
    for (const rel of files) {
        const abs = path.join(APP_DIR, rel);
        src += `\n//# --- ${rel} ---\n` + fs.readFileSync(abs, 'utf8') + `\n//# sourceURL=${rel}\n`;
    }
    // Bridge the shared-scope const enums + function constructors out to globalThis.
    src += `
;globalThis.__GP = {
    GenePool:            (typeof GenePool            !== 'undefined') ? GenePool            : undefined,
    Genotype:            (typeof Genotype            !== 'undefined') ? Genotype            : undefined,
    Vector2D:            (typeof Vector2D            !== 'undefined') ? Vector2D            : undefined,
    Obstacle:            (typeof Obstacle            !== 'undefined') ? Obstacle            : undefined,
    Camera:              (typeof Camera              !== 'undefined') ? Camera              : undefined,
    FoodBit:             (typeof FoodBit             !== 'undefined') ? FoodBit             : undefined,
    Embryology:          (typeof Embryology          !== 'undefined') ? Embryology          : undefined,
    SimulationStartMode: (typeof SimulationStartMode !== 'undefined') ? SimulationStartMode : undefined,
    NUM_GENES:           (typeof NUM_GENES           !== 'undefined') ? NUM_GENES           : undefined,
    BYTE_SIZE:           (typeof BYTE_SIZE           !== 'undefined') ? BYTE_SIZE           : undefined,
    MAX_SWIMBOTS:        (typeof MAX_SWIMBOTS        !== 'undefined') ? MAX_SWIMBOTS        : undefined,
    MAX_FOODBITS:        (typeof MAX_FOODBITS        !== 'undefined') ? MAX_FOODBITS        : undefined,
    NULL_INDEX:          (typeof NULL_INDEX          !== 'undefined') ? NULL_INDEX          : undefined,
};
`;
    vm.runInThisContext(src, { filename: 'genepool-bundle.js' });
    __GP = globalThis.__GP;
    if (!__GP || typeof __GP.GenePool !== 'function') {
        throw new Error('load-sim: __GP.GenePool missing after load');
    }
    return __GP;
}

module.exports = { loadSim };
