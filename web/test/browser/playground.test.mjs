// End-to-end tests of the playground in a real browser (headless Chromium via
// Playwright). Not part of `npm test` (which needs only Node):
//
//   npm i -D playwright && npx playwright install chromium     # once
//   npm run test:browser
//
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs  use a Playwright install that
//                                                  is not resolvable as "playwright"
// SCREENSHOT_DIR=dir                                also write screenshots there
// Under CI (CI=1) a missing Playwright is a failure, otherwise the suite skips.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EXAMPLES } from '../../app/examples.js';
import { createStaticServer } from '../../tools/server.mjs';

const webDir = fileURLToPath(new URL('../..', import.meta.url));
const shotDir = process.env.SCREENSHOT_DIR;
if (shotDir) mkdirSync(shotDir, { recursive: true });

async function loadPlaywright() {
  for (const id of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return await import(id); } catch { /* try the next candidate */ }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  const why = 'Playwright is not installed (npm i -D playwright && npx playwright install chromium, or set PLAYWRIGHT_MODULE)';
  if (process.env.CI) throw new Error(why);
  describe('playground (browser)', { skip: why }, () => it('skipped', () => {}));
} else {
  defineTests(pw);
}

function defineTests({ chromium }) {
  let server, base, browser;

  before(async () => {
    assert.ok(existsSync(path.join(webDir, 'dist', 'boblox_engine.wasm')), 'build the wasm first: ./web/build.sh');
    server = createStaticServer(webDir);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    // SwiftShader gives headless Chromium a software WebGL 2
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
  });

  after(async () => {
    await browser?.close();
    server?.closeAllConnections?.();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  });

  // A page that records console errors, and fails the test if there were any.
  async function session({ colorScheme = 'dark', viewport = { width: 1360, height: 860 }, mobile = false, init } = {}) {
    const context = await browser.newContext({
      viewport, colorScheme,
      ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return {
      page,
      errors,
      async open(query = '') {
        await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('st-engine').textContent.startsWith('engine ready'), null, { timeout: 30_000 });
      },
      async close() {
        await context.close();
      },
      async finish() {
        assert.deepEqual(errors, [], 'no console errors or uncaught exceptions');
        await context.close();
      },
    };
  }

  const text = (page, sel) => page.locator(sel).innerText();
  const virtualTime = (page) => page.evaluate(() => window.boblox.state.now);
  const consoleHas = (page, re) => page.waitForFunction(
    ([src, flags]) => new RegExp(src, flags).test(document.getElementById('console').innerText),
    [re.source, re.flags],
    { timeout: 20_000 },
  );
  const partsAre = (page, n) => page.waitForFunction((k) => document.getElementById('st-parts').textContent.startsWith(k + ' part'), n, { timeout: 30_000 });
  const shot = async (page, name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name + '.png') }); };

  describe('playground (browser)', () => {
    it('boots, runs the default example in a worker, and renders it', async () => {
      const s = await session();
      await s.open();
      await partsAre(s.page, 5);
      await s.page.waitForFunction(() => window.boblox.state.now > 0.4);
      assert.match(await text(s.page, '#console'), /4 planets orbiting/);
      assert.equal(await text(s.page, '#st-engine'), 'engine ready · worker');
      assert.equal(await s.page.locator('#explorer .row').count(), 6, 'Workspace + 5 parts');
      const gl = await s.page.evaluate(() => ({ ok: window.boblox.viewport.supported, frames: window.boblox.viewport.frames }));
      assert.equal(gl.ok, true, 'WebGL 2 viewport started');
      assert.ok(gl.frames > 2, `rendered ${gl.frames} frames`);
      await shot(s.page, 'playground-dark');
      await s.finish();
    });

    it('renders in the light theme too', async () => {
      const s = await session({ colorScheme: 'light' });
      await s.open('example=explorer');
      await partsAre(s.page, 6);
      await s.page.waitForTimeout(500);
      await shot(s.page, 'playground-light');
      await s.finish();
    });

    const expectations = {
      planets: { parts: 5 },
      tower: { parts: 13, console: /built 12 blocks/ },
      bounce: { parts: 10 },
      explorer: { parts: 6, console: /10 instances under Workspace\.Scene/ },
      events: { parts: 1, console: /worker finished/ },
      datatypes: { parts: 0, console: /Random\(42\): 56 23 5/ },
      spiral: { parts: 1500, console: /1500 parts created/ },
      hello: { parts: 0, console: /one virtual second later/ },
    };
    for (const ex of EXAMPLES) {
      it(`example "${ex.id}" runs without console errors`, async () => {
        const want = expectations[ex.id];
        assert.ok(want, `an expectation exists for ${ex.id}`);
        const s = await session();
        await s.open(`example=${ex.id}`);
        await s.page.selectOption('#speed', '4'); // reach the virtual time-dependent output sooner
        await partsAre(s.page, want.parts);
        if (want.console) await consoleHas(s.page, want.console);
        await s.page.waitForTimeout(300);
        if (ex.id === 'hello') {
          // hello ends with an intentional script error, reported in the console (not the browser console)
          assert.match(await text(s.page, '#console'), /an uncaught error ends the script/);
        }
        await s.finish();
      });
    }

    it('Explorer selection fills the Properties panel and the filter narrows it', async () => {
      const s = await session();
      await s.open('example=explorer');
      await partsAre(s.page, 6);
      await s.page.locator('#explorer .row', { hasText: 'Scene' }).locator('.caret').first().click();
      await s.page.locator('#explorer .row', { hasText: 'Ball' }).first().click();
      await s.page.waitForSelector('#props .title');
      const props = async () => Object.fromEntries(await s.page.$$eval('#props .row', (rows) =>
        rows.map((r) => [r.querySelector('.n').firstChild.textContent, r.querySelector('.v').textContent])));
      assert.match(await text(s.page, '#props .title'), /^Ball\s*Part$/);
      const p = await props();
      assert.equal(p.Name, 'Ball');
      assert.equal(p.Shape, 'Enum.PartType.Ball');
      assert.equal(p.Material, 'Enum.Material.Neon');
      assert.equal(p.Transparency, '0.25');
      assert.equal(p.Size, '3, 3, 3');
      assert.equal(p.Anchored, 'true');
      assert.ok(await s.page.locator('#explorer .row.selected', { hasText: 'Ball' }).count(), 'row is highlighted');
      assert.equal(await s.page.evaluate(() => window.boblox.viewport.selected === window.boblox.state.selected), true);
      await shot(s.page, 'explorer-properties');

      await s.page.fill('#prop-filter', 'shape');
      const filtered = Object.keys(await props());
      assert.ok(filtered.includes('Shape'));
      assert.ok(filtered.every((n) => /shape/i.test(n)), `only matching rows remain: ${filtered}`);
      await s.finish();
    });

    it('clicking a part in the viewport selects it (ray picking)', async () => {
      const s = await session();
      await s.open('example=explorer');
      await partsAre(s.page, 6);
      const target = await s.page.evaluate(() => {
        const vp = window.boblox.viewport;
        const p = vp.parts, S = 21;
        let at = -1;
        for (let i = 0; i < p.length; i += S) if (p[i + 7] === 10) at = i; // the 10-stud tower
        const { viewProj } = vp._matrices();
        const x = p[at + 9], y = p[at + 10], z = p[at + 11];
        const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
        const nx = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / w;
        const ny = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / w;
        const r = vp.canvas.getBoundingClientRect();
        return { id: p[at], x: r.left + (nx * 0.5 + 0.5) * r.width, y: r.top + (0.5 - ny * 0.5) * r.height };
      });
      await s.page.mouse.click(target.x, target.y);
      await s.page.waitForFunction((id) => window.boblox.state.selected === id, target.id);
      assert.match(await text(s.page, '#props .title'), /^Tower/);
      assert.ok(await s.page.locator('#explorer .row.selected', { hasText: 'Tower' }).count(), 'Explorer follows the pick');

      // a click on empty sky clears the selection
      await s.page.locator('#gl').click({ position: { x: 12, y: 12 } });
      await s.page.waitForFunction(() => window.boblox.state.selected === null);
      assert.match(await text(s.page, '#props'), /Select an instance/);
      await s.finish();
    });

    it('Pause freezes the clock, Step advances it exactly, Space toggles', async () => {
      const s = await session();
      await s.open('example=bounce');
      await s.page.waitForFunction(() => window.boblox.state.now > 0.3);
      await s.page.click('#play'); // pause
      assert.equal(await s.page.getAttribute('#play', 'aria-pressed'), 'true');
      await s.page.waitForTimeout(150);
      const t0 = await virtualTime(s.page);
      await s.page.waitForTimeout(500);
      assert.equal(await virtualTime(s.page), t0, 'the clock does not move while paused');

      await s.page.click('#step1');
      await s.page.waitForFunction((t) => window.boblox.state.now > t, t0);
      const t1 = await virtualTime(s.page);
      assert.ok(Math.abs(t1 - t0 - 1 / 60) < 1e-6, `one frame = 1/60 s (got ${t1 - t0})`);
      await s.page.click('#step2');
      await s.page.waitForFunction((t) => window.boblox.state.now > t + 0.4, t1);
      assert.ok(Math.abs((await virtualTime(s.page)) - t1 - 0.5) < 1e-6, 'half a second');
      assert.match(await text(s.page, '#st-time'), /^t = \d+\.\d{3} s$/);

      await s.page.locator('#viewport').click({ position: { x: 5, y: 5 } }); // focus outside the editor
      await s.page.keyboard.press('Space');
      await s.page.waitForFunction((t) => window.boblox.state.now > t + 0.2, await virtualTime(s.page));
      await s.finish();
    });

    it('Ctrl+Enter runs; a runaway loop hits the time limit; the engine recovers', async () => {
      const s = await session();
      await s.open('example=hello');
      await s.page.selectOption('#limit', '1000');
      await s.page.fill('#code', 'print("spinning")\nwhile true do end');
      await s.page.press('#code', 'Control+Enter');
      await consoleHas(s.page, /Script timeout: exhausted allowed execution time/);
      await consoleHas(s.page, /Paused: a script ran past the time limit/);
      assert.equal(await text(s.page, '#play'), '▶', 'the clock was paused');
      assert.equal(await text(s.page, '#st-engine'), 'engine ready · worker', 'the engine itself is fine');

      await s.page.fill('#code', 'print("recovered")');
      await s.page.press('#code', 'Control+Enter');
      await consoleHas(s.page, /^recovered$/m);
      assert.equal(await text(s.page, '#play'), '⏸', 'Run resumes the clock');
      await s.finish();
    });

    it('script errors link back to the editor line', async () => {
      const s = await session();
      await s.open('example=hello');
      await s.page.selectOption('#speed', '4');
      await s.page.waitForSelector('#console .line.error a[data-line]', { timeout: 20_000 });
      const line = Number(await s.page.getAttribute('#console .line.error a[data-line]', 'data-line'));
      assert.ok(line > 1);
      assert.equal(await s.page.locator('#gutter .err').innerText(), String(line), 'gutter marks the failing line');
      await s.page.click('#console .line.error a[data-line]');
      const caretLine = await s.page.evaluate(() => {
        const ta = document.getElementById('code');
        return ta.value.slice(0, ta.selectionStart).split('\n').length;
      });
      assert.equal(caretLine, line, 'the caret jumped to the line');
      await shot(s.page, 'error-link');
      await s.finish();
    });

    it('an engine failure is reported once and stops the clock; Run recovers', async () => {
      const s = await session();
      await s.open('example=bounce');
      await s.page.waitForFunction(() => window.boblox.state.now > 0.2);
      // simulate a poisoned engine: every frame call fails like a wasm stack overflow would
      await s.page.evaluate(() => {
        window.boblox.client.frame = async () => { throw new Error('unusable after an earlier WebAssembly failure (injected)'); };
      });
      await consoleHas(s.page, /The engine stopped working: unusable after an earlier WebAssembly failure/);
      await s.page.waitForTimeout(700);
      const reports = (await text(s.page, '#console')).split('The engine stopped working').length - 1;
      assert.equal(reports, 1, 'reported exactly once');
      assert.equal(await text(s.page, '#st-engine'), 'engine error');
      assert.equal(await text(s.page, '#play'), '▶');

      await s.page.evaluate(() => { delete window.boblox.client.frame; }); // un-break
      await s.page.click('#run');
      await partsAre(s.page, 10);
      await s.page.waitForFunction(() => window.boblox.state.now > 0.2);
      assert.equal(await text(s.page, '#st-engine'), 'engine ready · worker');
      await s.finish();
    });

    it('explains itself when the WebAssembly module cannot be loaded', async () => {
      const s = await session();
      await s.page.route('**/*.wasm', (route) => route.abort());
      await s.page.goto(`${base}/?example=tower`, { waitUntil: 'load' });
      await s.page.waitForFunction(() => document.getElementById('st-engine').textContent === 'failed to start', null, { timeout: 30_000 });
      const out = await text(s.page, '#console');
      assert.match(out, /The engine could not start/);
      assert.match(out, /\.\/web\/build\.sh/, 'tells the developer how to build it');
      await s.close(); // (the aborted request is logged as a console error by the browser itself)
    });

    it('works without module Workers (main-thread fallback)', async () => {
      const s = await session({ init: () => { delete window.Worker; } });
      await s.open('example=tower');
      await partsAre(s.page, 13);
      assert.equal(await text(s.page, '#st-engine'), 'engine ready');
      assert.match(await text(s.page, '#console'), /built 12 blocks/);
      await s.finish();
    });

    it('degrades gracefully without WebGL 2: message shown, everything else works', async () => {
      const s = await session({
        init: () => {
          const real = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            return type === 'webgl2' ? null : real.call(this, type, ...rest);
          };
        },
      });
      await s.open('example=tower');
      await s.page.waitForFunction(() => !document.getElementById('vp-msg').hidden);
      assert.match(await text(s.page, '#vp-msg'), /WebGL 2 is not available/);
      assert.equal(await s.page.locator('#frame').isDisabled(), true);
      await partsAre(s.page, 13);
      assert.match(await text(s.page, '#console'), /built 12 blocks/);
      assert.equal(await s.page.locator('#explorer .row').count() > 1, true, 'the Explorer still works');
      await s.finish();
    });

    it('editor: Tab, auto-indent, Ctrl+/, highlighting, and persistence across reloads', async () => {
      const s = await session();
      await s.open('example=hello&run=0');
      await s.page.fill('#code', 'if true then');
      await s.page.press('#code', 'Enter');
      await s.page.keyboard.type('print(1)');
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)', 'auto-indent after "then"');
      await s.page.press('#code', 'Enter');
      await s.page.keyboard.type('end');
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)\n    end', 'indent is kept');
      await s.page.press('#code', 'Shift+Tab');
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)\nend', 'Shift+Tab outdents');
      await s.page.press('#code', 'Control+/');
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)\n-- end', 'Ctrl+/ comments');
      await s.page.press('#code', 'Control+/');
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)\nend', 'and uncomments');
      await s.page.waitForSelector('#hl .tok-kw');
      assert.ok(await s.page.locator('#hl .tok-kw').count() >= 3, 'keywords are highlighted');
      assert.equal(await s.page.inputValue('#examples'), '', 'the example selector shows "Custom script"');

      // (an explicit ?example= would win over the saved script, so reload without one)
      await s.page.goto(`${base}/?run=0`, { waitUntil: 'load' });
      await s.page.waitForFunction(() => document.getElementById('code').value.length > 0);
      assert.equal(await s.page.inputValue('#code'), 'if true then\n    print(1)\nend', 'the script survives a reload');
      await s.finish();
    });

    it('mobile: single column, no horizontal scroll, footer below every pane', async () => {
      const s = await session({ colorScheme: 'light', viewport: { width: 390, height: 844 }, mobile: true });
      await s.open('example=bounce');
      await partsAre(s.page, 10);
      await s.page.waitForTimeout(400);
      const m = await s.page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const foot = document.querySelector('.statusbar').getBoundingClientRect();
        return {
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          footTop: foot.top + scrollY,
          lowestPane: Math.max(...[...document.querySelectorAll('.pane')].map((p) => p.getBoundingClientRect().bottom + scrollY)),
          canvasW: r('gl').width,
        };
      });
      assert.equal(m.scrollW, m.clientW, 'no horizontal overflow');
      assert.ok(m.footTop >= m.lowestPane - 1, `the status bar (${m.footTop}) sits below the last pane (${m.lowestPane})`);
      assert.ok(m.canvasW > 300);
      await shot(s.page, 'playground-mobile');
      await s.finish();
    });
  });
}
