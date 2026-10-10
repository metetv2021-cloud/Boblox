#!/usr/bin/env node
// Regenerates web/test/golden/*.txt — the reference transcripts — from the
// NATIVE build of the engine (web/build-native/boblox_cli). The WebAssembly
// build is then required to reproduce them byte for byte (parity.test.mjs).
//
//   ./web/build.sh native
//   node web/tools/gen-goldens.mjs           # rewrite the goldens
//   node web/tools/gen-goldens.mjs --check   # fail if the native CLI disagrees
//
// BOBLOX_CLI overrides the CLI path.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const cli = process.env.BOBLOX_CLI ?? path.join(webDir, 'build-native', 'boblox_cli');
const check = process.argv.includes('--check');

if (!existsSync(cli)) {
  console.error(`native CLI not found: ${cli}\nbuild it first: ./web/build.sh native`);
  process.exit(2);
}

const corpus = path.join(webDir, 'test', 'corpus');
const goldenDir = path.join(webDir, 'test', 'golden');
mkdirSync(goldenDir, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
let bad = 0;

for (const entry of manifest) {
  const args = ['--limit-ms', String(entry.limitMs ?? 10000)];
  if (entry.steps) args.push('--steps', String(entry.steps), '--dt', String(entry.dt ?? 0.1));
  if (entry.tree) args.push('--tree');
  if (entry.props) args.push('--props');
  args.push(path.join(corpus, entry.file));

  // exit status 1 just means "the script itself failed" — several do, on purpose
  const run = spawnSync(cli, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || run.status === null || run.status > 1) {
    console.error(`${entry.file}: CLI crashed (status ${run.status}, signal ${run.signal})\n${run.stderr}`);
    process.exit(1);
  }
  const target = path.join(goldenDir, entry.file.replace(/\.luau$/, '.txt'));
  if (check) {
    const have = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (have !== run.stdout) {
      console.error(`DRIFT  ${entry.file}`);
      bad++;
    } else {
      console.log(`ok     ${entry.file}`);
    }
  } else {
    writeFileSync(target, run.stdout);
    console.log(`wrote  ${path.relative(webDir, target)}  (${run.stdout.length} bytes)`);
  }
}
process.exit(bad ? 1 : 0);
