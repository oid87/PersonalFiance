/* Scoped integration probe; uses installed Playwright, never fetches market data. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.USRISK_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'pf-usrisk-browser-'));
fs.mkdirSync(out, { recursive: true });
const report = { root, branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runtime: { node: process.version, playwright: require(path.join(process.env.PLAYWRIGHT_MODULE || 'playwright', 'package.json')).version }, cases: [], console: [], identity: [], limitations: ['Chromium emulation; not real Safari/touch or native macOS IME'], cleanup: {} };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try { const body = fs.readFileSync(file); res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
let browser, activePage;
function check(name, ok, detail = null) { report.cases.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + JSON.stringify(detail)); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  report.url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true }); report.runtime.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Taipei' });
  const page = await context.newPage(); activePage = page;
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
  page.on('pageerror', e => report.console.push({ type: 'pageerror', text: e.message }));
  page.on('requestfailed', req => report.console.push({ type: 'requestfailed', url: req.url(), error: req.failure() }));
  let bundleRequests = 0;
  page.on('request', req => { if (req.url().endsWith('/data/us_risk_observations.json')) bundleRequests++; });
  const ids = new Set();
  const identityTasks = [];
  page.on('response', res => {
    const url = new URL(res.url());
    if (url.origin !== report.url) return;
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    if (ids.has(rel) || !['/index.html', '/js/tabs/usrisk.js', '/js/tabs/usrisk_calc.mjs', '/js/tabs/usrisk_controls.mjs', '/css/main.css', '/data/us_risk_observations.json'].includes(rel)) return;
    ids.add(rel);
    identityTasks.push((async () => { const actual = sha(await res.body()), expected = sha(fs.readFileSync(path.join(root, rel))); report.identity.push({ path: rel, actual, expected, ok: actual === expected }); })());
  });
  await page.goto(report.url + '/#tab=trend');
  await page.waitForSelector('#tab-trend:not([hidden])');
  check('new tab data remains lazy', bundleRequests === 0, bundleRequests);
  await page.evaluate(() => { location.hash = '#tab=usrisk'; });
  await page.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('研究區間'), { timeout: 30000 });
  check('strict default unavailable before observed archive', (await page.locator('#usrisk-study-note').innerText()).includes('N=0'));
  check('three real ECharts instances', await page.locator('#tab-usrisk [_echarts_instance_]').count() === 3);
  check('all selects have help', await page.locator('#tab-usrisk select').count() === await page.locator('#usrisk-controls .info-pop-btn, #usrisk-background-control .info-pop-btn').count());
  const firstInfo = page.locator('#usrisk-controls .info-pop-btn').first();
  await firstInfo.click();
  await page.waitForSelector('#info-popover:visible');
  check('click opens help with exact text', (await page.locator('#info-popover').innerText()).includes('價格報酬不含股息') && await firstInfo.getAttribute('aria-expanded') === 'true');
  await firstInfo.click();
  check('second click closes help', await page.locator('#info-popover').isHidden() && await firstInfo.getAttribute('aria-expanded') === 'false');
  await firstInfo.click(); await page.locator('#usrisk-controls .info-pop-btn').nth(1).click();
  check('opening another help replaces the first', await firstInfo.getAttribute('aria-expanded') === 'false' && await page.locator('#info-popover').isVisible());
  await page.keyboard.press('Escape');
  check('Escape closes help', await page.locator('#info-popover').isHidden());
  check('strict banner explains N=0 and offers the non-PIT view', await page.locator('#usrisk-strict-banner').isVisible() && (await page.locator('#usrisk-strict-banner').innerText()).includes('最早約'));
  await page.selectOption('#usrisk-dataMode', 'historical');
  await page.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('非 PIT'));
  check('historical mode explicitly non-PIT with outcomes', (await page.locator('#usrisk-study-note').innerText()).includes('N=19'));
  check('banner hidden outside strict mode', await page.locator('#usrisk-strict-banner').isHidden());
  await page.selectOption('#usrisk-dataMode', 'strict');
  await page.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('嚴格'));
  check('banner button switches to non-PIT', await page.locator('#usrisk-strict-banner button').isVisible());
  await page.locator('#usrisk-strict-banner button').click();
  await page.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('非 PIT'));
  check('banner button result is historical', await page.inputValue('#usrisk-dataMode') === 'historical');
  for (const mode of ['vxn', 'relative', 'semis', 'term', 'breadth', 'vix']) {
    await page.selectOption('#usrisk-mode', mode);
    await page.waitForFunction(() => !document.querySelector('#usrisk-status').textContent.includes('正在'));
    check('mode ' + mode + ' renders', !(await page.locator('#usrisk-status').innerText()).includes('不可用：'));
    if (mode === 'breadth') check('biased breadth is not backtested', (await page.locator('#usrisk-study-note').innerText()).includes('N=0'));
  }
  for (const [control, values] of [['thresholdMode', ['percentile', 'fixed']], ['asset', ['SPY', 'QQQ']], ['gate', ['0', '10', '15', '8']], ['horizon', ['5', '10', '60', '20']]]) {
    for (const value of values) { await page.selectOption('#usrisk-' + control, value); await page.waitForFunction(() => !document.querySelector('#usrisk-status').textContent.includes('正在')); check(control + '=' + value, !(await page.locator('#usrisk-status').innerText()).includes('不可用：')); }
  }
  await page.locator('#usrisk-risk-chart').scrollIntoViewIfNeeded();
  await page.evaluate(() => { const c = echarts.getInstanceByDom(document.querySelector('#usrisk-risk-chart')); c.dispatchAction({ type: 'dataZoom', start: 30, end: 80 }); c.dispatchAction({ type: 'legendUnSelect', name: '研究門檻' }); });
  await page.locator('#theme-btn').click();
  check('theme retains zoom and legend', await page.evaluate(() => { const o = echarts.getInstanceByDom(document.querySelector('#usrisk-risk-chart')).getOption(); return o.dataZoom[0].start === 30 && o.legend[0].selected['研究門檻'] === false; }));
  await page.evaluate(() => { location.hash = '#tab=trend'; });
  await page.waitForSelector('#tab-trend:not([hidden])');
  await page.evaluate(() => { location.hash = '#tab=usrisk'; });
  await page.waitForFunction(() => document.querySelector('#tab-usrisk')?.hidden === false && !document.querySelector('#usrisk-status').textContent.includes('正在'));
  check('hidden re-entry retains selection', await page.inputValue('#usrisk-dataMode') === 'historical');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 450 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, minSelectHeight: Math.min(...[...document.querySelectorAll('#tab-usrisk select')].map(e => e.getBoundingClientRect().height)) }));
    check('viewport ' + viewport.width + 'x' + viewport.height, geometry.scrollWidth <= geometry.width + 1 && geometry.minSelectHeight >= 44, geometry);
    await page.locator('#tab-usrisk').screenshot({ path: path.join(out, 'usrisk-' + viewport.width + 'x' + viewport.height + '.png') });
  }
  await Promise.all(identityTasks);
  check('HTTP bytes match served checkout', report.identity.length === 6 && report.identity.every(r => r.ok), report.identity);
  check('normal flow console clean', report.console.length === 0, report.console);
  // Expected fault scenarios have their own page/context and explicit diagnostics.
  report.faults = [];
  for (const fault of ['503', 'malformed', 'optional']) {
    const failurePage = await context.newPage();
    const errors = []; failurePage.on('pageerror', e => errors.push(e.message));
    let injected = true;
    await failurePage.route('**/data/us_risk_observations.json', async route => {
      if (!injected) return route.continue();
      if (fault === '503') return route.fulfill({ status: 503, body: 'test expected failure' });
      if (fault === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      const payload = JSON.parse(fs.readFileSync(path.join(root, 'data/us_risk_observations.json')));
      payload.series.VXN.records = []; payload.series.VXN.meta.available = false;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await failurePage.goto(report.url + '/#tab=usrisk');
    if (fault === 'optional') { await failurePage.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('研究區間')); check('optional unavailable is explicit', (await failurePage.locator('#usrisk-overview').innerText()).includes('unavailable')); }
    else {
      await failurePage.getByRole('button', { name: '重試', exact: true }).waitFor();
      injected = false; await failurePage.getByRole('button', { name: '重試', exact: true }).click();
      await failurePage.waitForFunction(() => document.querySelector('#usrisk-status').textContent.includes('研究區間'));
      check(fault + ' recovers via retry', true);
    }
    check(fault + ' has no uncaught exception', errors.length === 0, errors);
    report.faults.push({ fault, recovered: true, uncaught: errors }); await failurePage.close();
  }
})().catch(async error => { report.error = error.stack; process.exitCode = 1; if (activePage) { report.state = await activePage.locator('body').innerText().catch(() => 'unavailable'); await activePage.screenshot({path:path.join(out, 'failure.png'),fullPage:true}).catch(() => {}); } }).finally(async () => {
  if (browser) { await browser.close(); report.cleanup.browser = true; }
  await new Promise(resolve => server.close(resolve)); report.cleanup.server = true;
  report.pass = !report.error && report.cases.every(c => c.ok);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length, error: report.error || null, report: path.join(out, 'report.json') }));
});
