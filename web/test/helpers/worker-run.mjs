// Runs one script in a throwaway engine inside a worker thread and reports
// back. Used by tests that might never return (runaway loops): the parent can
// terminate() a worker, but it cannot interrupt its own synchronous WASM call.
import { parentPort, workerData } from 'node:worker_threads';

import { createEngine } from '../../js/boblox.mjs';

const { source, limitMs, stepDt } = workerData;
const engine = await createEngine();
engine.setTimeLimit(limitMs);

const t0 = performance.now();
const ok = engine.run(source);
if (stepDt) engine.step(stepDt);
const ms = performance.now() - t0;

// prove the engine is still usable afterwards
engine.setTimeLimit(5000);
const usable = engine.run('print("still usable")');
parentPort.postMessage({ ok, ms, usable, lines: engine.drain() });
engine.dispose();
