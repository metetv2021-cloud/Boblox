// boblox.mjs — JavaScript API over the WebAssembly build of the Boblox
// Engine profile (the Roblox-flavored Luau scripting environment).
//
//   import { createEngine } from './boblox.mjs';
//   const engine = await createEngine({
//     onOutput: (lines) => lines.forEach(l => console.log(l.level, l.text)),
//   });
//   engine.run('print("hello", Vector3.new(1, 2, 3))');
//   engine.step(1 / 60);              // advance the virtual clock
//   engine.dispose();
//
// Works in browsers (main thread or Worker) and Node >= 18. The engine is
// synchronous: a long-running script blocks the thread it runs on, so UIs
// should host it in a Worker (see boblox-client.mjs) — the time limit
// (setTimeLimit) turns runaway loops into a Luau error instead of a hang.
//
// Scope: scripting engine only. There is no networking and no Roblox client
// protocol in this module.

/** @typedef {'print' | 'warn' | 'error'} Level */
/** @typedef {{ level: Level, text: string }} OutputLine */

const LEVELS = ['print', 'warn', 'error'];

let sharedModule = null;

/**
 * Instantiate (or reuse) the Emscripten module. Engines created from the same
 * module share one WebAssembly instance (and one linear memory).
 *
 * @param {{ moduleUrl?: string | URL, locateFile?: (path: string, dir: string) => string }} [options]
 */
export async function loadModule(options = {}) {
  if (sharedModule && !options.moduleUrl && !options.locateFile) return sharedModule;
  const promise = (async () => {
    const url = options.moduleUrl ?? new URL('../dist/boblox_engine.mjs', import.meta.url);
    const factory = (await import(String(url))).default;
    const config = {};
    if (options.locateFile) config.locateFile = options.locateFile;
    return factory(config);
  })();
  if (!options.moduleUrl && !options.locateFile) {
    sharedModule = promise;
    promise.catch(() => { if (sharedModule === promise) sharedModule = null; });
  }
  return promise;
}

// Safety net for engines that are dropped without dispose(): free the native
// side when the JS wrapper is collected. (Explicit dispose() is still the
// right way — this is best-effort and GC timing is unspecified.)
const registry = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(({ M, handle }) => { try { M._boblox_destroy(handle); } catch { /* module gone */ } })
  : null;

export class BobloxEngine {
  #M;
  #h;
  #stride;
  #onOutput;
  #pending = [];
  #failed = null;

  /** Use createEngine() instead. */
  constructor(M, handle, onOutput) {
    this.#M = M;
    this.#h = handle;
    this.#stride = M._boblox_part_stride();
    this.#onOutput = onOutput ?? null;
    registry?.register(this, { M, handle }, this);
  }

  /** Floats per part in parts(). */
  get partStride() { return this.#stride; }

  /** Which sandbox profile this build exposes. Always "Engine". */
  get profile() { return this.#M.UTF8ToString(this.#M._boblox_profile()); }

  get disposed() { return this.#h === 0; }

  /** Virtual clock, in seconds (advanced only by step()). */
  get now() { return this.#call(() => this.#M._boblox_now(this.#h)); }

  /** Replace the output listener. `null` buffers output for drain(). */
  set onOutput(fn) { this.#onOutput = fn ?? null; }

  /**
   * Compile `source` and start it as a script thread (like task.spawn, so a
   * top-level task.wait() yields). Output — including any error — arrives via
   * onOutput / drain().
   * @param {string} source Luau source (type annotations are accepted)
   * @param {string} [chunkName] shown in error messages, e.g. "main:3: ..."
   * @returns {boolean} false if the script failed to compile or threw before its first yield
   */
  run(source, chunkName = 'main') {
    const ok = this.#call(() => this.#withUtf8(source, (sp, sl) =>
      this.#withUtf8(chunkName, (cp, cl) => this.#M._boblox_run(this.#h, sp, sl, cp, cl))));
    this.#flush();
    return ok === 1;
  }

  /**
   * Advance the virtual clock by `dt` seconds and resume everything due.
   * @returns {number} how many task resumes happened
   */
  step(dt) {
    const n = this.#call(() => this.#M._boblox_step(this.#h, dt));
    this.#flush();
    return n;
  }

  /** Per-call wall-clock budget in milliseconds (0 = unlimited). Default 10000. */
  setTimeLimit(ms) {
    this.#call(() => this.#M._boblox_set_time_limit_ms(this.#h, ms | 0));
  }

  /** Size of the Lua heap in KiB (instance objects live outside it). */
  get memoryKB() { return this.#call(() => this.#M._boblox_memory_kb(this.#h)); }

  /** Run a full Lua garbage collection. (run() also collects when the heap is large.) */
  collectGarbage() { this.#call(() => this.#M._boblox_gc(this.#h)); }

  /** Output produced since the last drain(), when no onOutput listener consumed it. */
  drain() {
    const out = this.#pending;
    this.#pending = [];
    return out;
  }

  /** The Workspace subtree as raw JSON text (see boblox.h for the shape). */
  treeJSON() {
    return this.#call(() => this.#str(this.#M._boblox_tree(this.#h)));
  }

  /**
   * The Workspace subtree: { count, truncated, root: { id, c, n, ch: [...] } }
   * where c = ClassName and n = Name. Ids are stable while an instance lives.
   */
  tree() { return JSON.parse(this.treeJSON()); }

  /** Properties of one instance as raw JSON text ("null" for an unknown id). */
  propertiesJSON(id) {
    return this.#call(() => this.#str(this.#M._boblox_props(this.#h, id >>> 0)));
  }

  /**
   * Properties of one instance from the latest tree()/parts() walk, or null
   * if the id is unknown. Entries: { n: name, t: type, v: shown value, ro }.
   */
  properties(id) { return JSON.parse(this.propertiesJSON(id)); }

  /**
   * Render data for every BasePart under Workspace as a Float64Array of
   * partStride doubles per part:
   *   [0] id  [1] shape (0 ball, 1 block, 2 cylinder, 3 wedge)  [2] transparency
   *   [3..5] color rgb (0..1)  [6..8] size  [9..20] CFrame (x y z r00..r22)
   * The array is a copy; it stays valid as long as you keep it.
   */
  parts() {
    return this.#call(() => {
      const M = this.#M;
      const ptr = M._boblox_parts(this.#h);
      const count = M._boblox_parts_count(this.#h);
      if (!ptr || !count) return new Float64Array(0);
      const start = ptr >>> 3; // doubles are 8-byte aligned
      return M.HEAPF64.slice(start, start + count * this.#stride);
    });
  }

  /** Free the native engine. Safe to call twice. */
  dispose() {
    if (this.#h === 0) return;
    const h = this.#h;
    this.#h = 0;
    registry?.unregister(this);
    try { this.#M._boblox_destroy(h); } catch { /* already broken */ }
  }

  // ---- internals ---------------------------------------------------------

  #call(fn) {
    if (this.#h === 0) throw new Error('BobloxEngine: disposed');
    if (this.#failed) {
      throw new Error('BobloxEngine: unusable after an earlier WebAssembly failure (' + this.#failed + ')');
    }
    try {
      return fn();
    } catch (e) {
      // A trap or RangeError out of wasm leaves the C++ side in an unknown
      // state (frames were skipped, not unwound). Refuse further use.
      this.#failed = e?.message ?? String(e);
      throw e;
    }
  }

  #withUtf8(text, fn) {
    const M = this.#M;
    const len = M.lengthBytesUTF8(text);
    const ptr = M._malloc(len + 1);
    if (!ptr) throw new Error('BobloxEngine: out of memory');
    try {
      M.stringToUTF8(text, ptr, len + 1);
      return fn(ptr, len);
    } finally {
      M._free(ptr);
    }
  }

  #str(ptr) {
    if (!ptr) throw new Error('BobloxEngine: native call failed');
    return this.#M.UTF8ToString(ptr);
  }

  #flush() {
    const raw = JSON.parse(this.#call(() => this.#str(this.#M._boblox_drain(this.#h))));
    if (!raw.length) return;
    const lines = raw.map((r) => ({ level: LEVELS[r.l] ?? 'print', text: r.t }));
    if (this.#onOutput) this.#onOutput(lines);
    else this.#pending.push(...lines);
  }
}

/**
 * Create an engine: an empty Workspace plus the Roblox-flavored globals
 * (Instance, task, Vector3, CFrame, Color3, Enum, ...).
 *
 * @param {{
 *   onOutput?: (lines: OutputLine[]) => void,
 *   timeLimitMs?: number,
 *   module?: object,
 *   moduleUrl?: string | URL,
 *   locateFile?: (path: string, dir: string) => string,
 * }} [options]
 */
export async function createEngine(options = {}) {
  const M = options.module ?? await loadModule(options);
  const handle = M._boblox_create();
  if (!handle) throw new Error('createEngine: native engine creation failed');
  const engine = new BobloxEngine(M, handle, options.onOutput);
  if (options.timeLimitMs !== undefined) engine.setTimeLimit(options.timeLimitMs);
  return engine;
}
