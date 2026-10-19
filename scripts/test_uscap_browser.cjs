/* US Capitulation Alert page integration probe; uses installed Playwright, reads only repository files (no market-data fetch).
 *   node scripts/test_uscap_browser.cjs        (PLAYWRIGHT_MODULE=<path> to use another Playwright install)
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end('not found'); }
});
const cases = [], problems = [];
const check = (name, ok, detail = null) => { cases.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + JSON.stringify(detail)); };
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on('console', m => { if (['warning', 'error'].includes(m.type())) problems.push({ type: m.type(), text: m.text() }); });
    page.on('pageerror', e => problems.push({ type: 'pageerror', text: e.message }));
    page.on('requestfailed', r => problems.push({ type: 'requestfailed', url: r.url() }));
    await page.goto(base + '/#tab=uscap');
    await page.waitForFunction(() => /完成|失敗/.test(document.getElementById('uscap-status')?.textContent || ''), null, { timeout: 30000 });
    const text = id => page.locator('#uscap-' + id).innerText();
    check('status finished without error', /完成/.test(await text('status')), await text('status'));
    const market = await text('market');
    check('Down Volume is shown as unavailable, never substituted', /Down Volume\s*\n?\s*unavailable/.test(market.replace(/\n+/g, '\n')), market.slice(0, 300));
    check('VIX / VXN / PCR cards present', ['VIX', 'VXN', 'Put/Call'].every(k => market.includes(k)));
    const stages = await text('stages');
    check('three stages stay separate', ['A　Panic Detection', 'B　Deleveraging Confirmation', 'C　Stabilization Confirmation'].every(k => stages.includes(k)));
    const position = await text('position');
    check('position text has all four sources', ['CFTC', 'FINRA', 'HYG', 'HY OAS'].every(k => position.includes(k)), position.slice(0, 200));
    for (const id of ['history', 'models', 'periods', 'stress']) check(`table ${id} has rows`, (await page.locator(`#uscap-${id} tbody tr`).count()) > 3, id);
    check('chart canvas drawn', (await page.locator('#uscap-chart canvas').count()) > 0);
    const models = await text('models');
    check('Models C and D are reported unavailable', /C：A ＋ 90% Down Volume[\s\S]*unavailable/.test(models) && /D：A ＋ PCR ＋ 90% Down Volume[\s\S]*unavailable/.test(models));
    check('hindsight markers are labelled as non-realtime', (await page.locator('#tab-uscap').innerText()).includes('事後才知道'));
    // interactions
    await page.selectOption('#uscap-asset', 'SPY');
    await page.waitForFunction(() => /完成/.test(document.getElementById('uscap-status').textContent) && /標的 SPY/.test(document.getElementById('uscap-asof').textContent));
    check('asset switch recomputes', /標的 SPY/.test(await text('asof')));
    await page.selectOption('#uscap-period', '2008–2009');
    check('period switch changes history', (await text('history-note')).startsWith('2008–2009'));
    await page.locator('#uscap-sensitivity-details > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#uscap-sensitivity tbody tr').length > 10, null, { timeout: 15000 });
    check('sensitivity renders on demand', true);
    await page.locator('#tab-uscap .info-pop-btn').first().click();
    check('info popover opens', await page.locator('#info-popover').isVisible());
    await page.keyboard.press('Escape');
    check('info popover closes on Escape', !(await page.locator('#info-popover').isVisible()));
    // layouts
    for (const [w, h] of [[390, 844], [844, 390], [1024, 450]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);   // let the resize handlers re-fit the charts
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sel: document.getElementById('uscap-asset').offsetHeight }));
      check(`no horizontal page scroll at ${w}x${h}`, m.sw <= m.iw + 1 && m.sel >= 44, m);
    }
    check('no console warning/error/pageerror/requestfailed', problems.length === 0, problems);
    console.log(JSON.stringify({ ok: true, cases: cases.length }));
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message, cases, problems })); process.exit(1); });
