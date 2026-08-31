// JSONL run-file sink (§14): the append-only SOURCE OF TRUTH. One JSON object per line -- a header first, then
// the raw event stream (founder / food_init / birth incl. base64 genes + masks / eat / death / tick). Everything
// needed to rebuild + analyze the run lives here and ONLY here; the SQLite catalog (ingest-jsonl.mjs) is a
// disposable index derived from it. The sink is a PURE OBSERVER (never touches the world) and STREAMS in small
// batches (no whole-run buffer) so memory stays bounded for endless runs.

import { openSync, writeSync, closeSync } from 'node:fs';

export const SCHEMA_VERSION = 1;

// runId: the content-addressed run identity (fold the founder genomes in -- see run-recorder). config/seed make
// the run rebuildable together with the founder/food_init events.
export function createJsonlSink(path, { runId, seed, config, engineVersion = null, batchSize = 1000 } = {}) {
    const fd = openSync(path, 'w'); // create/truncate
    let buf = '';
    let pending = 0;
    function writeLine(obj) { buf += JSON.stringify(obj) + '\n'; if (++pending >= batchSize) flush(); }
    function flush() { if (buf) { writeSync(fd, buf); buf = ''; pending = 0; } }
    writeLine({ type: 'header', schemaVersion: SCHEMA_VERSION, runId, seed, config, engineVersion });
    return {
        runId,
        onEvent(e) { writeLine(e); },
        flush,
        close() { flush(); closeSync(fd); },
    };
}
