// 市場預警與策略回測 — 使用者既有的 300MA Reset／150MA 站回、SSO 200MA→125/150MA 規則，
// 加上美股早期惡化指標、台股流動性研究狀態，以及 Python 預先計算的訊號回測與真實 ETF NAV 回測。
// 版面：摘要卡 → 控制項 → 主圖（價格＋MA＋訊號、相對強度／融資、廣度）→ 訊號回測表 → 策略 NAV
//       → walk-forward → 歷史案例 → 台股訊號分級 → 代理資料與限制。
// 資料：data/market_risk_lab.json（compute_market_risk_lab.py，每日）、
//       data/market_risk_lab_backtest.json（backtest_market_risk_lab.py，每日 daily／每週 full）。
import { echartsBase, PALETTE, isLight } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { tsToLocalDate } from '../utils/dates.js';
import * as C from './marketrisklab_calc.mjs';

const byId = id => document.getElementById('marketrisklab-' + id);
const finite = C.finite;
const pct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`.replace('-', '−') : '—');
const pp = (x, d = 0) => (finite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const RED = '#ef4444', GREEN = '#3fb950', ORANGE = '#f0883e', BLUE = '#58a6ff', PURPLE = '#a371f7';

const MARKET_LABEL = { US_NDX: 'Nasdaq 100（QQQ）', US_SPX: 'S&P 500', US_SOX: '費城半導體', TW: '台灣加權' };
const FAMILY_LABEL = {
  reset300: '300MA 盤中觸及（Reset）', reclaim150_after_reset: 'Reset 後站回 150MA',
  break200_reclaim125: '跌破 200MA 後站回 125MA', break200_reclaim150: '跌破 200MA 後站回 150MA',
};
const TIER = { core: ['已驗證核心', 'mrl-tier-core'], core_user_rule: ['使用者規則（未驗證增量）', 'mrl-tier-rule'],
  aux: ['輔助觀察', 'mrl-tier-aux'], research: ['研究中／未通過', 'mrl-tier-research'] };

const ui = { market: 'US_NDX', kind: 'SMA', rearm: 60, horizon: 120, from: 2000, to: 2026, variant: 'hold252_1', caseId: '2026oct' };
let LAB = null, BT = null, loadedAt = 0, charts = {};

// ── 摘要 ───────────────────────────────────────────────────────────────
function renderSummary() {
  const st = C.dataStatus(LAB);
  const s = LAB.states[ui.market] || {};
  const ls = C.latestSignal(LAB, ui.kind);
  const resetTxt = s.last_reset == null ? (LAB.events.SMA[ui.market]?.reset300 ? '近期未成立' : '不適用（此市場規則不用 Reset）')
    : `${s.last_reset}（${s.reset_days_ago} 個交易日前）`;
  const recl = s.last_reset == null ? '—' : s.reclaim150_done ? `已站回（${s.reclaim150_date}）` : '尚未站回';
  const cards = [
    ['當前狀態', s.state || '無法判定', s.date ? `${MARKET_LABEL[ui.market]}，${s.date} 收盤` : ''],
    ['300MA Reset', resetTxt, ui.market === 'US_NDX' ? 'QQQ 盤中低點或 NQ 期貨（含夜盤）觸及前一日 300MA' : '指數日 K 最低價觸及前一日 300MA'],
    ['150MA 恢復', recl, 'Reset 之後收盤 > 150MA'],
    ['最近一次訊號', ls ? `${ls.date}` : '無', ls ? `${MARKET_LABEL[ls.market]}：${FAMILY_LABEL[ls.family] || ls.family}` : ''],
    ['資料狀態', st.text, `完整率 ${pp(LAB.completeness)}；指標日 ${LAB.us_latest?.asof || '—'}`],
    ['模型版本', LAB.model_version, `回測 ${BT?.full_updated || '—'}（full）／${BT?.updated || '—'}（daily）`],
  ];
  byId('summary').innerHTML = cards.map(([k, v, sub]) =>
    `<div class="mrl-card"><div class="mrl-card-k">${esc(k)}</div><div class="mrl-card-v">${esc(v)}</div><div class="mrl-card-s">${esc(sub)}</div></div>`).join('');
  byId('summary').classList.toggle('mrl-stale', st.level === 'stale');
  byId('notice').textContent = '研究訊號不是交易指令；本頁不下單。所有門檻與規則照使用者既有定義，出場規則使用者未定義，回測以研究假設呈現。';
}

// ── 主圖 ───────────────────────────────────────────────────────────────
function mainOption() {
  const ser = C.marketSeries(LAB, ui.market);
  const ma = n => C.movingAverage(ser.close, n, ui.kind);
  const line = (name, data, color, extra = {}) => ({ name, type: 'line', showSymbol: false, data: ser.dates.map((d, i) => [d, data[i]]),
    itemStyle: { color }, lineStyle: { width: 1.2, color }, connectNulls: false, ...extra });
  const ev = LAB.events[ui.kind][ui.market] || {};
  const idx = new Map(ser.dates.map((d, i) => [d, i]));
  const marks = (list, color, sym, name) => ({ name, type: 'scatter', symbol: sym, symbolSize: 11, itemStyle: { color }, z: 5,
    data: (list || []).filter(e => idx.has(e.date)).map(e => [e.date, ser.close[idx.get(e.date)]]) });
  const series = [
    line('收盤', ser.close, PALETTE.text, { lineStyle: { width: 1.4 } }),
    line(`${ui.kind}50`, ma(50), '#8b949e'), line(`${ui.kind}150`, ma(150), BLUE),
    line(`${ui.kind}200`, ma(200), ORANGE), line(`${ui.kind}300`, ma(300), RED),
    marks(ev.reset300, RED, 'triangle', 'Reset（觸及300MA）'),
    marks(ev.reclaim150_after_reset, GREEN, 'diamond', 'Reset 後站回150MA'),
    marks(ev.break200_reclaim125, PURPLE, 'circle', '跌破200→站回125'),
    marks(ev.break200_reclaim150, GREEN, 'pin', '跌破200→站回150'),
  ];
  // 第二格：美股相對強度／台股融資餘額；第三格：美股廣度／臺灣50 站上60MA
  let lower = [], third = [];
  if (ui.market === 'TW') {
    const m = LAB.chart.tw.margin, b = LAB.chart.tw.breadth;
    if (m) lower = [{ name: '上市融資餘額（億）', type: 'line', showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: ORANGE },
      data: m.dates.map((d, i) => [d, m.bal?.[i] ?? null]) }];
    if (b) third = [{ name: '臺灣50 站上60MA%', type: 'line', showSymbol: false, xAxisIndex: 2, yAxisIndex: 2, itemStyle: { color: BLUE },
      data: b.dates.map((d, i) => [d, b.tw50_a60?.[i] ?? null]) }];
  } else {
    const r = LAB.chart.us.ratios, ds = LAB.chart.us.dates;
    const cols = { 'QQQ/SPY': BLUE, 'SOX/SPX': PURPLE, 'SOXX/SPY': ORANGE, 'RSP/SPY': GREEN };
    lower = Object.entries(r).filter(([, v]) => v).map(([k, v]) => {
      const base = v.find(finite);
      return { name: k, type: 'line', showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: cols[k] },
        data: ds.map((d, i) => [d, finite(v[i]) ? v[i] / base * 100 : null]) };
    });
    const b = LAB.chart.us.breadth;
    third = [
      { name: 'S&P 站上50MA%（現任成分代理）', type: 'line', showSymbol: false, xAxisIndex: 2, yAxisIndex: 2, itemStyle: { color: BLUE }, data: b.dates.map((d, i) => [d, b.above50[i]]) },
      { name: 'S&P 站上200MA%（現任成分代理）', type: 'line', showSymbol: false, xAxisIndex: 2, yAxisIndex: 2, itemStyle: { color: ORANGE }, data: b.dates.map((d, i) => [d, b.above200[i]]) },
    ];
  }
  const xa = i => ({ type: 'time', gridIndex: i, axisLabel: { show: i === 2 }, min: 'dataMin', max: 'dataMax' });
  return echartsBase({
    legend: { type: 'scroll', top: 0 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      formatter: ps => {
        const d = tsToLocalDate(ps[0].axisValue);
        return `<b>${d}</b><br>` + ps.filter(p => finite(p.value?.[1])).map(p => `${p.marker}${esc(p.seriesName)}：${p.value[1].toFixed(2)}`).join('<br>');
      } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ top: 40, height: '48%', left: 56, right: 16 }, { top: '64%', height: '14%', left: 56, right: 16 }, { top: '82%', height: '11%', left: 56, right: 16 }],
    xAxis: [xa(0), xa(1), xa(2)],
    yAxis: [{ type: 'log', scale: true, gridIndex: 0 }, { scale: true, gridIndex: 1, splitNumber: 2, name: ui.market === 'TW' ? '融資' : '相對(起點=100)', nameTextStyle: { fontSize: 10 } },
      { scale: true, gridIndex: 2, splitNumber: 2, max: ui.market === 'TW' ? 100 : 100, min: 0 }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], startValue: Date.parse('2018-01-01') }, { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 0, height: 16, startValue: Date.parse('2018-01-01') }],
    series: [...series, ...lower, ...third],
  });
}

// ── 訊號回測表 ─────────────────────────────────────────────────────────
function renderSignals() {
  const v = C.pickVariant(BT, ui.kind, ui.rearm);
  const host = byId('signals');
  if (!BT) { host.innerHTML = '<p class="status">回測檔無法載入，無法判定歷史統計。</p>'; byId('events').innerHTML = ''; return; }
  if (!v) { host.innerHTML = '<p class="status">此參數組合沒有預先計算的結果，需要由 Python 批次重新產生（每週排程或手動 workflow）。</p>'; return; }
  const fams = C.MARKET_FAMILIES[ui.market];
  const rows = fams.map(f => {
    const s = v.signals[`${ui.market}:${f}`];
    if (!s) return '';
    const st = C.filterStats(s.events, ui.horizon, ui.from, ui.to);
    const full = s.all[String(ui.horizon)] || {};
    const base = s.baseline_all_days[String(ui.horizon)] || {};
    const isFull = ui.from <= 1990 || (s.events[0] && Number(s.events[0].date.slice(0, 4)) >= ui.from && ui.to >= 2026);
    const oos = s.out_of_sample[String(ui.horizon)] || {};
    return `<tr><th>${esc(FAMILY_LABEL[f])}<div class="mrl-sub">${esc(s.basis)}</div></th>
      <td>${st.n}${st.pending ? `<span class="mrl-sub">＋${st.pending} 未滿</span>` : ''}</td>
      <td>${pct(st.mean)}</td><td>${pct(st.median)}</td><td>${pp(st.up)}</td><td>${pp(st.rebreak)}</td>
      <td>${pct(st.maeMedian)}／${pct(st.mfeMedian)}</td><td>${pct(st.mddWorst)}</td>
      <td>${isFull && full.ci90_mean ? `${pct(full.ci90_mean[0])}～${pct(full.ci90_mean[1])}` : '<span class="mrl-sub">僅全期間</span>'}</td>
      <td>${pct(base.median)}<span class="mrl-sub">上漲 ${pp(base.up)}</span></td>
      <td>${oos.n ? `${pct(oos.median)}<span class="mrl-sub">N=${oos.n}</span>` : '—'}</td></tr>`;
  }).join('');
  host.innerHTML = `<div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>訊號（${ui.horizon} 交易日）</th><th>完成 N</th><th>平均</th><th>中位數</th><th>上漲比例</th><th>再破底</th>
    <th>MAE／MFE 中位</th><th>期間最大回撤（最差）</th><th>平均數 90% CI</th><th>無訊號基準（同期所有日）中位</th><th>樣本外（${esc(v.signals[`${ui.market}:${fams[0]}`]?.oos_from?.slice(0, 4) || '')}+）中位</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mrl-sub">報酬以訊號日收盤為錨、價格指數（不含息）。「再破底」＝前瞻期間最低價低於訊號前 60 日最低價。未滿視窗的事件列為 pending，不計入。年份篩選後的統計不重抽 bootstrap。</p>`;
  const evList = fams.flatMap(f => (v.signals[`${ui.market}:${f}`]?.events || []).map(e => ({ ...e, f })))
    .filter(e => { const y = Number(e.date.slice(0, 4)); return y >= ui.from && y <= ui.to; })
    .sort((a, b) => a.date.localeCompare(b.date));
  byId('events').innerHTML = `<details><summary>逐事件明細（${evList.length} 筆）</summary><div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>日期</th><th>訊號</th>${BT.horizons.map(h => `<th>${h}日</th>`).join('')}<th>群聚</th></tr></thead><tbody>${
    evList.map(e => `<tr><td>${e.date}</td><td>${esc(FAMILY_LABEL[e.f])}</td>${BT.horizons.map(h => {
      const x = e.h[String(h)]; return `<td>${x.status === 'pending' ? '<span class="mrl-sub">pending</span>' : pct(x.ret)}</td>`; }).join('')}<td>${e.clustered ? '是' : ''}</td></tr>`).join('')
  }</tbody></table></div></details>`;
}

// ── 策略 NAV ───────────────────────────────────────────────────────────
function strategyOption() {
  const strat = BT?.strategies?.[ui.kind] || {};
  const ids = C.MARKET_STRATEGIES[ui.market];
  const series = [];
  const cols = [BLUE, GREEN, ORANGE, PURPLE];
  ids.forEach((id, k) => {
    const s = strat[id];
    if (!s?.available) return;
    const v = s.variants[ui.variant];
    if (k === 0) series.push({ name: `${s.trade} 買進持有`, type: 'line', showSymbol: false, itemStyle: { color: '#8b949e' }, data: s.buy_hold.nav });
    if (v) series.push({ name: `${s.label}`, type: 'line', showSymbol: false, itemStyle: { color: cols[k] }, data: v.nav });
  });
  return echartsBase({
    legend: { type: 'scroll', top: 0 }, tooltip: { trigger: 'axis', valueFormatter: x => (finite(x) ? Math.round(x).toLocaleString() : '—') },
    grid: { top: 40, left: 64, right: 16, bottom: 40 }, xAxis: { type: 'time' }, yAxis: { type: 'log', scale: true },
    dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 0, height: 16 }], series,
  });
}

function renderStrategyTable() {
  const strat = BT?.strategies?.[ui.kind] || {};
  const rows = C.MARKET_STRATEGIES[ui.market].map(id => {
    const s = strat[id];
    if (!s) return '';
    if (!s.available) return `<tr><th>${esc(id)}</th><td colspan="7">${esc(s.reason)}</td></tr>`;
    const v = s.variants[ui.variant], b = s.buy_hold.stats;
    const r = (name, st, extra = '') => `<tr><th>${esc(name)}</th><td>${st.start}～${st.end}</td><td>${pct(st.cagr)}</td><td>${pct(st.max_drawdown)}</td><td>${finite(st.sharpe_rf0) ? st.sharpe_rf0.toFixed(2) : '—'}</td><td>${pp(st.exposure)}</td><td>${extra}</td></tr>`;
    return r(s.label, v.stats, `${v.trades.filter(t => t.side === 'buy').length} 筆買進${v.open_position ? '，目前持有中' : ''}；成立前訊號 ${s.signals_before_inception.length} 筆未計`)
      + r(`${s.trade} 買進持有（對照）`, b, '');
  }).join('');
  byId('strategy-table').innerHTML = `<div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>策略</th><th>期間</th><th>CAGR</th><th>最大回撤</th><th>Sharpe(rf=0)</th><th>持有比例</th><th>備註</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mrl-sub">真實 ETF 成交價（含息換算），訊號日收盤後成立 → 次一交易日開盤成交；手續費＋滑價見方法文件；未投入資金利率 0。出場規則使用者未定義，此處為研究假設。ETF 成立前的訊號不回測（不以指數 ×2 推算）。</p>`;
  const trades = C.MARKET_STRATEGIES[ui.market].flatMap(id => (strat[id]?.variants?.[ui.variant]?.trades || []).map(t => ({ ...t, id })));
  byId('trades').innerHTML = `<details><summary>交易明細（${trades.length} 筆）</summary><div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>策略</th><th>日期</th><th>買賣</th><th>價格（含息換算）</th><th>說明</th></tr></thead><tbody>${
    trades.map(t => `<tr><td>${esc(t.id)}</td><td>${t.date}</td><td>${t.side === 'buy' ? `買（第${t.batch}批）` : '賣'}</td><td>${t.price}</td><td>${esc(t.side === 'buy' ? `訊號 ${t.signal}` : t.reason)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function renderWalkForward() {
  const wf = BT?.walk_forward;
  if (!wf) { byId('wf').innerHTML = '<p class="status">尚無 walk-forward 結果（等每週完整回測）。</p>'; return; }
  const o = wf.oos_120;
  byId('wf').innerHTML = `<p class="mrl-sub">${esc(wf.method)}（SSO 規則：125MA／150MA × SMA／EMA）</p><div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>方案</th><th>樣本外 N</th><th>120日中位</th><th>平均 90% CI</th><th>上漲比例</th></tr></thead><tbody>${
    Object.entries(o).map(([k, s]) => `<tr><th>${k === 'selected' ? '逐年選擇（walk-forward）' : esc(k)}</th><td>${s.n}</td><td>${pct(s.median)}</td><td>${s.ci90_mean ? `${pct(s.ci90_mean[0])}～${pct(s.ci90_mean[1])}` : '—'}</td><td>${pp(s.up)}</td></tr>`).join('')
  }</tbody></table></div>`;
}

// ── 歷史案例 ───────────────────────────────────────────────────────────
function renderCase() {
  const c = LAB.cases.find(x => x.id === ui.caseId) || LAB.cases.at(-1);
  const s = c.snapshot;
  if (!s) { byId('case').innerHTML = '<p class="status">此日期資料不足，無法判定。</p>'; return; }
  const rel = Object.entries(s.relative).map(([k, v]) => `<tr><th>${k}</th><td>${v ? v.value : '—'}</td><td>${v ? pct(v.chg21) : '—'}</td><td>${v?.above_ma50 == null ? '—' : v.above_ma50 ? '高於' : '<b class="mrl-neg">低於</b>'}</td></tr>`).join('');
  const tech = Object.entries(s.technical).map(([k, t]) => `<tr><th>${k}</th><td>${Object.entries(t.vs_ma).map(([n, x]) => `${n}MA ${pct(x)}`).join('<br>')}</td><td>${Object.entries(t.mom).map(([n, x]) => `${n}日 ${pct(x)}`).join('<br>')}</td><td>${t.dist_days_25}</td><td>${t.lower_high == null ? '—' : t.lower_high ? '<b class="mrl-neg">是</b>' : '否'}</td></tr>`).join('');
  const b = s.breadth;
  const breadth = b ? `S&P 站上 20／50／200MA：${b.above20 ?? '—'}%／${b.above50 ?? '—'}%／${b.above200 ?? '—'}%；新高 ${b.new_hi ?? '—'}、新低 ${b.new_lo ?? '—'}（${b.date}，現任成分代理）`
    : '廣度資料 2019-11 起，此日期之前無法判定。';
  const ad = s.adv_dec ? `漲 ${s.adv_dec.adv}／跌 ${s.adv_dec.dec}，近 10 日淨漲跌 ${s.adv_dec.net10}` : '漲跌家數 2015-12 起，此日期之前無法判定。';
  const outs = LAB.cases.map(x => ({ x, o: C.caseOutcome(x, 'SPY'), q: C.caseOutcome(x, 'QQQ') }));
  byId('case').innerHTML = `<p><b>${esc(c.label)}</b>：以下只用 ${esc(s.asof)} 收盤（含）以前已公布的資料。${c.status === 'pending' ? '<span class="mrl-pending">後續 60 日尚未走完（pending）</span>' : ''}</p>
    <div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>相對強弱</th><th>值</th><th>21日變化</th><th>vs 自身50MA</th></tr></thead><tbody>${rel}</tbody></table></div>
    <div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>技術結構</th><th>距均線</th><th>動能</th><th>Distribution Days（25日）</th><th>Lower High</th></tr></thead><tbody>${tech}</tbody></table></div>
    <p>${esc(breadth)}<br>${esc(ad)}</p>
    <div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>案例比較</th><th>SPY 60日後</th><th>SPY 期間最低</th><th>QQQ 60日後</th><th>QQQ 期間最低</th><th>狀態</th></tr></thead><tbody>${
      outs.map(({ x, o, q }) => `<tr${x.id === c.id ? ' class="mrl-sel"' : ''}><th>${esc(x.label)}</th><td>${pct(o?.end)}</td><td>${pct(o?.worst)}</td><td>${pct(q?.end)}</td><td>${pct(q?.worst)}</td><td>${o?.complete ? '完成' : `pending（${o?.days ?? 0} 日）`}</td></tr>`).join('')
    }</tbody></table></div><p class="mrl-sub">樣本 N=${LAB.cases.length}，事件日是人工挑選的「急跌開始」日，不是規則觸發，不能當成統計證據。2026/10/15 Minervini 建立 SPY 空單一事未找到可核實的一手來源；本頁只呈現該日可觀測的公開指標，不重建其未公開模型。</p>`;
}

function caseOption() {
  const series = LAB.cases.map((c, k) => ({ name: c.label.split('（')[0], type: 'line', showSymbol: false,
    lineStyle: { width: c.id === ui.caseId ? 2.6 : 1.1 }, itemStyle: { color: [BLUE, ORANGE, PURPLE, GREEN, RED][k % 5] },
    data: (c.forward.SPY?.path || []).map((p, i) => [i, p[1] * 100]) }));
  return echartsBase({ legend: { type: 'scroll', top: 0 }, tooltip: { trigger: 'axis', valueFormatter: x => (finite(x) ? `${x.toFixed(1)}%` : '—') },
    grid: { top: 40, left: 48, right: 16, bottom: 30 }, xAxis: { type: 'value', name: '交易日', min: 0, max: 60 }, yAxis: { type: 'value', name: 'SPY %' }, series });
}

// ── 台股分級 ───────────────────────────────────────────────────────────
function renderTW() {
  const tw = LAB.tw;
  if (!tw?.available) { byId('tw').innerHTML = '<p class="status">台股資料無法判定。</p>'; return; }
  const b = tw.breadth || {};
  byId('tw').innerHTML = `<p>${esc(tw.asof)}：距一年高點 盤中 ${pct(tw.drawdown_intraday)}／收盤 ${pct(tw.drawdown_close)}；臺灣50 站上60MA ${b.tw50_above60 ?? '—'}%、上市站上200MA ${b.twse_above200 ?? '—'}%、上市跌停占比 ${finite(b.limit_down_pct) ? b.limit_down_pct.toFixed(2) : '—'}%、融資 5 日 ${pct(b.margin_chg5)}（${esc(b.date || '—')}）。</p>
    <div class="mrl-table-wrap"><table class="mrl-table"><thead><tr><th>分級</th><th>指標</th><th>今天</th><th>最近一次</th><th>依據</th></tr></thead><tbody>${
      tw.signals.map(s => `<tr><td><span class="mrl-tier ${TIER[s.tier][1]}">${TIER[s.tier][0]}</span></td><td>${esc(s.name)}<div class="mrl-sub">${esc(s.basis)}</div></td><td>${s.triggered == null ? '—' : s.triggered ? '<b class="mrl-neg">觸發</b>' : '未觸發'}</td><td>${esc(s.last || '—')}${s.last_note ? `<div class="mrl-sub">${esc(s.last_note)}</div>` : ''}</td><td class="mrl-sub">${esc(s.evidence)}</td></tr>`).join('')
    }</tbody></table></div><p class="mrl-sub">只有「已驗證核心」可作為正式觸發條件；研究中／未證實增量價值的訊號不會升級為交易訊號。</p>`;
}

function renderProxies() {
  byId('proxies').innerHTML = `<ul>${Object.values(LAB.proxies).map(t => `<li>${esc(t)}</li>`).join('')}
    <li>Reset 去群聚：觸及後收盤連續 ${ui.rearm} 日站上 300MA 才記下一次（工程假設，可切 20／60）。</li>
    <li>NQ=F 為未換月調整的近月連續合約；台股不含台指期夜盤。Nasdaq 期貨盤中高低點來自日 K，非逐筆。</li></ul>`;
}

// ── 繪圖 ───────────────────────────────────────────────────────────────
function chart(key) {
  if (!charts[key]) charts[key] = echarts.init(byId(key), isLight() ? null : 'dark');
  return charts[key];
}
function drawAll() {
  renderSummary(); renderSignals(); renderStrategyTable(); renderWalkForward(); renderCase(); renderTW(); renderProxies();
  chart('main-chart').setOption(mainOption(), { notMerge: true });
  chart('nav-chart').setOption(strategyOption(), { notMerge: true });
  chart('case-chart').setOption(caseOption(), { notMerge: true });
  byId('twblock').hidden = ui.market !== 'TW';
}
function redraw(keepZoom = true) {
  if (!keepZoom) { drawAll(); return; }
  return preserveChartState(getCharts, drawAll);
}

function wire() {
  if (!bindOnce(byId('controls'))) return;
  chipPicker(byId('market'), 'market', v => { ui.market = v; drawAll(); });
  chipPicker(byId('kind'), 'kind', v => { ui.kind = v; redraw(); });
  chipPicker(byId('rearm'), 'rearm', v => { ui.rearm = Number(v); redraw(); });
  chipPicker(byId('horizon'), 'horizon', v => { ui.horizon = Number(v); renderSignals(); });
  byId('variant').addEventListener('change', e => { ui.variant = e.target.value; redraw(); });
  byId('from').addEventListener('change', e => { ui.from = Number(e.target.value); renderSignals(); });
  byId('to').addEventListener('change', e => { ui.to = Number(e.target.value); renderSignals(); });
  byId('casesel').addEventListener('change', e => { ui.caseId = e.target.value; renderCase(); chart('case-chart').setOption(caseOption(), { notMerge: true }); });
  byId('jump').addEventListener('click', () => {
    const c = LAB.cases.find(x => x.id === ui.caseId);
    if (!c) return;
    const t = Date.parse(c.date), y = 365 * 86400000;
    chart('main-chart').dispatchAction({ type: 'dataZoom', startValue: t - y / 2, endValue: t + y / 2 });
  });
}

function fillSelects() {
  const years = [];
  for (let y = 1990; y <= Number(LAB.updated.slice(0, 4)); y++) years.push(y);
  byId('from').innerHTML = years.map(y => `<option${y === ui.from ? ' selected' : ''}>${y}</option>`).join('');
  ui.to = years.at(-1);
  byId('to').innerHTML = years.map(y => `<option${y === ui.to ? ' selected' : ''}>${y}</option>`).join('');
  byId('casesel').innerHTML = LAB.cases.map(c => `<option value="${c.id}"${c.id === ui.caseId ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
}

// ── lifecycle ──────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (LAB && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const [lab, bt] = await Promise.all([
      requestJSON('data/market_risk_lab.json', { signal: context.signal }),
      requestJSON('data/market_risk_lab_backtest.json', { signal: context.signal }).catch(e => {
        if (context.signal?.aborted) throw e;
        return null; // 回測檔是 optional：缺失時頁面標示 partial
      }),
    ]);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!lab?.states || !lab?.chart?.us?.dates?.length) throw new Error('data/market_risk_lab.json 格式不完整');
    LAB = lab; BT = bt;
    byId('asof').textContent = `指標到 ${lab.us_latest?.asof || '—'}｜更新 ${lab.updated}`;
    byId('status').textContent = bt ? '' : '回測檔載入失敗（partial）：只顯示當前訊號。';
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  if (!byId('from').options.length) fillSelects();
  wire();
  drawAll();
}
export function getCharts() { return Object.values(charts); }
export function resize() { for (const c of Object.values(charts)) c.resize(); }
export function onThemeChange() {
  if (!LAB) return;
  return preserveChartState(getCharts, () => {
    for (const c of Object.values(charts)) c.dispose();
    charts = {};
    drawAll();
  });
}
