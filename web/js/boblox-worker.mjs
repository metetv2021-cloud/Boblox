// boblox-worker.mjs — hosts one BobloxEngine inside a (module) Web Worker.
// Use it through boblox-client.mjs; the wire protocol is private to the pair.
//
// Request : { id, method, args }
// Reply   : { id, ok: true,  result, lines }   or   { id, ok: false, error, lines }
// `lines` is every output line the engine produced since the previous reply,
// so output stays ordered with respect to results.

import { createEngine } from './boblox.mjs';

let engine = null;

const methods = {
  async init({ timeLimitMs, moduleUrl }) {
    engine?.dispose();
    engine = await createEngine({ timeLimitMs, moduleUrl });
    return { profile: engine.profile, partStride: engine.partStride };
  },
  run: ({ source, chunk }) => engine.run(source, chunk),
  step: ({ dt }) => ({ resumes: engine.step(dt), now: engine.now }),
  // One round trip per animation frame: advance the clock, optionally hand
  // back the render buffer (transferred, not copied).
  frame: ({ dt, parts }) => {
    const resumes = dt > 0 ? engine.step(dt) : 0;
    const out = { resumes, now: engine.now, memoryKB: engine.memoryKB };
    if (parts) out.parts = engine.parts();
    return out;
  },
  tree: () => engine.treeJSON(),
  properties: ({ id }) => engine.propertiesJSON(id),
  parts: () => engine.parts(),
  setTimeLimit: ({ ms }) => engine.setTimeLimit(ms),
  collectGarbage: () => engine.collectGarbage(),
  status: () => ({ now: engine.now, memoryKB: engine.memoryKB }),
};

self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  let reply;
  try {
    if (!(method in methods)) throw new Error(`unknown method: ${method}`);
    if (method !== 'init' && !engine) throw new Error('engine not initialised');
    const result = await methods[method](args ?? {});
    reply = { id, ok: true, result };
  } catch (e) {
    reply = { id, ok: false, error: { name: e?.name ?? 'Error', message: e?.message ?? String(e) } };
  }
  reply.lines = engine && !engine.disposed ? safeDrain() : [];
  const transfer = reply.result?.parts?.buffer ? [reply.result.parts.buffer]
    : reply.result?.buffer instanceof ArrayBuffer ? [reply.result.buffer] : [];
  self.postMessage(reply, transfer);
};

function safeDrain() {
  try { return engine.drain(); } catch { return []; }
}
