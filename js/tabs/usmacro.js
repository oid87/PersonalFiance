// Started from js/scaffold/_template.js; the diagnostic stays in the shared pure module.
import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { MACRO_DIAGNOSTIC_METHOD_VERSION, computeDiagnosticMA, isSupportedMacroDiagnosticMethodVersion, diagnoseUsMacro, deriveDivergenceHistory, verifyDiagnosticSnapshot, canonicalJSON } from '../utils/us_macro_diagnostic.js';

const BASE = 'data/us_macro_diagnostic_snapshots/';
const FILES = { macro_summary: 'data/us_macro_diagnostic.json', SPY: 'data/SPY.json', QQQ: 'data/QQQ.json', cpi: 'data/cpi.json', credit_spread: 'data/credit_spread.json' };
const IDS = ['DSPIC96', 'PCEC96', 'NEWORDER', 'INDPRO', 'PAYEMS', 'UNRATE', 'PERMIT', 'ISRATIO'];
const NAMES = { DSPIC96:'實質可支配所得', PCEC96:'實質消費', NEWORDER:'名目新訂單', INDPRO:'工業生產', PAYEMS:'非農就業', UNRATE:'失業率', PERMIT:'住宅建築許可', ISRATIO:'庫存銷售比' };
const FAMILY = { consumption:'實質消費', real_income:'實質所得', industrial_output:'工業生產', labor:'就業／失業率' };
const DIR = { positive:'轉強', negative:'轉弱', neutral:'持平', divergent:'分歧', insufficient:'資料不足', unclassified:'僅觀察升降', improving:'偏強', deteriorating:'偏弱', mixed:'混合', rising:'上升', falling:'下降', stable:'持平', widening:'擴大', narrowing:'收窄', above_both:'高於雙均線', below_both:'低於雙均線', between_or_equal:'位於兩線之間或相等' };
const COMP = { aligned_support:'總經與價格偏強並列', aligned_weak:'總經與價格偏弱並列', divergence_price_weak:'總經較強、價格較弱', divergence_macro_weak:'總經較弱、價格較強', neutral_price:'價格位置中性', mixed_macro:'總經方向混合', mixed_macro_and_price:'總經混合、價格中性', insufficient_price:'價格資料不足', insufficient_macro:'總經資料不足', insufficient_both:'兩軸資料不足' };
const FLOW = {real_income:'實質所得',consumption:'實質消費',nominal_orders:'名目新訂單',industrial_output:'工業生產',labor:'就業',purchasing_power_feedback:'家庭購買力回饋',housing_permits:'住宅許可（旁支）',inventory_sales_ratio:'庫存銷售比（旁支）'};
const CHECK = {income_to_consumption:'追蹤下一筆實質所得與消費',orders_to_output:'追蹤下一筆工業生產',labor_split:'追蹤下一筆就業與失業率',macro_price_SPY:'追蹤共同月與 SPY 雙均線',macro_price_QQQ:'追蹤共同月與 QQQ 雙均線',hy_spread:'追蹤下一筆 HY 利差',next_common_month:'追蹤下一個共同月與兩標的收盤位置'};
const LEVEL_UNITS = {
  DSPIC96:['Billions of Chained 2017 Dollars, SAAR','十億美元（2017年幣值、季調年率）'],
  PCEC96:['Billions of Chained 2017 Dollars, SAAR','十億美元（2017年幣值、季調年率）'],
  NEWORDER:['Millions of Dollars, SA','百萬美元（名目、季調）'],
  INDPRO:['Index 2017=100, SA','指數（2017年=100、季調）'],
  PAYEMS:['Thousands of Persons, SA','千人（季調）'],
  UNRATE:['Percent, SA','%（季調）'],
  PERMIT:['Thousands of Units, SAAR','千戶（季調年率）'],
  ISRATIO:['Ratio','比率（季調）'],
};
const levelUnit = (id, raw) => raw === LEVEL_UNITS[id]?.[0] ? LEVEL_UNITS[id][1] : esc(raw);
const unitText = value => ({pp:'百分點','ratio difference':'比率差','%':'%'}[value] ?? esc(value));
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (value, digits=2) => value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-TW',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const dateText = value => value ? new Date(value).toLocaleString('zh-TW', {timeZone:'Asia/Taipei',hour12:false}) : '—';
const stateText = value => DIR[value] ?? '資料不足';
const sourceLink = value => /^https:\/\/(?:fred\.stlouisfed\.org|api\.stlouisfed\.org)\//.test(value ?? '') ? value : null;
export function needsUsMacroRefresh(asOf, now = Date.now()) {
  const asOfMs = Date.parse(asOf), nowMs = Number(now);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(nowMs)) return false;
  if (nowMs - asOfMs > 36 * 3600000) return true;
  const taipei = new Date(nowMs + 8 * 3600000);
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    const day = new Date(Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), taipei.getUTCDate() - daysAgo));
    if (day.getUTCDay() < 2 || day.getUTCDay() > 6) continue;
    const scheduledAt = day.getTime() - 2 * 3600000; // Taipei 06:00 = previous UTC day 22:00.
    if (asOfMs < scheduledAt && scheduledAt <= nowMs) return true;
  }
  return false;
}
let loaded = false, activeSymbol = 'SPY', chart = null, diagnosis = null, sources = null;

async function optionalJSON(path) {
  try { const value = await fetchJSON(path); return Array.isArray(value) ? {data:value} : value; }
  catch (error) { if (/HTTP 404\b/.test(error.message)) return null; throw error; }
}
async function readInputs() {
  let macroSummary;
  try { macroSummary = await fetchJSON(FILES.macro_summary); }
  catch (error) { if (/HTTP 404\b/.test(error.message)) return null; throw error; }
  const [spy, qqq, cpi, creditSpread] = await Promise.all([optionalJSON(FILES.SPY), optionalJSON(FILES.QQQ), optionalJSON(FILES.cpi), optionalJSON(FILES.credit_spread)]);
  return {asOf:macroSummary.as_of,methodVersion:MACRO_DIAGNOSTIC_METHOD_VERSION,macroSummary,prices:{SPY:spy,QQQ:qqq},cpi,creditSpread};
}
function evidence(id, indicator, summary) {
  const source = summary.indicators[id], metadata = source.metadata ?? {};
  const rows = source.observations ?? [];
  const used = new Set(indicator.evidence.map(x => x.reference_month));
  const available = rows.filter(x => used.has(x.reference_month));
  const sourceUrl = sourceLink(source.source_url) ?? sourceLink(metadata.metadata_url);
  return `<details><summary>資料與計算依據</summary>
    <p>來源：${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(metadata.institution ?? id)} · ${esc(id)}</a>` : `${esc(metadata.institution ?? id)} · ${esc(id)}`} · 單位 ${esc(source.units)} · ${esc(metadata.seasonal_adjustment ?? '未提供季調')} · ${esc(metadata.price_basis ?? '未提供名實口徑')}</p>
    <p>參考月份 ${esc(indicator.reference_month)} · 擷取 ${esc(dateText(source.retrieved_at))} · 公布時間 ${source.release_at ? esc(dateText(source.release_at)) : '未提供'} · 本摘要為最新修訂值，非歷史市場當時可知。</p>
    <p>三月變動：${id === 'UNRATE' || id === 'ISRATIO' ? '本月水準 − 三個月前水準' : '(本月水準 ÷ 三個月前水準 − 1) × 100'}；同比需連續 13 個月有效值。${id === 'UNRATE' ? '失業率上升代表經濟方向轉弱。' : ''}</p>
    <p>原值：${available.map(x => `${esc(x.reference_month)} ${esc(x.raw_value)} (${fmt(x.value,3)})`).join(' · ') || '可用窗口不足'}</p>
  </details>`;
}
function indicatorCard(id) {
  const i = diagnosis.macro.indicators[id];
  const movement = id === 'ISRATIO' ? ` · ${stateText(i.movement)}` : '';
  return `<article class="um-card"><h3>${NAMES[id]}</h3><strong>${stateText(i.direction)}${movement}</strong>
    <p>${fmt(i.level,3)} ${levelUnit(id,i.level_units)} <span class="um-muted">· ${esc(i.reference_month)}</span></p>
    <p class="um-muted">三月累計 ${fmt(i.change_3m,2)} ${unitText(i.change_3m_units)} · 同比 ${fmt(i.yoy,2)} ${unitText(i.yoy_units)}</p>
    ${i.stale ? '<p class="um-muted">資料過期</p>' : ''}${i.source_status === 'failed' ? '<p class="um-muted">本次擷取失敗，沿用已保存資料</p>' : ''}${evidence(id,i,sources.macroSummary)}</article>`;
}
function backgroundCard(key,label,item,url,note) {
  return `<article class="um-card"><h3>${label}</h3><strong>${item.status === 'observed' ? stateText(item.direction) : '資料不足'}</strong>
    <p>${fmt(item.level,2)}% <span class="um-muted">· ${esc(item.reference_date)}</span></p>
    <p class="um-muted">變動 ${fmt(item.change,2)} pp${item.stale ? ' · 已過期' : ''}</p>
    <details><summary>資料與計算依據</summary><p><a href="${url}" target="_blank" rel="noopener noreferrer">來源 ${label}</a> · 單位 ${key === 'hy' ? '百分點（%）' : '同比百分比'} · ${note}</p><p>參考 ${esc(item.reference_date)} · 比較日期 ${esc(item.evidence_dates.join('、'))} · 公布時間未提供。最新檔案可修訂，非歷史市場當時可知。</p></details></article>`;
}
function priceCard(symbol) {
  const p = diagnosis.prices[symbol], c = diagnosis.comparison[symbol];
  return `<article class="um-card"><h3>${symbol} · 原始收盤</h3><strong>${stateText(p.state)}</strong>
    <p>${fmt(p.close,2)} <span class="um-muted">· ${esc(p.reference_date)}${p.stale ? ' · 過期' : ''}</span></p>
    <p class="um-muted">取診斷日前一交易日收盤</p>
    <p class="um-muted">SMA125 ${fmt(p.sma125,2)} · 乖離 ${fmt(p.deviation125_pct,2)}%</p>
    <p class="um-muted">SMA150 ${fmt(p.sma150,2)} · 乖離 ${fmt(p.deviation150_pct,2)}%</p>
    <p>${esc(COMP[c.code] ?? c.code)}</p><details><summary>資料與比較方法</summary><p><a href="${p.source}">${symbol} 原始價格檔</a>；先取診斷日以前收盤，最後 150 筆算雙均線；最近 150 筆有缺值則不足。日期 ${esc(p.reference_date)} 與總經月份 ${esc(c.macro_reference_month)} 各自保留，並列不代表因果或交易時點。</p></details></article>`;
}
function renderFlow() {
  const links = diagnosis.transmission.links;
  const main = links.slice(0,6), branches = links.slice(6);
  const card = link => `<article class="um-card"><strong>${esc(FLOW[link.id] ?? link.id)}</strong><p class="um-muted">${link.coverage === 'observed' ? '可觀察' : '證據不足'} · ${link.observation.map(x => `${NAMES[x.series_id]} ${stateText(x.direction)}`).join('、')}</p><details><summary>傳導證據</summary>${link.evidence.map(x => `<p>${esc(x.series_id)} ${esc(x.reference_month)} 原值 ${esc(x.raw_value)} ${esc(x.units)}</p>`).join('') || '<p>證據不足</p>'}</details></article>`;
  return `<div class="um-flow">${main.map((l,i) => `${i ? '<span aria-hidden="true">→</span>' : ''}${card(l)}`).join('')}</div><div class="um-grid">${branches.map(card).join('')}</div><p class="um-muted">箭頭只表示待驗證的經濟敘事順序，不表示已識別因果。尚未覆蓋：${diagnosis.transmission.uncovered.map(esc).join('、')}。</p>`;
}
function maPoints(input, period, cutoff) {
  const rows = input?.data?.filter(row => row.date < cutoff) ?? [];
  const out = [], segment = [];
  const flush = () => { if (segment.length) { const values = new Map(computeDiagnosticMA(segment,period).map(([d,v]) => [d,v])); for (const [d] of segment) out.push([d,values.get(d) ?? null]); segment.length=0; } };
  for (const row of rows) { if (row.close == null) { flush(); out.push([row.date,null]); } else segment.push([row.date,row.close]); }
  flush();
  return out;
}
function drawChart() {
  const input = sources?.prices[activeSymbol], host = document.getElementById('usmacro-chart');
  if (!host) return;
  const cutoff = diagnosis.as_of.slice(0,10);
  const rows = Array.isArray(input?.data) ? input.data.filter(r => r?.date < cutoff) : [];
  if (typeof echarts === 'undefined' || !rows.some(r => Number.isFinite(r.close) && r.close > 0)) {
    chart?.dispose(); chart = null;
    host.textContent = `${activeSymbol} 價格資料不足，無法繪圖。`;
    host.setAttribute('role','status');
    return;
  }
  host.removeAttribute('role');
  if (!chart) { host.textContent = ''; chart = echarts.init(host, isLight() ? null : 'dark'); }
  const last = rows.at(-1)?.date;
  const start = new Date(`${last}T00:00:00Z`); start.setUTCFullYear(start.getUTCFullYear()-1);
  const first = start.toLocaleDateString('sv-SE',{timeZone:'UTC'});
  const clip = pts => pts.filter(([d]) => d >= first);
  const series = [
    {name:'原始收盤',data:clip(rows.map(r => [r.date,r.close])),color:PALETTE.text},
    {name:'SMA125',data:clip(maPoints(input,125,cutoff)),color:PALETTE.muted},
    {name:'SMA150',data:clip(maPoints(input,150,cutoff)),color:PALETTE.text2},
  ];
  chart.setOption(echartsBase({
    legend:{top:0,textStyle:{color:PALETTE.text}},grid:{top:42,bottom:35,left:55,right:14},
    xAxis:{type:'time'},yAxis:{type:'value',scale:true},
    tooltip:{trigger:'axis',formatter:items => `<b>${esc(new Date(items[0].axisValue).toLocaleDateString('sv-SE'))}</b><br>${items.map(x => `${esc(x.seriesName)}：${fmt(x.value?.[1],2)}`).join('<br>')}`},
    series:series.map(s=>({name:s.name,type:'line',data:s.data,showSymbol:false,connectNulls:false,itemStyle:{color:s.color},lineStyle:{width:s.name==='原始收盤'?2:1.5,type:s.name==='SMA150'?'dashed':'solid'}})),
  }),{notMerge:true});
  chart.resize();
}
async function rawHash(path) {
  const response = await fetch(path,{cache:'no-cache'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256',bytes);
  return `sha256:${[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}`;
}
async function loadHistory() {
  const host = document.getElementById('usmacro-history');
  let index;
  try { index = await fetchJSON(`${BASE}index.json`); }
  catch (error) { if (/HTTP 404\b/.test(error.message)) { host.textContent='尚未開始累積正式快照'; return; } host.textContent=`歷史無法驗證：${error.message}`; return; }
  try {
    if (index?.schema_version !== 1 || !Array.isArray(index.entries)) throw new Error('快照索引結構錯誤');
    let previous = '', seen = new Set();
    for (const entry of index.entries) {
      if (!isSupportedMacroDiagnosticMethodVersion(entry.method_version)) throw new Error(`不支援診斷方法版本：${entry.method_version}`);
      if (!/^\d{4}\/\d{4}-\d\d-\d\d\.json$/.test(entry.path) || entry.path.slice(0,4) !== entry.path.slice(5,9) || !/^sha256:[0-9a-f]{64}$/.test(entry.sha256) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.as_of) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.captured_at) || !Number.isFinite(Date.parse(entry.as_of)) || !Number.isFinite(Date.parse(entry.captured_at)) || entry.captured_at < entry.as_of || entry.as_of <= previous || seen.has(entry.path)) throw new Error('快照索引項目無效');
      const taipeiDate = new Date(entry.as_of).toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'});
      if (entry.path !== `${taipeiDate.slice(0,4)}/${taipeiDate}.json`) throw new Error('索引日期與路徑不符');
      previous = entry.as_of; seen.add(entry.path);
    }
    if (!index.entries.length) { host.textContent='尚未開始累積正式快照'; return; }
    const selected = index.entries.slice(-120), snapshots=[];
    for (const entry of selected) {
      const response = await fetch(`${BASE}${entry.path}`,{cache:'no-cache'});
      if (!response.ok) throw new Error(`快照 HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256',bytes);
      const hash = `sha256:${[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}`;
      if (hash !== entry.sha256) throw new Error('快照檔案雜湊不符');
      const snapshot = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if (snapshot.as_of !== entry.as_of || snapshot.captured_at !== entry.captured_at || snapshot.method_version !== entry.method_version || entry.path !== `${snapshot.local_date_Taipei.slice(0,4)}/${snapshot.local_date_Taipei}.json`) throw new Error('快照與索引不一致');
      await verifyDiagnosticSnapshot(snapshot); snapshots.push(snapshot);
    }
    const last = snapshots.at(-1), hashes = {};
    for (const [key,path] of Object.entries(FILES)) hashes[key] = await rawHash(path);
    const liveMatches = last.as_of === diagnosis.as_of && last.method_version === diagnosis.method_version && canonicalJSON(last.diagnostic_output) === canonicalJSON(diagnosis) && Object.keys(FILES).every(k => last.source_file_sha256[k] === hashes[k]);
    const history = await deriveDivergenceHistory(snapshots,null,new Date().toISOString().replace(/\.\d{3}Z$/,'Z'));
    const phase = {observed_start:'首次觀察到背離',persistent:'背離持續',converged:'已收斂',ended_unresolved:'背離結束，未對齊',changed_type:'背離類型改變',no_divergence:'未見背離',insufficient:'資料不足'};
    host.innerHTML=`<p>已保存歷史：${esc(dateText(selected[0].as_of))} 至 ${esc(dateText(last.as_of))}；檢視最近 ${snapshots.length} 份／索引共 ${index.entries.length} 份。${liveMatches ? '本次診斷與最後保存資料一致。' : '歷史截至最後保存時間；本次診斷尚未保存。'}</p>${['SPY','QQQ'].map(s=>{const h=history[s];return `<div class="um-history-row"><strong>${s}</strong> · ${esc(phase[h.phase]??'尚無可驗證狀態')}${h.observed_since ? ` · 首次觀察 ${esc(dateText(h.observed_since))} · ${h.observed_snapshots} 份已保存快照${h.left_censored?'（左側截斷，不能推定起始日）':''}` : ''}</div>`}).join('')}`;
  } catch (error) { host.textContent=`歷史無法驗證：${error.message}`; }
}
function render() {
  const m=diagnosis.macro, counts=m.counts;
  document.getElementById('usmacro-meta').innerHTML=`B 摘要擷取 ${esc(dateText(diagnosis.as_of))}<br>本頁快取重算 ${esc(dateText(new Date()))}<br>核心共同月份 ${esc(m.reference_month)}<br>摘要距今 ${Math.max(0,Math.floor((Date.now()-Date.parse(diagnosis.as_of))/3600000))} 小時`;
  const old=needsUsMacroRefresh(diagnosis.as_of);
  document.getElementById('usmacro-status').textContent=`${old?'B 摘要已超過 36 小時，或跨過週二至週六 06:00 台北排程日，尚未刷新。':''}以目前快取重算，資料日期依 B 摘要時間截取；不代表當時已保存的診斷。四組指標：${stateText(m.direction)}；${counts?`轉強 ${counts.positive}／轉弱 ${counts.negative}／持平 ${counts.neutral}／分歧 ${counts.divergent}，固定分母 ${counts.denominator}`:'方向資料不足，固定分母 4 未能計票'}。${m.broad_weakening===true?'符合狹義轉弱擴散條件。':m.broad_weakening===false?'未符合狹義轉弱擴散條件。':'擴散條件資料不足。'}`;
  document.getElementById('usmacro-content').innerHTML=`<div class="um-section"><h3>四組實體經濟指標</h3><div class="um-grid">${Object.entries(FAMILY).map(([key,label])=>`<article class="um-card"><h3>${label}</h3><strong>${stateText(m.families[key].direction)}</strong><p class="um-muted">${m.families[key].indicators.map(id=>`${NAMES[id]}：${stateText(m.indicators[id].direction)}`).join(' · ')}</p></article>`).join('')}</div></div>
    <div class="um-section"><h3>六面向與補充證據</h3><div class="um-grid">${IDS.map(indicatorCard).join('')}</div></div>
    <div class="um-section"><h3>價格與總經並列</h3><div class="um-grid">${['SPY','QQQ'].map(priceCard).join('')}</div><div class="picker-row" id="usmacro-picker"><span class="chip active" data-usmacro-symbol="SPY">SPY</span><span class="chip" data-usmacro-symbol="QQQ">QQQ</span></div><div id="usmacro-chart" class="um-chart"></div><p class="um-muted">原始 close 與 SMA125／SMA150；先以完整可用資料計算，再只展示近一年。價格／月份參考日期可能不同。</p></div>
    <div class="um-section"><h3>通膨與信用背景</h3><div class="um-grid">${backgroundCard('headline','CPI 總指數',diagnosis.background.cpi.headline,'https://fred.stlouisfed.org/series/CPIAUCSL','季調指數計算同比；三月差為百分點')}${backgroundCard('core','核心 CPI',diagnosis.background.cpi.core,'https://fred.stlouisfed.org/series/CPILFESL','季調指數計算同比；三月差為百分點')}${backgroundCard('hy','HY 信用利差',diagnosis.background.hy,'https://fred.stlouisfed.org/series/BAMLH0A0HYM2','ICE BofA OAS；最近 21 筆差為百分點')}</div></div>
    <div class="um-section"><h3>觀察傳導鏈</h3>${renderFlow()}<h3>下一驗證點</h3><p>${diagnosis.transmission.next_checks.map(x=>esc(CHECK[x.id]??x.id)).join('；')}</p></div>
    <div class="um-section"><h3>正式快照歷史</h3><div id="usmacro-history" class="um-alert">核對中…</div><p class="um-muted">快照只從正式保存當天開始累積；最新修訂資料不可回填成過去市場當時可知的診斷。</p></div>`;
  chipPicker(document.getElementById('usmacro-picker'),'usmacro-symbol',symbol=>{activeSymbol=symbol;drawChart();});
  drawChart();
}
export async function activate() {
  if (loaded) { chart?.resize(); return; }
  const status=document.getElementById('usmacro-status');
  if (!bindOnce(status)) return;
  try {
    sources=await readInputs();
    if (!sources) { status.textContent='美國總經摘要無資料（B 摘要檔不存在）。'; loaded=true; return; }
    diagnosis=diagnoseUsMacro(sources);
    render(); loaded=true;
    await loadHistory();
  } catch(error) { status.textContent=`資料錯誤：${error.message}`; document.getElementById('usmacro-content').textContent='無法安全顯示診斷。'; loaded=true; }
}
export function onThemeChange() { if (chart && diagnosis) { chart.dispose(); chart=null; drawChart(); } }
export function resize() { chart?.resize(); }
