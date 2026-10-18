// Risk-only page, based on js/scaffold/_template.js lifecycle.
import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { validateBundle, runStudy, latestOverview, confirmationAt, rollContaminated, goodBar, nyDate, latestVersions, strictOutlook } from './usrisk_calc.mjs';
import { infoButton, initInfoPopovers } from '../utils/info_popover.js';
import { HELP, MODES } from './usrisk_controls.mjs';

let bundle, result, backgroundResult, charts = [], generation = 0;
const studyCache = new Map();   // key: JSON(config) → runStudy result; cleared whenever a different bundle object is loaded
const byId = id => document.getElementById('usrisk-' + id);
const num = (x, digits = 2) => typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'unavailable';
const pct = x => x == null ? 'unavailable' : num(x) + '%';
const status = text => { byId('status').textContent = text; };
function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
function info(key) { return infoButton(HELP[key], '說明：' + key); }
function cachedStudy(config) {
  const key = JSON.stringify(config);
  if (!studyCache.has(key)) studyCache.set(key, runStudy(bundle, config));
  return studyCache.get(key);
}
function selectOptions(el, values, selected) {
  el.replaceChildren(...values.map(([value, label]) => {
    const option = node('option', label, { value }); option.selected = String(value) === String(selected); return option;
  }));
}
function control(id, label, values, selected) {
  const host = node('div', null, { class: 'usrisk-control' }), title = node('label', label + ' ', { for: 'usrisk-' + id });
  title.append(info(id));
  const select = node('select', null, { id: 'usrisk-' + id }); selectOptions(select, values, selected);
  host.append(title, select); return host;
}
function controls() {
  if (!bindOnce(byId('controls'))) return;
  byId('controls').append(
    control('asset', '研究標的', [['SPY', 'SPY'], ['QQQ', 'QQQ']], 'QQQ'),
    control('dataMode', '資料口徑', [['strict', '嚴格可得版本'], ['historical', '歷史收盤重建（非 PIT）']], 'strict'),
    control('mode', '日頻壓力指標', Object.entries(MODES).map(([k, v]) => [k, v.label]), 'vix'),
    control('gate', '回撤閘門', [0, 8, 10, 15].map(v => [v, v + '%']), 8),
    control('thresholdMode', '門檻方法', [['fixed', '明示假設門檻'], ['percentile', '滾動歷史分位數']], 'fixed'),
    control('threshold', '壓力門檻', [], ''),
    control('cooldown', '事件冷卻', [[10, '10 個交易日（固定）']], 10),
    control('horizon', '研究視窗', [5, 10, 20, 60].map(v => [v, v + ' 個交易日']), 20));
  setThreshold();
  byId('controls').addEventListener('change', event => {
    if (['usrisk-mode', 'usrisk-thresholdMode'].includes(event.target.id)) setThreshold();
    const ticket = ++generation; status('正在依目前參數計算…');
    setTimeout(() => { if (ticket === generation) { try { renderStudy(); } catch (e) { clearStudy(); status('研究不可用：' + e.message); } } }, 0);
  });
  byId('background-control').append(control('background', '週月背景', [
    ['CFTC_ES', 'CFTC S&P 500 consolidated'], ['CFTC_NQ', 'CFTC Nasdaq-100 consolidated'], ['CFTC_RTY', 'CFTC Russell E-mini'],
    ['NFCI_RISK', 'NFCI risk'], ['NFCI_CREDIT', 'NFCI credit'], ['NFCI_LEVERAGE', 'NFCI leverage'], ['FINRA', 'FINRA margin debt'],
  ], 'CFTC_ES'));
  byId('background').addEventListener('change', () => drawBackground());
}
function setThreshold() {
  const mode = MODES[byId('mode').value], rolling = byId('thresholdMode').value === 'percentile';
  const vals = rolling ? (mode.low ? [5, 10, 20] : [80, 90, 95]) : mode.options;
  selectOptions(byId('threshold'), vals.map(v => [v, rolling ? '過去分布 P' + v : (mode.low ? '≤ ' : '≥ ') + v + mode.unit]), rolling ? (mode.low ? 10 : 90) : mode.value);
}
function config() {
  const value = id => byId(id).value;
  return { asset: value('asset'), dataMode: value('dataMode'), mode: value('mode'), gate: +value('gate'), thresholdMode: value('thresholdMode'),
    threshold: +value('threshold'), percentile: value('thresholdMode') === 'percentile' ? +value('threshold') : (MODES[value('mode')].low ? 10 : 90), cooldown: 10, horizon: +value('horizon') };
}
function priceRatio(a, b) {
  const right = new Map(latestVersions(bundle, b).map(r => [r.date, r])), axis = latestVersions(bundle, a), last = axis.at(-1), prior = axis.at(-21);
  if (![last, prior, right.get(last?.date), right.get(prior?.date)].every(goodBar)) return { value: null, date: last?.date };
  return { value: (last.values.close / right.get(last.date).values.close / (prior.values.close / right.get(prior.date).values.close) - 1) * 100, date: last.date };
}
function card(title, value, date, note) {
  const host = node('article', null, { class: 'ui-card' });
  host.append(node('h3', title), node('div', value, { class: 'usrisk-value' }), node('p', '觀測：' + (date || 'unavailable'), { class: 'status' }), node('p', note, { class: 'note-muted' }));
  return host;
}
function table(id, headers, rows) {
  const el = node('table'), thead = node('thead'), tr = node('tr'), body = node('tbody');
  for (const text of headers) { const cell = node('th'); cell.append(text instanceof Node ? text : document.createTextNode(String(text))); tr.append(cell); }
  thead.append(tr);
  if (!rows.length) rows = [['unavailable：沒有符合條件的資料']];
  for (const row of rows) { const r = node('tr'); row.forEach((value, i) => { const cell = node(i === 0 ? 'th' : 'td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value ?? 'unavailable'))); r.append(cell); }); body.append(r); }
  el.append(thead, body); byId(id).replaceChildren(el);
}
function renderOverview() {
  const o = latestOverview(bundle), scalar = id => o[id]?.record?.values.value ?? null, cards = [];
  for (const asset of ['SPY', 'QQQ']) {
    const bars = latestVersions(bundle, asset), tail = bars.slice(-120), last = tail.at(-1), dd = tail.length === 120 && tail.every(goodBar) ? (1 - last.values.close / Math.max(...tail.map(r => r.values.close))) * 100 : null;
    cards.push(card(asset + ' 120日高點回撤', pct(dd), last?.date, dd == null ? 'OHLC 或窗口資料不完整；不代填或修補價格' : '最新價格重建；已發生回撤，不代表接近底部'));
  }
  cards.push(card('VIX', num(scalar('VIX')), o.VIX?.date, 'S&P 500 隱含波動；可能漏掉科技集中壓力'));
  cards.push(card('VXN', num(scalar('VXN')), o.VXN?.date, 'Nasdaq-100 隱含波動；尚無領先性驗證'));
  const vix = o.VIX?.record, three = o.VIX3M?.record, ratio = vix?.date === three?.date && three?.values.value > 0 ? vix.values.value / three.values.value : null;
  cards.push(card('VIX / VIX3M', num(ratio), ratio == null ? null : vix.date, '同日配對；隱含波動比，不是 VIX 期貨曲線'));
  for (const [a, b, label] of [['QQQ', 'SPY', '科技相對壓力'], ['SOXX', 'QQQ', '半導體相對壓力'], ['HYG', 'LQD', '信用價格代理']]) {
    const r = priceRatio(a, b); cards.push(card(label + '（' + a + '/' + b + '）', pct(r.value), r.date, '比值20交易日變動；價格代理，不是底部訊號' + (a === 'HYG' ? '，不是 HY OAS，受久期與配息影響' : '')));
  }
  const breadth = o.NDX_BREADTH?.record;
  cards.push(card('NDX 成分股 >50MA', pct(breadth?.values.value), breadth?.date, '有效分母 ' + (breadth?.values.above50_total ?? '未知') + '／快照 ' + (breadth?.values.total ?? '未知') + '；現今成分股回填／混合版本，僅作背景'));
  byId('overview').replaceChildren(...cards);
  byId('captured').textContent = '本系統快照：' + bundle.generated_at + '；各指標有效觀測日分列，不以檔案更新日冒充即時資料。';
  const confirms = confirmationAt(bundle, nyDate(bundle.generated_at));
  table('confirmation', ['序列', '觀測期間', '目前已見值', '品質／週變動', '實際取得時間'], Object.entries(confirms).map(([id, r]) => {
    const m = bundle.series[id].meta;
    return [m.label, r?.date, id.startsWith('CFTC_') && r ? '多 ' + num(r.values.long, 0) + '／空 ' + num(r.values.short, 0) + '／合計 ' + num(r.gross, 0) + ' 張' : r ? num(r.values.value, 3) + ' ' + m.unit : null,
      id.startsWith('CFTC_') ? (r?.rollContaminated ? '轉倉污染：遮罩' : '比較兩端乾淨才計算') + '／週變動 ' + pct(r?.change) : m.quality, r?.observed_at];
  }));
}
function statsRow(label, s) {
  return [label, s.eligibleN, s.rawFlagDays, s.eventCount, s.N, pct(s.return.median), pct(s.return.p10) + ' ～ ' + pct(s.return.p90), pct(s.maxLoss.median), pct(s.maxLoss.min), pct(s.mdd.median), pct(s.rebreakRate), s.nonOverlappingCount];
}
function confirmationText(items) {
  const rows = Object.entries(items || {}).filter(([, row]) => row);
  if (!rows.length) return 'unavailable';
  return rows.map(([id, r]) => (bundle.series[id]?.meta.label || id) + ' ' + r.date + (r.rollContaminated ? '（轉倉污染）' : '') + '；取得 ' + r.observed_at).join('\n');
}
function clearStudy() {
  for (const id of ['stats', 'events']) byId(id).replaceChildren();
  for (const id of ['study-note', 'sample-warning', 'censoring', 'nonoverlap', 'diagnostics']) byId(id).textContent = '';
  byId('strict-banner').hidden = true;
  for (const index of [0, 1]) charts[index]?.clear();
}
function strictBanner(c, cover) {
  const box = byId('strict-banner');
  if (c.dataMode !== 'strict' || cover.eligibleDays > 0) { box.hidden = true; return; }
  const o = strictOutlook(bundle);
  box.replaceChildren(
    node('span', '嚴格模式目前沒有可評估日（N=0）：封存從 ' + o.firstObserved + ' 才開始記錄「當時實際看到」的版本，需累積 120 個交易日的觀測。固定門檻最早約 ' + o.earliestFixedThreshold + '，滾動分位數最早約 ' + o.earliestPercentile + '。 '),
    Object.assign(node('button', '先看非 PIT 歷史重建', { type: 'button', class: 'chip' }), { onclick: () => { const select = byId('dataMode'); select.value = 'historical'; select.dispatchEvent(new Event('change', { bubbles: true })); } }));
  box.hidden = false;
}
function renderStudy() {
  const c = config(); result = cachedStudy(c);
  // The background chart only needs drawdown/indicator/threshold, which do not depend on gate, cooldown or horizon.
  backgroundResult = cachedStudy({ ...c, dataMode: 'historical', gate: 8, cooldown: 10, horizon: 20 });
  const s = result.stats, cover = result.coverage;
  const caution = c.dataMode === 'strict' ? '嚴格模式：首次匯入的舊資料不計為當時已知。觀察歷史不足時結果為 unavailable。' : '歷史收盤重建：使用目前已見日頻版本，未完整排除後續修訂；只能描述歷史，不得當作正式流程驗證。';
  byId('study-note').textContent = caution + ' N=' + s.N + '；警報日 ' + s.rawFlagDays + '，10日冷卻事件 ' + s.eventCount + '；覆蓋 ' + cover.eligibleDays + '/' + cover.totalDays + '（' + pct(cover.ratio == null ? null : cover.ratio * 100) + '）。';
  strictBanner(c, cover);
  byId('sample-warning').textContent = s.N < 30 ? '樣本不足30件：只能描述，無法確認有效性；同波段事件仍可能相關。切換門檻不等於找到穩健訊號。' : '樣本數較多也不代表彼此獨立；需樣本外驗證與多重測試控制。';
  const loss = node('span', '最大虧損中位 '); loss.append(info('loss'));
  table('stats', ['組別', '可評估日', '條件日', '冷卻事件', '完整 N', c.horizon + '日報酬中位', 'P10 ～ P90', loss, '最差最大虧損', '收盤峰谷回撤中位', '再破警報低點', '視窗不重疊事件'],
    [statsRow('觀察警報', s), ...Object.entries(result.baselines).map(([k, g]) => statsRow({ all: '所有可評估日', drawdownMatched: '同回撤閘門', singleIndicator: '單指標（無回撤閘門）' }[k], g.stats))]);
  byId('censoring').textContent = '警報右設限 ' + s.rightCensored + '；視窗壞價／缺價 ' + s.badPrice + '。基準共用同期間與指標可得性，並套同樣冷卻。視窗不重疊列按 max(10, ' + c.horizon + ') 日重新抽樣，不能解讀為統計獨立。';
  const non = s.nonOverlapping.filter(e => e.outcome.status === 'complete');
  byId('nonoverlap').textContent = '不重疊完整 N=' + non.length + '；逐筆報酬：' + (non.map(e => e.date + ' ' + pct(e.outcome.return)).join('、') || 'unavailable');
  const d = result.diagnostics;
  byId('diagnostics').textContent = '完整且全覆蓋波段 ' + d.evaluatedEpisodes + '；漏報 ' + d.missedEpisodes + '（' + pct(d.missedRate) + '）；完整事件落於波段外 ' + d.falseAlarms + '。全部波段 ' + result.episodes.length + '；未結束、左設限或缺覆蓋 ' + result.episodes.filter(e => e.censored).length + ' 不納入漏報分母。 ';
  byId('diagnostics').append(info('misses'));
  table('events', ['警報日', '最早隔日開盤', '回撤／指標', c.horizon + '日結果', '當時實際可得週月資料', '首次事後資料（取得時間）'], result.events.map(e => [e.date, (e.entryDate || 'unavailable') + '\n' + num(e.entryPrice), pct(e.drawdown) + '／' + num(e.indicator), e.outcome.status + '\n' + pct(e.outcome.return) + '／最大虧損 ' + pct(e.outcome.maxLoss), confirmationText(e.confirmation), confirmationText(e.laterConfirmation)]));
  status('研究區間 ' + result.config.from + ' ～ ' + result.config.to + '；' + c.asset + '；' + MODES[c.mode].label + '；' + (c.dataMode === 'strict' ? '嚴格可得版本' : '非 PIT 歷史重建'));
  drawRisk(); drawDistribution();
}
function chart(index, host) { if (!charts[index]) charts[index] = echarts.init(byId(host), isLight() ? null : 'dark'); return charts[index]; }
function line(name, data, axis = 0) { return { name, type: 'line', showSymbol: false, connectNulls: false, xAxisIndex: axis, yAxisIndex: axis, data, itemStyle: { color: axis === 0 ? PALETTE.text : PALETTE.muted } }; }
function drawRisk() {
  const days = backgroundResult.days, drawdownByDate = new Map(days.map(d => [d.date, d.drawdown])), axis = { type: 'time', min: days[0]?.date, max: days.at(-1)?.date };
  chart(0, 'risk-chart').setOption(echartsBase({ legend: { top: 0, textStyle: { color: PALETTE.text } },
    grid: [{ left: 58, right: 25, top: 45, height: '32%' }, { left: 58, right: 25, top: '56%', height: '28%' }],
    xAxis: [{ ...axis, gridIndex: 0 }, { ...axis, gridIndex: 1 }],
    yAxis: [{ type: 'value', name: '回撤 %', inverse: true, gridIndex: 0 }, { type: 'value', name: MODES[result.config.mode].unit, gridIndex: 1 }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' }, { type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: 22 }],
    series: [line(result.config.asset + ' 回撤（最新版本背景）', days.map(d => [d.date, d.drawdown])), line(MODES[result.config.mode].label, days.map(d => [d.date, d.indicator]), 1),
      { ...line('研究門檻', days.map(d => [d.date, d.threshold]), 1), lineStyle: { type: 'dashed' } },
      { name: '本口徑接受警報', type: 'scatter', data: result.events.map(e => [e.date, drawdownByDate.get(e.date) ?? null]).filter(p => p[1] !== null), symbolSize: 8, itemStyle: { color: PALETTE.text2 } }],
  }), { notMerge: true });
}
function drawDistribution() {
  const values = result.stats.return.values, bins = Array.from({ length: 11 }, (_, i) => ({ label: i === 0 ? '<−20%' : i === 10 ? '≥25%' : (-25 + i * 5) + '～' + (-20 + i * 5) + '%', count: 0 }));
  values.forEach(v => { bins[Math.max(0, Math.min(10, Math.floor((v + 20) / 5) + 1))].count++; });
  chart(1, 'distribution-chart').setOption(echartsBase({ xAxis: { type: 'category', data: bins.map(b => b.label), axisLabel: { rotate: 35, fontSize: 10 } }, yAxis: { type: 'value', minInterval: 1, name: '完整事件數' }, grid: { bottom: 65 }, dataZoom: [], series: [{ name: '報酬分布', type: 'bar', data: bins.map(b => b.count), itemStyle: { color: PALETTE.muted } }] }), { notMerge: true });
}
function drawBackground() {
  const id = byId('background').value, rows = latestVersions(bundle, id), m = bundle.series[id].meta, points = field => rows.map(r => [r.date, r.values[field] ?? null]);
  const series = id.startsWith('CFTC_') ? [line('方向性多單', points('long')), { ...line('方向性空單', points('short')), lineStyle: { type: 'dashed' } },
    { name: '轉倉污染（到期週＋次週）', type: 'scatter', data: rows.filter(r => rollContaminated(r.date)).map(r => [r.date, r.values.long + r.values.short]), symbol: 'triangle', symbolSize: 9, itemStyle: { color: PALETTE.text2 } },
    { ...line('方向性合計（未含spreading）', rows.map(r => [r.date, r.values.long + r.values.short])), lineStyle: { width: 2 } }] : [line(m.label, points('value'))];
  chart(2, 'background-chart').setOption(echartsBase({ xAxis: { type: 'time' }, legend: { type: 'scroll', textStyle: { color: PALETTE.text } }, grid: { top: 65, left: 65, bottom: 40 }, yAxis: { type: 'value', name: id.startsWith('CFTC_') ? '張' : m.unit }, series }), { notMerge: true });
  byId('background-note').textContent = m.label + '：' + (m.reason || m.quality) + '。此圖採目前已見版本，包含事後修訂；不能據此推定當時可得。';
}
function renderSources() {
  const overview = latestOverview(bundle);
  table('sources', ['來源／頻率', '有效觀測日', '首次觀測該版本', '延遲／品質／授權'], Object.entries(bundle.series).map(([id, item]) => {
    const o = overview[id], m = item.meta, link = /^https:\/\//.test(m.source_url || '') ? node('a', m.label, { href: m.source_url, target: '_blank', rel: 'noopener noreferrer' }) : node('span', m.label);
    const cell = node('div'); cell.append(link, node('p', m.frequency + '／' + m.unit));
    const note = node('div', m.delay + '\n' + m.quality + '\n' + (m.reason || '') + '\n' + m.license);
    if (m.mirror_url) note.append(node('p', '實際管線：'), (/^https:\/\//.test(m.mirror_url) ? node('a', '第三方 CSV 鏡站', { href: m.mirror_url, target: '_blank', rel: 'noopener noreferrer' }) : node('span', '第三方 CSV 鏡站')));
    return [cell, (o.date || 'unavailable') + '\n' + (o.stale ? '過期或不可用' : '依來源頻率觀察') + '\n' + m.status, (o.observed_at || 'unavailable') + '\n官方發布：' + (o.record?.published_at || '未知；不推估'), note];
  }));
}
export async function activate(context = {}) {
  const payload = validateBundle(await requestJSON('data/us_risk_observations.json', { signal: context.signal }));
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  initInfoPopovers();
  if (payload === bundle && result) { resize(); return; }   // same cached payload on re-entry: nothing to recompute
  bundle = payload; studyCache.clear(); controls(); renderOverview(); renderSources(); renderStudy(); drawBackground();
}
export function getCharts() { return charts.filter(Boolean); }
export function resize() { getCharts().forEach(c => c.resize()); }
export function onThemeChange() {
  if (!bundle) return;
  return preserveChartState(getCharts, () => { charts.forEach(c => c?.dispose()); charts = []; drawRisk(); drawDistribution(); drawBackground(); });
}
