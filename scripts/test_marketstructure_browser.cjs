// Same Playwright setup/env as smoke_tabs.cjs. Exercises real UI, partial outages and retry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.argv[2] || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const unhandled = [];
  page.on('pageerror', e => unhandled.push(e.message));
  const checks = [];
  async function settled() {
    await page.waitForFunction(() => !document.querySelector('#marketstructure-overall-status').textContent.includes('正在更新'), undefined, { timeout: 20000 });
  }
  async function refresh() {
    await page.locator('#marketstructure-retry').click();
    await settled();
  }
  async function option(id) {
    return page.evaluate(id => echarts.getInstanceByDom(document.getElementById(id)).getOption(), id);
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('[data-cat="analysis"]').click();
    await page.locator('[data-tab="marketstructure"]').click();
    await settled();
    for (const id of ['cftc', 'cboe', 'liquidity', 'aaii', 'vix', 'putcall']) {
      const status = page.locator(`#marketstructure-${id}-status`);
      assert.ok(!/is-error|is-loading/.test(await status.getAttribute('class')), `${id} must contain current data`);
    }
    checks.push('primary sources load');
    for (const id of ['sp500', 'nasdaq100', 'russell2000']) {
      await page.locator(`[data-ms-cot="${id}"]`).click();
      const o = await option('marketstructure-cot-chart');
      assert.ok(o.series[0].data.length >= 156);
      const expected = {sp500:'S&P 500',nasdaq100:'Nasdaq-100',russell2000:'Russell 2000'}[id];
      assert.ok(o.series[0].name.includes(expected));
    }
    for (const id of ['vix', 'margin', 'aaii']) {
      await page.locator(`[data-ms-risk="${id}"]`).click();
      const o = await option('marketstructure-risk-chart');
      assert.ok(o.series[0].data.length > 0);
      assert.ok(o.series[0].data.every(p => typeof p[1] === 'number' && Number.isFinite(p[1])));
    }
    checks.push('all instrument/risk selectors');
    const before = (await option('marketstructure-options-chart')).series[0].data.length;
    await page.route('**/data/cboe_putcall.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await refresh();
    assert.match(await page.locator('#marketstructure-cboe-status').innerText(), /失敗|暫時|無法/);
    assert.ok((await option('marketstructure-risk-chart')).series[0].data.length > 0);
    assert.equal((await option('marketstructure-options-chart')).series[0].data.length, before);
    checks.push('503 preserves labeled cache and unaffected chart');
    await page.unroute('**/data/cboe_putcall.json');
    await refresh();
    assert.ok(!/is-error|is-stale/.test(await page.locator('#marketstructure-cboe-status').getAttribute('class')));
    checks.push('retry restores source');
    await page.route('**/data/cftc_positions.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await refresh();
    assert.match(await page.locator('#marketstructure-cftc-status').innerText(), /失敗|暫時|無法/);
    assert.ok(!(await page.locator('#marketstructure-overall-status').innerText()).includes('各資料區塊已更新'));
    await page.unroute('**/data/cftc_positions.json');
    await refresh();
    checks.push('malformed 200 response never reports fresh');
    for (let i=0; i<2; i++) { await page.locator('#theme-btn').click(); await page.waitForTimeout(100); }
    await page.setViewportSize({ width:390, height:844 });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => {
      const el=document.getElementById('tab-marketstructure');
      return el.scrollWidth<=window.innerWidth+2 && [...el.querySelectorAll('.ms-chart')].every(c=>c.clientWidth>0 && c.clientHeight>0);
    }));
    checks.push('theme and portrait layout');
    await page.screenshot({path:process.env.MARKET_SCREENSHOT || 'marketstructure-mobile.png',fullPage:true});
    // Cold-load failure: no cached Cboe data must produce an explicit empty chart, not a blank page.
    const cold = await browser.newPage();
    cold.on('pageerror', e => unhandled.push(e.message));
    await cold.route('**/data/cboe_putcall.json', route => route.fulfill({status:503,body:'unavailable'}));
    await cold.goto(url,{waitUntil:'networkidle'});
    await cold.locator('[data-cat="analysis"]').click();
    await cold.locator('[data-tab="marketstructure"]').click();
    await cold.waitForFunction(()=>!document.querySelector('#marketstructure-overall-status').textContent.includes('正在更新'));
    assert.match(await cold.locator('#marketstructure-cboe-status').innerText(),/無法取得/);
    assert.ok(await cold.evaluate(()=>echarts.getInstanceByDom(document.getElementById('marketstructure-risk-chart')).getOption().series[0].data.length>0));
    checks.push('cold partial outage keeps dashboard usable');
    await cold.close();
    assert.deepEqual(unhandled,[]);
    console.log(JSON.stringify({passed:checks.length,checks,unhandled},null,2));
    if(process.env.MARKET_TEST_OUTPUT)fs.writeFileSync(process.env.MARKET_TEST_OUTPUT,JSON.stringify({passed:checks.length,checks,unhandled},null,2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
