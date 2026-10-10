// transcript.mjs — runs a script through the WebAssembly engine and renders the
// result in the exact text format of web/src/boblox_cli.cpp, so a WASM run and
// a native run can be compared byte for byte (see parity.test.mjs).
//
// Format (one record per line; text escaped so a record never spans lines):
//   == run <ok|fail>            P/W/E <text>           (print/warn/error)
//   == step <i> t=<now>         == tree  <json>        == props <id>  <json>

import { createEngine } from '../js/boblox.mjs';

const TAG = { print: 'P', warn: 'W', error: 'E' };

const escape = (s) => s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r');

/**
 * @param {string} source
 * @param {{ steps?: number, dt?: number, limitMs?: number, tree?: boolean, props?: boolean }} [opts]
 * @param {object} [engineOptions] forwarded to createEngine (e.g. moduleUrl)
 * @returns {Promise<string>} transcript text, newline-terminated
 */
export async function runTranscript(source, opts = {}, engineOptions = {}) {
  const out = [];
  const engine = await createEngine(engineOptions);
  try {
    engine.setTimeLimit(opts.limitMs ?? 10000);
    const dump = () => {
      for (const l of engine.drain()) out.push(`${TAG[l.level]} ${escape(l.text)}`);
    };

    const ok = engine.run(source, 'main');
    out.push(`== run ${ok ? 'ok' : 'fail'}`);
    dump();

    for (let i = 1; i <= (opts.steps ?? 0); i++) {
      engine.step(opts.dt ?? 0.1);
      out.push(`== step ${i} t=${engine.now.toFixed(6)}`);
      dump();
    }

    if (opts.tree || opts.props) {
      const tree = engine.treeJSON();
      if (opts.tree) out.push('== tree', tree);
      if (opts.props) {
        for (const m of tree.matchAll(/"id":(\d+)/g)) {
          out.push(`== props ${m[1]}`, engine.propertiesJSON(Number(m[1])));
        }
      }
    }
  } finally {
    engine.dispose();
  }
  return out.join('\n') + '\n';
}
