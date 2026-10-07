// Isolated panel QA only; no dashboard route integration, market requests or CDN.
// Authored in Cloud, NOT executed by the coding model. Run in Sol 6.1 low QA.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const MODULES = [
  'js/utils/grouped_watchlists.mjs', 'js/utils/grouped_watchlists_panel.mjs',
  'js/tabs/leverage_calc.mjs', 'js/tabs/levvol_calc.mjs',
  'js/tabs/leverage_diagnostics.mjs', 'js/tabs/leverage_diagnostics_panel.mjs',
  'js/tabs/monthly_return_heatmap.mjs',
];
const CASES = ['desktop group edits and symbol selection', 'remount restores saved groups',
  'malformed saved data survives session-only edits', 'destroy removes owned DOM',
  'leverage panel separates sample periods and price-only basis',
  'heatmap retains caller values and partial labels', '390px watchlist controls',
  'all imported source HTTP hashes match checkout', 'console and requests are clean'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--output')) {
    throw new Error('Usage: node scripts/test_cloud_remaining_browser.cjs [--output <new-directory>]');
  }
  const output = args.length ? path.resolve(args[1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'personalfiance-cloud-panels-'));
  if (args.length) fs.mkdirSync(output, { recursive: false });
  const report = { scope: 'isolated Cloud panels; not integrated dashboard UI',
    sourceIdentity: { root: ROOT, head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), status: git(['status', '--porcelain=v1', '--untracked-files=all']) },
    runtime: { node: process.version, platform: process.platform, chromiumSandbox: true },
    cases: [], console: { error: [], warning: [], pageerror: [] }, requests: [],
    artifacts: { report: path.join(output, 'report.json') },
    limitations: ['Synthetic price fixtures only; no financial data acquisition.',
      'Standalone panels, no catalogue/HTML integration, ECharts canvas rendering or theme/lifecycle matrix.',
      'Chromium emulation is not Safari, native IME, screen reader or real touch.'],
    cleanup: { browser: false, server: false } };
  let server, browser, context, page;
  const responses = [];
  let base;
  async function scenario(name, fn) {
    try { await fn(); report.cases.push({ name, status: 'PASS' }); }
    catch (error) {
      report.cases.push({ name, status: 'FAIL', error: error.stack ?? String(error) });
      if (page && !page.isClosed()) {
        const file = path.join(output, `failure-${report.cases.length}.png`);
        try { await page.screenshot({ path: file, fullPage: true }); report.cases.at(-1).screenshot = file; }
        catch (captureError) { report.cases.at(-1).captureError = String(captureError); }
        try {
          const state = path.join(output, `failure-${report.cases.length}-state.json`);
          fs.writeFileSync(state, JSON.stringify({ url: page.url(), html: await page.content() }, null, 2) + '\n');
          report.cases.at(-1).state = state;
        } catch (captureError) { report.cases.at(-1).stateError = String(captureError); }
      }
    }
  }
  try {
    const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    report.runtime.playwrightModule = require.resolve(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const packagePath = path.join(path.dirname(report.runtime.playwrightModule), 'package.json');
    report.runtime.playwright = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    const executable = process.env.CHROMIUM_EXECUTABLE || playwright.chromium.executablePath();
    report.runtime.executable = executable;
    if (!fs.existsSync(executable)) throw new Error(`Browser executable absent: ${executable}`);
    const sources = new Map(MODULES.map(file => [file, fs.readFileSync(path.join(ROOT, file))]));
    report.sourceIdentity.moduleHashes = Object.fromEntries([...sources].map(([file, bytes]) => [file, sha(bytes)]));
    server = http.createServer((request, response) => {
      const file = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
      if (!file) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><title>Isolated panel QA</title><main id="watchlists"></main><main id="leverage"></main></html>');
      } else if (sources.has(file)) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(sources.get(file));
      } else { response.writeHead(404); response.end('Not part of this probe'); }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    report.sourceIdentity.url = base;
    browser = await playwright.chromium.launch({ executablePath: executable, chromiumSandbox: true });
    report.runtime.browser = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('console', event => {
      if (event.type() === 'error') report.console.error.push(event.text());
      if (event.type() === 'warning') report.console.warning.push(event.text());
    });
    page.on('pageerror', error => report.console.pageerror.push(String(error)));
    page.on('requestfailed', request => report.requests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.url().startsWith(base + '/js/')) responses.push(response); });
    await page.route('**/*', async route => {
      if (route.request().url().startsWith(base + '/')) await route.continue();
      else { report.requests.push({ url: route.request().url(), error: 'External request forbidden' }); await route.abort(); }
    });
    await page.goto(base);
    report.artifacts.before = path.join(output, 'before-desktop.png');
    await page.screenshot({ path: report.artifacts.before, fullPage: true });
    await page.evaluate(async () => {
      window.watchModule = await import('/js/utils/grouped_watchlists_panel.mjs');
      window.catalogue = [{ key: 'QQQ', label: 'Nasdaq ETF' }, { key: '0050', label: '台灣50 ETF' }];
      window.selected = [];
      window.mount = () => window.watch = window.watchModule.mountGroupedWatchlists(document.querySelector('#watchlists'),
        { instruments: window.catalogue, storage: localStorage, onSelect: key => window.selected.push(key) });
      window.mount();
    });
    await scenario(CASES[0], async () => {
      await page.getByLabel('新群組名稱', { exact: false }).fill('<img src=x onerror=alert(1)>');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      await page.getByLabel('加入標的', { exact: false }).selectOption('QQQ');
      await page.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByRole('button', { name: 'Nasdaq ETF (QQQ)', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.selected), ['QQQ']);
      assert.equal(await page.locator('#watchlists img').count(), 0);
      await page.getByLabel('群組名稱', { exact: true }).fill('核心觀察');
      await page.getByRole('button', { name: '重新命名', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.watch.getState().groups[0]),
        { id: 'group-1', name: '核心觀察', symbols: ['QQQ'] });
    });
    await scenario(CASES[1], async () => {
      await page.evaluate(() => { window.watch.destroy(); window.mount(); });
      assert.equal(await page.getByRole('button', { name: 'Nasdaq ETF (QQQ)', exact: true }).count(), 1);
      assert.equal(await page.getByRole('heading', { name: '核心觀察', exact: true }).count(), 1);
    });
    await scenario(CASES[2], async () => {
      await page.evaluate(() => { window.watch.destroy(); localStorage.setItem('pf:watchlists:v1', '{bad'); window.mount(); });
      await page.getByLabel('新群組名稱', { exact: false }).fill('本次畫面');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('pf:watchlists:v1')), '{bad');
      assert.match(await page.getByRole('status').innerText(), /原儲存內容不改寫/);
    });
    await scenario(CASES[3], async () => {
      await page.evaluate(() => window.watch.destroy());
      assert.equal(await page.locator('#watchlists > *').count(), 0);
    });
    await scenario(CASES[4], async () => {
      await page.evaluate(async () => {
        const { mountLeverageDiagnostics } = await import('/js/tabs/leverage_diagnostics_panel.mjs');
        let price = 100;
        const data = Array.from({ length: 265 }, (_, i) => {
          price *= Math.exp((i % 7 - 3) / 1000);
          return [new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), price];
        });
        const bundle = { updated: 'fixture', underlyings: { U: { name: '合成價格 fixture', priceOnly: true, data } },
          etfs: [{ id: 'T', zh: 'fixture', underlying: 'U', leverage: 2, inception: data[0][0], expense: 0, financing: 0,
            real: data.map(([date, price]) => [date, 100 * (price / 100) ** 2]) }] };
        window.leverage = mountLeverageDiagnostics(document.querySelector('#leverage'), { bundle,
          settings: { etf: 'T', initial: 100, dca: false, from: data[260][0], to: data[264][0] } });
      });
      const text = await page.locator('#leverage').innerText();
      assert.match(text, /不含股息/);
      assert.match(text, /5 個價格觀測/);
      assert.match(text, /264 個報酬觀測/);
      assert.match(text, /不隨上方回測區間裁切/);
      assert.equal(await page.locator('#leverage .info-table tbody tr').count(), 5);
      report.artifacts.desktop = path.join(output, 'after-desktop.png');
      await page.screenshot({ path: report.artifacts.desktop, fullPage: true });
    });
    await scenario(CASES[5], async () => {
      const value = await page.evaluate(async () => {
        const module = await import('/js/tabs/monthly_return_heatmap.mjs');
        const model = module.monthlyReturnHeatmapModel([{ month: '2026-10', returnPct: 1.234567, partial: true }]);
        const option = module.monthlyReturnHeatmapOption(model, { calculationLabel: 'fixture supplied return',
          colors: { negative: '#f00', neutral: '#fff', positive: '#0f0', text: '#111', border: '#aaa' } });
        const data = option.series[0].data.find(item => item.cell.month === '2026-10');
        return { raw: data.value[2], label: option.series[0].label.formatter({ data }) };
      });
      assert.deepEqual(value, { raw: 1.234567, label: '1.23%（未完整）' });
    });
    await scenario(CASES[6], async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { localStorage.removeItem('pf:watchlists:v1'); window.mount(); });
      await page.getByLabel('新群組名稱', { exact: false }).fill('手機觀察');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      await page.getByLabel('加入標的', { exact: false }).selectOption('0050');
      await page.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByRole('button', { name: '台灣50 ETF (0050)', exact: true }).click();
      assert.equal(await page.evaluate(() => window.selected.at(-1)), '0050');
      report.artifacts.mobile = path.join(output, 'after-mobile.png');
      await page.screenshot({ path: report.artifacts.mobile, fullPage: true });
    });
    await scenario(CASES[7], async () => {
      const actual = {};
      for (const response of responses) {
        const file = new URL(response.url()).pathname.slice(1);
        actual[file] = sha(await response.body());
        assert.equal(actual[file], sha(fs.readFileSync(path.join(ROOT, file))), file);
      }
      assert.deepEqual(Object.keys(actual).sort(), [...MODULES].sort());
      report.sourceIdentity.httpHashes = actual;
    });
    await scenario(CASES[8], async () => {
      assert.deepEqual(report.console, { error: [], warning: [], pageerror: [] });
      assert.deepEqual(report.requests, []);
    });
  } catch (error) {
    report.startupError = error.stack ?? String(error);
    for (const name of CASES.filter(name => !report.cases.some(item => item.name === name))) {
      report.cases.push({ name, status: 'BLOCKED', error: String(error) });
    }
  } finally {
    if (context) {
      try { const trace = path.join(output, 'trace.zip'); await context.tracing.stop({ path: trace }); report.artifacts.trace = trace; }
      catch (error) { report.traceError = String(error); }
    }
    if (browser) { try { await browser.close(); report.cleanup.browser = true; } catch (error) { report.cleanup.browserError = String(error); } }
    else report.cleanup.browser = true;
    if (server?.listening) { await new Promise(resolve => server.close(resolve)); report.cleanup.server = true; }
    else report.cleanup.server = true;
    const passed = report.cases.filter(item => item.status === 'PASS').length;
    report.summary = { passed, total: CASES.length, status: passed === CASES.length
      && report.cleanup.browser && report.cleanup.server ? 'PASS' : 'FAIL' };
    fs.writeFileSync(report.artifacts.report, JSON.stringify(report, null, 2) + '\n');
    console.log(`${report.summary.status} ${passed}/${CASES.length}; ${report.artifacts.report}`);
    process.exitCode = report.summary.status === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
