#!/usr/bin/env node
// Serve the playground:
//
//   node web/tools/serve.mjs [--port 8080] [--host 127.0.0.1] [--dir web]
//
// then open http://127.0.0.1:8080/ (needs web/dist: run ./web/build.sh first).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createStaticServer } from './server.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = path.resolve(opt('dir', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const port = Number(opt('port', '8080'));
const host = opt('host', '127.0.0.1');

if (!existsSync(path.join(root, 'dist', 'boblox_engine.wasm'))) {
  console.warn('warning: dist/boblox_engine.wasm is missing — build it first: ./web/build.sh');
}
createStaticServer(root).listen(port, host, () => {
  console.log(`serving ${root}\n  http://${host}:${port}/`);
});
