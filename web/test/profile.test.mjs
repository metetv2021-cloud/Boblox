// Guards on WHAT is in the browser build. The WebAssembly module must stay the
// scripting engine only: no challenge runner, no networking, no Roblox
// client-protocol code. These tests inspect the compiled binary itself, so a
// future change that links something else in fails loudly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../js/boblox.mjs';

const wasmPath = fileURLToPath(new URL('../dist/boblox_engine.wasm', import.meta.url));
const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

test('the module exports exactly the boblox C ABI (plus Emscripten plumbing)', () => {
  const names = WebAssembly.Module.exports(module).map((e) => e.name).sort();
  const boblox = names.filter((n) => n.startsWith('boblox_'));
  assert.deepEqual(boblox, [
    'boblox_create', 'boblox_destroy', 'boblox_drain', 'boblox_gc', 'boblox_memory_kb',
    'boblox_now', 'boblox_part_stride', 'boblox_parts', 'boblox_parts_count', 'boblox_profile',
    'boblox_props', 'boblox_run', 'boblox_set_time_limit_ms', 'boblox_step', 'boblox_tree',
  ]);
  // Emscripten plumbing. The default build needs little; the -DBOBLOX_WASM_EXCEPTIONS=js
  // flavor additionally exports the C++ exception ABI (__cxa_*, setThrew, ...).
  const plumbing = /^(memory|__wasm_call_ctors|__indirect_function_table|free|malloc|__trap|setThrew|__cxa_\w+|_?emscripten_\w+)$/;
  const unexpected = names.filter((n) => !n.startsWith('boblox_') && !plumbing.test(n));
  assert.deepEqual(unexpected, [], 'unexpected exports: ' + unexpected.join(', '));
});

test('the module imports no networking or filesystem capability', () => {
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  // Allowed: clock, environment, stdio plumbing, date/time helpers, exit — and, in the
  // JS-exceptions flavor, the C++ exception ABI (__cxa_*, invoke_*, __resumeException, ...).
  const allowed = /^(env\.(exit|emscripten_get_now|emscripten_date_now|_tzset_js|_mktime_js|_localtime_js|_gmtime_js|emscripten_resize_heap|_abort_js|__cxa_\w+|__resumeException|llvm_eh_typeid_for|invoke_\w+|_emscripten_\w+)|wasi_snapshot_preview1\.(clock_time_get|environ_sizes_get|environ_get|fd_close|fd_write|fd_seek|fd_read))$/;
  const stray = imports.filter((i) => !allowed.test(i));
  assert.deepEqual(stray, [], 'unexpected imports: ' + stray.join(', '));
  assert.ok(!imports.some((i) => /sock|fetch|xhr|http|net|path_open|fd_pread|fd_pwrite|proc_raise/i.test(i)));
});

test('the 0x9B challenge runner and client-protocol code are not linked in', () => {
  const text = Buffer.from(bytes).toString('latin1');
  // runner.cpp's chunk name and main.cpp's CLI flags only exist if the
  // challenge runner was linked; the others are client/ strings.
  for (const marker of ['=challenge', '--program=', 'challenge_runner', 'RSB1', 'ngtcp2', 'RbxTransport', 'udmux']) {
    assert.ok(!text.includes(marker), `build contains "${marker}"`);
  }
  // sanity: the engine we DO ship is present
  for (const marker of ['rbx.Scheduler', 'Unable to create an Instance of type']) {
    assert.ok(text.includes(marker), `build is missing "${marker}"`);
  }
});

test('engines are Engine-profile only', async () => {
  const engine = await createEngine();
  try {
    assert.equal(engine.profile, 'Engine');
    const lines = [];
    engine.onOutput = (l) => lines.push(...l.map((x) => x.text));
    // the Engine surface (Instance world, scheduler, datatypes)...
    engine.run('print(typeof(Instance), typeof(task), typeof(Vector3), typeof(CFrame), typeof(Enum), typeof(workspace))');
    // ...on top of the historical sandbox: Random, game, os, newproxy, UserSettings
    engine.run('print(typeof(Random), typeof(game), typeof(os), typeof(newproxy), typeof(UserSettings), typeof(os.exit))');
    // calibration used for the challenge profile is NOT applied here
    engine.run('print(tostring(UserSettings()), game.JobId)');
    // os.exit exists but cannot terminate anything: it raises
    engine.run('print(pcall(os.exit, 3))\nprint("still alive")');
    assert.deepEqual(lines, [
      'table table table table Enum Instance',
      'table table table function function function',
      'UserSettings 00000000-0000-0000-0000-000000000000',
      'false os.exit unavailable',
      'still alive',
    ]);
  } finally {
    engine.dispose();
  }
});
