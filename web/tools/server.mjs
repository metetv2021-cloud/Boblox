// server.mjs — the playground's static file server, as a module (used by
// serve.mjs and by the browser tests). No dependencies.
//
// Why not `python3 -m http.server`: .wasm must be served as application/wasm
// (streaming compilation) and .mjs as a JavaScript MIME type for module
// scripts and module Workers; this server guarantees both.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.luau': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** @param {string} root directory to serve @returns {import('node:http').Server} */
export function createStaticServer(root) {
  root = path.resolve(root);
  return createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    let file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end('forbidden'); // path traversal
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const st = statSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + rel);
    }
  });
}
