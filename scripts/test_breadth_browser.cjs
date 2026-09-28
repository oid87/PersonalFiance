'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const base = process.env.BREADTH_TEST_URL || 'http://127.0.0.1:8766';
async function openBreadth(page) {
  await page.goto(base, {waitUntil:'networkidle'});
  await page.locator('.cat-btn[data-cat="liquidity"]').click();
  await page.locator('[data-tab="breadth"]').click();
}
async function ready(page, label) {
  await page.waitForFunction(label => document.getElementById('breadth-status').textContent.includes(label) && document.getElementById('breadth-status').textContent.includes('共同可用日期'), label);
}
async function option(page) { return page.evaluate(() => echarts.getInstanceByDom(document.getElementById('breadth-chart')).getOption()); }
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = []; page.on('pageerror',error => errors.push(error.message));
    await openBreadth(page); await ready(page,'S&P 500');
    for (const [universe,label,ticker] of [['SP500','S&P 500','SPY'],['NDX','Nasdaq-100','QQQ'],['XLG','市值前50代理股票群','XLG'],['TW50','台灣50','0050']]) {
      await page.locator(`[data-breadth-universe="${universe}"]`).click(); await ready(page,label);
      for (const ma of [20,50,200]) {
        await page.locator(`[data-breadth-ma="${ma}"]`).click();
        const opt = await option(page);
        assert.equal(opt.series[0].name,ticker); assert.equal(opt.series[1].name,`${ticker} ${ma}MA`);
        assert.equal(await page.locator('#breadth-study-table tbody tr').count(),7);
      }
    }
    await page.locator('[data-breadth-universe="SP500"]').click(); await ready(page,'S&P 500');
    await page.locator('[data-breadth-ma="50"]').click();
    const oracle = await page.evaluate(async () => {
      const {buildBreadthContext} = await import('./js/tabs/breadthSignals.mjs');
      const {evaluateEventStudy} = await import('./js/utils/eventStudy.mjs');
      const [b,p] = await Promise.all(['breadth.json','SPY.json'].map(async name => (await fetch(`data/${name}`)).json()));
      const c = buildBreadthContext(b.data,p.data,50);
      return evaluateEventStudy({prices:p.data,events:c.signals.down,eligibleDates:c.eligibleDates}).stats;
    });
    for (const stat of oracle) {
      const cells = await page.locator(`#breadth-study-table tr[data-horizon="${stat.horizon}"] td`).allTextContents();
      assert.equal(+cells[1],stat.n); assert.equal(cells[2],stat.mean === null ? '—' : `${stat.mean.toFixed(2)}%`);
      assert.equal(cells[6],stat.baseline.mean === null ? '—' : `${stat.baseline.mean.toFixed(2)}%`);
      assert.equal(cells[9],stat.mean === null || stat.baseline.mean === null ? '—' : (stat.mean-stat.baseline.mean).toFixed(2));
    }
    const statusBefore = await page.locator('#breadth-study-status').innerText();
    await page.locator('[data-breadth-range="1Y"]').click();
    assert.equal(await page.locator('#breadth-study-status').innerText(),statusBefore);
    for (const signal of ['down','up','divergence']) for (const range of ['MAX','5Y','2Y']) {
      await page.selectOption('#breadth-study-signal',signal); await page.selectOption('#breadth-study-range',range);
      for (const horizon of ['5','10','21','42','63','126','252']) {
        await page.selectOption('#breadth-study-horizon',horizon);
        assert.match(await page.locator('#breadth-study-status').innerText(),new RegExp(`${horizon}交易日有效`));
        const paths = await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('breadth-study-chart')).getOption());
        assert.equal(paths.xAxis[0].data.length,+horizon+1);
      }
    }
    await page.selectOption('#breadth-study-signal','down'); await page.selectOption('#breadth-study-range','MAX'); await page.selectOption('#breadth-study-horizon','63');
    const first = page.locator('#breadth-study-events button').first();
    if (await first.count()) { await first.click(); assert.match(await page.locator('#breadth-study-selection').innerText(),/選取/); }
    await page.locator('#breadth-vix-toggle').click(); await page.locator('#breadth-fg-toggle').click();
    await page.waitForFunction(() => /VIX：\d/.test(document.getElementById('breadth-status').textContent) && /F&G：\d/.test(document.getElementById('breadth-status').textContent));
    assert.ok((await option(page)).series.some(s => s.name === 'VIX')); assert.ok((await option(page)).series.some(s => s.name === 'F&G'));
    await page.locator('[data-breadth-range="MAX"]').click();
    const tooltip = await page.evaluate(() => {
      const chart=echarts.getInstanceByDom(document.getElementById('breadth-chart')),opt=chart.getOption();
      const legacy=opt.xAxis[0].data.findIndex(date => date < '2026-09-01');
      const date=opt.xAxis[0].data[legacy];
      return opt.tooltip[0].formatter([{axisValue:date,dataIndex:legacy,seriesIndex:5,seriesName:'研究保留訊號',value:[date,123],marker:''}]);
    });
    assert.match(tooltip,/200MA:.*分母未記錄/);
    const shots=[];
    for (const theme of ['dark','light']) {
      const current=await page.evaluate(() => document.body.classList.contains('light')?'light':'dark');
      if(current !== theme) await page.locator('#theme-btn').click();
      const shot=path.join(os.tmpdir(),`breadth-p1p2-${theme}.png`); await page.screenshot({path:shot,fullPage:true});shots.push(shot);
      assert.equal(await page.evaluate(() => Boolean(echarts.getInstanceByDom(document.getElementById('breadth-study-chart')))),true);
    }
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(600);
    const mobileWidth = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,x:scrollX,body:document.body.getBoundingClientRect().toJSON(),tab:document.getElementById('tab-breadth').getBoundingClientRect().toJSON(),items:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('.breadth-table-scroll')).map(e=>({id:e.id,cls:e.className,right:e.getBoundingClientRect().right,width:e.clientWidth})).slice(0,35)}));
    assert.ok(mobileWidth.scroll <= mobileWidth.width+1,JSON.stringify(mobileWidth));
    const mobile=path.join(os.tmpdir(),'breadth-p1p2-mobile.png'); await page.screenshot({path:mobile,fullPage:true});shots.push(mobile);
    assert.deepEqual(errors,[]);

    for (const failure of ['503','empty','price503']) {
      const cold=await browser.newPage(); let fail=true;
      const file=failure === 'price503' ? 'SPY.json' : 'breadth.json';
      await cold.route(`**/data/${file}`,route => fail ? route.fulfill({status:failure==='empty'?200:503,contentType:'application/json',body:failure==='empty'?' {"data":[]}':'{}'}) : route.continue());
      await openBreadth(cold); await cold.locator('#breadth-retry').waitFor({state:'visible'});
      assert.equal(await cold.locator('#breadth-study-table tbody tr').count(),0);
      fail=false;await cold.locator('#breadth-retry').click();await ready(cold,'S&P 500');await cold.close();
    }
    const fixture=await browser.newPage();
    const fixturePrices=Array.from({length:360},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),close:100+i/10}));
    // Deterministic crossings, an incomplete tail and a price gap exercise individual paths.
    fixturePrices[345].close=null;
    const fixtureRows=fixturePrices.map((p,i)=>({date:p.date,above20_pct:i%30<15?60:40,above50_pct:i%30<15?60:40,above200_pct:i%30<15?60:40,total:50,above50_count:i%30<15?30:20,above200_count:i%30<15?30:20}));
    await fixture.route('**/data/breadth.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:fixtureRows})}));
    await fixture.route('**/data/SPY.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:fixturePrices})}));
    await openBreadth(fixture);await ready(fixture,'S&P 500');
    await fixture.locator('#breadth-study-events button').first().click();
    assert.match(await fixture.locator('#breadth-study-selection').innerText(),/未完成或缺價/);
    const partial=await fixture.evaluate(()=>echarts.getInstanceByDom(document.getElementById('breadth-study-chart')).getOption().series.at(-1).data);
    const firstNull=partial.indexOf(null);assert.ok(firstNull>=0);assert.ok(partial.slice(firstNull).every(v=>v===null));
    await fixture.locator('#breadth-study-events button').last().click();
    const fixed=await fixture.evaluate(()=>echarts.getInstanceByDom(document.getElementById('breadth-study-chart')).getOption().series);
    assert.equal(fixed.at(-1).data[0],100);assert.equal(fixed.at(-1).data.length,64);
    await fixture.selectOption('#breadth-study-horizon','252');
    const bandCounts=await fixture.evaluate(async()=>{
      const {buildBreadthContext}=await import('./js/tabs/breadthSignals.mjs');
      const {evaluateEventStudy}=await import('./js/utils/eventStudy.mjs');
      const [b,p]=await Promise.all(['breadth.json','SPY.json'].map(async name=>(await fetch(`data/${name}`)).json()));
      const c=buildBreadthContext(b.data,p.data,50),s=evaluateEventStudy({prices:p.data,events:c.signals.down,eligibleDates:c.eligibleDates,pathHorizon:252});
      return {n:s.paths.n,counts:s.paths.points.map(p=>p.n),medians:s.paths.points.map(p=>p.median),shown:echarts.getInstanceByDom(document.getElementById('breadth-study-chart')).getOption().series[2].data};
    });
    assert.ok(bandCounts.counts.every(n=>n===bandCounts.n));assert.deepEqual(bandCounts.shown,bandCounts.medians);
    await fixture.locator('[data-breadth-ma="200"]').click();
    assert.match(await fixture.locator('#breadth-study-status').innerText(),/有效 n=0/);
    assert.match(await fixture.locator('#breadth-study-table tr[data-horizon="252"]').innerText(),/—/);
    assert.equal(await fixture.evaluate(()=>echarts.getInstanceByDom(document.getElementById('breadth-study-chart')).getOption().graphic[0].elements[0].style.text),'無完整事件可計算分位帶');
    await fixture.close();
    const race=await browser.newPage(); await openBreadth(race); await ready(race,'S&P 500');
    let release; const hold=new Promise(resolve => { release=resolve; });
    await race.route('**/data/breadth_ndx.json',async route => { await hold; await route.continue(); });
    await race.locator('[data-breadth-universe="NDX"]').click();
    await race.locator('[data-breadth-universe="TW50"]').click(); await ready(race,'台灣50'); release();
    await race.waitForTimeout(500); assert.equal((await option(race)).series[0].name,'0050');
    assert.match(await race.locator('#breadth-status').innerText(),/^台灣50/);await race.close();
    console.log(JSON.stringify({pass:true,screenshots:shots,checks:'4 universes × 3 MA; 3 signals × 3 ranges × 7 horizons; core parity; overlays; tooltip; themes; mobile; 503/empty/retry; async race'}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
