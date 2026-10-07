// Actual in-repo tools page QA. Local committed data only, no provider/CDN calls.
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
  "tools.html",
  "css/tools-workspace.css",
  "js/tools_workspace.mjs",
  "js/utils/data.js",
  "js/state.js",
  "js/utils/grouped_watchlists.mjs",
  "js/utils/grouped_watchlists_panel.mjs",
  "js/tabs/leverage_calc.mjs",
  "js/tabs/levvol_calc.mjs",
  "js/tabs/leverage_diagnostics.mjs",
  "js/tabs/leverage_diagnostics_panel.mjs",
  "js/tabs/monthly_return_heatmap.mjs",
  "js/tabs/monthly_return_heatmap_panel.mjs",
  "js/utils/tools_contracts.mjs",
  "js/utils/macro_calendar_status.mjs",
  "js/utils/taiwan_observations.mjs",
  "js/utils/taiwan_observations_panel.mjs",
  "data/TWII.json",
  "data/taiwan_margin_ratio.json",
  "data/taiwan_margin_total.json",
  "data/taiwan_money_supply.json",
  "data/leverage.json",
  "data/QQQ.json",
  "data/0050.TW.json"
];
const CASES = [
  "actual tools entry and dashboard links",
  "group create rename add remove delete and price selection",
  "reload restores browser groups",
  "malformed saved groups stay untouched with session edits",
  "monthly supplied input raw value null zero missing partial clear and malformed retry",
  "local bundle malformed payload retry and empty backtest window",
  "missing price payload retry",
  "theme mobile landscape short-height layout",
  "synthetic pagehide/pageshow cleanup and session-state restore",
  "macro unavailable and no fake events",
  "actual served checkout assets and data hashes",
  "console and requests clean",
  "Taiwan observations preserve six source values dates units and proxy scope",
  "Taiwan partial latest-null stored-spread mismatch and local retry"
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--output')) {
    throw new Error('Usage: node scripts/test_tools_workspace_browser.cjs [--output <new-directory>]');
  }
  const output = args.length ? path.resolve(args[1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'personalfiance-tools-ui-'));
  if (args.length) fs.mkdirSync(output, { recursive: false });
  const report = { scope: 'actual tools.html integration; existing local data; no market/provider acquisition',
    sourceIdentity: { root: ROOT, head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), status: git(['status', '--porcelain=v1', '--untracked-files=all']) },
    runtime: { node: process.version, platform: process.platform, chromiumSandbox: true },
    cases: [], console: { error: [], warning: [], pageerror: [] }, requests: [],
    artifacts: { report: path.join(output, 'report.json') },
    limitations: ['Existing committed data for normal flows; labeled malformed-payload fixtures only for explicit faults.',
      'Synthetic pagehide/pageshow exercises handler ownership, not proof of native browser back/forward cache.',
      'No ECharts canvas on tools.html; native table heatmap. Existing 72-page dashboard breadth is outside this probe.',
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
      if (sources.has(file)) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript';
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); response.end(sources.get(file));
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
    page.on('response', response => { if (response.url().startsWith(base + '/')) responses.push(response); });
    await page.route('**/*', async route => {
      if (route.request().url().startsWith(base + '/')) await route.continue();
      else { report.requests.push({ url: route.request().url(), error: 'External request forbidden' }); await route.abort(); }
    });
    await page.goto(base + '/tools.html');
    await page.waitForFunction(() => !document.querySelector('#leverage-controls').disabled);
    report.artifacts.before = path.join(output, 'before-desktop.png');
    await page.screenshot({ path: report.artifacts.before, fullPage: true });
    await scenario(CASES[0], async () => {
      assert.equal(await page.title(), '研究工具 · PersonalFiance');
      assert.equal(await page.locator('a[href="index.html"]').count(), 1);
      assert.equal(await page.locator('#leverage-result .info-table tbody tr').count(), 5);
      assert.match(await page.locator('#leverage-result').innerText(), /不隨上方回測區間裁切/);
      assert.ok(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('href="tools.html"'));
    });
    await scenario(CASES[1], async () => {
      await page.getByLabel('新群組名稱', { exact: false }).fill('<img src=x onerror=alert(1)>');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      assert.equal(await page.locator('#watchlist-host img').count(), 0);
      await page.getByLabel('群組名稱', { exact: true }).fill('核心觀察');
      await page.getByRole('button', { name: '重新命名', exact: true }).click();
      await page.getByLabel('加入標的', { exact: false }).selectOption('QQQ');
      await page.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByRole('button', { name: 'QQQ (QQQ)', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#quote-status').textContent.includes('觀測日期'));
      assert.match(await page.locator('#quote-result').innerText(), /close 原值/);
      assert.equal(await page.locator('#quote-title').evaluate(el => el === document.activeElement), true);
      await page.getByRole('button', { name: '移除', exact: false }).click();
      assert.equal(await page.getByRole('button', { name: 'QQQ (QQQ)', exact: true }).count(), 0);
      await page.getByLabel('加入標的', { exact: false }).selectOption('0050');
      await page.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByRole('button', { name: '0050 (0050)', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#quote-result a')?.getAttribute('href') === 'data/0050.TW.json');
      await page.getByLabel('新群組名稱', { exact: false }).fill('暫時群組');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      await page.getByRole('button', { name: '刪除群組 暫時群組', exact: true }).click();
      assert.equal(await page.getByRole('heading', { name: '暫時群組', exact: true }).count(), 0);
    });
    await scenario(CASES[2], async () => {
      await page.reload(); await page.waitForFunction(() => !document.querySelector('#leverage-controls').disabled);
      assert.equal(await page.getByRole('heading', { name: '核心觀察', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '0050 (0050)', exact: true }).count(), 1);
    });
    await scenario(CASES[3], async () => {
      await page.evaluate(() => localStorage.setItem('pf:watchlists:v1', '{bad'));
      await page.reload(); await page.waitForFunction(() => !document.querySelector('#leverage-controls').disabled);
      await page.getByLabel('新群組名稱', { exact: false }).fill('本次畫面');
      await page.getByRole('button', { name: '建立群組', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('pf:watchlists:v1')), '{bad');
      assert.match(await page.locator('#watchlist-host [role="status"]').innerText(), /原儲存內容不改寫/);
    });
    await scenario(CASES[4], async () => {
      await page.getByRole('button', { name: '載入明確標示的合成示範', exact: true }).click();
      assert.match(await page.locator('#monthly-result h3').innerText(), /合成示範/);
      const payload = {schemaVersion:1,kind:'supplied',source:'QA supplied fixture',basis:'explicit fixture only',calculationLabel:'precomputed supplied values',rows:[
        {month:'2026-01',returnPct:1.234567,partial:true,from:'endpoint-a',to:'endpoint-b'},
        {month:'2026-02',returnPct:0,partial:false},{month:'2026-03',returnPct:null,partial:false}]};
      await page.locator('#monthly-json').fill(JSON.stringify(payload));
      await page.getByRole('button', { name: '呈現資料', exact: true }).click();
      await page.locator('#monthly-result button[data-month="2026-01"]').click();
      assert.match(await page.locator('#monthly-result [role="status"]').innerText(), /1.234567.*endpoint-a → endpoint-b/);
      assert.match(await page.locator('#monthly-result button[data-month="2026-02"]').innerText(), /0.00%/);
      assert.match(await page.locator('#monthly-result button[data-month="2026-03"]').getAttribute('aria-label'), /提供 null/);
      assert.match(await page.locator('#monthly-result button[data-month="2026-04"]').getAttribute('aria-label'), /未提供/);
      await page.locator('#monthly-json').fill('{bad'); await page.getByRole('button', { name: '呈現資料', exact: true }).click();
      assert.match(await page.locator('#monthly-status').innerText(), /無法呈現/);
      assert.equal(await page.locator('#monthly-result > *').count(), 0);
      assert.equal(await page.locator('#monthly-json').inputValue(), '{bad');
      await page.getByRole('button', { name: '清除輸入與結果', exact: true }).click();
      assert.equal(await page.locator('#monthly-json').inputValue(), '');
      assert.equal(await page.locator('#monthly-json').evaluate(el => el === document.activeElement), true);
    });
    await scenario(CASES[5], async () => {
      await page.route('**/data/leverage.json', route => route.fulfill({status:200,headers:{'content-type':'application/json','x-qa-fixture':'malformed-bundle'},body:'{}'}));
      try {
        await page.locator('#leverage-retry').click();
        await page.waitForFunction(() => document.querySelector('#leverage-status').textContent.includes('不可用'));
        // fieldset owns the native disabled property; check its descendant control too.
        assert.equal(await page.locator('#leverage-controls').evaluate(el => el.disabled), true);
        assert.equal(await page.locator('#leverage-etf').isDisabled(), true);
        assert.equal(await page.locator('#leverage-result > *').count(), 0);
      } finally { await page.unroute('**/data/leverage.json'); }
      await page.locator('#leverage-retry').click();
      await page.waitForFunction(() => !document.querySelector('#leverage-controls').disabled);
      await page.locator('#leverage-form input[name="from"]').fill('1900-01-01');
      await page.locator('#leverage-form input[name="to"]').fill('1900-01-02');
      await page.getByRole('button', { name: '更新診斷', exact: true }).click();
      assert.match(await page.locator('#leverage-result').innerText(), /此區間無足夠資料/);
      assert.equal(await page.locator('#leverage-result .info-table tbody tr').count(), 5);
      await page.locator('#leverage-form input[name="from"]').fill(''); await page.locator('#leverage-form input[name="to"]').fill('');
      await page.getByRole('button', { name: '更新診斷', exact: true }).click();
      await page.locator('#leverage-etf').selectOption('TQQQ'); await page.getByRole('button', { name: '更新診斷', exact: true }).click();
      assert.match(await page.locator('#leverage-result h3').innerText(), /TQQQ/);
    });
    await scenario(CASES[6], async () => {
      await page.locator('#quote-symbol').selectOption('QQQ');
      await page.route('**/data/QQQ.json', route => route.fulfill({status:200,headers:{'content-type':'application/json','x-qa-fixture':'empty-price'},body:'{"data":[]}'}));
      await page.getByRole('button', { name: '查看／重試', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#quote-status').textContent.includes('無可用價格'));
      assert.equal(await page.locator('#quote-result > *').count(), 0);
      await page.unroute('**/data/QQQ.json'); await page.getByRole('button', { name: '查看／重試', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#quote-status').textContent.includes('觀測日期'));
    });
    await scenario(CASES[12], async () => {
      await page.waitForFunction(() => document.querySelector('#taiwan-result [role="status"]').textContent.includes('已讀取 6'));
      assert.equal(await page.locator('#taiwan-result tbody tr').count(), 6);
      const newest = file => JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8')).data.at(-1);
      const money = JSON.parse(fs.readFileSync(path.join(ROOT,'data/taiwan_money_supply.json'),'utf8'));
      const monthly = money.monthly.at(-1);
      for (const [key,value,date,unit] of [
        ['twii',newest('data/TWII.json').close,newest('data/TWII.json').date,'點'],
        ['maintenance',newest('data/taiwan_margin_ratio.json').ratio,newest('data/taiwan_margin_ratio.json').date,'%'],
        ['margin',newest('data/taiwan_margin_total.json').margin_money,newest('data/taiwan_margin_total.json').date,'新臺幣億元'],
        ['m1b',monthly.m1b_yoy,monthly.date.slice(0,7),'%'],
        ['m2',monthly.m2_yoy,monthly.date.slice(0,7),'%'],
        ['spread',monthly.spread,monthly.date.slice(0,7),'百分點'],
      ]) {
        const cells = page.locator(`#taiwan-result tr[data-metric="${key}"] td`);
        assert.equal(await cells.nth(0).innerText(),String(value));
        assert.equal(await cells.nth(1).innerText(),unit);
        assert.ok((await cells.nth(2).innerText()).startsWith(date));
      }
      assert.equal(await page.locator('#taiwan-result tr[data-metric="m1b"] td').nth(3).innerText(),money.updated);
      assert.match(await page.locator('#taiwan-result tr[data-metric="maintenance"]').innerText(),/上市融資多頭.*重建代理/s);
      assert.match(await page.locator('#taiwan-result tr[data-metric="m1b"]').innerText(),/月頻期底.*非日平均/s);
      assert.match(await page.locator('#taiwan-result').innerText(),/官方整戶維持率.*尚未接入/);
      assert.equal(await page.locator('a[href="docs/references/taiwan-observations.md"]').count(),1);
    });
    await scenario(CASES[13], async () => {
      const button = page.getByRole('button',{name:'重新讀取台灣觀察快照',exact:true});
      await page.route('**/data/taiwan_money_supply.json', route => route.fulfill({status:200,headers:{'content-type':'application/json','x-qa-fixture':'empty-monthly'},body:'{"monthly":[],"annual":[{"date":"2025-12-31","freq":"annual","m1b_yoy":99,"m2_yoy":0,"spread":99}]}'}));
      await button.click();
      await page.waitForFunction(() => document.querySelector('#taiwan-result [role="status"]').textContent.includes('可用 3／6'));
      assert.equal(await page.locator('#taiwan-result tr[data-metric="m1b"] td').nth(0).innerText(),'—');
      assert.notEqual(await page.locator('#taiwan-result tr[data-metric="twii"] td').nth(0).innerText(),'—');
      await page.unroute('**/data/taiwan_money_supply.json');
      const fixture={updated:'fixture save stamp',monthly:[{date:'2025-02-01',freq:'monthly',m1b_yoy:7.18,m2_yoy:6.92,spread:-0.26}]};
      await page.route('**/data/taiwan_money_supply.json', route => route.fulfill({status:200,headers:{'content-type':'application/json','x-qa-fixture':'opposite-spread'},body:JSON.stringify(fixture)}));
      await button.click();
      await page.waitForFunction(() => document.querySelector('#taiwan-result [role="status"]').textContent.includes('可用 5／6'));
      assert.equal(await page.locator('#taiwan-result tr[data-metric="m1b"] td').nth(0).innerText(),'7.18');
      assert.equal(await page.locator('#taiwan-result tr[data-metric="spread"] td').nth(0).innerText(),'—');
      assert.match(await page.locator('#taiwan-result tr[data-metric="spread"]').innerText(),/不一致/);
      await page.unroute('**/data/taiwan_money_supply.json');
      await page.route('**/data/TWII.json', route => route.fulfill({status:200,headers:{'content-type':'application/json','x-qa-fixture':'latest-null-index'},body:'{"updated":"fixture","data":[{"date":"2025-03-20","close":123},{"date":"2025-03-21","close":null}]}'}));
      await button.click();
      await page.waitForFunction(() => document.querySelector('#taiwan-result [role="status"]').textContent.includes('可用 5／6'));
      assert.equal(await page.locator('#taiwan-result tr[data-metric="twii"] td').nth(0).innerText(),'—');
      assert.match(await page.locator('#taiwan-result tr[data-metric="twii"]').innerText(),/2025-03-21.*null/s);
      await page.unroute('**/data/TWII.json'); await button.click();
      await page.waitForFunction(() => document.querySelector('#taiwan-result [role="status"]').textContent.includes('已讀取 6'));
    });
    await scenario(CASES[7], async () => {
      await page.locator('#tools-theme').click(); assert.equal(await page.locator('body').evaluate(el => el.classList.contains('dark')), true);
      await page.getByRole('button', { name: '載入明確標示的合成示範', exact: true }).click();
      for (const [width,height] of [[390,844],[844,390],[390,320]]) {
        await page.setViewportSize({width,height});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const boxes = await page.locator('button:visible').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
        assert.ok(boxes.every(height => height >= 44));
      }
      report.artifacts.mobile = path.join(output,'after-mobile-short.png'); await page.screenshot({path:report.artifacts.mobile,fullPage:true});
      await page.setViewportSize({width:1280,height:900}); report.artifacts.desktop = path.join(output,'after-desktop.png'); await page.screenshot({path:report.artifacts.desktop,fullPage:true});
    });
    await scenario(CASES[8], async () => {
      await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); });
      await page.waitForFunction(() => !document.querySelector('#leverage-controls').disabled);
      assert.equal(await page.getByRole('heading',{name:'本次畫面',exact:true}).count(),1);
      assert.equal(await page.evaluate(() => localStorage.getItem('pf:watchlists:v1')), '{bad');
      assert.equal(await page.locator('body').evaluate(el => el.classList.contains('dark')), true);
      assert.match(await page.locator('#monthly-result h3').innerText(), /合成示範/);
      await page.getByLabel('新群組名稱',{exact:false}).fill('只有一組handler');
      await page.getByRole('button',{name:'建立群組',exact:true}).click();
      assert.equal(await page.getByRole('heading',{name:'只有一組handler',exact:true}).count(),1);
    });
    await scenario(CASES[9], async () => {
      assert.match(await page.locator('#macro-result').innerText(), /unavailable/);
      assert.equal(await page.locator('#macro-result a').count(),3);
      assert.equal(await page.locator('#macro-result table').count(),0);
    });
    await scenario(CASES[10], async () => {
      const actual = {}, fixtures = [];
      for (const response of responses) {
        const file = new URL(response.url()).pathname.slice(1);
        if ((await response.allHeaders())['x-qa-fixture']) { fixtures.push({file,fixture:(await response.allHeaders())['x-qa-fixture']}); continue; }
        actual[file] = sha(await response.body()); assert.equal(actual[file],sha(fs.readFileSync(path.join(ROOT,file))),file);
      }
      assert.deepEqual(Object.keys(actual).sort(),[...MODULES].sort());
      report.sourceIdentity.httpHashes=actual; report.injectedFixtures=fixtures;
    });
    await scenario(CASES[11], async () => { assert.deepEqual(report.console,{error:[],warning:[],pageerror:[]}); assert.deepEqual(report.requests,[]); });
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
