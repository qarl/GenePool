// Tiny static server for the viewer + its ES-module imports (engine/*.js). Serves the REPO ROOT with real JS MIME.
// EPHEMERAL port (listen 0) + a real readiness signal (the listen callback) + an error handler, so bind failures are
// loud and there are no port collisions or sleep-guesses. Returns { port, close } only once actually listening.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', '..', '..'));   // test/visual/lib -> repo root
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png' };

export function startServer(){
  return new Promise((resolve, reject) => {
    const srv = createServer(async (req, res) => {
      let path = decodeURIComponent((req.url || '/').split('?')[0]);
      if (path === '/') path = '/viewer-micrograph-gl.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)){ res.writeHead(403); res.end('forbidden'); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found: ' + path); }
    });
    srv.on('error', reject);                                  // EADDRINUSE etc -> reject loudly, not an uncaught crash
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise(r => srv.close(r)) }));
  });
}
