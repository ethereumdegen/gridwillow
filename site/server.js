// A static file server with no dependencies, for Railway.
//
// `npm install` on deploy would be a download and a lockfile for something the
// standard library already does. Railway sets PORT; everything else is defaults.
//
// Two things here are not plain static serving, and both exist so that a coding
// agent fetching this site gets something worth reading:
//
//   1. /docs/language resolves to docs/language.html, and docs/language.md is
//      served alongside it. One document, two representations, one URL stem.
//   2. A client that asks for markdown or plain text — and does not ask for
//      HTML — gets the .md twin of whatever page it requested.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;
const ORIGIN = 'https://gridwillow.com';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.ebnf': 'text/plain; charset=utf-8',
  '.bp':   'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
};

// Only the exported blueprint is genuinely immutable between deploys — it is a
// megabyte and it changes when the sample does. Everything else is small enough
// that a five-minute window costs nothing and saves a stale-docs support thread.
const cacheFor = (rel) =>
  rel.endsWith('.blueprint.html') ? 'public, max-age=604800' : 'public, max-age=300';

const exists = async (file) => {
  try { return await stat(file); } catch { return null; }
};

// True only when the client named markdown or plain text and did not name HTML.
// `Accept: */*` — what curl and most naive fetchers send — deliberately does not
// match: an unspecific client gets the HTML, which is the safe answer.
function wantsPlain(accept = '') {
  const a = accept.toLowerCase();
  if (a.includes('text/html')) return false;
  return a.includes('text/markdown') || a.includes('text/plain');
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // normalize() collapses any ../ before it can escape the directory
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel.endsWith('/')) rel += 'index.html';

    let file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let info = await exists(file);

    if (info?.isDirectory()) {
      res.writeHead(302, { Location: rel + '/' }).end();
      return;
    }

    // /docs/language -> docs/language.html
    if (!info && !extname(rel)) {
      const html = `${rel}.html`;
      if (await exists(join(ROOT, html))) { rel = html; file = join(ROOT, html); info = true; }
    }

    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(notFound());
      return;
    }

    // The markdown twin, when the client asked for markdown and not for HTML.
    const twin = rel.endsWith('.html') ? rel.replace(/\.html$/, '.md') : null;
    const hasTwin = twin ? Boolean(await exists(join(ROOT, twin))) : false;
    if (hasTwin && wantsPlain(req.headers.accept)) {
      rel = twin;
      file = join(ROOT, twin);
    }

    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cacheFor(rel),
      'X-Content-Type-Options': 'nosniff',
    };

    // Advertise the other representation, so a client that would rather have
    // markdown can find it without guessing at the URL.
    if (hasTwin && ext === '.html') {
      headers.Link = `<${ORIGIN}/${twin.replace(/^\/+/, '')}>; rel="alternate"; type="text/markdown"`;
    }

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('server error');
  }
}).listen(PORT, () => console.log(`gridwillow.com listening on :${PORT}`));

// A 404 that still tells an agent where the documentation is, since a wrong
// guess at a URL is the most likely way one arrives here.
function notFound() {
  return '<!doctype html><meta charset=utf-8><title>Not found — Gridwillow</title>'
       + '<meta name="robots" content="noindex">'
       + '<body style="font:16px/1.7 -apple-system,sans-serif;background:#f3f1ec;'
       + 'color:#111;display:grid;place-items:center;height:100vh;margin:0;padding:20px">'
       + '<div style="max-width:44ch">'
       + '<h1 style="font-size:40px;letter-spacing:-.03em;margin:0 0 10px">404</h1>'
       + '<p style="color:#5c5c5c;margin:0 0 14px">That page does not exist.</p>'
       + '<p style="color:#5c5c5c;margin:0">The documentation index is at '
       + '<a href="/docs/" style="color:#111">/docs/</a>. Every document on this '
       + 'site is listed in <a href="/llms.txt" style="color:#111">/llms.txt</a> '
       + 'and concatenated into <a href="/llms-full.txt" style="color:#111">'
       + '/llms-full.txt</a>. Or start from <a href="/" style="color:#111">the '
       + 'front page</a>.</p></div>';
}
