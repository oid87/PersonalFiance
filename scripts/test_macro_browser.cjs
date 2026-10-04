#!/usr/bin/env node
'use strict';
// Independent macro browser QA; no product/data mutation or dependency installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startServer, hash } = require('./browser_smoke.cjs');
const ORIGINAL = path.resolve(__dirname, '..');
const FIXED_TIME = '2026-10-04T12:00:00Z';
const BIZ = '/data/taiwan_business_signal.json';
const VIEWPORTS = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function parseArgs(argv) {
  const o = { root: ORIGINAL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') o.help = true;
    else if (arg === '--baseline-only') o.baselineOnly = true;
    else if (['--root', '--before-root', '--output'].includes(arg) && argv[i + 1]) o[({ '--root': 'root', '--before-root': 'beforeRoot', '--output': 'output' })[arg]] = path.resolve(argv[++i]);
    else throw new Error('Unknown/incomplete argument: ' + arg);
  }
  return o;
}
function identity(root) {
  const run = args => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { root: fs.realpathSync(root), head: run(['rev-parse', 'HEAD']), branch: run(['branch', '--show-current']), dirty: run(['status', '--porcelain']), files: Object.fromEntries(['index.html', 'js/tabs/macro.js', 'js/switcher.js', 'js/state.js', 'js/utils/data.js', 'data/US10Y.json', 'data/US2Y.json', 'data/M2.json', 'data/CAPE.json', BIZ.slice(1)].map(f => [f, hash(fs.readFileSync(path.join(root, f)))])) };
}
async function snapshot(page) {
  return page.evaluate(() => {
    const charts = ['macro-chart', 'biz-chart'].map(id => {
      const c = echarts.getInstanceByDom(document.getElementById(id));
      if (!c) return { id, absent: true };
      const o = c.getOption();
      const options = Object.fromEntries(['series', 'xAxis', 'yAxis', 'legend', 'dataZoom', 'grid', 'visualMap'].filter(k => o[k]).map(k => [k, o[k]]));
      return { id, options: JSON.parse(JSON.stringify(options, (_, v) => typeof v === 'function' ? String(v) : v)) };
    });
    return { charts, status: ['macro-status', 'biz-status'].map(id => ({ id, text: document.getElementById(id).innerText })),
      controls: [...document.querySelectorAll('#tab-macro .chip')].map(e => ({ id: e.id, text: e.innerText, active: e.classList.contains('active'), range: e.dataset.macroRange, disabled: !!e.disabled, visible: !!e.getClientRects().length })), text: document.getElementById('tab-macro').innerText };
  });
}
async function settled(page) {
  await page.waitForFunction(() => { const s = document.getElementById('tab-macro'); return s && !s.hidden && s.getAttribute('aria-busy') !== 'true' && /目前利差/.test(document.getElementById('macro-status').innerText); }, {}, { timeout: 25000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function run(options) {
  const out = options.output || fs.mkdtempSync(path.join(os.tmpdir(), 'macro-browser-'));
  if (options.output) fs.mkdirSync(out); // Preserve failed attempts by refusing reuse.
  const report = { scope: 'macro only', commands: { argv: process.argv, cwd: process.cwd() }, started: new Date().toISOString(),
    runtime: { node: process.version, os: os.platform() + ' ' + os.release(), fixedTime: FIXED_TIME, timezone: 'UTC', chromiumSandbox: true, viewports: VIEWPORTS },
    sourceIdentity: { after: identity(options.root), before: options.beforeRoot ? identity(options.beforeRoot) : null, responses: [], syntheticResponses: [] },
    cases: [], console: [], requests: [], artifacts: { directory: out, report: path.join(out, 'report.json'), failures: [], snapshots: [] }, cleanup: { browserClosed: false, serversClosed: false },
    limitations: ['Chromium emulation; Safari, native touch and screen reader not exercised.', 'Macro only, not 72 pages.', 'Optional-source multiplicity is N/A: macro has one optional endpoint.', 'Existing switcher keeps per-tab activation alive on route exit; explicit aborted/current=false consumer contexts are tested separately.', 'CDN ECharts requires network; no installation or financial fetch.'] };
  let browser, activePage, activeContext, stage = 'startup';
  const servers = [], pending = [];
  const save = () => fs.writeFileSync(report.artifacts.report, JSON.stringify(report, null, 2) + '\n');
  async function test(name, fn) {
    stage = name;
    try { const evidence = await fn(); report.cases.push({ name, status: 'PASS', evidence }); }
    catch (error) {
      report.cases.push({ name, status: 'FAIL', reason: error.message, stack: error.stack });
      if (activePage && !activePage.isClosed()) {
        const stem = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const screenshot = path.join(out, stem + '.png'), state = path.join(out, stem + '-state.json');
        await activePage.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
        await snapshot(activePage).then(value => fs.writeFileSync(state, JSON.stringify(value, null, 2))).catch(() => {});
        report.artifacts.failures.push({ name, screenshot, state });
      }
    }
    save();
  }
  async function session(server, viewport, name, mode = 'full') {
    const context = await browser.newContext({ viewport, timezoneId: 'UTC', deviceScaleFactor: 1 });
    activeContext = context;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(10000);
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    const control = { mode, count: 0, gates: [], expected503: 0 };
    const expected = new Map();
    const phaseCasesStart = report.cases.length;
    page.on('console', m => {
      if (!['error', 'warning'].includes(m.type())) return;
      const location = m.location();
      const injected = m.type() === 'error' && location.url === server.url + BIZ && /Failed to load resource.*503/.test(m.text());
      report.console.push({ stage, phase: name, type: m.type(), text: m.text(), location, expected: injected });
    });
    page.on('pageerror', e => report.console.push({ stage, phase: name, type: 'pageerror', text: e.message, expected: false }));
    page.on('requestfailed', r => report.requests.push({ stage, phase: name, type: 'failed', url: r.url(), error: r.failure() }));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== server.url) { report.requests.push({ phase: name, type: 'external', url: url.href, status: response.status() }); return; }
      pending.push((async () => {
        const file = decodeURIComponent(url.pathname).slice(1) || 'index.html';
        const row = { phase: name, root: server.root, path: file, status: response.status() };
        try {
          row.httpSha256 = hash(await response.body());
          const injection = expected.get(response.request());
          if (injection) { row.fixture = injection.mode; row.fixtureSha256 = hash(injection.body); row.equal = row.httpSha256 === row.fixtureSha256; report.sourceIdentity.syntheticResponses.push(row); }
          else { row.diskSha256 = hash(fs.readFileSync(path.join(server.root, file))); row.equal = row.httpSha256 === row.diskSha256; report.sourceIdentity.responses.push(row); }
        } catch (e) { row.error = e.message; row.equal = false; report.sourceIdentity.responses.push(row); }
      })());
    });
    const fulfill = async (route, mode) => {
      if (mode === 'full') return route.continue();
      const body = mode === 'http503' ? 'Injected BIZ HTTP 503' : mode === 'malformed' ? '{invalid-json' : JSON.stringify({ data: mode === 'empty' ? [] : [{ date: mode === 'bad-date' ? '2026-02-30' : '2026-08-01', score: mode === 'bad-score' ? '30' : 30, light: '綠燈' }] });
      expected.set(route.request(), { mode, body });
      if (mode === 'http503') control.expected503++;
      await route.fulfill({ status: mode === 'http503' ? 503 : 200, contentType: 'application/json', body });
    };
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() !== 'GET' || (url.origin !== server.url && req.url() !== 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js')) {
        report.requests.push({ phase: name, type: 'unexpected', url: req.url(), method: req.method() }); return route.abort();
      }
      if (url.origin === server.url && url.pathname === BIZ) {
        control.count++;
        if (control.mode === 'gate') { control.gates.push(route); return; }
        return fulfill(route, control.mode);
      }
      return route.continue();
    });
    control.release = async mode => { const routes = control.gates.splice(0); for (const route of routes) await fulfill(route, mode); };
    await page.goto(server.url + '/#tab=macro', { waitUntil: 'networkidle' });
    await settled(page);
    const close = async () => {
      // Release any held transport before closing; no orphan handlers/profiles/server.
      await control.release('full').catch(() => {});
      await Promise.all(pending.splice(0));
      const failures = report.cases.slice(phaseCasesStart).some(c => c.status !== 'PASS');
      const trace = failures ? path.join(out, name + '-trace.zip') : null;
      await context.tracing.stop(trace ? { path: trace } : {});
      if (trace) report.artifacts.failures.push({ phase: name, trace });
      await context.close(); activeContext = null; activePage = null;
    };
    return { page, control, close };
  }
  async function matrix(server, label) {
    const output = {};
    for (const viewport of VIEWPORTS) {
      const name = label + '-' + viewport.width;
      const { page, close } = await session(server, viewport, name);
      try {
        const rows = [];
        for (const range of ['1Y', '3Y', '5Y', '10Y', '20Y', 'MAX']) {
          for (const overlays of [[false, false], [true, false], [true, true], [false, true]]) {
            await page.locator(`[data-macro-range="${range}"]`).click();
            for (const [id, wanted] of [['m2-toggle', overlays[0]], ['cape-toggle', overlays[1]]]) {
              const current = await page.locator('#' + id).evaluate(e => e.classList.contains('active'));
              if (current !== wanted) await page.locator('#' + id).click();
            }
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            const value = await snapshot(page);
            assert(value.charts.every(c => c.options?.series?.length), 'Missing full-data chart series');
            rows.push({ range, m2: overlays[0], cape: overlays[1], value });
          }
        }
        output[viewport.width] = rows;
        const file = path.join(out, name + '-matrix.json');
        fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n'); report.artifacts.snapshots.push(file);
      } finally { await close(); }
    }
    return output;
  }
  async function unavailable(page) {
    const text = await page.locator('#biz-status').innerText();
    assert(/台灣景氣/.test(text) && /暫不可用|不可用|未載入|缺/.test(text) && /無法.*判|不能.*判|無.*判/.test(text), 'Missing explicit unavailable / cannot judge Taiwan signal disclosure: ' + text);
    assert(/美國/.test(text), 'US availability not disclosed');
    assert(await page.locator('#macro-biz-retry').isVisible(), 'Retry missing');
    assert(await page.locator('#macro-biz-retry').isEnabled(), 'Retry disabled while settled');
    const snap = await snapshot(page);
    assert(snap.charts[0].options.series.length >= 3 && snap.charts[0].options.series.slice(0, 3).every(s => s.data.length), 'US curves unusable');
    assert(!snap.charts[1].options?.series?.some(s => s.data?.length), 'Unavailable BIZ has misleading signal series');
    assert(!await page.evaluate(async () => !!(await import('/js/state.js')).macroLoaded.BIZ), 'Invalid optional rows committed');
    await page.locator('#biz-status').scrollIntoViewIfNeeded();
    const bounds = await page.locator('#biz-status').evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const button = await page.locator('#macro-biz-retry').boundingBox(); const viewport = page.viewportSize();
    assert(button && button.x >= 0 && button.x + button.width <= viewport.width && button.y >= 0 && button.y + button.height <= viewport.height, 'Retry outside viewport: ' + JSON.stringify(button));
    assert(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'Disclosure horizontally clipped: ' + JSON.stringify(bounds));
    const accessibility = await page.locator('#biz-status').evaluate(e => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live') }));
    return { text, disclosureBounds: bounds, buttonBounds: button, viewport, accessibility };
  }
  async function waitGate(page, control) {
    await page.waitForFunction(() => document.getElementById('macro-biz-retry')?.disabled === true);
    for (let i = 0; !control.gates.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert(control.gates.length === 1, 'Expected one pending BIZ transport');
  }
  async function switchTo(page, id, wait = true) {
    if (wait) return page.evaluate(async id => (await import('/js/switcher.js')).switchTo(id), id);
    return page.evaluate(id => { void import('/js/switcher.js').then(m => m.switchTo(id)); }, id);
  }
  try {
    const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const pkg = require.resolve((process.env.PLAYWRIGHT_MODULE || 'playwright') + '/package.json'); report.runtime.playwright = JSON.parse(fs.readFileSync(pkg)).version;
    browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings', '--enable-unsafe-swiftshader'] }); report.runtime.browser = browser.version();
    const afterServer = await startServer(options.root); servers.push(afterServer);
    let baseline;
    if (options.beforeRoot || options.baselineOnly) {
      const beforeServer = options.beforeRoot ? await startServer(options.beforeRoot) : afterServer;
      if (beforeServer !== afterServer) servers.push(beforeServer);
      await test('fixed-clock before matrix stable twice', async () => { baseline = await matrix(beforeServer, 'before-1'); const twice = await matrix(beforeServer, 'before-2'); assert(equal(baseline, twice), 'Before matrices differ; cannot assert financial equivalence'); return { combinationsPerViewport: 24, matrixSha256: hash(JSON.stringify(baseline)) }; });
    }
    if (!options.baselineOnly) {
      await test('all-data financial/options/status/chips matrix', async () => { const after = await matrix(afterServer, 'after'); if (baseline) assert(equal(baseline, after), 'Before/after all-data matrix differs'); return { combinationsPerViewport: 24, comparedToBefore: !!baseline, matrixSha256: hash(JSON.stringify(after)) }; });
      for (const viewport of VIEWPORTS) {
        for (const mode of ['http503', 'malformed', 'empty', 'bad-score', 'bad-date']) {
          let s;
          await test('optional ' + mode + ' disclosure ' + viewport.width, async () => { s = await session(afterServer, viewport, mode + '-' + viewport.width, mode); return unavailable(s.page); });
          if (s) await s.close();
        }
        for (const outcome of ['full', 'http503']) {
          const name = 'retry-' + outcome + '-' + viewport.width;
          let s;
          await test(name, async () => {
            s = await session(afterServer, viewport, name, 'http503'); const { page, control } = s;
            await unavailable(page);
            await page.locator('#m2-toggle').click(); await page.locator('#cape-toggle').click();
            await page.locator('[data-macro-range="3Y"]').click();
            await page.evaluate(() => { const c = echarts.getInstanceByDom(document.getElementById('macro-chart')); c.dispatchAction({ type: 'dataZoom', start: 20, end: 80 }); c.dispatchAction({ type: 'legendUnSelect', name: '美債2Y' }); });
            const state = await snapshot(page), before = control.count; control.mode = 'gate';
            await page.locator('#macro-biz-retry').click(); await waitGate(page, control);
            assert(/載入|重試中/.test(await page.locator('#biz-status').innerText()), 'No visible retry pending state');
            await page.evaluate(() => { for (let i = 0; i < 4; i++) document.getElementById('macro-biz-retry').click(); });
            assert(control.count === before + 1, 'Repeated pending clicks started extra requests');
            await page.locator('#theme-btn').click(); await page.setViewportSize({ width: viewport.width, height: viewport.height - 40 });
            await control.release(outcome); await settled(page);
            const result = await snapshot(page);
            const saved = state.charts[0].options, current = result.charts[0].options;
            assert(current.dataZoom[0].start === saved.dataZoom[0].start && current.dataZoom[0].end === saved.dataZoom[0].end, 'Retry/theme/resize lost US zoom');
            assert(equal(current.legend.map(l => l.selected), saved.legend.map(l => l.selected)), 'Retry lost legend selection');
            assert(result.controls.filter(c => c.active).map(c => c.id || c.range).join(',') === state.controls.filter(c => c.active).map(c => c.id || c.range).join(','), 'Retry lost range/overlay controls');
            if (outcome === 'full') { assert(!await page.locator('#macro-biz-retry').count(), 'Recovered retry remains'); assert(result.charts[1].options.series[0].data.length > 0, 'Recovery missing BIZ chart'); }
            else await unavailable(page);
            control.mode = outcome;
            await switchTo(page, 'macro'); await settled(page);
            return { requestCount: control.count, pendingRepeatedClicks: 4, outcome, usZoom: current.dataZoom[0], legend: current.legend.map(l => l.selected) };
          });
          if (s) await s.close();
        }
        let s;
        await test('route exit/re-entry during retry ' + viewport.width, async () => {
          s = await session(afterServer, viewport, 'route-' + viewport.width, 'http503'); const { page, control } = s;
          control.mode = 'gate'; await page.locator('#macro-biz-retry').click(); await waitGate(page, control);
          // cpi is an existing registered route; switching back attaches to the same pending activation.
          await switchTo(page, 'cpi');
          assert(await page.locator('#tab-macro').evaluate(e => e.hidden), 'Macro stayed visible after exit');
          await control.release('full');
          await page.waitForFunction(() => document.getElementById('tab-macro').getAttribute('aria-busy') !== 'true');
          const hidden = await page.evaluate(() => { const c = echarts.getInstanceByDom(document.getElementById('biz-chart')); return { hidden: document.getElementById('tab-macro').hidden, chartWidth: c?.getWidth() ?? null }; });
          assert(hidden.hidden, 'Background optional response changed active route');
          await switchTo(page, 'macro'); await settled(page);
          const dimensions = await page.locator('#biz-chart').evaluate(e => { const c = echarts.getInstanceByDom(e); return { width: c.getWidth(), height: c.getHeight() }; });
          assert(dimensions.width > 0 && dimensions.height > 0, 'Re-entry BIZ chart has zero dimensions');
          assert(control.count === 2, 'Re-entry duplicated pending BIZ request');
          assert((await snapshot(page)).charts[1].options.series[0].data.length > 0, 'Re-entry failed to recover');
          return { requests: control.count, hiddenOnExit: true, hiddenCompletion: hidden, reentryDimensions: dimensions };
        });
        if (s) await s.close();
        for (const expiry of ['abort', 'current-false']) {
          let s;
          await test('interrupted consumer ' + expiry + ' ' + viewport.width, async () => {
            s = await session(afterServer, viewport, expiry + '-' + viewport.width, 'http503'); const { page, control } = s;
            control.mode = 'gate';
            await page.evaluate(async () => {
              const module = await import('/js/tabs/macro.js'), data = await import('/js/utils/data.js'); data.clearRequestCache('data/taiwan_business_signal.json');
              window.__macroProbe = { controller: new AbortController(), current: true, done: false };
              const p = window.__macroProbe;
              p.promise = module.activate({ signal: p.controller.signal, isCurrent: () => p.current }).then(() => { p.done = true; p.result = 'resolved'; }, e => { p.done = true; p.result = e.name; });
            });
            await waitGate(page, control);
            await page.evaluate(expiry => { if (expiry === 'abort') window.__macroProbe.controller.abort(); else window.__macroProbe.current = false; }, expiry);
            // Establish a newer visible result before releasing the expired transport.
            const marker = 'newer-context-visible-status';
            await page.locator('#biz-status').evaluate((e, marker) => { e.textContent = marker; }, marker);
            await control.release('full'); await page.waitForFunction(() => window.__macroProbe.done);
            const result = await page.evaluate(async () => ({ result: window.__macroProbe.result, biz: (await import('/js/state.js')).macroLoaded.BIZ || null, status: document.getElementById('biz-status').innerText }));
            assert(result.result === 'AbortError', 'Expired consumer did not reject AbortError: ' + JSON.stringify(result));
            assert(!result.biz && result.status === marker, 'Expired response committed BIZ or repainted newer status');
            control.mode = 'full'; await page.evaluate(async () => { (await import('/js/utils/data.js')).clearRequestCache('data/taiwan_business_signal.json'); });
            await switchTo(page, 'macro'); await settled(page);
            assert((await snapshot(page)).charts[1].options.series[0].data.length > 0, 'Retry after interruption failed');
            return result;
          });
          if (s) await s.close();
        }
      }
    }
    await Promise.all(pending.splice(0));
    await test('served checkout and injected response hashes', async () => {
      const ending = identity(options.root); report.sourceIdentity.afterEnding = ending;
      assert(equal(ending.files, report.sourceIdentity.after.files), 'Target source/data changed during this run');
      assert(report.sourceIdentity.responses.length > 0, 'No HTTP evidence');
      const bad = [...report.sourceIdentity.responses, ...report.sourceIdentity.syntheticResponses].filter(r => !r.equal || r.error);
      assert(!bad.length, 'Response hash identity failure: ' + JSON.stringify(bad));
      for (const file of ['index.html', 'js/tabs/macro.js', 'data/US10Y.json', 'data/US2Y.json', 'data/M2.json', 'data/CAPE.json']) assert(report.sourceIdentity.responses.some(r => r.path === file), 'Missing loaded identity: ' + file);
      return { diskResponses: report.sourceIdentity.responses.length, declaredInjectedResponses: report.sourceIdentity.syntheticResponses.length };
    });
    await test('only exact injected HTTP503 console failures', async () => {
      const unexpected = report.console.filter(m => !m.expected), badRequests = report.requests.filter(r => r.type !== 'external' || r.status !== 200);
      assert(!unexpected.length && !badRequests.length, 'Unexpected browser diagnostics: ' + JSON.stringify({ unexpected, badRequests }));
      const http503 = report.sourceIdentity.syntheticResponses.filter(r => r.status === 503);
      assert(report.console.filter(m => m.expected).length === http503.length, 'Injected HTTP503 count does not exactly match console errors');
      return { expectedErrors: report.console.filter(m => m.expected), warnings: 0, pageerrors: 0, failedRequests: 0 };
    });
  } catch (error) { report.fatal = { stage, message: error.message, stack: error.stack }; report.cases.push({ name: stage + ' startup/runtime', status: 'FAIL', reason: error.message }); }
  finally {
    if (activeContext) await activeContext.close().catch(e => { report.cleanup.contextError = e.message; });
    if (browser) await browser.close().then(() => { report.cleanup.browserClosed = true; }, e => { report.cleanup.browserError = e.message; }); else report.cleanup.browserClosed = true;
    await Promise.all(servers.map(s => s.close().catch(e => { report.cleanup.serverError = e.message; })));
    report.cleanup.serversClosed = !report.cleanup.serverError;
    if (!report.cleanup.browserClosed || !report.cleanup.serversClosed) report.cases.push({ name: 'resource cleanup', status: 'FAIL' });
    const failed = report.cases.filter(c => c.status !== 'PASS'); report.summary = { status: failed.length ? 'FAIL' : 'PASS', passed: report.cases.length - failed.length, total: report.cases.length, failedScenarios: failed.map(c => c.name), unexpectedErrors: report.console.filter(m => !m.expected && m.type === 'error').length, expectedInjectedErrors: report.console.filter(m => m.expected).length, warnings: report.console.filter(m => m.type === 'warning').length, pageerrors: report.console.filter(m => m.type === 'pageerror').length, exitCode: failed.length ? 1 : 0 };
    report.finished = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ summary: report.summary, report: report.artifacts.report, cleanup: report.cleanup }, null, 2));
  return report;
}
module.exports = { parseArgs, snapshot, run };
if (require.main === module) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
  if (options?.help) console.log('Usage: node scripts/test_macro_browser.cjs [--root CHECKOUT] [--before-root ACTUAL_WIP_SNAPSHOT] [--output NEW_DIRECTORY] [--baseline-only]\nFixed UTC clock; sandboxed Chromium; unique evidence; no installs or product writes. Baseline comparison only when before-root supplied. baseline-only checks the same baseline twice.');
  else if (options) run(options).then(r => { process.exitCode = r.summary.exitCode; }).catch(e => { console.error(e.stack); process.exitCode = 1; });
}
