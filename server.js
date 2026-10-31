// Zero-dependency static file server for Roadflow.
// Usage: npm start  ->  http://127.0.0.1:8080
// S08.3: binds 127.0.0.1 by default; external binding needs HOST=0.0.0.0
// explicitly. Serves only allowlisted public assets; traversal returns a
// controlled 400/404 and never crashes the process.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublicPath } from './scripts/package-lib.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://x').pathname;
    if (path === '/') path = '/index.html';
    const file = resolvePublicPath(ROOT, path);
    if (!file) { res.writeHead(400); res.end('Bad request'); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, HOST, () => console.log(`Roadflow running at http://${HOST}:${PORT}`));
