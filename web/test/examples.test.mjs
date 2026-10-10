// Every playground example must run cleanly against the real engine: no
// unintended errors, the expected scene, and (for the animated ones) actual
// motion on the virtual clock. A broken example would otherwise only be found
// by someone opening the playground.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_EXAMPLE, EXAMPLES } from '../app/examples.js';
import { createEngine } from '../js/boblox.mjs';

const byId = Object.fromEntries(EXAMPLES.map((e) => [e.id, e]));

async function play(id, seconds = 3) {
  const lines = [];
  const engine = await createEngine({ onOutput: (l) => lines.push(...l) });
  const ok = engine.run(byId[id].code);
  const before = engine.parts();
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) engine.step(1 / 60);
  const after = engine.parts();
  return { engine, ok, lines, before, after };
}

const errors = (lines) => lines.filter((l) => l.level === 'error').map((l) => l.text);

test('the example list is well-formed', () => {
  const ids = EXAMPLES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(ids.includes(DEFAULT_EXAMPLE));
  for (const e of EXAMPLES) {
    assert.ok(e.title && e.note && e.code.trim(), `${e.id}: title, note and code present`);
  }
});

test('planets: five bodies, four of them moving', async () => {
  const { engine, ok, lines, before, after } = await play('planets');
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  const stride = engine.partStride;
  assert.equal(before.length / stride, 5);
  let moved = 0;
  for (let i = 0; i < 5; i++) {
    const b = before.subarray(i * stride + 9, i * stride + 12);
    const a = after.subarray(i * stride + 9, i * stride + 12);
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1) moved++;
  }
  assert.equal(moved, 4, 'the sun stays put, each planet moves');
  assert.match(lines[0].text, /4 planets orbiting/);
  engine.dispose();
});

test('tower: a static scene of 13 parts', async () => {
  const { engine, ok, lines, before, after } = await play('tower', 1);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  assert.equal(before.length / engine.partStride, 13);
  assert.deepEqual(Array.from(after), Array.from(before), 'nothing animates');
  assert.equal(lines[0].text, 'built 12 blocks; 14 instances in Workspace');
  engine.dispose();
});

test('bounce: nine balls plus a floor, balls move and stay above the floor', async () => {
  const { engine, ok, lines, before, after } = await play('bounce', 4);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  const stride = engine.partStride;
  assert.equal(after.length / stride, 10);
  let changed = 0;
  for (let i = 0; i < 10; i++) {
    const y0 = before[i * stride + 10];
    const y1 = after[i * stride + 10];
    if (y0 !== y1) changed++;
    if (i > 0) assert.ok(y1 >= 1 - 1e-9, `ball ${i} stays on/above the floor (y=${y1})`);
  }
  assert.ok(changed >= 9, `${changed} parts moved`);
  engine.dispose();
});

test('explorer: the browsable scene', async () => {
  const { engine, ok, lines } = await play('explorer', 0.1);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  assert.equal(lines[0].text, '10 instances under Workspace.Scene');
  assert.equal(engine.parts().length / engine.partStride, 6);
  const classes = new Set();
  (function walk(n) { classes.add(n.c); n.ch.forEach(walk); })(engine.tree().root);
  for (const c of ['Model', 'Part', 'WedgePart', 'SpawnLocation', 'Humanoid', 'ParticleEmitter', 'Frame']) {
    assert.ok(classes.has(c), `scene contains a ${c}`);
  }
  engine.dispose();
});

test('events: handlers and tasks fire in virtual-time order', async () => {
  const { engine, ok, lines } = await play('events', 3);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  assert.deepEqual(lines.map((l) => `${l.level}: ${l.text}`), [
    'print: Name changed to Renamed',
    'print: Level attribute is now 1',
    'print: worker started',                      // task.spawn runs immediately...
    'print: main chunk done; the rest happens as the clock advances',
    'print: task.defer runs on the next pump, after the main chunk',
    'print: Level attribute is now 2',
    'print: t=0.5s  health=70',
    'print: Level attribute is now 3',
    'print: t=1.0s  health=40',
    'print: task.delay fired at about 1.25s',
    'print: Level attribute is now 4',
    'print: t=1.5s  health=10',
    'print: Level attribute is now 5',
    'warn: the humanoid died!',                   // Died fires once, when health crosses 0
    'print: t=2.0s  health=-20',
    'print: worker finished',
  ]);
  engine.dispose();
});

test('datatypes: no errors, expected values', async () => {
  const { engine, ok, lines } = await play('datatypes', 0.1);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  const all = lines.map((l) => l.text).join('\n');
  assert.match(all, /Vector3 3, 4, 12 magnitude 13 dot 3/);
  assert.match(all, /Random\(42\): 56 23 5/);
  assert.match(all, /inverse \* cf is identity: true/);
  assert.match(all, /DateTime 2023-11-14T22:13:20\.000Z/);
  engine.dispose();
});

test('spiral: 1500 parts', async () => {
  const { engine, ok, lines } = await play('spiral', 0.1);
  assert.equal(ok, true);
  assert.deepEqual(errors(lines), []);
  assert.equal(engine.parts().length / engine.partStride, 1500);
  engine.dispose();
});

test('hello: runs, waits a virtual second, then ends with its intentional error', async () => {
  const lines = [];
  const engine = await createEngine({ onOutput: (l) => lines.push(...l) });
  assert.equal(engine.run(byId.hello.code), true);
  assert.deepEqual(errors(lines), [], 'no error before the wait elapses');
  assert.ok(lines.some((l) => l.text === 'fib(25) = 75025'));
  engine.step(1);
  assert.ok(lines.some((l) => l.text === 'one virtual second later'));
  assert.equal(errors(lines).length, 1);
  assert.match(errors(lines)[0], /^main:\d+: an uncaught error ends the script/);
  engine.dispose();
});
