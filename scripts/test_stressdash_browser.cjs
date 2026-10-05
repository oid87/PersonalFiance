#!/usr/bin/env node
'use strict';
// Independent stressdash contract probe. Uses existing Playwright/server; never mutates market data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startServer, hash } = require('./browser_smoke.cjs');
const assert = (v, m) => { if (!v) throw new Error(m); };
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const args = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all) => i%2 ? a : [...a,[v.replace(/^--/,''),all[i+1]]],[]));
const root = fs.realpathSync(args.root || path.resolve(__dirname,'..'));
const out = path.resolve(args.output || fs.mkdtempSync(path.join(os.tmpdir(),'stressdash-qa-')));
if (args.output) fs.mkdirSync(out);
const fixedTime = '2026-10-05T12:00:00.000Z';
const optional = 'data/stlfsi_kcfsi.json';
const dataFiles = ['data/nfci.json',optional,'data/SPY.json','data/QQQ.json','data/SOXX.json'];
const report = {root, mode:args.mode || 'suite', fixedTime, commands:{argv:process.argv,cwd:process.cwd()},
 runtime:{node:process.version,os:os.release(),chromiumSandbox:true}, source:{files:{},responses:[]}, cases:[], messages:[], requests:[], injected:[], snapshots:[], cleanup:{},
 limitations:['Chromium desktop/mobile emulation; native Safari, touch, screen reader and macOS IME not exercised.','Frozen time and data; HTTP fixtures are explicitly recorded separately from disk identity.']};
for (const f of ['index.html','js/tabs/stressdash.js','js/boot.js','js/switcher.js','js/utils/data.js',...dataFiles]) report.source.files[f]=hash(fs.readFileSync(path.join(root,f)));
report.source.runnerHash=hash(fs.readFileSync(__filename));
fs.copyFileSync(__filename,path.join(out,'runner.cjs'));
try { report.source.git = execFileSync('git',['-C',root,'status','--short'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}); report.source.head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); } catch { report.source.git='frozen non-Git tree'; }
let browser,server,page,context,stage='setup',pending=[],fixture=null;
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const counts=()=>Object.fromEntries(dataFiles.map(f=>[f,report.requests.filter(r=>r.stage===stage&&r.url.endsWith('/'+f)).length]));
async function frame(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function snap(){return page.evaluate(()=>{
 const c=echarts.getInstanceByDom(document.getElementById('stressdash-chart')),o=c.getOption();
 return {financial:{series:o.series,xAxis:o.xAxis,yAxis:o.yAxis,grid:o.grid,legend:o.legend,dataZoom:o.dataZoom,axisPointer:o.axisPointer},
 cards:Object.fromEntries(['nfci','stlfsi','kcfsi'].map(k=>[k,Object.fromEntries(['val','sub','signal'].map(s=>[s,{text:document.getElementById('stressdash-'+k+'-'+s).textContent,color:document.getElementById('stressdash-'+k+'-'+s).style.color}]))])),
 table:document.getElementById('stressdash-table').innerHTML,status:document.getElementById('stressdash-status').textContent,
 chips:[...document.querySelectorAll('#tab-stressdash .chip[data-stressdash-ticker],#tab-stressdash .chip[data-stressdash-range]')].map(e=>({text:e.textContent,active:e.classList.contains('active')}))};
 });}
async function ready(){await page.waitForFunction(()=>{const e=document.getElementById('tab-stressdash');return !e.hidden && e.getAttribute('aria-busy')!=='true'&&echarts?.getInstanceByDom(document.getElementById('stressdash-chart'))?.getOption().series?.length;},null,{timeout:22000});await frame();}
async function newPage(viewport,inject,bootless=false){
 if(context)await context.close();fixture=inject || null;pending=[];
 // Keep the financial baseline's viewport-only profile exact. Failure-state mobile
 // cases also emulate a coarse touch pointer to exercise the existing 44px CSS rule.
 const hasTouch=viewport.width===390&&!stage.startsWith('full-data');report.runtime.contexts||=[];report.runtime.contexts.push({stage,viewport,hasTouch,timezone:'UTC'});
 context=await browser.newContext({viewport,hasTouch,timezoneId:'UTC'});page=await context.newPage();page.setDefaultTimeout(7000);page.setDefaultNavigationTimeout(30000);await page.clock.setFixedTime(new Date(fixedTime));
 page.on('console',m=>{if(['error','warning'].includes(m.type()))report.messages.push({stage,type:m.type(),text:m.text(),location:m.location(),injected:!!fixture});});
 page.on('pageerror',e=>report.messages.push({stage,type:'pageerror',text:e.message,injected:!!fixture}));
 page.on('request',r=>report.requests.push({stage,url:r.url()}));
 page.on('requestfailed',r=>report.messages.push({stage,type:'requestfailed',text:r.failure()?.errorText,url:r.url(),injected:!!fixture}));
 const injectedRequests=new Map();
 if(bootless)await page.route('**/js/boot.js',async route=>{const body='// Browser QA fixture: explicit module activation with real DOM and ECharts.';injectedRequests.set(route.request(),hash(body));report.injected.push({stage,file:'js/boot.js',status:200,bodyHash:hash(body),label:'declared boot suppression fixture for AbortController lifecycle probe'});await route.fulfill({contentType:'text/javascript',body});});
 await page.route('**/data/*.json',async route=>{
  const f=new URL(route.request().url()).pathname.slice(1);if(!fixture?.[f])return route.continue();
  const result=await fixture[f](route);if(!result)return route.continue();
  injectedRequests.set(route.request(),hash(result.body));report.injected.push({stage,file:f,status:result.status||200,bodyHash:hash(result.body),label:result.label});const {label,...response}=result;await route.fulfill({contentType:'application/json',...response});
 });
 page.on('response',r=>{if(!r.url().startsWith(server.url+'/')){report.externalResponses||=[];report.externalResponses.push({stage,url:r.url(),status:r.status()});return;}
  pending.push((async()=>{const f=new URL(r.url()).pathname.slice(1)||'index.html';if(injectedRequests.has(r.request())){const item={stage,file:f,status:r.status(),injected:true,fixtureHash:injectedRequests.get(r.request())};try{item.bodyHash=hash(await r.body());item.fixtureEqual=item.bodyHash===item.fixtureHash;}catch(e){item.error=e.message;item.fixtureEqual=false;}report.source.responses.push(item);return;}
  const item={stage,file:f,status:r.status()};try{item.httpHash=hash(await r.body());item.diskHash=hash(fs.readFileSync(path.join(root,f)));item.equal=item.httpHash===item.diskHash;}catch(e){item.error=e.message;}report.source.responses.push(item);})());
 });
 await page.goto(server.url+'/#tab=stressdash');
 if(bootless)await page.locator('#tab-stressdash').evaluate(e=>e.hidden=false);
}
async function test(name,fn){if(args.case&&!new RegExp(args.case).test(name))return;stage=name;try{const evidence=await fn();report.cases.push({name,status:'PASS',evidence});console.log('PASS '+name);}catch(e){report.cases.push({name,status:'FAIL',reason:e.message,stack:e.stack});console.log('FAIL '+name+': '+e.message);if(page&&!page.isClosed()){try{await page.screenshot({path:path.join(out,name.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});fs.writeFileSync(path.join(out,name.replace(/[^a-z0-9]+/gi,'-')+'-state.json'),JSON.stringify({dom:await page.evaluate(()=>({text:document.body.innerText,html:document.getElementById('tab-stressdash').outerHTML})),snapshot:await snap()},null,2));}catch{}}}await Promise.allSettled(pending);save();}
const body=value=>({body:JSON.stringify(value),label:'synthetic optional contract fixture'});
const original=JSON.parse(fs.readFileSync(path.join(root,optional)));
const retry=()=>page.locator('#tab-stressdash button').filter({hasText:/重試|Retry/i}).filter({visible:true});
function requiredPresent(s){assert(s.cards.nfci.val.text!=='—'&&s.cards.nfci.val.text!=='Unavailable','NFCI missing');assert(s.financial.series.some(x=>x.type==='candlestick'&&x.data.length),'price missing');assert(s.table.includes('<tbody>')&&s.table.includes('%'),'table missing');}
function unavailable(s){for(const k of ['stlfsi','kcfsi']){assert(s.cards[k].val.text==='Unavailable',k+' not Unavailable');assert(!/明顯緊縮|壓力偏高|略緊|略鬆|明顯寬鬆|壓力偏低|歷史均值|MA20|0\.00/.test(s.cards[k].signal.text),k+' has stress classification');assert(s.cards[k].val.color==='var(--muted)',k+' not muted');}for(const x of s.financial.series.filter(s=>/STLFSI|KCFSI/.test(s.name)))assert(x.data.length===0,'auxiliary series not empty');requiredPresent(s);}
const requiredFinancial=s=>s.financial.series.filter(x=>!/^STLFSI|^KCFSI/.test(x.name));
const requiredTable=s=>[...s.table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(x=>x[1]).filter((x,i)=>i!==2));
const zoom=s=>s.financial.dataZoom.map(z=>[z.start,z.end]);
// ECharts dispatches legend actions to both legends, adding keys that the other legend
// does not display. Compare each visible data name with ECharts' default selected=true.
// Raw before/after maps remain in retryLegendRaw for review.
const legends=s=>s.financial.legend.map(l=>l.data.map(d=>typeof d==='string'?d:d.name).map(name=>[name,l.selected[name]!==false]));
function requiredSame(before,after){assert(equal(requiredFinancial(before),requiredFinancial(after)),'required chart changed during optional retry');assert(equal(requiredTable(before),requiredTable(after)),'required table values changed during optional retry');assert(equal(before.cards.nfci,after.cards.nfci),'NFCI card changed during optional retry');}
async function geometry(){const g=await page.evaluate(()=>{
 const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const status=document.getElementById('stressdash-status'),button=document.getElementById('stressdash-optional-retry');
 return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,
 cards:[...document.querySelectorAll('#stressdash-top>.breadth-card')].map(e=>({rect:rect(e),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,
 children:[...e.querySelectorAll('*')].map(c=>({rect:rect(c),clientWidth:c.clientWidth,scrollWidth:c.scrollWidth,clientHeight:c.clientHeight,scrollHeight:c.scrollHeight}))})),
 status:{rect:rect(status),clientWidth:status.clientWidth,scrollWidth:status.scrollWidth,clientHeight:status.clientHeight,scrollHeight:status.scrollHeight,
 lines:[...status.querySelectorAll('span')].flatMap(s=>[...s.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom})))},button:button&&!button.hidden?rect(button):null};});
 assert(g.documentWidth<=g.width+1,'document horizontal overflow');assert(g.cards.length===3,'summary card count');
 for(const c of g.cards){assert(c.rect.left>=-1&&c.rect.right<=g.width+1,'card outside viewport');assert(c.scrollWidth<=c.clientWidth+1&&c.scrollHeight<=c.clientHeight+1,'card clipping');for(const e of c.children){assert(e.rect.left>=c.rect.left-1&&e.rect.right<=c.rect.right+1,'card child horizontal clipping');if(e.clientWidth)assert(e.scrollWidth<=e.clientWidth+1,'child text overflow');if(e.clientHeight)assert(e.scrollHeight<=e.clientHeight+1,'child vertical clipping');}}
 const rows=new Set(g.cards.map(c=>Math.round(c.rect.top)));assert(rows.size===(g.width<600?3:1),'summary responsive columns');
 assert(g.status.scrollWidth<=g.status.clientWidth+1&&g.status.scrollHeight<=g.status.clientHeight+1,'status clipping');for(const r of g.status.lines)assert(r.left>=-1&&r.right<=g.width+1,'status text outside viewport');
 if(g.button&&g.width===390)assert(g.button.width>=44&&g.button.height>=44,'mobile retry below 44px target');return g;
}
async function interactions(){
 await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('stressdash-chart'));c.dispatchAction({type:'dataZoom',start:20,end:80});c.dispatchAction({type:'legendSelect',name:'NFCI MA20'});});
 const before=await snap();await page.locator('#theme-btn').click();await frame();const themed=await snap();assert(equal(before.financial.series.map(s=>s.data),themed.financial.series.map(s=>s.data)),'theme numeric change');assert(equal(zoom(before),zoom(themed)),'theme lost zoom');assert(equal(legends(before),legends(themed)),'theme lost legend');
 const b=page.getByRole('button',{name:'金融壓力圖表：放大或還原'});await b.click();await frame();assert(await page.locator('#tab-stressdash').getAttribute('aria-modal')==='true','focus not modal');await page.keyboard.press('Escape');await frame();assert(await page.locator('#tab-stressdash').getAttribute('aria-modal')===null,'focus residue');assert(await b.evaluate(e=>e===document.activeElement),'focus not restored');
 await page.evaluate(()=>location.hash='#tab=aaii');await page.waitForFunction(()=>document.getElementById('tab-stressdash').hidden);await page.evaluate(()=>location.hash='#tab=stressdash');await ready();const reentered=await snap();assert(equal(themed.financial.series.map(s=>s.data),reentered.financial.series.map(s=>s.data)),'reentry numeric change');assert(equal(zoom(themed),zoom(reentered)),'reentry lost zoom');assert(equal(legends(themed),legends(reentered)),'reentry lost legend');return {before,themed,reentered};
}
(async()=>{try{
 server=await startServer(root);report.source.serverRoot=server.root;report.source.url=server.url;
 const p=require(process.env.PLAYWRIGHT_MODULE||'playwright');report.runtime.playwright=require((process.env.PLAYWRIGHT_MODULE||'playwright')+'/package.json').version;
 browser=await p.chromium.launch({headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings','--enable-unsafe-swiftshader']});report.runtime.browser=browser.version();
 for(const viewport of [{width:1280,height:900},{width:390,height:844}])await test('full-data-'+viewport.width,async()=>{
 await newPage(viewport);await ready();const snapshots=[];
 for(const ticker of ['SPY','QQQ','SOXX'])for(const range of ['1Y','3Y','5Y','10Y','MAX']){
 await page.locator('[data-stressdash-ticker="'+ticker+'"]').click();await page.locator('[data-stressdash-range="'+range+'"]').click();await frame();const s=await snap();requiredPresent(s);snapshots.push({viewport,ticker,range,...s});}
 report.snapshots.push(...snapshots);return {choices:snapshots.length};});
 fs.writeFileSync(path.join(out,'snapshots.json'),JSON.stringify(report.snapshots,null,2)+'\n');
 if(args.baseline)await test('full-data-before-after-equality',async()=>{const base=JSON.parse(fs.readFileSync(args.baseline));assert(equal(base,report.snapshots),'full chart/cards/table/status/options differ');return {snapshots:base.length,sha256:hash(JSON.stringify(base))};});
 if(report.mode!=='baseline'){
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
 for(const missing of [['stlfsi4'],['kcfsi'],['stlfsi4','kcfsi'],['empty'],['null']])await test('no-observation-'+missing.join('-')+'-'+viewport.width,async()=>{
 const data=missing[0]==='empty'?[]:original.data.map(r=>{const n={...r};if(missing[0]==='null'){n.stlfsi4=null;n.kcfsi=null;}else for(const k of missing)delete n[k];return n;});await newPage(viewport,{[optional]:()=>body({data})});await ready();const s=await snap();requiredPresent(s);
 for(const k of ['empty','null'].includes(missing[0])?['stlfsi4','kcfsi']:missing){const card=k==='stlfsi4'?'stlfsi':'kcfsi';assert(s.cards[card].val.text==='—','no observation changed to unavailable/zero');assert(s.cards[card].signal.text==='—','no observation stress classification');for(const x of s.financial.series.filter(x=>x.name.startsWith(k==='stlfsi4'?'STLFSI4':'KCFSI')))assert(!x.data.length,'no observation plotted');}
 assert(await retry().count()===0,'ordinary no observations offers retry');const layout=await geometry();if(missing.length===2)await page.screenshot({path:path.join(out,'missing-'+viewport.width+'.png'),fullPage:true});return {snapshot:s,layout};});
 await test('numeric-zero-'+viewport.width,async()=>{await newPage(viewport,{[optional]:()=>body({data:[{date:'2026-10-02',stlfsi4:0,kcfsi:0}]})});await ready();const s=await snap();for(const k of ['stlfsi','kcfsi']){assert(s.cards[k].val.text==='+0.00','zero not retained');assert(s.cards[k].signal.text.includes('略緊'),'zero threshold changed');}return s;});
 for(const [label,result] of [['http503',{status:503,body:'{}',label:'intentional HTTP503'}],['malformed',{body:'{',label:'intentional malformed JSON'}],['shape',body({data:{}})],['string',body({data:[{date:'2026-10-02',stlfsi4:'0',kcfsi:0}]})]])await test('optional-'+label+'-'+viewport.width,async()=>{
 await newPage(viewport,{[optional]:()=>result});await ready();const s=await snap();unavailable(s);assert(await page.locator('.tab-load-error').count()===0,'optional failed whole page');const r=retry();assert(await r.count()===1,'optional retry absent');assert(await r.getAttribute('type')==='button','not accessible native button');assert((await r.getAttribute('class')||'').includes('chip'),'missing chip affordance');await r.focus();assert(await r.evaluate(e=>e===document.activeElement),'retry not focusable');const layout=await geometry();if(label==='http503')await page.screenshot({path:path.join(out,'unavailable-'+viewport.width+'.png'),fullPage:true});return {snapshot:s,counts:counts(),layout};});
 await test('theme-focus-reentry-'+viewport.width,async()=>{await newPage(viewport);await ready();return interactions();});
 }
 for(const viewport of [{width:1280,height:900},{width:390,height:844}])await test('optional-local-retry-success-failure-double-click-and-counts-'+viewport.width,async()=>{
 let n=0,release;const gate=new Promise(r=>release=r);const failures={status:503,body:'{}',label:'intentional optional HTTP503'};
 await newPage(viewport,{[optional]:async()=>{n++;if(n===1||n===3)return failures;if(n===2)await gate;return body(original);}});await ready();const initial=await snap();unavailable(initial);
 await page.evaluate(()=>{const c=echarts.getInstanceByDom(document.getElementById('stressdash-chart'));c.dispatchAction({type:'dataZoom',start:20,end:80});c.dispatchAction({type:'legendSelect',name:'NFCI MA20'});});const before=await snap(),requestsBefore=counts();const r=retry();await r.click();await page.waitForFunction(()=>document.querySelector('#tab-stressdash button[disabled]'));
 await r.evaluate(e=>{e.dispatchEvent(new MouseEvent('click',{bubbles:true}));e.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await frame();assert(n===2,'duplicate optional requests');assert(await r.isDisabled(),'retry not disabled during fetch');release();await page.waitForFunction(()=>document.getElementById('stressdash-stlfsi-val').textContent!=='Unavailable');await frame();const after=await snap();report.retryLegendRaw={before:before.financial.legend.map(l=>({data:l.data,selected:l.selected})),after:after.financial.legend.map(l=>({data:l.data,selected:l.selected}))};requiredSame(before,after);assert(equal(zoom(before),zoom(after)),'optional retry lost zoom');assert(equal(legends(before),legends(after)),'optional retry lost legend');const requestsAfter=counts();for(const f of dataFiles)assert(requestsAfter[f]-requestsBefore[f]===(f===optional?1:0),'optional retry requested '+f);assert(await retry().count()===0,'retry visible after success');
 // A fresh load starts a second independent failure → failure → success cycle.
 n=0;await newPage(viewport,{[optional]:()=>{n++;return n<3?failures:body(original);}});await ready();const beforeFailure=counts();await retry().click();await page.waitForFunction(()=>!document.querySelector('#tab-stressdash button[disabled]'));await frame();unavailable(await snap());assert(n===2,'failed retry count incorrect');const afterFailure=counts();for(const f of dataFiles)assert(afterFailure[f]-beforeFailure[f]===(f===optional?1:0),'failed local retry requested '+f);await retry().click();await page.waitForFunction(()=>document.getElementById('stressdash-stlfsi-val').textContent!=='Unavailable');await frame();assert(n===3,'repeat retry count incorrect');const afterRepeatedSuccess=counts();for(const f of dataFiles)assert(afterRepeatedSuccess[f]-afterFailure[f]===(f===optional?1:0),'repeated local retry requested '+f);return {before,after,requestsBefore,requestsAfter,beforeFailure,afterFailure,afterRepeatedSuccess,repeatAttempts:n};
 });
 await test('optional-pending-retry-route-interruption-stale-completion',async()=>{
 let n=0,release;const gate=new Promise(r=>release=r);await newPage({width:1280,height:900},{[optional]:async()=>{n++;if(n===1)return {status:503,body:'{}',label:'intentional initial failure'};if(n===2){await gate;return body({data:[{date:'2026-10-02',stlfsi4:0,kcfsi:0}]});}return body(original);}});await ready();await retry().click();await page.waitForFunction(()=>document.querySelector('#tab-stressdash button[disabled]'));await page.evaluate(()=>location.hash='#tab=aaii');await page.waitForFunction(()=>document.getElementById('tab-stressdash').hidden);await frame();await page.evaluate(()=>location.hash='#tab=stressdash');await ready();const requestsBefore=counts();release();await page.waitForResponse(r=>r.url().endsWith('/'+optional));await frame();const interrupted=await snap();unavailable(interrupted);assert(await retry().isEnabled(),'reentry retry not enabled');assert(n===2,'reentry unexpectedly triggered optional fetch');await retry().click();await page.waitForFunction(()=>document.getElementById('stressdash-stlfsi-val').textContent!=='Unavailable');await frame();const s=await snap();assert(s.cards.stlfsi.val.text!=='+0.00','stale result remained cached');assert(n===3,'explicit reentry retry did not fetch optional once');requiredPresent(s);const requestsAfter=counts();for(const f of dataFiles)assert(requestsAfter[f]-requestsBefore[f]===(f===optional?1:0),'reentry retry requested '+f);return {attempts:n,interrupted,snapshot:s,requestsBefore,requestsAfter};
 });
 for(const [label,file,result] of [['nfci503','data/nfci.json',{status:503,body:'{}',label:'intentional required NFCI HTTP503'}],['nfci-noobs','data/nfci.json',body({data:[]})],['price503','data/SOXX.json',{status:503,body:'{}',label:'intentional required price HTTP503'}]])await test('required-'+label+'-whole-page-retry',async()=>{
 let fail=true;await newPage({width:1280,height:900},{[file]:()=>fail?result:null});await page.locator('#tab-stressdash .tab-load-error').waitFor({state:'visible',timeout:22000});assert(await page.locator('#tab-stressdash .tab-load-error button').count()===1,'dispatcher retry missing');assert(await retry().count()===1,'optional retry appeared on required failure');const before=counts();fail=false;await page.locator('#tab-stressdash .tab-load-error button').click();await ready();const s=await snap();requiredPresent(s);assert(await page.locator('.tab-load-error').count()===0,'whole page retry failed');return {before,after:counts(),snapshot:s};
 });
 await test('explicit-aborted-first-activation-no-partial-state',async()=>{
 let nfciCalls=0,optionalCalls=0,release,arriveNfci,arriveOptional;const gate=new Promise(r=>release=r),nfciArrived=new Promise(r=>arriveNfci=r),optionalArrived=new Promise(r=>arriveOptional=r);
 await newPage({width:1280,height:900},{'data/nfci.json':async()=>{nfciCalls++;arriveNfci();if(nfciCalls===1)await gate;return null;},[optional]:()=>{optionalCalls++;arriveOptional();return optionalCalls===1?{status:503,body:'{}',label:'intentional optional failure before required activation abort'}:body(original);}},true);
 await page.evaluate(async()=>{const m=await import('./js/tabs/stressdash.js');window.__abortModule=m;window.__abortController=new AbortController();m.activate({signal:__abortController.signal,isCurrent:()=>!__abortController.signal.aborted}).then(()=>window.__abortResult={ok:true},e=>window.__abortResult={name:e.name,message:e.message});});await Promise.all([nfciArrived,optionalArrived]);await page.evaluate(()=>__abortController.abort());await page.waitForFunction(()=>window.__abortResult);const aborted=await page.evaluate(()=>({result:__abortResult,cards:['nfci','stlfsi','kcfsi'].map(k=>document.getElementById('stressdash-'+k+'-val').textContent),status:document.getElementById('stressdash-status').textContent}));assert(aborted.result.name==='AbortError','activation abort did not propagate');assert(aborted.cards.every(v=>v==='—'),'aborted activation committed partial cards');assert(!aborted.status.includes('Unavailable'),'abort turned into optional Unavailable');await page.evaluate(async()=>{const d=await import('./js/utils/data.js');d.clearRequestCacheForSignal(__abortController.signal);});release();await page.evaluate(()=>__abortModule.activate({isCurrent:()=>true}));await ready();const recovered=await snap();requiredPresent(recovered);assert(recovered.cards.stlfsi.val.text!=='Unavailable','partial state cached after abort');assert(optionalCalls===2,'optional failure state cached after abort');return {kind:'explicit module AbortController; boot suppressed, real source/DOM/ECharts',aborted,recovered,nfciCalls,optionalCalls};
 });
 }
}catch(e){report.fatal={message:e.message,stack:e.stack};report.cases.push({name:stage,status:'FAIL',reason:e.message});}finally{
 if(context)await context.close();await Promise.allSettled(pending);if(browser){await browser.close();report.cleanup.browserClosed=true;}if(server){await server.close();report.cleanup.serverClosed=true;}
 report.expectedInjectedDiagnostics=report.messages.filter(m=>m.injected&&m.type!=='pageerror'&&(
 (m.type==='error'&&m.text.includes('503')&&/\/data\/(stlfsi_kcfsi|nfci|SOXX)\.json/.test(m.location?.url||''))||
 (['error','warning'].includes(m.type)&&/^\[stressdash\] load failed|^\[tabs\] stressdash activation failed/.test(m.text)&&
 ({'required-nfci503-whole-page-retry':/data\/nfci\.json: HTTP 503/,'required-nfci-noobs-whole-page-retry':/Financial stress source: invalid rows/,'required-price503-whole-page-retry':/SOXX: HTTP 503/}[m.stage])?.test(m.text))||
 (m.type==='requestfailed'&&m.text==='net::ERR_ABORTED'&&/stlfsi_kcfsi\.json/.test(m.url||'')&&m.stage.includes('interruption'))));
 report.unexpected=report.messages.filter(m=>!report.expectedInjectedDiagnostics.includes(m));
 const identityErrors=report.source.responses.filter(r=>r.injected?!r.fixtureEqual:(r.status!==200||!r.equal));
 report.cases.push({name:'HTTP-disk-identity',status:identityErrors.length?'FAIL':'PASS',evidence:identityErrors});
 report.cases.push({name:'unexpected-browser-diagnostics',status:report.unexpected.length?'FAIL':'PASS',evidence:report.unexpected});
 const externalErrors=(report.externalResponses||[]).filter(r=>r.status!==200);report.cases.push({name:'external-response-status',status:externalErrors.length?'FAIL':'PASS',evidence:externalErrors});
 report.summary={passed:report.cases.filter(c=>c.status==='PASS').length,total:report.cases.length,failed:report.cases.filter(c=>c.status==='FAIL').map(c=>c.name)};save();console.log(JSON.stringify(report.summary));console.log(path.join(out,'report.json'));process.exitCode=report.summary.failed.length?1:0;
}})();
