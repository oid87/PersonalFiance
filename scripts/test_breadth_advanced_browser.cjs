'use strict';
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const base = process.env.BREADTH_TEST_URL || 'http://127.0.0.1:8766';
(async()=>{
  const {makeAdvancedFixture} = await import(pathToFileURL(path.resolve(__dirname,'fixtures/breadth_advanced_fixture.mjs')).href);
  const fixture = makeAdvancedFixture();
  const browser = await chromium.launch({headless:true});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base,{waitUntil:'networkidle'});
    await page.locator('.cat-btn[data-cat="liquidity"]').click();await page.locator('[data-tab="breadth"]').click();
    const text = id => page.locator(`#breadth-advanced-${id}`).innerText();
    const chart = id => page.evaluate(id=>echarts.getInstanceByDom(document.getElementById(`breadth-advanced-${id}`))?.getOption()??null,id);
    const upload = async (data,name='input.json') => {await page.locator('#breadth-advanced-file').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(typeof data==='string'?data:JSON.stringify(data))});await page.waitForFunction(()=>!/讀取/.test(document.getElementById('breadth-advanced-status').textContent));};
    const empty = async () => {assert.equal(await page.locator('#breadth-advanced-results').isVisible(),false);assert.equal(await page.locator('#breadth-advanced-table tbody tr').count(),0);assert.equal(await page.locator('#breadth-advanced-events tbody tr').count(),0);for(const id of ['ad-chart','osc-chart','sum-chart','path-chart'])assert.equal(await chart(id),null);assert.equal(await text('metadata'),'');};
    assert.match(await text('status'),/等待匯入/);assert.equal(await page.locator('#breadth-advanced-results').isVisible(),false);await empty();
    const downloadPromise=page.waitForEvent('download');await page.locator('#breadth-advanced-template').click();const dl=await downloadPromise;assert.equal(dl.suggestedFilename(),'breadth-import-template.json');const template=JSON.parse(require('node:fs').readFileSync(await dl.path(),'utf8'));assert.equal(template.benchmark.data.length,0);assert.equal(template.sp500.data.length,0);assert.equal(template.nyse.data.length,0);assert.equal(template.nyse.seed,null);
    const projectAd={meta:{source:'PROJECT RAW META',constituentsBasis:'CURRENT',priceBasis:'ADJUSTED'},data:fixture.sp500.data.map(row=>({...row,total:row.advances+row.declines+row.unchanged}))};
    projectAd.data.push({date:'2099-01-01',advances:1,declines:1,unchanged:0,total:2});
    const projectPrices={data:fixture.benchmark.data};
    let projectMode='ok', releaseProject;
    await page.route('**/data/sp500_ad.json', async route=>{
      if(projectMode==='slow') await new Promise(resolve=>{releaseProject=resolve;});
      await route.fulfill(projectMode==='fail'?{status:503,body:'{}'}:{json:projectAd});
    });
    await page.route('**/data/SP500.json',route=>route.fulfill({json:projectPrices}));
    const waitProject=()=>page.waitForFunction(()=>!/載入專案/.test(document.getElementById('breadth-advanced-status').textContent));
    await page.locator('#breadth-advanced-project').click();await waitProject();
    assert.match(await text('status'),/已匯入/);assert.match(await text('metadata'),/PROJECT RAW META/);
    assert.match(await text('metadata'),/含倖存者偏誤，可能影響 A-D 線與事件日期/);assert.match(await text('metadata'),/丟棄 1 個/);
    // fetchJSON defaults still unwrap rows; raw mode retains the actual metadata envelope.
    assert.deepEqual(await page.evaluate(async()=>{const {fetchJSON}=await import('./js/utils/data.js');const rows=await fetchJSON('data/sp500_ad.json');const raw=await fetchJSON('data/sp500_ad.json',{raw:true});return {array:Array.isArray(rows),source:raw.meta.source,same:JSON.stringify(rows)===JSON.stringify(raw.data)};}),{array:true,source:'PROJECT RAW META',same:true});
    projectMode='fail';await page.locator('#breadth-advanced-project').click();await waitProject();assert.match(await text('status'),/匯入失敗.*503/);await empty();
    projectMode='slow';await page.locator('#breadth-advanced-project').click();
    while(!releaseProject)await page.waitForTimeout(10);
    const localWinner=structuredClone(fixture);localWinner.benchmark.source='LOCAL PROJECT RACE WINNER';await upload(localWinner,'project-race-local.json');
    releaseProject();await page.waitForTimeout(150);assert.match(await text('metadata'),/LOCAL PROJECT RACE WINNER/);assert.ok(!(await text('metadata')).includes('PROJECT RAW META'));
    projectMode='ok';await page.locator('#breadth-advanced-clear').click();
    await upload(fixture);assert.match(await text('status'),/已匯入/);assert.equal(await page.locator('#breadth-advanced-results').isVisible(),true);assert.match(await text('metadata'),/SYNTHETIC TEST ONLY/);
    for(const signal of ['ad','mc','joint']) {
      await page.selectOption('#breadth-advanced-signal',signal);
      assert.equal(await page.locator('#breadth-advanced-table tbody tr').count(),7);
      assert.ok(await page.locator('#breadth-advanced-events tbody tr').count()>0,signal);
      for(const horizon of [5,10,21,42,63,126,252]) {
        await page.selectOption('#breadth-advanced-horizon',String(horizon));
        assert.equal((await chart('path-chart')).xAxis[0].data.length,horizon+1);
      }
      const parity=await page.evaluate(async ({fixture,signal})=>{
        const {buildAdvancedContext}=await import('./js/tabs/breadthAdvanced.mjs');
        const {evaluateEventStudy}=await import('./js/utils/eventStudy.mjs');
        const c=buildAdvancedContext(fixture);
        return evaluateEventStudy({prices:c.prices,events:c.signals[signal],eligibleDates:c.eligibleDates[signal],pathHorizon:252}).stats;
      },{fixture,signal});
      for(const s of parity){const cells=await page.locator(`#breadth-advanced-table tr[data-horizon="${s.horizon}"] td`).allTextContents();assert.equal(+cells[1],s.n);assert.equal(cells[2],s.mean===null?'—':`${s.mean.toFixed(2)}%`);assert.equal(+cells[9],s.baseline.n);assert.equal(+cells[17],s.excluded.incomplete);}
    }
    const jointDates=await page.locator('#breadth-advanced-events tbody tr').allTextContents();assert.ok(jointDates.some(s=>s.includes('202')));
    await page.locator('#breadth-advanced-events button').first().click();assert.match(await text('selection'),/選取/);
    await page.locator('#breadth-advanced-events button').last().click();assert.match(await text('selection'),/未完成或缺價/);
    const series=(await chart('path-chart')).series.at(-1).data, gap=series.indexOf(null);assert.ok(gap>=0);assert.ok(series.slice(gap).every(v=>v===null));
    for(const range of ['2Y','5Y','MAX']){await page.selectOption('#breadth-advanced-range',range);assert.equal(await page.locator('#breadth-advanced-table tbody tr').count(),7);}
    const before=await text('study-status'), metadata=await text('metadata');await page.locator('[data-breadth-universe="NDX"]').click();await page.waitForTimeout(250);assert.equal(await text('study-status'),before);assert.equal(await text('metadata'),metadata);
    for (const theme of ['dark','light']) {
      const current=await page.evaluate(()=>document.body.classList.contains('light')?'light':'dark');
      if(current!==theme) await page.locator('#theme-btn').click();
      assert.equal(await text('study-status'),before);assert.ok(await chart('ad-chart'));
      assert.equal(await page.evaluate(()=>document.body.classList.contains('light')),theme==='light');
      await page.locator('#breadth-advanced-panel').screenshot({path:`/tmp/breadth-p3p4p5-panel-${theme}.png`});
    }
    assert.equal((await chart('sum-chart')).series[0].markLine.data[0].label.position,'insideEndTop');
    assert.equal((await chart('path-chart')).yAxis[0].scale,true);
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);const dims=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dims.scroll<=dims.width+1,JSON.stringify(dims));
    await page.screenshot({path:'/tmp/breadth-p3p4p5-mobile.png',fullPage:true});
    await page.locator('#breadth-advanced-panel').screenshot({path:'/tmp/breadth-p3p4p5-panel-mobile.png'});
    await upload('{');assert.match(await text('status'),/匯入失敗/);await empty();
    await upload(fixture);await page.locator('#breadth-advanced-clear').click();assert.match(await text('status'),/等待匯入/);await empty();
    await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){if(this.name==='slow.json')return new Promise(resolve=>{window.releaseAdvanced=()=>original.call(this).then(resolve);});return original.call(this);};});
    await page.locator('#breadth-advanced-file').setInputFiles({name:'slow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
    const fast=structuredClone(fixture);fast.benchmark.source='FAST RACE WINNER';await upload(fast,'fast.json');await page.evaluate(()=>window.releaseAdvanced());await page.waitForTimeout(150);assert.match(await text('metadata'),/FAST RACE WINNER/);
    await page.locator('#breadth-advanced-file').setInputFiles({name:'slow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.locator('#breadth-advanced-clear').click();await page.evaluate(()=>window.releaseAdvanced());await page.waitForTimeout(150);await empty();
    await page.evaluate(()=>{const file=new File(['{}'],'oversize.json');Object.defineProperty(file,'size',{value:10*1024*1024+1});const input=document.getElementById('breadth-advanced-file'),dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change'));});assert.match(await text('status'),/10 MiB/);await empty();
    const adOnly=structuredClone(fixture);delete adOnly.nyse;await upload(adOnly);await page.selectOption('#breadth-advanced-signal','ad');assert.ok(await page.locator('#breadth-advanced-events tbody tr').count()>0);await page.selectOption('#breadth-advanced-signal','joint');assert.match(await text('study-status'),/停用/);assert.match(await text('study-status'),/P5 無法研究/);assert.equal(await page.locator('#breadth-advanced-events tbody tr').count(),0);
    const mcOnly=structuredClone(fixture);delete mcOnly.sp500;await upload(mcOnly);await page.selectOption('#breadth-advanced-signal','mc');assert.ok(await page.locator('#breadth-advanced-events tbody tr').count()>0);await page.selectOption('#breadth-advanced-signal','ad');assert.match(await text('study-status'),/P3 無法研究/);assert.equal(await page.locator('#breadth-advanced-events tbody tr').count(),0);
    const unseeded=structuredClone(fixture);unseeded.nyse.seed=null;await upload(unseeded);await page.selectOption('#breadth-advanced-signal','mc');assert.match(await text('study-status'),/停用/);assert.equal(await page.locator('#breadth-advanced-events tbody tr').count(),0);assert.ok(!(await chart('sum-chart')).series[0].markLine);
    const gapData=structuredClone(fixture);gapData.nyse.data[600].advances=null;gapData.nyse.data[600].declines=null;gapData.nyse.data[600].unchanged=null;await upload(gapData);assert.match(await text('metadata'),/缺口使當天及後續計算停止/);const sums=(await chart('sum-chart')).series[0].data;assert.ok(sums.slice(600).every(v=>v===null));
    const attack=structuredClone(fixture);attack.benchmark.source='<img src=x onerror="window.advancedInjected=true">';await upload(attack);assert.match(await text('metadata'),/<img/);assert.equal(await page.locator('#breadth-advanced-metadata img').count(),0);assert.equal(await page.evaluate(()=>window.advancedInjected),undefined);
    for(const mutate of [b=>b.nyse.variant='unknown',b=>b.benchmark.symbol='SPY',b=>b.sp500.data[0].advances='1']){const bad=structuredClone(fixture);mutate(bad);await upload(bad);assert.match(await text('status'),/匯入失敗/);await empty();}
    assert.deepEqual(errors,[]);
    const cold=await browser.newPage();cold.on('pageerror',e=>errors.push(e.message));await cold.route('**/data/breadth.json',route=>route.fulfill({status:503,body:'{}'}));await cold.goto(base,{waitUntil:'networkidle'});await cold.locator('.cat-btn[data-cat="liquidity"]').click();await cold.locator('[data-tab="breadth"]').click();await cold.locator('#breadth-retry').waitFor({state:'visible'});await cold.locator('#breadth-advanced-file').setInputFiles({name:'cold.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await cold.waitForFunction(()=>document.getElementById('breadth-advanced-status').textContent.includes('已匯入'));assert.equal(await cold.locator('#breadth-advanced-table tbody tr').count(),7);await cold.close();assert.deepEqual(errors,[]);
    console.log(JSON.stringify({pass:true,checks:'project success/503/local-file race; fetchJSON raw/default; empty/template/import; 3 signals/7 horizons parity; quantile paths; invalid clearing; clear/oversize; races; individual universes; seed/gap gates; metadata XSS; universe independence; theme/mobile; P1 failure independence; pageerror-free',screenshot:'/tmp/breadth-p3p4p5-mobile.png'}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
