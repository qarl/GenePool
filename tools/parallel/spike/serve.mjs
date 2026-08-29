// Static server for the in-browser parallel viewer. SharedArrayBuffer requires the page to be CROSS-ORIGIN
// ISOLATED, which needs two response headers on the document (COOP same-origin + COEP require-corp); module
// workers inherit that isolation. It also serves every module with a real JS MIME (Chrome rejects module
// scripts/workers served as octet-stream). Serves the whole REPO ROOT so /engine/* resolves from the spike dir.
//
// LAUNCH:  node tools/parallel/spike/serve.mjs
//          then open  http://localhost:8099/viewer-parallel.html   (Chrome; file:// will NOT work)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', '..', '..')); // repo root (…/GenePool)
const PORT = Number(process.env.PORT || 8099);
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/') path = '/viewer-parallel.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; } // no path traversal
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': MIME[extname(file)] || 'application/octet-stream',
            // cross-origin isolation -> SharedArrayBuffer available in the page + its module workers
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'same-origin', // belt-and-suspenders for the same-origin subresources
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch {
        res.writeHead(404); res.end('not found: ' + path);
    }
}).listen(PORT, () => {
    console.log(`\nGenePool parallel viewer — serving ${ROOT}`);
    console.log(`  open:  http://localhost:${PORT}/viewer-parallel.html   (Chrome; not file://)\n`);
});
