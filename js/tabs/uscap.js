// US Capitulation Alert — 美股恐慌性拋售偵測（描述性研究，不是買賣訊號）。
// 引擎：js/tabs/uscap_calc.mjs（與 scripts/research/backtest_us_capitulation.mjs 共用）。
// 三個階段分開呈現、不合成單一分數：A 恐慌偵測、B 去槓桿背景（僅顯示）、C 止穩確認。
// NYSE/Nasdaq Down Volume 沒有合格來源，所有相關條件一律顯示 unavailable。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { infoButton, initInfoPopovers } from '../utils/info_popover.js';
import * as U from './uscap_calc.mjs';

const byId = id => document.getElementById('uscap-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const num = (x, d = 1) => (finite(x) ? x.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : 'unavailable');
const sg = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)}` : '—');
const pct = (x, d = 1) => (finite(x) ? `${x.toFixed(d)}%` : 'unavailable');
const mark = ok => (ok === null || ok === undefined ? '—（unavailable）' : ok ? '✓ 成立' : '✗ 未成立');

const HELP = {
  stageA: 'Stage A 偵測「是否正在恐慌性拋售」：VIX ≥ 30 或 VXN ≥ 35，且收盤距 120 日高點已回撤 ≥ 8%。Put/Call 與 90% Down Volume 是加強條件，不是必要條件。成立只代表恐慌正在發生，不代表底部。另有「敏感層」：VXN ≥ 30 ＋ 同一回撤閘門（不要求 VIX），專抓科技股壓力單獨出現的情況（例如 2026-07-29 QQQ：VXN 30.8、VIX 只有 20.7）。敏感層誤報較多，只獨立標示，不混入模型比較與主設定。',
  sensitive: '敏感層（非主設定）：VXN ≥ 30 且距 120 日高點回撤 ≥ 8%，不要求 VIX。這個門檻是看到 2026-07-29 案例後才加的，屬於事後觀察到的情境，沒有樣本外驗證；2022 年事件數從 11 件增加到 19 件（QQQ）。',
  stageB: 'Stage B 只顯示「更廣泛的槓桿與信用壓力」背景：CFTC 槓桿基金部位（週資料，公布後才可用）、FINRA 融資餘額（月資料，約月底＋25 天才可知，不插值）、信用價格代理。先前的研究顯示這些低頻資料沒有證實能領先低點，所以它們不進任何訊號模型。缺資料顯示 unavailable，不當成「沒有壓力」。',
  stageC: 'Stage C 偵測「是否開始止穩」：在 Stage A 事件後 40 個交易日內，同時滿足 ① 近 5 日沒有創事件後新低收盤 ② 波動指標跌到事件後高點的 80% 以下（SPY 用 VIX、QQQ 用 VXN） ③ 收盤站回 10 日均線。90% Up Volume 與市場廣度改善因缺合格資料不可評估。Stage A 成立不代表 Stage C 成立。',
  cooldown: '同一波下跌會連續數日觸發。事件＝冷卻 10 個交易日後的第一個訊號；「首次觸發」＝每一波下跌（回撤 ≥8% 進入、<3% 結束）的第一個事件。同一事件的 5/10/20/60/120 日結果高度重疊，不是獨立樣本。',
  mae: '訊號收盤後才能取得，最早下一交易日開盤進場。MAE＝視窗內最低價相對進場價的最大不利跌幅；MFE＝最高價的最大有利漲幅。價格報酬，不含股息、手續費與滑價。',
  hindsight: '灰色空心菱形是「事後才知道」的波段低點，只用來事後對照，當時不可能被即時偵測到。紅色三角（Stage A）與綠色圓點（Stage C）是只用當日以前資料產生的即時警報日。',
  pcr: 'Equity Put/Call 成交量比。Put 成交量不等於新增空單。2019-10-05 前為 CBOE 口徑、之後為 OCC 全交易所加總，水準不連續，所以百分位只用同一口徑內的過去資料，口徑切換後約半年 unavailable。',
  breadth: 'SPXA50R／NDXA50R 是用現任成分股回填的歷史，有倖存者偏差：只顯示、不進任何模型或回測。',
  sensitivity: '改變門檻只是看結果穩不穩，不是在挑最佳門檻。主設定在看到結果前就固定；若因為某一列看起來好而改主設定，就失去樣本外意義。',
};

let ds = null, loadedAt = 0, missing = [], frames = {}, asset = 'QQQ', rangeKey = 'all', charts = [], generation = 0, wired = false;
let periodKey = '2022', evCache = new Map();

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const withInfo = (el, key) => { el.append(' ', infoButton(HELP[key], '說明：' + key)); return el; };
function table(id, headers, rows) {
  const t = node('table', null, { class: 'info-table' }), thead = node('thead'), htr = node('tr'), body = node('tbody');
  for (const h of headers) htr.append(node('th', h));
  thead.append(htr);
  if (!rows.length) rows = [['unavailable：沒有符合條件的資料']];
  for (const row of rows) { const tr = node('tr'); row.forEach((v, i) => tr.append(node(i === 0 ? 'th' : 'td', v ?? 'unavailable'))); body.append(tr); }
  t.append(thead, body); byId(id).replaceChildren(t);
}
function card(title, value, sub, note, tone = '') {
  const el = node('article', null, { class: 'ui-card' + (tone ? ' uscap-' + tone : '') });
  el.append(node('h4', title), node('div', value, { class: 'uscap-value' }), node('p', sub || '', { class: 'status' }), node('p', note || '', { class: 'note-muted' }));
  return el;
}
function stageCard(title, helpKey, lines, foot) {
  const el = node('article', null, { class: 'ui-card uscap-stage' }), h = node('h4', title);
  withInfo(h, helpKey);
  const ul = node('ul', null, { class: 'uscap-lines' });
  for (const [text, ok] of lines) ul.append(node('li', `${text}：${mark(ok)}`, { class: ok === true ? 'uscap-on' : '' }));
  el.append(h, ul, node('p', foot || '', { class: 'note-muted' }));
  return el;
}

// ── data ────────────────────────────────────────────────────────────────
async function load(context = {}) {
  const get = async (url, required = false) => {
    try { return await requestJSON(url, { signal: context.signal }); } catch (e) {
      if (context.signal?.aborted || required) throw e;
      missing.push(url); return null;
    }
  };
  const [spy, qqq, vix, vxn, term, pc, hyg, oas, br, brn, cftc, cftcOld, finra] = await Promise.all([
    get('data/SPY.json', true), get('data/QQQ.json', true), get('data/VIX.json', true), get('data/VXN.json'), get('data/vix_term.json'), get('data/putcall.json'),
    get('data/HYG.json'), get('data/credit_spread.json'), get('data/breadth.json'), get('data/breadth_ndx.json'),
    get('data/cftc_positions.json'), get('data/research/us_delever/cftc_tff_2019_2021.json'), get('data/margin_global_us.json')]);
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  const rows = p => (Array.isArray(p?.data) ? p.data : []);
  ds = U.buildDataset({
    SPY: rows(spy), QQQ: rows(qqq), VIX: rows(vix), VXN: rows(vxn), vixTerm: rows(term), putcall: pc || {}, HYG: rows(hyg), credit: rows(oas),
    breadth: rows(br), breadthNdx: rows(brn), cftc: cftc ? { main: cftc, history: cftcOld } : null, finra: rows(finra),
  });
  frames = {}; evCache = new Map();
  return true;
}
const frame = () => (frames[asset] ??= U.buildFrame(ds, asset));
const events = key => { if (!evCache.has(asset + key)) evCache.set(asset + key, U.eventRows(frame(), ds, key === 'all' ? {} : { from: key.split('|')[0], to: key.split('|')[1] })); return evCache.get(asset + key); };

// ── A / B / C ───────────────────────────────────────────────────────────
function renderMarket() {
  const st = U.liveStatus(frame(), ds);
  if (!st) { byId('market').replaceChildren(node('p', 'unavailable：沒有可用的價格資料')); return null; }
  const c = frame().cfg, d = st.eff, when = k => (st.asOf[k] && st.asOf[k] !== st.date ? `${st.asOf[k]}（比價格晚公布，採各自最新觀測）` : st.asOf[k] || '');
  byId('asof').textContent = `標的 ${asset}｜最新可用交易日 ${st.date}${st.latestBarUsable ? '' : `（${st.latestBarDate} 的 OHLC 自相矛盾，已排除，不補值）`}｜VXN／Put-Call 若晚一天公布，採各自最新觀測並標明日期，最多回看 3 個交易日`;
  byId('market').replaceChildren(
    card('VIX', num(d.vix), st.date, `Stage A 條件：≥ ${c.vix}｜${mark(st.a.vix.ok)}`, st.a.vix.ok ? 'hot' : ''),
    card('VXN', num(d.vxn), when('vxn') || 'unavailable', `Stage A 條件：≥ ${c.vxn}｜${mark(st.a.vxn.ok)}｜敏感層（≥ ${c.vxnSensitive}）：${mark(st.a.vxnSens.ok)}`, st.a.vxn.ok ? 'hot' : ''),
    card('Equity Put/Call（5 日均）', finite(d.pcrAvg) ? d.pcrAvg.toFixed(3) : 'unavailable', when('pcr') || 'unavailable', finite(d.pcrThr) ? `門檻 P${c.pcrPct}＝${d.pcrThr.toFixed(3)}｜${mark(st.a.pcr.ok)}（成交量比，不等於新增空單）` : '歷史不足或口徑切換期間：unavailable'),
    card('NYSE／Nasdaq Down Volume', 'unavailable', '', '沒有合格資料來源（不以 SPY/QQQ 成交量代替）。90% Down／Up Volume 條件不可評估。'),
    card('SPXA50R（站上 50MA %）', st.breadthSpx ? pct(st.breadthSpx.value) : 'unavailable', st.breadthSpx?.date || '', '現任成分股回填，有倖存者偏差；僅顯示，不進模型'),
    card('NDXA50R（站上 50MA %）', st.breadthNdx ? pct(st.breadthNdx.value) : 'unavailable', st.breadthNdx?.date || '', '同上；2019-12 起'));
  return st;
}
function renderPosition(st) {
  const ctx = st.context, cards = [];
  const cf = (label, x) => (x ? card(`CFTC 槓桿基金：${label}`, `${x.ratio.toFixed(1)}%`, `as-of ${x.date}｜公布 ${x.releasedOn}`,
    `淨部位／未平倉量（多−空）；自 ${x.firstDate.slice(0, 4)} 起歷史百分位 P${x.rank.toFixed(0)}（${x.history} 週，短史）${x.lowest5 ? '｜最低 5% 以內' : x.lowest10 ? '｜最低 10% 以內' : ''}。含避險與套利，不等於方向性看空。`) : card(`CFTC 槓桿基金：${label}`, 'unavailable', '', '資料缺失；不當成未觸發'));
  cards.push(cf('S&P 500', ctx.cftcES), cf('Nasdaq-100', ctx.cftcNQ));
  const f = ctx.finra;
  cards.push(f ? card('FINRA Margin Debt', `${(f.balance / 1000).toFixed(0)}B`, `${f.month}（假設 ${f.assumedPublic} 起可知）`, `月變動 ${sg(f.mom)}%｜3 個月 ${sg(f.m3)}%｜6 個月 ${sg(f.m6)}%｜距 12 個月高 ${sg(f.fromPeak12)}%。月資料、不插值成日資料。`) : card('FINRA Margin Debt', 'unavailable', '', '資料缺失'));
  const k = ctx.credit;
  cards.push(k ? card('HYG（高收益債 ETF 價格代理）', num(k.hygClose, 2), k.date, `距 60 日高 ${sg(k.fromHigh60)}%｜${k.aboveSma10 ? '在' : '低於'} 10 日均線。價格受利率與利差共同影響，不等於信用風險下降。`) : card('HYG', 'unavailable', '', '資料缺失'));
  cards.push(k && finite(k.oas) ? card('HY OAS（ICE BofA）', `${k.oas.toFixed(2)}%`, k.oasDate, `5 日變動 ${sg(k.oasChg5, 2)} pt；歷史僅自 ${k.oasFirst} 起（約 3 年），無法回測更早。`) : card('HY OAS', 'unavailable', '', '資料缺失或過期；沒有 FRED key 無法補更早歷史'));
  byId('position').replaceChildren(...cards);
}
function renderStages(st) {
  const a = st.a, ctx = st.context, anyA = st.anyA;
  const A = stageCard('A　Panic Detection（恐慌偵測）', 'stageA', [[a.vix.text, a.vix.ok], [a.vxn.text, a.vxn.ok], [a.drawdown.text, a.drawdown.ok], [a.pcr.text + '（加強條件）', a.pcr.ok], [a.downVolume.text, null], [a.vxnSens.text + '＋回撤（QQQ 敏感層，非主設定）', st.anySensitive]],
    `Stage A（VIX/VXN ＋ 回撤）：${mark(anyA)}｜Model B（再加 PCR）：${mark(st.stageB)}｜敏感層：${mark(st.anySensitive)}。${st.lastA ? `最近一次 Stage A：${st.lastA}` : '近 40 個交易日沒有 Stage A'}`);
  const rank = x => (x ? x.rank <= 10 : null);
  const B = stageCard('B　Deleveraging Confirmation（去槓桿確認，僅背景）', 'stageB', [
    ['CFTC S&P 500 槓桿基金淨部位在歷史最低 10%', rank(ctx.cftcES)], ['CFTC Nasdaq-100 槓桿基金淨部位在歷史最低 10%', rank(ctx.cftcNQ)],
    ['FINRA 融資餘額月減 ≥ 3%（已公布）', ctx.finra ? ctx.finra.mom <= -3 : null], ['HYG 距 60 日高 ≤ -3%（價格代理）', ctx.credit ? ctx.credit.fromHigh60 <= -3 : null],
    ['HY OAS 5 日擴大（≥ +0.25 pt）', ctx.credit && finite(ctx.credit.oasChg5) ? ctx.credit.oasChg5 >= 0.25 : null]],
    '這些低頻資料沒有證實領先低點，不進任何訊號；缺資料＝unavailable，不是未成立。');
  const sc = st.stageC;
  const C = sc ? stageCard('C　Stabilization Confirmation（止穩確認）', 'stageC', [[sc.checks.noNewLow.text, sc.checks.noNewLow.ok], [sc.checks.volRetreat.text, sc.checks.volRetreat.ok], [sc.checks.reclaim.text, sc.checks.reclaim.ok], ['90% Up Volume／市場廣度改善', null]],
    `對應 Stage A：${sc.panicDate}（${sc.sinceDays} 個交易日前）。${sc.confirmed ? `已於 ${sc.confirmed.date} 確認（延遲 ${sc.confirmed.lag} 日）；之後若收盤跌破 A→C 最低收盤＝失敗。` : '尚未全部成立。'}`)
    : stageCard('C　Stabilization Confirmation（止穩確認）', 'stageC', [['近 40 個交易日內沒有 Stage A 事件', null]], '沒有可對應的 Stage A 事件，Stage C 不適用。Stage A 成立≠Stage C 成立。');
  byId('stages').replaceChildren(A, B, C);
}

// ── chart ───────────────────────────────────────────────────────────────
const RANGES = { all: null, '2008': '2008-01-01', '2020': '2020-01-01', '2022': '2022-01-01', '1y': 'last' };
function chart() { if (!charts[0]) charts[0] = echarts.init(byId('chart'), isLight() ? null : 'dark'); return charts[0]; }
function drawChart() {
  const f = frame(), days = f.days, c = f.cfg, dates = days.map(d => d.date);
  const { rows, waves } = events('all');
  const evByDate = new Map(rows.map(r => [r.date, r])), cByDate = new Map(rows.filter(r => r.confirm).map(r => [r.confirm.date, r]));
  const pts = list => list.map(([date, v]) => [date, v]);
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: dates, boundaryGap: false, axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show }, axisTick: { show: false }, splitLine: { show: false } });
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, scale: true, nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const L = mob() ? 44 : 60, R = mob() ? 12 : 24;
  const a = rows.map(r => [r.date, f.byDate.get(r.date).close]);
  const b = rows.filter(r => r.modelB).map(r => [r.date, f.byDate.get(r.date).close]);
  const cc = rows.filter(r => r.confirm).map(r => [r.confirm.date, r.confirm.close]);
  const sens = U.modelEvents(f, U.MODELS.find(m => m.id === 'S')).confirmed.map(e => days[e.index]);
  const sensDates = new Set(sens.map(d => d.date));
  const tr = waves.filter(w => w.maxDd >= 10).map(w => [w.troughDate, f.byDate.get(w.troughDate).close]);
  const option = echartsBase({
    animation: false,
    legend: { top: 0, type: 'scroll', textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const d = days[params?.[0]?.dataIndex]; if (!d) return '';
        const ev = evByDate.get(d.date), ce = cByDate.get(d.date);
        const lines = [`<b>${d.date}</b>｜${asset} ${num(d.close, 2)}｜距 ${c.lookback} 日高 ${finite(d.dd) ? '-' + d.dd.toFixed(1) + '%' : 'unavailable'}`,
          `VIX ${num(d.vix)}｜VXN ${num(d.vxn)}｜PCR5 ${finite(d.pcrAvg) ? d.pcrAvg.toFixed(3) : 'unavailable'}${finite(d.pcrThr) ? `（門檻 ${d.pcrThr.toFixed(3)}）` : ''}`];
        if (ev) lines.push(`<b style="color:#ef4444">▲ Stage A 警報日${ev.modelB ? '（同時 Model B）' : ''}</b>：20 日 ${ev.out.h[20]?.status === 'complete' ? sg(ev.out.h[20].ret) + '%（MAE ' + sg(ev.out.h[20].mae) + '／MFE ' + sg(ev.out.h[20].mfe) + '）' : '—'}`);
        if (sensDates.has(d.date)) lines.push(`<b style="color:#f0883e">△ 敏感層警報日（VXN ≥ ${c.vxnSensitive}，非主設定）</b>`);
        if (ce) lines.push(`<b style="color:#3fb950">● Stage C 確認日</b>（距 Stage A ${ce.confirm.lag} 日，Stage A ${ce.date}）`);
        if (tr.some(t => t[0] === d.date)) lines.push('◇ 事後分析：波段低點（當時無法即時得知）');
        return lines.join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 34, height: '46%' }, { left: L, right: R, top: '58%', height: '16%' }, { left: L, right: R, top: '78%', height: '12%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [yAxis(0, asset, { type: 'log', min: 'dataMin' }), yAxis(1, 'VIX / VXN', { scale: false }), yAxis(2, 'PCR 5 日均', { scale: true })],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { name: asset, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: days.map(d => (d.ok ? d.close : null)), showSymbol: false, lineStyle: { width: 1.2, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: 'Stage A 警報日（即時）', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts(a), symbol: 'triangle', symbolSize: 10, itemStyle: { color: '#ef4444' }, z: 5 },
      { name: `敏感層（VXN≥${c.vxnSensitive}，非主設定）`, type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts(sens.map(d => [d.date, d.close])), symbol: 'triangle', symbolSize: 9, itemStyle: { color: 'transparent', borderColor: '#f0883e', borderWidth: 2 }, z: 4 },
      { name: 'Model B（A＋PCR）', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts(b), symbol: 'diamond', symbolSize: 9, itemStyle: { color: '#e3b341' }, z: 6 },
      { name: 'Stage C 確認日（即時）', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts(cc), symbol: 'circle', symbolSize: 8, itemStyle: { color: '#3fb950' }, z: 6 },
      { name: '事後：波段低點（非即時）', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts(tr), symbol: 'rect', symbolSize: 11, itemStyle: { color: 'transparent', borderColor: PALETTE.muted, borderWidth: 2 }, z: 4 },
      { name: 'VIX', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: days.map(d => d.vix), showSymbol: false, lineStyle: { width: 1, color: '#58a6ff' }, itemStyle: { color: '#58a6ff' },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#58a6ff' }, label: { formatter: String(c.vix), color: PALETTE.muted, fontSize: 10 }, data: [{ yAxis: c.vix }] } },
      { name: 'VXN', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: days.map(d => d.vxn), showSymbol: false, lineStyle: { width: 1, color: '#a371f7' }, itemStyle: { color: '#a371f7' } },
      { name: 'PCR 5 日均', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: days.map(d => d.pcrAvg), showSymbol: false, lineStyle: { width: 1, color: '#e3b341' }, itemStyle: { color: '#e3b341' } },
      { name: `PCR P${c.pcrPct} 門檻（過去 2 年、同口徑）`, type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: days.map(d => d.pcrThr), showSymbol: false, lineStyle: { width: 1, type: 'dashed', color: PALETTE.muted }, itemStyle: { color: PALETTE.muted } },
    ],
  });
  chart().setOption(option, { notMerge: true });
  applyRange();
}
function applyRange() {
  const ch = charts[0]; if (!ch) return;
  const dates = frame().days.map(d => d.date), key = RANGES[rangeKey];
  const start = key === 'last' ? dates[Math.max(0, dates.length - 252)] : key ? dates.find(x => x >= key) : dates[0];
  ch.dispatchAction({ type: 'dataZoom', startValue: start, endValue: dates.at(-1) });
}

// ── tables ──────────────────────────────────────────────────────────────
const H = U.DEFAULTS.horizons;
const med = (s, h, key) => (s.by[h].n ? sg(s.by[h][key]) : '—');
function renderModels() {
  const f = frame(), res = U.runModels(f), base = U.baselines(f);
  const rows = Object.values(res).map(x => x.unavailable ? [x.label, 'unavailable', x.unavailable, '', '', '', '', ''] : [x.label, `${x.triggerDays}`, x.stabilize ? `${x.confirmedCount}／${x.baseCount}` : `${x.baseCount}`,
    ...[20, 60].map(h => (x.stats.by[h].n ? `${sg(x.stats.by[h].median)}｜${pct(x.stats.by[h].win, 0)}` : '—')), `${med(x.stats, 60, 'maeMedian')}／${med(x.stats, 60, 'mfeMedian')}`,
    x.stats.rebreakRate == null ? '—' : pct(x.stats.rebreakRate, 0), x.waveFirst.length ? `${x.waveFirst.length} 波：20 日 ${med(x.waveStats, 20, 'median')}、60 日 ${med(x.waveStats, 60, 'median')}` : '—']);
  rows.push(['（基準）只有回撤閘門', '', `${base.drawdownEvents}`, ...[20, 60].map(h => `${sg(base.drawdownOnly.by[h].median)}｜${pct(base.drawdownOnly.by[h].win, 0)}`), `${med(base.drawdownOnly, 60, 'maeMedian')}／${med(base.drawdownOnly, 60, 'mfeMedian')}`, '', '']);
  rows.push(['（基準）所有交易日', `${base.eligibleDays}`, '', ...[20, 60].map(h => `${sg(base.allDays.by[h].median)}｜${pct(base.allDays.by[h].win, 0)}`), `${med(base.allDays, 60, 'maeMedian')}／${med(base.allDays, 60, 'mfeMedian')}`, '', '']);
  table('models', ['模型', '觸發日數', '事件數（冷卻 10 日）', '20 日 中位 %｜勝率', '60 日 中位 %｜勝率', '60 日 MAE／MFE 中位 %', '20 日內再破低', '每一波首次觸發'], rows);
  byId('models-note').textContent = `${asset}，2000 起全樣本；止穩模型的事件日＝確認日（「確認數／Stage A 事件數」）。再破低＝進場後 20 日最低價跌破訊號日低點（止穩模型為 A→C 最低價）。Model C/D 需要 Down Volume：unavailable，E′ 以 B＋止穩代替 D＋止穩。`;
  const periods = U.PERIODS.map(([name, from, to]) => {
    const r = U.runModels(f, { from, to }), cell = id => { const x = r[id]; return x.baseCount ? `${x.stabilize ? x.confirmedCount : x.baseCount}｜20 日 ${med(x.stats, 20, 'median')}｜60 日 ${med(x.stats, 60, 'median')}｜MAE60 ${med(x.stats, 60, 'maeMedian')}` : '0'; };
    return [name, cell('A'), cell('B'), cell('AS'), cell('E')];
  });
  table('periods', ['區間', 'A：事件｜20 日｜60 日｜MAE（中位 %）', 'B', 'A′（A＋止穩）', 'E′（B＋止穩）'], periods);
}
function renderHistory() {
  const [name, from, to] = U.PERIODS.find(p => p[0] === periodKey) || U.PERIODS[6];
  const { rows } = events(`${from}|${to}`);
  const mm = (o, h) => (o.h[h]?.status === 'complete' ? `${sg(o.h[h].mae)}／${sg(o.h[h].mfe)}` : '—');
  table('history', ['Stage A 警報日', `${asset} 收盤`, '指數回撤', 'VIX', 'VXN', 'PCR 5 日均', 'Down Volume', 'SPXA50R／NDXA50R*', '後續 20 日 MAE／MFE %', '後續 60 日 MAE／MFE %', 'Stage C 確認（延遲）／失敗辨識'],
    rows.map(r => [r.date + (r.modelB ? '（B）' : ''), num(r.close, 2), finite(r.dd) ? '-' + r.dd.toFixed(1) + '%' : 'unavailable', num(r.vix), num(r.vxn), finite(r.pcr) ? r.pcr.toFixed(3) : 'unavailable', 'unavailable',
      `${finite(r.breadthSpx) ? r.breadthSpx.toFixed(0) : '—'}／${finite(r.breadthNdx) ? r.breadthNdx.toFixed(0) : '—'}`, mm(r.out, 20), mm(r.out, 60),
      r.confirm ? `${r.confirm.date}（+${r.confirm.lag}）${r.confirm.invalid ? `；確認後第 ${r.confirm.invalid.days} 日跌破 A→C 低點（損失 ${sg(r.confirm.invalid.lossAtInvalidation)}%）` : '；60 日內未跌破'}` : '40 日內未確認']));
  byId('history-note').textContent = `${name}：共 ${rows.length} 個 Stage A 事件（冷卻 10 日）。*廣度為現任成分股回填，僅供參考；2019-12 前為 —。MAE／MFE 為訊號隔日開盤進場後視窗內的最大不利／有利幅度。（B）＝同日也構成 Model B。`;
  const S = U.episodeSummary(rows), d = l => (l.length ? `（${l.map(x => x.slice(5)).join('、')}）` : '');
  const items = [
    `Stage A 事件 ${S.n} 件，其中 Model B ${S.modelB} 件。`,
    `事後 60 日 MAE 差於 -10%：${S.deep.length} 件${d(S.deep)}；-5%～-10%：${S.mid.length} 件${d(S.mid)}；淺於 -5%：${S.shallow.length} 件${d(S.shallow)}${S.incomplete.length ? `；視窗不足 ${S.incomplete.length} 件` : ''}。（分級切點只是描述用，不是模型參數）`,
    `Stage A → Stage C 延遲：${S.confirmed}/${S.n} 件有確認，中位數 ${S.lagMedian ?? '—'} 個交易日（${S.lagMin ?? '—'}～${S.lagMax ?? '—'}）；確認後 60 日報酬為負 ${S.confirmedNegative60}/${S.confirmed} 件。`,
    `Stage C 確認後再跌破 A→C 最低收盤（失敗辨識）：${S.failed.length}/${S.confirmed} 件${S.failed.length ? '；損失 ' + S.failed.map(x => `${x.confirmDate.slice(5)} ${sg(x.loss)}%`).join('、') : ''}。辨識時已承受該段損失，不是事前預警。`,
  ];
  byId('history-summary').replaceChildren(...items.map(t => node('li', t)));
}
function renderStress() {
  const f = frame(), days = f.days.filter(d => d.date >= '2022-01-01' && d.date <= '2022-12-31'), c = f.cfg;
  const conds = [['VIX ≥ 30', d => d.vix >= c.vix], ['VXN ≥ 35', d => d.vxn >= c.vxn], ['PCR5 ≥ P95', d => d.pcrExt === true], ['回撤 ≥ 8%', d => d.dd >= c.gate],
    ['Stage A', d => U.stageA(d, c) === true], ['Model B', d => U.stageB(d, c) === true],
    ['SPXA50R < 20%（非 PIT）', d => (ds.breadthSpx.get(d.date) ?? 100) < 20], ['NDXA50R < 20%（非 PIT）', d => (ds.breadthNdx.get(d.date) ?? 100) < 20]];
  const months = [...new Set(days.map(d => d.date.slice(5, 7)))];
  table('stress', ['2022 符合條件的交易日數', ...months, '全年'], conds.map(([label, fn]) => [label, ...months.map(m => `${days.filter(d => d.date.slice(5, 7) === m && fn(d)).length || ''}`), `${days.filter(fn).length}`]));
}
function renderSensitivity() {
  const rows = U.runSensitivity(frame()).map(r => [`${r.group}：${r.label}`, `${r.triggerDays}`, `${r.events}`, med(r.stats, 20, 'median'), med(r.stats, 60, 'median'), med(r.stats, 60, 'maeMedian'), r.stats.by[60].n ? pct(r.stats.by[60].win, 0) : '—']);
  for (const r of U.runPcrVariants(ds, asset)) rows.push([`PCR 變體：${r.label}`, `${r.triggerDays}`, `${r.events}`, med(r.stats, 20, 'median'), med(r.stats, 60, 'median'), med(r.stats, 60, 'maeMedian'), r.stats.by[60].n ? pct(r.stats.by[60].win, 0) : '—']);
  table('sensitivity', ['條件（皆含回撤閘門、10 日冷卻、隔日開盤進場）', '觸發日', '事件數', '20 日中位 %', '60 日中位 %', '60 日 MAE 中位 %', '60 日勝率'], rows);
}

function renderAll() {
  const ticket = ++generation;
  byId('status').textContent = `正在計算 ${asset}…`;
  setTimeout(() => {
    if (ticket !== generation) return;
    try {
      const st = renderMarket();
      if (st) { renderPosition(st); renderStages(st); }
      drawChart(); renderHistory(); renderModels(); renderStress();
      if (byId('sensitivity-details').open) renderSensitivity();
      byId('status').textContent = missing.length ? `部分資料載入失敗，相關欄位顯示 unavailable：${missing.join('、')}` : '完成。所有欄位均為描述性研究，不是買賣指令。';
    } catch (e) { byId('status').textContent = '計算失敗：' + e.message; }
  }, 0);
}
function wire() {
  if (!bindOnce(byId('controls'))) return;
  byId('asset').addEventListener('change', e => { asset = e.target.value; renderAll(); });
  byId('period').replaceChildren(...U.PERIODS.map(([n]) => { const o = node('option', n, { value: n }); o.selected = n === periodKey; return o; }));
  byId('period').addEventListener('change', e => { periodKey = e.target.value; try { renderHistory(); } catch (err) { byId('status').textContent = '計算失敗：' + err.message; } });
  chipPicker(byId('range'), 'uscap-range', key => { rangeKey = key; applyRange(); });
  byId('sensitivity-details').addEventListener('toggle', e => { if (e.target.open && ds) { try { renderSensitivity(); } catch (err) { byId('status').textContent = '計算失敗：' + err.message; } } });
  for (const h of document.querySelectorAll('#tab-uscap [data-help]')) h.append(' ', infoButton(HELP[h.dataset.help], '說明：' + h.dataset.help));
}

export async function activate(context = {}) {
  initInfoPopovers();
  if (ds && Date.now() - loadedAt < 300_000) { resize(); return; }   // re-entry with the same data: nothing to recompute
  missing = [];
  const fresh = await load(context);
  if (fresh === false) return;
  loadedAt = Date.now();
  wire(); renderAll();
}
export function getCharts() { return charts.filter(Boolean); }
export function resize() { getCharts().forEach(c => c.resize()); }
export function onThemeChange() {
  if (!ds) return;
  return preserveChartState(getCharts, () => { charts.forEach(c => c?.dispose()); charts = []; drawChart(); });
}
