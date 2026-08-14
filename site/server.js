// A static file server with no dependencies, for Railway.
//
// `npm install` on deploy would be a download and a lockfile for something the
// standard library already does. Railway sets PORT; everything else is defaults.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.bp':   'text/plain; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // normalize() collapses any ../ before it can escape the directory
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: rel + '/' }).end();
      return;
    }

    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    // The exported blueprint is a megabyte and changes only on deploy, so it is
    // worth caching hard. The page itself is not.
    const immutable = ext !== '.html';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': immutable ? 'public, max-age=604800' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset=utf-8><title>Not found</title>'
          + '<body style="font:16px/1.6 -apple-system,sans-serif;background:#f3f1ec;'
          + 'color:#111;display:grid;place-items:center;height:100vh;margin:0">'
          + '<div><h1 style="font-size:40px;letter-spacing:-.03em;margin:0 0 8px">404</h1>'
          + '<p style="color:#6e6e6e"><a href="/" style="color:#111">Back to Gridwillow</a></p></div>');
  }
}).listen(PORT, () => console.log(`gridwillow.com listening on :${PORT}`));
