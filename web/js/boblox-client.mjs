// boblox-client.mjs — promise API over an engine running in a Web Worker.
//
//   const engine = await BobloxWorker.create({
//     onOutput: (lines) => ...,           // [{ level: 'print'|'warn'|'error', text }]
//     onCrash: (error) => ...,            // worker died (e.g. WebAssembly stack overflow)
//   });
//   await engine.run('print("hi")');
//   const { now, parts } = await engine.frame(1 / 60, { parts: true });
//   engine.terminate();
//
// Why a Worker: the engine is synchronous. In a worker, a long-running script
// never freezes the page, and a hung or crashed engine is simply terminated
// and replaced — the UI thread stays alive either way.

export class BobloxWorker {
  #worker;
  #pending = new Map();
  #nextId = 1;
  #onOutput;
  #onCrash;
  #dead = null;

  /** Use BobloxWorker.create(). */
  constructor(worker, { onOutput, onCrash }) {
    this.#worker = worker;
    this.#onOutput = onOutput ?? (() => {});
    this.#onCrash = onCrash ?? (() => {});
    worker.onmessage = ({ data }) => this.#onReply(data);
    worker.onerror = (ev) => this.#die(new Error('engine worker crashed: ' + (ev.message || 'unknown error')));
    worker.onmessageerror = () => this.#die(new Error('engine worker sent an unreadable message'));
  }

  /**
   * @param {{
   *   onOutput?: (lines: {level: string, text: string}[]) => void,
   *   onCrash?: (error: Error) => void,
   *   timeLimitMs?: number,
   *   workerUrl?: string | URL,
   *   moduleUrl?: string,
   * }} [options]
   */
  static async create(options = {}) {
    const url = options.workerUrl ?? new URL('./boblox-worker.mjs', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    const client = new BobloxWorker(worker, options);
    const info = await client.#call('init', {
      timeLimitMs: options.timeLimitMs,
      moduleUrl: options.moduleUrl,
    });
    client.profile = info.profile;
    client.partStride = info.partStride;
    return client;
  }

  /** Compile and start a script. @returns {Promise<boolean>} false on compile/early runtime error. */
  run(source, chunk = 'main') { return this.#call('run', { source, chunk }); }

  /** Advance the virtual clock. @returns {Promise<{resumes: number, now: number}>} */
  step(dt) { return this.#call('step', { dt }); }

  /**
   * One round trip per animation frame: step the clock by `dt` (0 = don't) and
   * optionally return the render buffer as a Float64Array (transferred).
   * @returns {Promise<{resumes: number, now: number, memoryKB: number, parts?: Float64Array}>}
   */
  frame(dt, { parts = false } = {}) { return this.#call('frame', { dt, parts }); }

  /** Discard the world and start a fresh engine in the same worker. */
  async reset({ timeLimitMs } = {}) {
    const info = await this.#call('init', { timeLimitMs });
    this.profile = info.profile;
    this.partStride = info.partStride;
  }

  /** The Workspace tree as raw JSON text (cheap to compare before parsing). */
  treeJSON() { return this.#call('tree'); }

  /** The Workspace tree: { count, truncated, root }. */
  async tree() { return JSON.parse(await this.treeJSON()); }

  /** Properties of an instance id from the latest tree/parts walk (or null). */
  async properties(id) { return JSON.parse(await this.#call('properties', { id })); }

  /** Render buffer for all BaseParts (see BobloxEngine.parts). */
  parts() { return this.#call('parts'); }

  setTimeLimit(ms) { return this.#call('setTimeLimit', { ms }); }
  collectGarbage() { return this.#call('collectGarbage'); }
  status() { return this.#call('status'); }

  /** Kill the worker; pending calls reject. The engine and its state are gone. */
  terminate() {
    this.#die(new Error('engine terminated'), { notify: false });
  }

  get alive() { return this.#dead === null; }

  // ---- internals ------------------------------------------------------------

  #call(method, args) {
    if (this.#dead) return Promise.reject(this.#dead);
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, method, args });
    });
  }

  #onReply({ id, ok, result, error, lines }) {
    if (lines?.length) this.#onOutput(lines);
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (ok) {
      p.resolve(result);
    } else {
      const e = new Error(error.message);
      e.name = error.name;
      p.reject(e);
    }
  }

  #die(error, { notify = true } = {}) {
    if (this.#dead) return;
    this.#dead = error;
    try { this.#worker.terminate(); } catch { /* already gone */ }
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
    if (notify) this.#onCrash(error);
  }
}

/**
 * The same promise API, but the engine runs on the calling thread. Used when
 * module Workers are unavailable (Firefox < 114, Safari < 15). A runaway
 * script then blocks the page until the time limit trips — which is why the
 * Worker is preferred.
 */
export class BobloxLocal {
  #engine = null;
  #options;

  constructor(options) { this.#options = options; this.alive = true; }

  static async create(options = {}) {
    const local = new BobloxLocal(options);
    await local.reset({ timeLimitMs: options.timeLimitMs });
    return local;
  }

  async reset({ timeLimitMs } = {}) {
    const { createEngine } = await import('./boblox.mjs');
    this.#engine?.dispose();
    this.#engine = await createEngine({
      onOutput: this.#options.onOutput,
      timeLimitMs: timeLimitMs ?? this.#options.timeLimitMs,
      moduleUrl: this.#options.moduleUrl,
    });
    this.profile = this.#engine.profile;
    this.partStride = this.#engine.partStride;
  }

  async run(source, chunk = 'main') { return this.#guard(() => this.#engine.run(source, chunk)); }
  async step(dt) { return this.#guard(() => ({ resumes: this.#engine.step(dt), now: this.#engine.now })); }
  async frame(dt, { parts = false } = {}) {
    return this.#guard(() => {
      const resumes = dt > 0 ? this.#engine.step(dt) : 0;
      const out = { resumes, now: this.#engine.now, memoryKB: this.#engine.memoryKB };
      if (parts) out.parts = this.#engine.parts();
      return out;
    });
  }
  async treeJSON() { return this.#guard(() => this.#engine.treeJSON()); }
  async tree() { return JSON.parse(await this.treeJSON()); }
  async properties(id) { return this.#guard(() => this.#engine.properties(id)); }
  async parts() { return this.#guard(() => this.#engine.parts()); }
  async setTimeLimit(ms) { return this.#guard(() => this.#engine.setTimeLimit(ms)); }
  async collectGarbage() { return this.#guard(() => this.#engine.collectGarbage()); }
  async status() { return this.#guard(() => ({ now: this.#engine.now, memoryKB: this.#engine.memoryKB })); }

  terminate() {
    this.alive = false;
    this.#engine?.dispose();
    this.#engine = null;
  }

  // A WebAssembly failure leaves the engine unusable: report it like a worker crash.
  async #guard(fn) {
    if (!this.alive || !this.#engine) throw new Error('engine terminated');
    try {
      return fn();
    } catch (e) {
      this.alive = false;
      this.#options.onCrash?.(e);
      throw e;
    }
  }
}
