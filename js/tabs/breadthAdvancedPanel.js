import { parseBreadthImport, buildAdvancedContext, projectSp500Bundle } from './breadthAdvanced.mjs';
import { evaluateEventStudy } from '../utils/eventStudy.mjs';
import { echartsBase, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';
import { bindOnce } from '../utils/dom.js';

const el = suffix => document.getElementById(`breadth-advanced-${suffix}`);
const charts = new Map();
let bundle = null, context = null, study = null, selected = null, request = 0;
const num = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const pct = value => Number.isFinite(value) ? `${num(value)}%` : '—';
function clear(message = '等待匯入本機 JSON') {
  bundle = context = study = selected = null;
  el('results').hidden = true;
  for (const chart of charts.values()) chart.dispose();
  charts.clear();
  for (const id of ['metadata','study-status','selection']) el(id).textContent = '';
  for (const id of ['table','events']) el(id).replaceChildren();
  el('status').textContent = message;
}
function chart(id, options) {
  if (!charts.has(id)) charts.set(id, echarts.init(el(id)));
  charts.get(id).setOption(echartsBase({tooltip:{confine:true},...options}), { notMerge:true });
}
const line = (name, data, color, extra = {}) => ({ name, type:'line', data, showSymbol:false, connectNulls:false, itemStyle:{color}, lineStyle:{color}, ...extra });
function startDate() {
  const range = el('range').value;
  if (range === 'MAX') return null;
  const tail = context.prices.at(-1).date;
  const d = new Date(`${tail}T00:00:00Z`), month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - Number(range.slice(0,-1)));
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d.toISOString().slice(0,10);
}
function renderIndicators(from) {
  const rows = context.sessions.filter(s => !from || s.date >= from), dates = rows.map(s => s.date);
  const events = key => context.signals[key].filter(e => dates.includes(e.date));
  const markers = (key, field, color) => ({ name:{ad:'P3 A-D',mc:'P4 McClellan',joint:'P5 聯合'}[key],type:'scatter',symbol:'triangle',symbolSize:10,itemStyle:{color},data:events(key).map(e => [e.date,rows.find(r=>r.date===e.date)?.[field]]),label:{show:false} });
  const axis = {data:dates,boundaryGap:false};
  const legend = {textStyle:{color:PALETTE.text},top:0};
  chart('ad-chart',{legend,xAxis:axis,grid:{top:55,right:65,bottom:42},yAxis:[{type:'value',scale:true,axisLabel:{color:PALETTE.muted},splitLine:{lineStyle:{color:PALETTE.grid}}},{type:'value',scale:true,axisLabel:{color:PALETTE.muted},splitLine:{show:false}}],series:[line('S&P500 指數',rows.map(s=>s.close),'#a371f7',{yAxisIndex:1}),line('SP500 A-D',rows.map(s=>s.ad),'#58a6ff'),line('A-D 200MA',rows.map(s=>s.adMA200),'#e3b341'),markers('ad','ad','#f85149'),markers('joint','ad','#3fb950')]});
  chart('osc-chart',{legend,xAxis:axis,grid:{top:45,bottom:42},series:[line(`NYSE Oscillator (${context.meta.variant ?? '未匯入'})`,rows.map(s=>s.oscillator),'#58a6ff')]});
  chart('sum-chart',{legend,xAxis:axis,grid:{top:55,bottom:42},series:[line(`NYSE Summation (${context.meta.variant ?? '未匯入'})`,rows.map(s=>s.summation),'#a371f7',context.meta.calibrated ? {markLine:{symbol:'none',silent:true,lineStyle:{type:'dashed'},data:[{yAxis:-500,label:{formatter:'−500',position:'insideEndTop'}}]}} : {}),markers('mc','summation','#f85149'),markers('joint','summation','#3fb950')]});
}
function table(id, headers, rows, eventButtons = false) {
  const head = document.createElement('thead'), body = document.createElement('tbody'), tr = document.createElement('tr');
  headers.forEach(text => {const th=document.createElement('th');th.textContent=text;tr.append(th);});head.append(tr);
  rows.forEach((cells,i) => {
    const row = document.createElement('tr');
    if (id === 'table') row.dataset.horizon = study.stats[i].horizon;
    cells.forEach((text,j) => {const td=document.createElement('td');if(eventButtons && j===0){const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.eventDate=text;b.setAttribute('aria-pressed',String(selected===text));td.append(b);}else td.textContent=String(text);row.append(td);});body.append(row);
  });
  el(id).replaceChildren(head,body);
}
function renderPath() {
  const points = study.paths.points, individual = study.paths.individual.find(p=>p.date===selected);
  const series = [line('P25',points.map(p=>p.p25),'#8b949e',{lineStyle:{type:'dashed'}}),line('P75',points.map(p=>p.p75),'#8b949e',{lineStyle:{type:'dashed'}}),line('完整固定樣本中位數',points.map(p=>p.median),'#58a6ff')];
  if (individual) series.push(line(`事件 ${individual.date}`,individual.values,'#d29922'));
  el('selection').textContent = individual ? `選取 ${individual.date}；${individual.complete?'完整路徑':'未完成或缺價；缺口後不接線'}` : '點選事件日期查看個別路徑';
  chart('path-chart',{legend:{textStyle:{color:PALETTE.text},top:0},grid:{top:55,bottom:42},xAxis:{data:points.map(p=>p.offset),name:'交易日',nameLocation:'middle',nameGap:26},yAxis:{scale:true},series,graphic:study.paths.n?[]:[{type:'text',left:'center',top:'middle',style:{text:'無完整事件可計算分位線',fill:PALETTE.muted}}]});
}
function render() {
  if (!context) return;
  const signal = el('signal').value, from = startDate(), horizon = Number(el('horizon').value);
  study = evaluateEventStudy({prices:context.prices,events:context.signals[signal],eligibleDates:context.eligibleDates[signal],from,cooldownSessions:20,pathHorizon:horizon});
  if (!study.events.some(e=>e.date===selected)) selected = null;
  const blocked = signal !== 'ad' && !context.meta.calibrated;
  const unavailable = (signal === 'ad' && !bundle.sp500) ? 'P3 無法研究：未匯入 SP500 家數。 ' : (signal === 'mc' && !bundle.nyse) ? 'P4 無法研究：未匯入 NYSE 家數。 ' : (signal === 'joint' && (!bundle.sp500 || !bundle.nyse)) ? 'P5 無法研究：需要 SP500 與 NYSE 家數。 ' : '';
  const effectiveN = study.stats.find(s => s.horizon === horizon).n;
  el('study-status').textContent = `${unavailable}${blocked?'P4/P5 門檻事件停用：缺供應者校準 seed。 ':''}原始 ${study.rawN} 次；20 session 冷卻後 ${study.keptN} 次；${horizon} session 固定完整樣本 n=${study.paths.n}${effectiveN < 10?'；小樣本，有效 n<10，僅供描述':''}`;
  table('table',['期間 session','有效 n','平均','中位數','勝率','平均最大虧損','最差最大虧損','平均 MDD','最差 MDD','基準 n','基準平均','基準中位數','基準勝率','基準平均最大虧損','基準平均 MDD','平均差 pp','相鄰重疊','未完成','缺價'],study.stats.map(s=>[s.horizon,s.n,pct(s.mean),pct(s.median),pct(s.winRate),pct(s.meanMaxLoss),pct(s.worstMaxLoss),pct(s.meanMdd),pct(s.worstMdd),s.baseline.n,pct(s.baseline.mean),pct(s.baseline.median),pct(s.baseline.winRate),pct(s.baseline.meanMaxLoss),pct(s.baseline.meanMdd),num(s.mean===null||s.baseline.mean===null?null:s.mean-s.baseline.mean),`${s.overlapPairs}/${s.possiblePairs}`,s.excluded.incomplete,s.excluded.missingPrice]));
  table('events',['事件日','A-D 原始日','MC 原始日','間隔 session','A-D','AD200','Summation','狀態','報酬','最大虧損','MDD'],study.events.map(e=>[e.date,e.adDate??'—',e.mcDate??'—',e.lagSessions??'—',num(e.ad),num(e.adMA200),num(e.summation),e.outcomes[horizon].status,pct(e.outcomes[horizon].forwardReturnPct),pct(e.outcomes[horizon].maxLossPct),pct(e.outcomes[horizon].mddPct)]),true);
  renderIndicators(from);renderPath();
}
function applyBundle(token, input, extraNotes = []) {
  if (token !== request) return;
  const parsed = parseBreadthImport(input), built = buildAdvancedContext(parsed);
  bundle = parsed;context = built;
  el('results').hidden = false;
  const metadata = [`benchmark SP500：${bundle.benchmark.source}；價格 ${bundle.benchmark.priceBasis}`];
  for (const key of ['sp500','nyse']) if(bundle[key]) metadata.push(`${bundle[key].universe}：${bundle[key].source}；成分 ${bundle[key].constituentsBasis}；價格 ${bundle[key].priceBasis}`);
  metadata.push(`NYSE 版本：${context.meta.variant??'未匯入'}；${context.meta.calibrated ? `供應者 seed：${bundle.nyse.seed.date} / ${bundle.nyse.seed.source}；EMA19=${bundle.nyse.seed.ema19}，EMA39=${bundle.nyse.seed.ema39}，Summation=${bundle.nyse.seed.summation}；校準由匯入者提供，未經外部核實` : '未校準：首筆有效 net 初始化兩 EMA，Summation=0；P4/P5 門檻事件停用'}`);
  metadata.push(`最後一筆日期 benchmark ${context.latest.benchmark??'—'}；SP500 ${context.latest.sp500??'—'}；NYSE ${context.latest.nyse??'—'}。SP500 缺值 ${context.diagnostics.missingSp500}；NYSE 缺值 ${context.diagnostics.missingNyse}。${context.diagnostics.mcInvalidated?'NYSE 缺口使當天及後續計算停止；請補齊歷史再匯入。':''}`);
  metadata.push(...extraNotes);
  el('metadata').textContent = metadata.join('\n');
  el('status').textContent = `已匯入 ${context.prices.length} benchmark sessions；僅在記憶體保留`;
  render();
}
async function loadProject() {
  const token = ++request;
  clear('載入專案資料…');
  try {
    const [adFile, sp500File] = await Promise.all([fetchJSON('data/sp500_ad.json', { raw:true }), fetchJSON('data/SP500.json', { raw:true })]);
    if (token !== request) return;
    const { bundle, droppedDates } = projectSp500Bundle(adFile, sp500File);
    applyBundle(token, bundle, ['⚠ 自算：現任成分股、非 point-in-time，含倖存者偏誤，可能影響 A-D 線與事件日期；僅供描述性參考。', `丟棄 ${droppedDates.length} 個不在 ^GSPC 交易日軸上的 A/D 日期`]);
  } catch(error) { if(token===request) clear(`匯入失敗：${error.message}`); }
}
async function importFile(file) {
  const token = ++request;
  clear(file ? '讀取本機檔案…' : '等待匯入本機 JSON');
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('檔案超過 10 MiB');
    const text = await file.text();
    if (token !== request) return;
    applyBundle(token, text);
  } catch(error) {if(token===request) clear(`匯入失敗：${error.message}`);}
}
function downloadTemplate() {
  const metadata = {source:'請填資料來源',constituentsBasis:'請填歷史成分股依據',priceBasis:'請填價格口徑',data:[]};
  const template = {schemaVersion:1,benchmark:{symbol:'SP500',source:'請填 S&P500 指數資料來源',priceBasis:'請填價格口徑',data:[]},sp500:{universe:'SP500',...metadata},nyse:{universe:'NYSE',...metadata,variant:'ratio',seed:null}};
  const url=URL.createObjectURL(new Blob([JSON.stringify(template,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='breadth-import-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function initAdvancedPanel() {
  if (!bindOnce(el('panel'))) return;
  el('file').addEventListener('change',()=>importFile(el('file').files[0]));
  el('clear').addEventListener('click',()=>{++request;el('file').value='';clear();});
  el('template').addEventListener('click',downloadTemplate);
  el('project').addEventListener('click',loadProject);
  for(const id of ['signal','range','horizon']) el(id).addEventListener('change',render);
  el('events').addEventListener('click',event=>{const b=event.target.closest('button[data-event-date]');if(!b)return;selected=b.dataset.eventDate;el('events').querySelectorAll('button').forEach(node=>node.setAttribute('aria-pressed',String(node===b)));renderPath();});
}
export function advancedThemeChange() {for(const c of charts.values())c.dispose();charts.clear();if(context)render();}
export function resizeAdvancedPanel() {for(const c of charts.values())c.resize();}
