#!/usr/bin/env node
'use strict';
// Targeted product QA; reuses the existing portable server and browser runtime.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {startServer,hash}=require('./browser_smoke.cjs');
const ROOT=path.resolve(__dirname,'..');
const assert=(v,m)=>{if(!v)throw new Error(m);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fixture=JSON.parse(fs.readFileSync(path.join(ROOT,'js/__tests__/fixtures/marginpeak-transparency.json')));
const horizon=fixture.horizons;
function prices(start,length){return Array.from({length},(_,i)=>({date:new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10),close:100+i}));}
function synthetic(empty){
  const m=empty?fixture.noEvents:fixture.monthly;
  const margin=m.debits.map((debit,i)=>({date:new Date(Date.UTC(+m.start.slice(0,4),+m.start.slice(5,7)-1+i,1)).toISOString().slice(0,10),debit}));
  return {'data/liquidity.json':{margin},'data/SP500.json':{data:prices(fixture.short.start,fixture.short.spxLength)},'data/QQQ.json':{data:prices(fixture.short.start,fixture.short.qqqLength)}};
}
// Independent direct monthly oracle, never importing the product calculation.
function reference(rows,asset){
  const result={};
  for(const [h,td] of Object.entries(horizon)){
    const v=[];
    for(let y=1999;y<=2025;y++)for(let mo=1;mo<=12;mo++){
      const ym=`${y}-${String(mo).padStart(2,'0')}`;if(ym<'1999-04'||ym>'2025-06')continue;
      const end=new Date(Date.UTC(y,mo,0)).toISOString().slice(0,10);
      let a=-1;for(let i=0;i<rows.length;i++){if(rows[i].date<=end)a=i;else break;}
      if(a>=0&&a+td<rows.length)v.push(+((rows[a+td].close/rows[a].close-1)*100).toFixed(2));
    }
    v.sort((a,b)=>a-b);const n=v.length,med=n?(v[Math.floor((n-1)/2)]+v[Math.floor(n/2)])/2:null;
    result[asset+'_'+h]={n,text:med==null?'N/A':`${med>=0?'+':''}${med.toFixed(1)}%`};
  }
  return result;
}
async function run(options={}){
  const out=options.output||fs.mkdtempSync(path.join(os.tmpdir(),'marginpeak-qa-'));if(options.output)fs.mkdirSync(out);
  const report={scope:'marginpeak',root:fs.realpathSync(ROOT),head:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),cases:[],console:[],responses:[],syntheticResponses:[],runtime:{node:process.version,chromiumSandbox:true},cleanup:{},limitations:['Chromium desktop/390px emulation; not Safari, real touch, screen reader or the full page matrix.','Price observations are not an exchange-calendar completeness test.']};
  let browser,server;const pending=[];
  const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  async function check(name,fn,page){try{report.cases.push({name,status:'PASS',evidence:await fn()});console.log('PASS '+name);}catch(e){report.cases.push({name,status:'FAIL',reason:e.message,stack:e.stack});console.log('FAIL '+name+': '+e.message);if(page){await page.screenshot({path:path.join(out,`${report.cases.length}-failure.png`),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(out,`${report.cases.length}-failure-state.json`),JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,hash:location.hash})).catch(()=>({})),null,2));}}}
  async function open(serv,mobile,data){
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},timezoneId:'UTC'});
    const page=await context.newPage();await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
    page.on('console',m=>{if(['error','warning'].includes(m.type()))report.console.push({type:m.type(),text:m.text()});});
    page.on('pageerror',e=>report.console.push({type:'pageerror',text:e.message}));
    page.on('requestfailed',r=>report.console.push({type:'requestfailed',url:r.url(),text:r.failure()?.errorText}));
    if(data)await page.route('**/data/*.json',async route=>{const key=new URL(route.request().url()).pathname.slice(1);if(data[key]){const body=JSON.stringify(data[key]);report.syntheticResponses.push({path:key,sha256:hash(body)});await route.fulfill({status:200,contentType:'application/json',body});}else await route.continue();});
    page.on('response',response=>{if(!response.url().startsWith(serv.url))return;const key=new URL(response.url()).pathname.slice(1)||'index.html';pending.push((async()=>{if(data?.[key]){assert(hash(await response.body())===hash(JSON.stringify(data[key])),'fixture hash '+key);return;}const body=await response.body();const disk=fs.readFileSync(path.join(serv.root,key));report.responses.push({root:serv.root,path:key,status:response.status(),equal:hash(body)===hash(disk),sha256:hash(body)});})().catch(e=>report.console.push({type:'identityerror',text:e.message})));});
    await page.goto(serv.url+'/#tab=marginpeak',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>window.echarts?.getInstanceByDom(document.getElementById('marginpeak-chart'))?.getOption()?.series?.length&&document.querySelectorAll('#marginpeak-table table').length===2,null,{timeout:30000});
    return {context,page};
  }
  async function snap(page){return page.evaluate(()=>{const o=echarts.getInstanceByDom(document.getElementById('marginpeak-chart')).getOption();return{series:o.series.map(s=>({name:s.name,type:s.type,data:s.data,markLine:s.markLine?.data,markArea:s.markArea?.data,yAxisIndex:s.yAxisIndex})),xAxis:o.xAxis.map(a=>({type:a.type,data:a.data,min:a.min,max:a.max})),yAxis:o.yAxis.map(a=>({type:a.type,min:a.min,max:a.max})),zoom:(o.dataZoom||[]).map(z=>({start:z.start,end:z.end})),legend:o.legend?.map(l=>l.selected)};});}
  async function click(page,id){await page.locator('#'+id).click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function matrix(page){const result={};for(const asset of ['spx','qqq'])for(const mode of ['yoy','abs'])for(const view of ['table','eventstudy']){await click(page,'marginpeak-idx-'+asset);await click(page,'marginpeak-mode-'+mode);await click(page,'marginpeak-view-'+view);result[asset+'-'+mode+'-'+view]=await snap(page);}return result;}
  async function hover(page,index){const point=await page.evaluate(index=>{const host=document.getElementById('marginpeak-chart'),c=echarts.getInstanceByDom(host),r=host.getBoundingClientRect();c.dispatchAction({type:'hideTip'});return{x:r.left+c.convertToPixel({xAxisIndex:0},index),y:r.top+c.getHeight()/2};},index);await page.mouse.move(point.x,point.y);await page.waitForTimeout(80);return page.evaluate(()=>[...document.querySelectorAll('#marginpeak-chart div')].filter(e=>getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none').map(e=>e.innerText).find(t=>t?.startsWith('第 ')&&t.includes('事件 n=')));}
  try{
    const pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');report.runtime.playwright=require(path.join(path.dirname(require.resolve(process.env.PLAYWRIGHT_MODULE||'playwright')),'package.json')).version;
    report.runtime.binary=pw.chromium.executablePath();browser=await pw.chromium.launch({headless:true,chromiumSandbox:true});report.runtime.browser=browser.version();server=await startServer(ROOT);report.url=server.url;
    let baseline;
    if(options.baseline){const bs=await startServer(options.baseline);try{baseline=[];for(let i=0;i<2;i++){const {context,page}=await open(bs,false);try{baseline.push(await matrix(page));}finally{await context.close();}}assert(equal(baseline[0],baseline[1]),'before baseline is not stable');report.baseline={root:bs.root,stableRuns:2,sha256:hash(JSON.stringify(baseline[0]))};}finally{await bs.close();}}
    for(const mobile of [false,true]){
      const label=mobile?'390px':'desktop';const {context,page}=await open(server,mobile);
      try{
        await check(label+' baseline medians and distinct denominators',async()=>{
          const spx=JSON.parse(fs.readFileSync(path.join(ROOT,'data/SP500.json'))).data,qqq=JSON.parse(fs.readFileSync(path.join(ROOT,'data/QQQ.json'))).data;
          const expected={...reference(spx,'SPX'),...reference(qqq,'QQQ')};
          const tables=await page.locator('#marginpeak-table table').evaluateAll(tables=>tables.map(t=>[...t.querySelector('tbody').lastElementChild.children].slice(1).map(e=>e.innerText)));
          const want=Object.values(expected).map(v=>`${v.text}\n基準 n=${v.n}`);for(const row of tables)assert(equal(row,want),'baseline table/oracle differs '+JSON.stringify({row,want}));
          const current=Object.values(expected).map(v=>v.text);assert(equal(current,['+1.2%','+2.8%','+5.2%','+10.8%','+1.5%','+4.2%','+8.0%','+15.5%']),'review values no longer reproducible');
          const event=await page.locator('#marginpeak-table table').evaluateAll(ts=>ts.map(t=>[...t.querySelector('tbody').lastElementChild.previousElementSibling.children].slice(1).map(c=>c.querySelector('small').innerText)));
          assert(equal(event[0],[4,4,3,3,3,3,2,2].map(n=>'事件 n='+n)),'A counts');assert(equal(event[1],[9,9,9,9,8,8,8,8].map(n=>'事件 n='+n)),'B counts');return{expected,event};
        },page);
        await check(label+' method, horizon tooltips and retrospective disclosure',async()=>{
          const t=await page.locator('#marginpeak-methodology').innerText();for(const word of ['不是上漲機率','marginpeak-monthly-raw-v1','不自動滾動','未來價格可超過','不是確認月','未來 6 筆 YoY','並非曆月报酬'.replace('报','報')])assert(t.includes(word),'disclosure '+word);
          const titles=await page.locator('#marginpeak-table th[title]').evaluateAll(es=>es.map(e=>e.title));assert(titles.length===16,'horizon titles');for(const td of Object.values(horizon))assert(titles.some(t=>t.includes('+'+td+' 個價格觀測')),'tooltip horizon '+td);return{titles};
        },page);
        await check(label+' two assets/two views and non-baseline financial regression',async()=>{const after=await matrix(page);if(baseline)assert(equal(after,baseline[0]),'chart series/axes/statistics changed');return{sha256:hash(JSON.stringify(after)),beforeCompared:!!baseline};},page);
        await check(label+' event-study hover n for both assets',async()=>{for(const [asset,n] of [['spx',9],['qqq',8]]){await click(page,'marginpeak-idx-'+asset);await click(page,'marginpeak-view-eventstudy');for(const index of [0,21,63,126,252]){const t=await hover(page,index);assert(t?.includes('事件 n='+n),'hover n '+asset+' '+index+' '+t);assert(t.includes('非曆月 horizon'),'hover horizon');}}return{SPX:9,QQQ:8};},page);
        await check(label+' theme/resize and route re-entry follow existing chart-state policy',async()=>{
          await click(page,'marginpeak-view-table');await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('marginpeak-chart'));c.dispatchAction({type:'dataZoom',start:20,end:70});c.dispatchAction({type:'legendUnSelect',name:'QQQ'});});const before=await snap(page);
          await click(page,'theme-btn');const themed=await snap(page);assert(equal(before,themed),'theme changed numeric data/zoom/legend');
          await page.evaluate(()=>location.hash='#tab=trend');await page.waitForFunction(()=>!document.getElementById('tab-trend').hidden);await page.evaluate(()=>location.hash='#tab=marginpeak');await page.waitForFunction(()=>!document.getElementById('tab-marginpeak').hidden);await page.waitForTimeout(150);
          const after=await snap(page);assert(equal(before.series,after.series),'re-entry numeric series changed');return{before,after,delayedRenderPolicy:'existing 50ms render may reset interaction on re-entry; no new policy introduced'};
        },page);
        await check(label+' geometry/table scroll and readable disclosures',async()=>{
          await click(page,'marginpeak-view-table');const g=await page.evaluate(()=>{const s=document.getElementById('tab-marginpeak'),h=document.getElementById('marginpeak-chart'),wrap=document.getElementById('marginpeak-table').parentElement,controls=document.getElementById('marginpeak-mode-abs').parentElement;return{pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,chart:{width:h.clientWidth,height:h.clientHeight},scroll:{client:wrap.clientWidth,width:wrap.scrollWidth,overflow:getComputedStyle(wrap).overflowX},controls:[...controls.querySelectorAll('.chip')].map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};}),methods:{width:document.getElementById('marginpeak-methodology').clientWidth,scroll:document.getElementById('marginpeak-methodology').scrollWidth},textVisible:s.innerText.includes('基準中位報酬')};});
          assert(g.pageWidth<=g.viewport+1,'page overflow');assert(g.chart.width>300&&g.chart.height>=400,'chart compressed');assert(g.textVisible,'method not visible');assert(g.methods.width<=g.viewport&&g.methods.scroll<=g.methods.width+1,'method text clipped');for(const c of g.controls)assert(c.x>=0&&c.x+c.w<=g.viewport+1,'control clipping');for(let i=0;i<g.controls.length;i++)for(let j=i+1;j<g.controls.length;j++){const a=g.controls[i],b=g.controls[j];assert(!(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h),'control overlap');}await page.screenshot({path:path.join(out,label+'.png'),fullPage:true});return g;
        },page);
      }finally{await context.close();}
    }
    for(const [name,empty,mobile] of [['short-desktop',false,false],['short-390px',false,true],['empty-events',true,false]]){
      const data=synthetic(empty),{context,page}=await open(server,mobile,data);
      try{await check(name+' rendered missing horizons and baseline/event denominators',async()=>{
        const rows=await page.locator('#marginpeak-table table').evaluateAll(ts=>ts.map(t=>({events:t.querySelector('tbody').children.length-2,median:[...t.querySelector('tbody').lastElementChild.previousElementSibling.children].slice(1).map(c=>c.innerText),baseline:[...t.querySelector('tbody').lastElementChild.children].slice(1).map(c=>c.innerText)})));
        const expected=Object.values({...reference(data['data/SP500.json'].data,'SPX'),...reference(data['data/QQQ.json'].data,'QQQ')}).map(v=>`${v.text}\n基準 n=${v.n}`);for(const r of rows){assert(equal(r.baseline,expected),'short baseline denominator');if(empty){assert(r.events===0,'empty events');assert(r.median.every(t=>t==='N/A\n事件 n=0'),'empty N/A');}else{assert(r.events===1,'expected one event');assert(r.median[2]==='N/A\n事件 n=0'&&r.median[5]==='N/A\n事件 n=0','incomplete horizon N/A');}}return rows;
      },page);
      await check(name+' sparse/empty per-observation n in rendered hover',async()=>{
        const results={};for(const [asset,len] of [['spx',90],['qqq',22]]){await click(page,'marginpeak-idx-'+asset);await click(page,'marginpeak-view-eventstudy');const note=await page.locator('#marginpeak-eventstudy-note').innerText();assert(note.includes(empty?'t=0～252：n=0':`t=${len}～252：n=0`),'all-null tail n is not disclosed');const opts=await snap(page);for(const i of [0,21,22,89,90,252]){const expected=!empty&&i<len?1:0;
          // On an all-null tail, exercise the installed chart formatter using the
          // real chart options, since ECharts omits dispatchAction showTip there.
          if(expected){const t=await hover(page,i);assert(t?.includes('事件 n=1'),'valid sparse hover '+asset+' '+i+' '+t);}
          else {const t=await hover(page,i);if(t){assert(t.includes('事件 n=0'),'all-null hover n');assert(!t.includes('Mean:')&&!t.includes('Percentile:'),'all-null hover fabricated statistic');}}
          const rendered=await page.evaluate(i=>{const c=echarts.getInstanceByDom(document.getElementById('marginpeak-chart')),o=c.getOption();const params=o.series.map((s,index)=>({axisValue:i,seriesName:s.name,value:s.data[i],marker:'',seriesIndex:index}));return o.tooltip[0].formatter(params);},i);
          assert(rendered.includes('事件 n='+expected),'formatter n');if(expected===0){assert(opts.series.every(s=>s.data[i]===null),'missing series fabricated');assert(!rendered.includes('<b>'),'missing hover fabricated statistic');}results[asset+'_'+i]={n:expected,html:rendered};}
        }return results;
      },page);}finally{await context.close();}
    }
    await Promise.all(pending);
    await check('HTTP identity and zero console/errors/warnings/pageerrors/request failures',async()=>{assert(report.responses.length>0&&report.responses.every(r=>r.status===200&&r.equal),'HTTP identity');assert(!report.console.length,JSON.stringify(report.console));return{checked:report.responses.length,fixtures:report.syntheticResponses.length,console:0};});
  }catch(e){report.cases.push({name:'startup or phase setup',status:'FAIL',reason:e.message,stack:e.stack});}
  finally{if(browser)await browser.close().then(()=>report.cleanup.browserClosed=true);if(server)await server.close().then(()=>report.cleanup.serverClosed=true);}
  report.summary={status:report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL',passed:report.cases.filter(c=>c.status==='PASS').length,total:report.cases.length,consoleErrors:report.console.filter(m=>m.type==='error').length,consoleWarnings:report.console.filter(m=>m.type==='warning').length,pageErrors:report.console.filter(m=>m.type==='pageerror').length};save();console.log(JSON.stringify(report.summary)+'\nreport: '+path.join(out,'report.json'));return report;
}
if(require.main===module){const options={};for(let i=2;i<process.argv.length;i++){if(process.argv[i]==='--output')options.output=path.resolve(process.argv[++i]);else if(process.argv[i]==='--baseline')options.baseline=path.resolve(process.argv[++i]);else throw new Error('Unknown argument '+process.argv[i]);}run(options).then(r=>process.exitCode=r.summary.status==='PASS'?0:1).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={run};
