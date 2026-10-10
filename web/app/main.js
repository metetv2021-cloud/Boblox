// main.js — the playground controller. The engine lives in a Web Worker
// (or, where module workers are unavailable, in-thread); this file owns the
// UI state and the animation loop:
//
//   rAF tick -> client.frame(dt * speed, { parts: true }) -> viewport.setParts(...)
//
// The simulation clock is the engine's virtual clock, so Pause, Step and the
// speed selector are exact — nothing depends on wall-clock timing.

import { BobloxLocal, BobloxWorker } from '../js/boblox-client.mjs';
import { ConsoleView } from './console.js';
import { Editor } from './editor.js';
import { DEFAULT_EXAMPLE, EXAMPLES } from './examples.js';
import { Explorer, PropertiesPanel } from './explorer.js';
import { Viewport } from './viewport.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { return localStorage.getItem('boblox.' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('boblox.' + key, value); } catch { /* storage unavailable: that is fine */ }
  },
};

const state = {
  client: null,
  playing: true,
  speed: 1,
  now: 0,
  memoryKB: 0,
  frameInFlight: false,
  generation: 0,      // bumped on every (re)start so late replies can be dropped
  lastTs: 0,
  treeRaw: '',
  selected: null,
  selectedNode: null,
  timeLimitMs: Number(store.get('limit', '3000')),
  inWorker: true,
};

// ---------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------

const consoleView = new ConsoleView($('console'), {
  onLocation: (chunk, line) => { if (chunk === 'main') editor.goToLine(line); },
});

const editor = new Editor({
  textarea: $('code'),
  pre: $('hl'),
  gutter: $('gutter'),
  onRun: () => run(),
  onChange: (value) => {
    store.set('code', value);
    $('examples').value = EXAMPLES.find((e) => e.code === value)?.id ?? '';
  },
});

const explorer = new Explorer($('explorer'), {
  onSelect: (id, node) => {
    state.selected = id;
    state.selectedNode = node;
    viewport.setSelected(id);
    if (id === null) propsPanel.clear();
    else refreshProperties().catch(engineFailed);
  },
});
const propsPanel = new PropertiesPanel($('props'), $('prop-filter'));

const viewport = new Viewport($('gl'), {
  onPick: (id) => {
    if (id === null) explorer.select(null);
    else explorer.select(id, { reveal: true });
  },
  onUnsupported: (why) => {
    const msg = $('vp-msg');
    msg.hidden = false;
    msg.textContent = why;
    $('vp-hint').hidden = true;
    $('frame').disabled = true;
  },
});

function setPill(kind, text) {
  const pill = $('st-engine');
  pill.className = 'pill ' + kind;
  pill.textContent = text;
}

function updateStatus() {
  $('st-time').textContent = `t = ${state.now.toFixed(3)} s`;
  const n = viewport.partCount;
  $('st-parts').textContent = `${n} part${n === 1 ? '' : 's'}`;
  $('st-mem').textContent = `Lua heap ${state.memoryKB.toLocaleString()} KiB`;
}

function setPlaying(on) {
  state.playing = on;
  const b = $('play');
  b.textContent = on ? '⏸' : '▶';
  b.setAttribute('aria-pressed', String(!on));
  b.title = (on ? 'Pause' : 'Play') + ' the virtual clock (Space)';
}

// ---------------------------------------------------------------------------
// engine lifecycle
// ---------------------------------------------------------------------------

function onOutput(lines) {
  consoleView.append(lines, state.now);
  const err = lines.find((l) => l.level === 'error');
  if (err) {
    const m = /^main:(\d+):/.exec(err.text);
    if (m) editor.markError(Number(m[1]));
    if (/Script timeout/.test(err.text) && state.playing) {
      setPlaying(false);
      consoleView.append([{ level: 'info', text: 'Paused: a script ran past the time limit. Press ▶ to continue, or Run to start over.' }], state.now);
    }
  }
}

// Errors out of an engine that is still "alive" (e.g. a WebAssembly stack
// overflow poisoned it) used to vanish into .catch(() => {}) and leave a frozen
// scene. Say so once and stop the clock; Run starts a fresh engine.
let engineErrorShown = false;
function engineFailed(error) {
  if (engineErrorShown || !state.client?.alive) return; // a dead worker is reported by onCrash
  engineErrorShown = true;
  setPlaying(false);
  setPill('error', 'engine error');
  consoleView.append([{
    level: 'error',
    text: `The engine stopped working: ${error?.message ?? error}. Press Run to start a fresh one.`,
  }], state.now);
}

function onCrash(error) {
  state.client = null;
  setPill('error', 'engine crashed');
  consoleView.append([{
    level: 'error',
    text: `The engine stopped: ${error?.message ?? error}. Press Run to start a fresh one.`,
  }], state.now);
}

function startupFailed(error) {
  setPill('error', 'failed to start');
  consoleView.append([{
    level: 'error',
    text: `The engine could not start: ${error?.message ?? error}\n` +
      'Is the WebAssembly module built? Run ./web/build.sh (it creates web/dist/boblox_engine.wasm), ' +
      'and serve this folder over http(s) — file:// cannot load modules.',
  }], 0);
}

// Returns true when a brand-new engine had to be created.
async function ensureEngine() {
  if (state.client?.alive) return false;
  setPill('busy', 'starting…');
  const options = { onOutput, onCrash, timeLimitMs: state.timeLimitMs };
  try {
    state.client = await BobloxWorker.create(options);
    state.inWorker = true;
  } catch (e) {
    // module workers unavailable (or the worker failed to start): run in-thread
    console.warn('worker unavailable, falling back to the main thread:', e);
    try {
      state.client = await BobloxLocal.create(options);
    } catch (e2) {
      startupFailed(e2);
      throw e2;
    }
    state.inWorker = false;
    consoleView.append([{ level: 'info', text: 'Running on the main thread (this browser has no module workers).' }], 0);
  }
  setPill('ready', state.inWorker ? 'engine ready · worker' : 'engine ready');
  return true;
}

async function run() {
  const gen = ++state.generation;
  engineErrorShown = false;
  try {
    const fresh = await ensureEngine();
    if (gen !== state.generation) return;
    if (!fresh) await state.client.reset({ timeLimitMs: state.timeLimitMs }); // a new world every Run
    if (gen !== state.generation) return;
    state.now = 0;
    state.treeRaw = '';
    state.memoryKB = 0;
    editor.markError(null);
    consoleView.clear();
    viewport.setParts(new Float64Array(0));
    viewport.userMovedCamera = false;
    explorer.setTree(null, '');
    explorer.select(null, { notify: true });
    setPlaying(true);
    setPill('busy', 'running…');
    await state.client.run(editor.value, 'main');
    if (gen !== state.generation) return;
    await refreshFrame(0);
    await refreshPanels();
    viewport.autoFrameOnce();
    setPill('ready', state.inWorker ? 'engine ready · worker' : 'engine ready');
  } catch (e) {
    engineFailed(e);
    if (state.client?.alive && !engineErrorShown) {
      consoleView.append([{ level: 'error', text: String(e?.message ?? e) }], state.now);
      setPill('error', 'error');
    }
  }
}

async function resetWorld() {
  state.generation++;
  engineErrorShown = false;
  setPlaying(false);
  if (state.client?.alive) {
    try { await state.client.reset({ timeLimitMs: state.timeLimitMs }); } catch { /* handled by onCrash */ }
  }
  state.now = 0;
  state.treeRaw = '';
  viewport.setParts(new Float64Array(0));
  explorer.setTree(null, '');
  explorer.select(null);
  consoleView.clear();
  editor.markError(null);
  updateStatus();
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

// Advance the virtual clock by dt (0 = just refresh) and draw.
async function refreshFrame(dt) {
  const client = state.client;
  if (!client?.alive) return;
  const gen = state.generation;
  const res = await client.frame(dt, { parts: true });
  if (gen !== state.generation) return;
  state.now = res.now;
  state.memoryKB = res.memoryKB;
  viewport.setParts(res.parts);
  updateStatus();
}

async function refreshPanels() {
  const client = state.client;
  if (!client?.alive) return;
  const gen = state.generation;
  const raw = await client.treeJSON();
  if (gen !== state.generation) return;
  if (raw !== state.treeRaw) {
    state.treeRaw = raw;
    const tree = JSON.parse(raw);
    explorer.setTree(tree.root ? tree : null, raw);
    $('tree-count').textContent = tree.truncated ? `${tree.count}+ instances` : `${tree.count} instance${tree.count === 1 ? '' : 's'}`;
  }
  await refreshProperties();
}

async function refreshProperties() {
  const client = state.client;
  if (!client?.alive || state.selected === null) return;
  const gen = state.generation;
  const id = state.selected;
  const props = await client.properties(id);
  if (gen !== state.generation || id !== state.selected) return;
  propsPanel.show(state.selectedNode, props);
}

function tick(ts) {
  requestAnimationFrame(tick);
  const real = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
  state.lastTs = ts;
  if (!state.playing || state.frameInFlight || !state.client?.alive) return;
  state.frameInFlight = true;
  refreshFrame(real * state.speed)
    .catch(engineFailed)
    .finally(() => { state.frameInFlight = false; });
}

async function stepBy(dt) {
  if (!state.client?.alive || state.frameInFlight) return;
  state.frameInFlight = true;
  try {
    await refreshFrame(dt);
    await refreshPanels();
  } catch (e) {
    engineFailed(e);
  } finally {
    state.frameInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function loadExample(id, { runIt }) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  editor.value = ex.code;
  $('examples').value = ex.id;
  store.set('code', ex.code);
  store.set('example', ex.id);
  if (runIt) run();
}

function init() {
  const select = $('examples');
  const custom = new Option('Custom script', '');
  custom.disabled = true;
  select.add(custom);
  for (const ex of EXAMPLES) select.add(new Option(ex.title, ex.id));
  select.addEventListener('change', () => loadExample(select.value, { runIt: true }));

  $('run').addEventListener('click', () => run());
  $('reset').addEventListener('click', () => resetWorld());
  $('play').addEventListener('click', () => setPlaying(!state.playing));
  $('step1').addEventListener('click', () => stepBy(1 / 60));
  $('step2').addEventListener('click', () => stepBy(0.5));
  $('frame').addEventListener('click', () => viewport.frameAll());
  $('clear').addEventListener('click', () => consoleView.clear());
  $('timestamps').addEventListener('change', (e) => { consoleView.showTime = e.target.checked; });
  $('speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });

  const limit = $('limit');
  limit.value = String(state.timeLimitMs);
  if (limit.value !== String(state.timeLimitMs)) limit.value = '3000';
  limit.addEventListener('change', async () => {
    state.timeLimitMs = Number(limit.value);
    store.set('limit', limit.value);
    if (state.client?.alive) await state.client.setTimeLimit(state.timeLimitMs);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName));
    if (e.code === 'Space' && !typing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setPlaying(!state.playing);
    }
  });

  // panels refresh at ~4 Hz while the clock runs (cheap: unchanged trees are skipped)
  setInterval(() => {
    if (state.playing && state.client?.alive && !document.hidden) refreshPanels().catch(engineFailed);
  }, 250);

  // Initial content: the saved script if there is one, else the default example.
  const params = new URLSearchParams(location.search);
  const wanted = params.get('example');
  const saved = store.get('code', null);
  if (wanted && EXAMPLES.some((e) => e.id === wanted)) {
    loadExample(wanted, { runIt: false });
  } else if (saved) {
    editor.value = saved;
    select.value = EXAMPLES.find((e) => e.code === saved)?.id ?? '';
  } else {
    loadExample(DEFAULT_EXAMPLE, { runIt: false });
  }

  setPlaying(true);
  requestAnimationFrame(tick);
  updateStatus();
  if (params.get('run') !== '0') run();
  else ensureEngine().catch(() => { /* startupFailed already told the user */ });

  // handy for debugging and for the browser tests
  window.boblox = {
    run,
    get client() { return state.client; },
    get state() { return { ...state, client: undefined }; },
    editor,
    viewport,
    explorer,
  };
}

init();
