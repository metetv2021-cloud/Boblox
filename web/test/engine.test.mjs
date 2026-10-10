// API-level tests for the JS wrapper over the WebAssembly engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createEngine, loadModule } from '../js/boblox.mjs';

async function withEngine(fn, options = {}) {
  const engine = await createEngine(options);
  const out = [];
  engine.onOutput = (lines) => out.push(...lines);
  try {
    return await fn(engine, out);
  } finally {
    engine.dispose();
  }
}
const texts = (out) => out.map((l) => l.text);

// Run a script in a worker that we are able to kill if it never returns.
function runInWorker(options, killAfterMs = 20_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL('./helpers/worker-run.mjs', import.meta.url)), {
      workerData: options,
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`script did not return within ${killAfterMs} ms (time limit not enforced)`));
    }, killAfterMs);
    worker.once('message', (m) => { clearTimeout(timer); resolve(m); worker.terminate(); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

test('print, warn and errors arrive in order with their level', () => withEngine((engine, out) => {
  assert.equal(engine.run('print("a", 1, nil)\nwarn("careful", 2)\nerror("boom")'), false);
  assert.deepEqual(out, [
    { level: 'print', text: 'a 1 nil' },
    { level: 'warn', text: 'careful 2' },
    { level: 'error', text: 'main:3: boom' },
  ]);
}));

test('print joins with spaces (Roblox style), honors __tostring, and prints empty lines', () => withEngine((engine, out) => {
  engine.run('print()\nprint(setmetatable({}, {__tostring = function() return "OBJ" end}), true)');
  assert.deepEqual(texts(out), ['', 'OBJ true']);
}));

test('compile errors are reported with the chunk name; run() returns false', () => withEngine((engine, out) => {
  assert.equal(engine.run('local x = = 1', 'lib.luau'), false);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'error');
  assert.match(out[0].text, /^lib\.luau:1: /);
}));

test('non-string error values are reported rather than crashing', () => withEngine((engine, out) => {
  assert.equal(engine.run('error({code = 1})'), false);
  assert.equal(out.at(-1).level, 'error');
  assert.equal(engine.run('print("fine")'), true);
}));

test('without a listener output is buffered for drain()', async () => {
  const engine = await createEngine();
  try {
    engine.run('print("one")');
    engine.step(0);
    engine.run('print("two")');
    assert.deepEqual(engine.drain().map((l) => l.text), ['one', 'two']);
    assert.deepEqual(engine.drain(), []);
    // a listener installed later receives only new output
    const seen = [];
    engine.onOutput = (l) => seen.push(...l);
    engine.run('print("three")');
    assert.deepEqual(seen.map((l) => l.text), ['three']);
  } finally {
    engine.dispose();
  }
});

test('UTF-8 and embedded NULs survive the JS <-> wasm boundary', () => withEngine((engine, out) => {
  engine.run('print("héllo 🚀 日本語")\nprint("a\\0b")');
  assert.deepEqual(texts(out), ['héllo 🚀 日本語', 'a\0b']);
  out.length = 0;
  engine.run('local p = Instance.new("Part") p.Name = "naïve 🚀" p.Parent = workspace');
  assert.equal(engine.tree().root.ch[0].n, 'naïve 🚀');
}));

test('very large sources and outputs', () => withEngine((engine, out) => {
  const big = 'x'.repeat(1 << 20);
  assert.equal(engine.run(`local s = "${big}"\nprint(#s)\nprint(s)`), true);
  assert.equal(out[0].text, String(big.length));
  assert.equal(out[1].text.length, big.length);
}));

// ---------------------------------------------------------------------------
// scheduler and the virtual clock
// ---------------------------------------------------------------------------

test('a top-level task.wait yields; step() resumes the script on the virtual clock', () => withEngine((engine, out) => {
  assert.equal(engine.run('print("a")\ntask.wait(1)\nprint("b")'), true);
  assert.deepEqual(texts(out), ['a']);
  assert.equal(engine.now, 0, 'running a script does not advance the clock');
  assert.equal(engine.step(0.5), 0);
  assert.deepEqual(texts(out), ['a']);
  assert.equal(engine.step(0.5), 1);
  assert.deepEqual(texts(out), ['a', 'b']);
  assert.equal(engine.now, 1);
}));

test('task errors surface after step() and do not stop other tasks', () => withEngine((engine, out) => {
  engine.run(`
    task.delay(1, function() error("task failure") end)
    task.delay(2, function() print("survivor") end)`);
  engine.step(1);
  assert.deepEqual(out.map((l) => l.level), ['error']);
  assert.match(out[0].text, /task failure/);
  engine.step(1);
  assert.deepEqual(texts(out).slice(1), ['survivor']);
}));

test('a failure after the first yield is reported by step(), not run()', () => withEngine((engine, out) => {
  assert.equal(engine.run('task.wait(0.1)\nerror("late")'), true);
  assert.deepEqual(out, []);
  engine.step(0.2);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /main:2: late/);
}));

test('engine state persists across run() calls', () => withEngine((engine, out) => {
  engine.run('counter = 10\nlocal p = Instance.new("Part") p.Name = "kept" p.Parent = workspace');
  engine.run('counter += 5\nprint(counter, workspace:FindFirstChild("kept") ~= nil)');
  assert.deepEqual(texts(out), ['15 true']);
}));

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

test('a runaway loop is aborted by the time limit and the engine stays usable', async () => {
  const r = await runInWorker({ source: 'while true do end', limitMs: 150 });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
  assert.match(r.lines[0].text, /Script timeout: exhausted allowed execution time/);
  assert.equal(r.usable, true);
  assert.equal(r.lines.at(-1).text, 'still usable');
});

test('the time limit cannot be swallowed with pcall', async () => {
  const r = await runInWorker({
    source: 'while true do pcall(function() while true do end end) end',
    limitMs: 150,
  });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
  assert.match(r.lines[0].text, /Script timeout/);
  assert.equal(r.usable, true);
});

test('the time limit also bounds scheduler work in step()', async () => {
  const r = await runInWorker({
    source: 'task.spawn(function() task.wait(1) while true do end end)',
    limitMs: 150,
    stepDt: 2,
  });
  assert.equal(r.ok, true, 'the script itself started fine');
  assert.ok(r.lines.some((l) => l.level === 'error' && /Script timeout/.test(l.text)));
  assert.equal(r.usable, true);
});

test('setTimeLimit(0) disables the limit', () => withEngine((engine, out) => {
  const work = 'local n = 0 for i = 1, 3e7 do n += i end print(n)';
  engine.setTimeLimit(1);
  assert.equal(engine.run(work), false);
  assert.match(out.at(-1).text, /Script timeout/);
  out.length = 0;
  engine.setTimeLimit(0);
  assert.equal(engine.run(work), true);
  assert.deepEqual(texts(out), ['450000015000000']);
}));

test('memory: big allocations grow the heap; garbage is reclaimable; 1 GiB fails cleanly', () => withEngine((engine, out) => {
  const before = engine.memoryKB;
  engine.run('big = string.rep("x", 48 * 1024 * 1024)');
  assert.ok(engine.memoryKB > before + 40 * 1024, 'heap grew by ~48 MiB');
  engine.run('big = nil');
  engine.collectGarbage();
  assert.ok(engine.memoryKB < before + 8 * 1024, 'garbage was reclaimed');

  engine.run('print(pcall(string.rep, "x", 2^30))');
  assert.equal(out.at(-1).text, 'false not enough memory');
  assert.equal(engine.run('print("alive")'), true, 'still usable after the allocation failure');
}));

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test('engines are isolated from each other', async () => {
  const a = await createEngine();
  const b = await createEngine();
  try {
    a.run('shared = "A" local p = Instance.new("Part") p.Name = "only-in-a" p.Parent = workspace');
    b.run('print(shared) task.wait(5)');
    assert.deepEqual(b.drain().map((l) => l.text), ['nil']);
    assert.equal(a.tree().root.ch.length, 1);
    assert.equal(b.tree().root.ch.length, 0);
    a.step(3);
    assert.equal(a.now, 3);
    assert.equal(b.now, 0);
    a.dispose();
    b.step(5); // b survives a's disposal
    assert.equal(b.now, 5);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('dispose() is idempotent and a disposed engine refuses further calls', async () => {
  const engine = await createEngine();
  assert.equal(engine.disposed, false);
  engine.dispose();
  engine.dispose();
  assert.equal(engine.disposed, true);
  assert.throws(() => engine.run('print(1)'), /disposed/);
  assert.throws(() => engine.step(1), /disposed/);
  assert.throws(() => engine.tree(), /disposed/);
});

test('a WebAssembly failure poisons the engine instead of continuing on corrupt state', async () => {
  const real = await loadModule();
  // behave like the real module, except step() dies the way a WASM stack
  // overflow does (V8 surfaces it as a RangeError out of the export)
  const faulty = new Proxy(real, {
    get(target, key) {
      if (key === '_boblox_step') return () => { throw new RangeError('Maximum call stack size exceeded'); };
      return target[key];
    },
  });
  const engine = await createEngine({ module: faulty });
  assert.equal(engine.run('print("fine")'), true);
  assert.throws(() => engine.step(1), RangeError);
  assert.throws(() => engine.run('print("again")'), /unusable after an earlier WebAssembly failure/);
  assert.throws(() => engine.tree(), /unusable/);
  engine.dispose(); // must still release what it can without throwing
  assert.equal(engine.disposed, true);
});

test('loadModule() is memoized; a module can be passed explicitly', async () => {
  const m1 = await loadModule();
  const m2 = await loadModule();
  assert.equal(m1, m2);
  const engine = await createEngine({ module: m1, timeLimitMs: 1234 });
  try {
    assert.equal(engine.profile, 'Engine');
  } finally {
    engine.dispose();
  }
});

// ---------------------------------------------------------------------------
// viewer data: tree / properties / parts
// ---------------------------------------------------------------------------

test('tree(): structure, stable ids, and removal of destroyed instances', () => withEngine((engine) => {
  engine.run(`
    local m = Instance.new("Model") m.Name = "M" m.Parent = workspace
    local a = Instance.new("Part", m) a.Name = "A"
    local b = Instance.new("Part", m) b.Name = "B"
  `);
  const t1 = engine.tree();
  assert.equal(t1.count, 4);
  assert.equal(t1.truncated, false);
  assert.equal(t1.root.c, 'Workspace');
  const [m1] = t1.root.ch;
  assert.deepEqual(m1.ch.map((c) => [c.c, c.n]), [['Part', 'A'], ['Part', 'B']]);
  const idOfA = m1.ch[0].id;
  const idOfB = m1.ch[1].id;

  engine.run(`
    local m = workspace:FindFirstChild("M")
    m:FindFirstChild("A"):Destroy()
    local c = Instance.new("Part", m) c.Name = "C"
    m:FindFirstChild("B").Name = "B2"
  `);
  const t2 = engine.tree();
  const [m2] = t2.root.ch;
  assert.deepEqual(m2.ch.map((c) => c.n), ['B2', 'C']);
  assert.equal(m2.ch[0].id, idOfB, 'a surviving instance keeps its id (even renamed)');
  assert.ok(!JSON.stringify(t2).includes(`"id":${idOfA},`), 'destroyed instance is gone');
  assert.equal(engine.properties(idOfA), null, 'its id no longer resolves');
}));

test('tree() JSON survives hostile names', () => withEngine((engine) => {
  engine.run(String.raw`
    local p = Instance.new("Part")
    p.Name = 'quote" back\\slash \n newline \t tab \1 ctrl'
    p.Parent = workspace
  `);
  assert.equal(engine.tree().root.ch[0].n, 'quote" back\\slash \n newline \t tab \x01 ctrl');
}));

test('tree() is capped instead of exploding on huge scenes', () => withEngine((engine) => {
  engine.run('local f = Instance.new("Folder") f.Parent = workspace for i = 1, 25000 do Instance.new("Part", f) end');
  const t = engine.tree();
  assert.equal(t.truncated, true);
  assert.equal(t.count, 20000);
}));

test('properties(): typed, de-duplicated, human-readable values', () => withEngine((engine) => {
  engine.run(`
    local p = Instance.new("Part")
    p.Name = "Probe"
    p.Color = Color3.new(1, 0, 0)
    p.Size = Vector3.new(2, 3, 4)
    p.Shape = Enum.PartType.Ball
    p.Material = Enum.Material.Neon
    p.Parent = workspace
    local m = Instance.new("Model") m.Parent = workspace m.PrimaryPart = p
  `);
  const tree = engine.tree();
  const probe = tree.root.ch.find((c) => c.n === 'Probe');
  const props = engine.properties(probe.id);
  const byName = Object.fromEntries(props.map((p) => [p.n, p]));
  assert.equal(new Set(props.map((p) => p.n)).size, props.length, 'no duplicate property names');
  assert.deepEqual([byName.Name.t, byName.Name.v], ['String', 'Probe']);
  assert.deepEqual([byName.Size.t, byName.Size.v], ['Vector3', '2, 3, 4']);
  assert.deepEqual([byName.Color.t, byName.Color.v], ['Color3', '1, 0, 0']);
  assert.deepEqual([byName.Anchored.t, byName.Anchored.v], ['Bool', 'false']);
  assert.equal(byName.Shape.v, 'Enum.PartType.Ball');
  assert.equal(byName.Material.v, 'Enum.Material.Neon');
  assert.equal(byName.CFrame.v, '0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1');
  assert.equal(byName.Mass.ro, true, 'read-only flag is exposed');
  const model = tree.root.ch.find((c) => c.c === 'Model');
  const mp = Object.fromEntries(engine.properties(model.id).map((p) => [p.n, p]));
  assert.equal(mp.PrimaryPart.v, 'Probe (Part)', 'Instance-valued property');
  assert.ok(props.every((p) => !/0x[0-9a-f]{6,}/.test(p.v)), 'no raw pointer values leak into the UI');
}));

test('parts(): layout, shapes, CFrame/Position handling, ids, removal', () => withEngine((engine) => {
  assert.equal(engine.partStride, 21);
  engine.run(`
    local function mk(name, cls, parent)
      local p = Instance.new(cls) p.Name = name p.Parent = parent or workspace return p
    end
    local a = mk("A", "Part")
    a.CFrame = CFrame.new(1, 2, 3)
    a.Size = Vector3.new(5, 6, 7)
    a.Color = Color3.new(0.25, 0.5, 0.75)
    a.Transparency = 0.5
    local b = mk("B", "Part")
    b.Position = Vector3.new(9, 8, 7)           -- Position only: CFrame never set
    b.Shape = Enum.PartType.Ball
    local c = mk("C", "WedgePart")
    local d = mk("D", "Part") d.Shape = Enum.PartType.Cylinder
    local f = mk("NotAPart", "Folder")
    local nested = mk("N", "Part", f)
    nested.CFrame = CFrame.fromAxisAngle(Vector3.new(0, 1, 0), math.pi / 2)
  `);
  const stride = engine.partStride;
  const parts = engine.parts();
  assert.equal(parts.length, 5 * stride, 'five BaseParts; the Folder is not drawn');
  assert.ok(parts instanceof Float64Array);
  const row = (i) => Array.from(parts.subarray(i * stride, (i + 1) * stride));

  const tree = engine.tree();
  const idOf = (n) => (function find(node) {
    if (node.n === n) return node.id;
    for (const c of node.ch) { const r = find(c); if (r !== undefined) return r; }
  })(tree.root);

  const A = row(0);
  assert.equal(A[0], idOf('A'), 'part ids are the tree ids');
  assert.deepEqual(A.slice(1, 9), [1, 0.5, 0.25, 0.5, 0.75, 5, 6, 7]);   // shape block, transp, color, size
  assert.deepEqual(A.slice(9, 21), [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1]); // translation + identity
  const B = row(1);
  assert.equal(B[1], 0, 'Ball');
  assert.deepEqual(B.slice(9, 12), [9, 8, 7], 'Position is honored while CFrame was never set');
  assert.equal(row(2)[1], 3, 'WedgePart');
  assert.equal(row(3)[1], 2, 'Cylinder');
  const N = row(4);
  assert.ok(Math.abs(N[12 + 2] - 1) < 1e-12 || Math.abs(N[12 + 2] + 1) < 1e-12, 'rotated about Y by 90deg');

  engine.run('workspace:FindFirstChild("A"):Destroy()');
  assert.equal(engine.parts().length, 4 * stride);
}));
