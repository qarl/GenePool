// desktop/generator.mjs -- runs INSIDE an Electron utilityProcess (real Node, the SAME V8 as the playback renderer,
// so restore()+resim is bit-identical -- D1). Receives a generate request from main, runs the headless generator
// (tools/scrub/run-gen.mjs) writing runs/run-<seed>.db, and posts {ready}/{progress}/{done}/{error} back. It may be
// killed at any moment on a seed change (S5); run-db's atomic keyframe writes + the S4 resume path make a partial .db
// safe to reopen and continue.
import { generateRun } from '../tools/scrub/run-gen.mjs';

process.parentPort.on('message', (e) => {
    const { seed, out, opts } = e.data || {};
    try {
        const summary = generateRun(out, seed, {
            ...opts,
            onReady: (info) => process.parentPort.postMessage({ type: 'ready', ...info }),
            onProgress: (tick) => process.parentPort.postMessage({ type: 'progress', tick }),
        });
        process.parentPort.postMessage({ type: 'done', ...summary });
    } catch (err) {
        process.parentPort.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
});
