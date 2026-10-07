// Read-only publication probe. Self-test is explicitly not production acceptance.
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
  'published assets and data match exact checkout bytes',
  'actual tools entry five sections and dashboard link',
  'Taiwan six stored values dates units and proxy labels',
  'ephemeral group CRUD selection and reload persistence',
  'existing leverage diagnostics and period labels',
  'supplied and synthetic monthly raw null zero missing labels',
  'desktop mobile landscape layout and screenshots',
  'zero console errors warnings pageerrors and failed requests'
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['--no-optional-locks', ...args], {cwd:ROOT,encoding:'utf8'}).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
function options(argv) {
  const result = {};
  while (argv.length) {
    const key=argv.shift();
    assert(['--url','--expected-sha','--output','--self-test'].includes(key),'Unknown argument');
    assert(!(key in result),'Duplicate argument');
    result[key]=key==='--self-test' ? true : argv.shift();
    assert(result[key], 'Missing argument value');
  }
  assert(result['--output'],'--output <new-directory> is required');
  if(result['--self-test']) assert(!result['--url']&&!result['--expected-sha'],'Self-test cannot claim a production SHA/URL');
  else {
    assert(result['--url']==='https://personal-fiance-nine.vercel.app','Only authorized production alias is allowed');
    assert(/^[0-9a-f]{40}$/.test(result['--expected-sha']||''),'Expected full SHA is required');
  }
  return result;
}
async function waitVercel(expected, report) {
  const endpoint=`https://api.github.com/repos/oid87/PersonalFiance/commits/${expected}/status`;
  const deadline=Date.now()+8*60*1000;
  report.deployment={endpoint,expectedSha:expected,deadlineMs:8*60*1000,intervalMs:15000,polls:[]};
  while(Date.now()<deadline) {
    const headers={Accept:'application/vnd.github+json','User-Agent':'PersonalFiance-publication-QA','X-GitHub-Api-Version':'2022-11-28'};
    // Authentication is restricted to this exact GitHub API endpoint and never recorded.
    if(process.env.GITHUB_TOKEN) headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
    const response=await fetch(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(Math.min(15000,deadline-Date.now()))});
    assert.equal(response.status,200,'GitHub exact-commit status API failed');
    const payload=await response.json();assert.equal(payload.sha,expected,'Deployment status SHA mismatch');
    const statuses=payload.statuses.filter(s=>/^vercel(?:\b|$)/i.test(s.context));
    const proof={at:new Date().toISOString(),sha:payload.sha,combinedState:payload.state,statuses:statuses.map(s=>({context:s.context,state:s.state,targetUrl:s.target_url}))};
    report.deployment.polls.push(proof);
    if(statuses.some(s=>s.state==='failure'||s.state==='error')) throw new Error('Exact-commit Vercel status failed');
    if(statuses.length && statuses.every(s=>s.state==='success')) {report.deployment.accepted=proof;return;}
    await delay(Math.min(15000,Math.max(0,deadline-Date.now())));
  }
  throw new Error('Vercel exact-commit success status deadline exceeded');
}
async function main() {
  // Establish an artifact destination even when argument validation fails.
  const argv=process.argv.slice(2);const oi=argv.indexOf('--output');
  const output=oi>=0 && argv[oi+1] ? path.resolve(argv[oi+1]) : fs.mkdtempSync(path.join(os.tmpdir(),'pf-publication-error-'));
  if(!fs.existsSync(output)) fs.mkdirSync(output,{recursive:false});
  else if(oi>=0) throw new Error('Output directory must be new');
  const report={scope:'UNVALIDATED',sourceIdentity:{root:ROOT},runtime:{node:process.version,platform:process.platform,chromiumSandbox:true},cases:[],console:{error:[],warning:[],pageerror:[]},requests:[],artifacts:{report:path.join(output,'report.json')},limitations:['Focused tools page only; not the 72-page dashboard matrix.','Chromium emulation does not verify Safari, native IME, screen readers or real-device touch.','Client-only localStorage uses a fresh disposable context; no remote writes or provider acquisition.','Exact served bytes and existing stored data are checked, not independent market correctness.'],cleanup:{context:false,browser:false,server:false}};
  let browser,context,page,server;
  const pendingResponses=[];const allowedFiles=new Set([...MODULES,'index.html']);
  async function scenario(name,fn) {
    try {await fn();report.cases.push({name,status:'PASS'});}
    catch(error) {
      const item={name,status:'FAIL',error:String(error.stack||error)};report.cases.push(item);
      if(page&&!page.isClosed()) {
        try {item.screenshot=path.join(output,`failure-${report.cases.length}.png`);await page.screenshot({path:item.screenshot,fullPage:true});} catch(e){item.captureError=String(e);}
        try {item.state=path.join(output,`failure-${report.cases.length}-state.json`);fs.writeFileSync(item.state,JSON.stringify({url:page.url(),html:await page.content()},null,2));}catch(e){item.stateError=String(e);}
      }
    }
  }
  try {
    const opt=options([...argv]);report.scope=opt['--self-test']?'HARNESS_SELF_TEST':'PRODUCTION_POSTPUBLICATION';
    report.sourceIdentity={root:ROOT,head:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),branch:git(['branch','--show-current']),status:git(['status','--porcelain']),moduleHashes:Object.fromEntries([...allowedFiles].map(f=>[f,sha(fs.readFileSync(path.join(ROOT,f)))])),httpHashes:{},browserHttpHashes:{}};
    let base=opt['--url'];
    if(opt['--self-test']) {
      server=http.createServer((req,res)=>{
        const f=new URL(req.url,'http://127.0.0.1').pathname.slice(1);
        if(!['GET','HEAD'].includes(req.method)||!allowedFiles.has(f)){res.writeHead(403);res.end();return;}
        res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html; charset=utf-8':f.endsWith('.css')?'text/css; charset=utf-8':f.endsWith('.json')?'application/json':'text/javascript'});
        res.end(req.method==='HEAD'?undefined:fs.readFileSync(path.join(ROOT,f)));
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      base=`http://127.0.0.1:${server.address().port}`;
      report.deployment={skipped:true,reason:'HARNESS_SELF_TEST; no production claim'};
    } else {assert.equal(opt['--expected-sha'],report.sourceIdentity.head,'Expected SHA must equal checkout HEAD');await waitVercel(opt['--expected-sha'],report);}
    report.sourceIdentity.url=base;
    await scenario(CASES[0],async()=>{
      for(const f of allowedFiles) {
        const response=await fetch(`${base}/${f}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
        assert.equal(response.status,200,f);const digest=sha(Buffer.from(await response.arrayBuffer()));
        report.sourceIdentity.httpHashes[f]=digest;assert.equal(digest,report.sourceIdentity.moduleHashes[f],`Published byte mismatch: ${f}`);
      }
    });
    const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
    report.runtime.playwright=JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve(process.env.PLAYWRIGHT_MODULE||'playwright')),'package.json'),'utf8')).version;
    assert.equal(report.runtime.playwright,'1.58.0');report.runtime.executable=playwright.chromium.executablePath();
    assert(fs.existsSync(report.runtime.executable),'Pinned browser executable absent');
    browser=await playwright.chromium.launch({executablePath:report.runtime.executable,chromiumSandbox:true});report.runtime.browser=browser.version();
    context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'UTC',serviceWorkers:'block'});
    await context.tracing.start({screenshots:true,snapshots:true,sources:true});
    const origin=new URL(base).origin;
    await context.route('**/*',async route=>{
      const req=route.request();const url=new URL(req.url());
      if(url.origin!==origin||!['GET','HEAD'].includes(req.method())||!allowedFiles.has(url.pathname.slice(1))) {
        report.requests.push({url:req.url(),method:req.method(),error:'Unexpected origin, method or path'});await route.abort();return;
      }
      await route.continue();
    });
    page=await context.newPage();
    page.on('console',e=>{if(e.type()==='error')report.console.error.push(e.text());if(e.type()==='warning')report.console.warning.push(e.text());});
    page.on('pageerror',e=>report.console.pageerror.push(String(e)));
    page.on('requestfailed',req=>report.requests.push({url:req.url(),error:req.failure()?.errorText}));
    page.on('response',response=>{
      if(new URL(response.url()).origin===origin) pendingResponses.push((async()=>{
        const f=new URL(response.url()).pathname.slice(1);assert.equal(response.status(),200,f);const h=sha(await response.body());
        report.sourceIdentity.browserHttpHashes[f]=h;assert.equal(h,report.sourceIdentity.moduleHashes[f],`Browser byte mismatch: ${f}`);
      })().then(()=>null,error=>String(error)));
    });
    await page.goto(base+'/tools.html');await page.waitForFunction(()=>!document.querySelector('#leverage-controls').disabled);
    await scenario(CASES[1],async()=>{
      assert.equal(await page.title(),'研究工具 · PersonalFiance');assert.equal(await page.locator('a[href="index.html"]').count(),1);
      for(const id of ['taiwan','watchlists','diagnostics','monthly','macro']) assert.equal(await page.locator(`section#${id}`).count(),1);
      assert(fs.readFileSync(path.join(ROOT,'index.html'),'utf8').includes('href="tools.html"'));
      assert.equal(report.sourceIdentity.httpHashes['index.html'],sha(fs.readFileSync(path.join(ROOT,'index.html'))));
    });
    await scenario(CASES[2], async () => {
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

    await scenario(CASES[3],async()=>{
      assert.equal(await page.evaluate(()=>localStorage.getItem('pf:watchlists:v1')),null);
      await page.getByLabel('新群組名稱',{exact:false}).fill('發布驗證暫存');await page.getByRole('button',{name:'建立群組',exact:true}).click();
      await page.getByLabel('群組名稱',{exact:true}).fill('發布驗證群組');await page.getByRole('button',{name:'重新命名',exact:true}).click();
      await page.getByLabel('加入標的',{exact:false}).selectOption('QQQ');await page.getByRole('button',{name:'加入',exact:true}).click();
      await page.getByRole('button',{name:'QQQ (QQQ)',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#quote-status').textContent.includes('觀測日期'));
      assert.match(await page.locator('#quote-result').innerText(),/close 原值/);
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#leverage-controls').disabled);
      assert.equal(await page.getByRole('heading',{name:'發布驗證群組',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'QQQ (QQQ)',exact:true}).count(),1);
      await page.getByRole('button',{name:'移除',exact:false}).click();assert.equal(await page.getByRole('button',{name:'QQQ (QQQ)',exact:true}).count(),0);
      await page.getByRole('button',{name:'刪除群組 發布驗證群組',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'發布驗證群組',exact:true}).count(),0);
      // Exercise the other real quote dataset so actual browser identity covers all24 files.
      await page.locator('#quote-symbol').selectOption('0050');
      await page.getByRole('button',{name:'查看／重試',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#quote-result a')?.getAttribute('href')==='data/0050.TW.json');
      assert.match(await page.locator('#quote-result').innerText(),/close 原值/);

    });
    await scenario(CASES[4],async()=>{
      assert.equal(await page.locator('#leverage-controls').evaluate(el=>el.disabled),false);assert.equal(await page.locator('#leverage-etf').isDisabled(),false);
      await page.locator('#leverage-etf').selectOption('TQQQ');await page.getByRole('button',{name:'更新診斷',exact:true}).click();
      assert.match(await page.locator('#leverage-result h3').innerText(),/TQQQ/);assert.equal(await page.locator('#leverage-result .info-table tbody tr').count(),5);
      // Reuse the production pure calculator; no independent financial methodology.
      const { computeVolatilityPair, WINDOW_LABEL } = await import('../js/tabs/levvol_calc.mjs');
      const bundle=JSON.parse(fs.readFileSync(path.join(ROOT,'data/leverage.json'),'utf8'));
      const etf=bundle.etfs.find(item=>item.id==='TQQQ');const volatility=computeVolatilityPair(bundle,etf);
      assert(volatility);const rows=page.locator('#leverage-result .info-table tbody tr');
      const ratio=value=>Number.isFinite(value)?value.toFixed(3):'—';
      for(let i=0;i<volatility.windows.length;i++) {
        const window=volatility.windows[i];
        assert.deepEqual(await rows.nth(i).locator('td').allInnerTexts(),[WINDOW_LABEL[window.w],ratio(window.median),ratio(window.mean),ratio(window.p5),ratio(window.p95),String(window.n),String(etf.leverage)]);
      }
      assert.match(await page.locator('#leverage-result').innerText(),new RegExp(volatility.startDate+' → '+volatility.endDate));
      const text=await page.locator('#leverage-result').innerText();assert.match(text,/選定區間：歷史回測/);assert.match(text,/全期真實資料，不隨上方回測區間裁切/);assert.match(text,/個報酬觀測/);assert.match(text,/有效樣本 n/);
    });
    await scenario(CASES[5], async () => {
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

    await scenario(CASES[6],async()=>{
      await page.getByRole('button',{name:'載入明確標示的合成示範',exact:true}).click();
      for(const [label,width,height] of [['desktop',1280,900],['mobile',390,844],['landscape',844,390]]) {
        await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const heights=await page.locator('button:visible').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().height));assert(heights.every(h=>h>=44));
        const file=path.join(output,label+'.png');await page.screenshot({path:file,fullPage:true});report.artifacts[label]=file;
      }
    });
    await scenario(CASES[7],async()=>{
      const errors=await Promise.all(pendingResponses);assert.deepEqual(errors.filter(Boolean),[]);
      assert.deepEqual(Object.keys(report.sourceIdentity.browserHttpHashes).sort(),[...MODULES].sort());
      assert.deepEqual(report.console,{error:[],warning:[],pageerror:[]});assert.deepEqual(report.requests,[]);
    });
  } catch(error) {report.startupError=String(error.stack||error);}
  finally {
    for(const name of CASES.filter(n=>!report.cases.some(c=>c.name===n)))report.cases.push({name,status:'BLOCKED',error:report.startupError||'Not reached'});
    if(context) {
      try {const file=path.join(output,'trace.zip');await context.tracing.stop({path:file});report.artifacts.trace=file;}catch(e){report.traceError=String(e);}
      try {await context.close();report.cleanup.context=true;}catch(e){report.cleanup.contextError=String(e);}
    }else report.cleanup.context=true;
    if(browser)try {await browser.close();report.cleanup.browser=true;}catch(e){report.cleanup.browserError=String(e);}else report.cleanup.browser=true;
    if(server?.listening)await new Promise(resolve=>server.close(()=>{report.cleanup.server=true;resolve();}));else report.cleanup.server=true;
    const passed=report.cases.filter(c=>c.status==='PASS').length;
    report.summary={passed,total:CASES.length,status:passed===CASES.length&&!report.startupError&&!report.traceError&&Object.values(report.cleanup).every(v=>v===true)?'PASS':'FAIL'};
    fs.writeFileSync(report.artifacts.report,JSON.stringify(report,null,2)+'\n');console.log(`${report.scope} ${report.summary.status} ${passed}/${CASES.length}; ${report.artifacts.report}`);
    process.exitCode=report.summary.status==='PASS'?0:1;
  }
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
