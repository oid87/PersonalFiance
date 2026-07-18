// 槓桿模擬 tab — leveraged-ETF volatility-decay simulator.
// Four modes: 歷史回測 (real total-return backtest) / 單次模擬 (single GBM path) /
// 暴跌事件 (preset crash scenarios) / 蒙地卡羅 (Monte-Carlo final-value distribution).
// Data: self-contained data/leverage.json (total-return underlyings + real 2x/3x ETF
// NAV). The decay engine chains DAILY returns — real fund return post-inception,
// synthetic (K×underlyingRet − dailyCost) before — so synthetic→real splices smoothly.
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';

let levChart = null;
let BUNDLE = null;
let loadPromise = null;
let mode = 'backtest';
let logScale = false;
let wired = false;

const ETF_ORDER = ['TQQQ', 'SOXL', 'UPRO', '00631L', '00675L'];

// 崩跌起點（市場高點）→ 今日
const EVENTS = [
  { key: 'dotcom2000', label: '2000 網路泡沫', start: '2000-03-10' },
  { key: 'gfc2008',    label: '2008 金融海嘯', start: '2007-10-09' },
  { key: 'covid2020',  label: '2020 COVID 暴跌', start: '2020-02-19' },
  { key: 'rate2022',   label: '2022 升息空頭', start: '2022-01-03' },
  { key: 'q4-2018',    label: '2018 Q4 股災', start: '2018-09-20' },
  { key: 'china2015',  label: '2015 股災',    start: '2015-06-12' },
  { key: 'custom',     label: '自訂日期',     start: null },
];

const SCENARIOS = [
  { k: 'vshape',   l: 'V 型急跌反彈' },
  { k: 'lcrash',   l: 'L 型崩盤打底' },
  { k: 'sawtooth', l: '鋸齒洗盤（純耗損）' },
  { k: 'slowbear', l: '慢性陰跌熊市' },
];

// ── Per-mode settings (mutated in place) ──────────────────────────────────
const bt = { etf: '00675L', event: 'dotcom2000', from: '2000-03-10', to: '', initial: 10000, dca: false, dcaAmount: 1000 };
const sg = { K: 3, mu: 0,  sigma: 50, days: 252, cost: 1, seed: 1 };
const cr = { K: 3, scenario: 'vshape', cost: 1 };
const mc = { K: 3, mu: 8,  sigma: 40, days: 252, cost: 1, n: 2000, seed: 1 };

const curSettings = () => mode === 'backtest' ? bt : mode === 'single' ? sg : mode === 'crash' ? cr : mc;

// ── Formatting ────────────────────────────────────────────────────────────
const fmtMoney = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtPct = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
const clsPN = v => v >= 0 ? 'pos' : 'neg';
const fmtK = v => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return v.toFixed(0);
};
const fmtLbl = (v, unit) => unit === 'money' ? '$' + (+v).toLocaleString()
  : unit === '天' ? (+v).toLocaleString() + ' 天'
  : unit ? v + unit : '' + v;
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ── Math core ─────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Geometric Brownian Motion underlying level path (starts at 1).
function gbmLevels(days, muA, sigA, rng) {
  const dt = 1 / 252, drift = (muA - 0.5 * sigA * sigA) * dt, vol = sigA * Math.sqrt(dt);
  const L = [1];
  for (let i = 1; i <= days; i++) L.push(L[i - 1] * Math.exp(drift + vol * gauss(rng)));
  return L;
}
// Daily-reset leveraged curve (starts at 1) from an underlying level series.
function leverageFromLevels(levels, K, annualCost) {
  const dd = annualCost / 252, lev = [1];
  for (let i = 1; i < levels.length; i++) {
    const r = levels[i] / levels[i - 1] - 1;
    lev.push(Math.max(lev[i - 1] * (1 + K * r - dd), 0));
  }
  return lev;
}
function maxDrawdown(eq) {
  let peak = -Infinity, mdd = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak > 0) mdd = Math.min(mdd, v / peak - 1); }
  return mdd;
}
function longestUnderwater(dates, eq) {
  let peak = -Infinity, peakDate = dates[0], maxd = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] >= peak) { peak = eq[i]; peakDate = dates[i]; }
    else maxd = Math.max(maxd, dayDiff(peakDate, dates[i]));
  }
  return maxd;
}
function drawdownEpisodes(dates, eq, topN = 5) {
  const eps = [];
  let peak = eq[0], pi = 0, trough = eq[0], ti = 0, inDD = false;
  for (let i = 1; i < eq.length; i++) {
    if (eq[i] >= peak) {
      if (inDD) { eps.push({ pi, ti, ri: i, depth: trough / peak - 1 }); inDD = false; }
      peak = eq[i]; pi = i; trough = eq[i]; ti = i;
    } else {
      if (eq[i] < trough) { trough = eq[i]; ti = i; }
      inDD = true;
    }
  }
  if (inDD) eps.push({ pi, ti, ri: null, depth: trough / peak - 1 });
  eps.sort((a, b) => a.depth - b.depth);
  return eps.slice(0, topN).map(e => ({
    depth: e.depth, peakDate: dates[e.pi], troughDate: dates[e.ti],
    recDate: e.ri != null ? dates[e.ri] : null,
    days: dayDiff(dates[e.pi], e.ri != null ? dates[e.ri] : dates[dates.length - 1]),
  }));
}
function crashLevels(scenario) {
  const L = [1];
  const glideTo = (target, steps) => {
    const start = L[L.length - 1];
    for (let i = 1; i <= steps; i++) L.push(start * Math.pow(target / start, i / steps));
  };
  if (scenario === 'vshape') { glideTo(0.65, 25); glideTo(0.95, 35); glideTo(1.02, 20); }
  else if (scenario === 'lcrash') { glideTo(0.5, 18); for (let i = 0; i < 55; i++) L.push(L[L.length - 1] * (1 + (i % 2 ? 0.004 : -0.004))); }
  else if (scenario === 'sawtooth') { for (let i = 0; i < 90; i++) L.push(L[L.length - 1] * (1 + (i % 2 ? 0.06 : -0.06))); }
  else { glideTo(0.55, 180); }
  return L;
}

// ── Historical backtest builder ───────────────────────────────────────────
function applyContrib(dates, levNav, oneNav) {
  const n = dates.length, levVal = new Array(n), oneVal = new Array(n);
  let levUnits = 0, oneUnits = 0, contributed = 0, curMonth = dates[0].slice(0, 7);
  for (let i = 0; i < n; i++) {
    if (i === 0) { levUnits += bt.initial / levNav[0]; oneUnits += bt.initial / oneNav[0]; contributed += bt.initial; }
    else if (bt.dca) {
      const m = dates[i].slice(0, 7);
      if (m !== curMonth) { curMonth = m; if (levNav[i] > 0 && oneNav[i] > 0) { levUnits += bt.dcaAmount / levNav[i]; oneUnits += bt.dcaAmount / oneNav[i]; contributed += bt.dcaAmount; } }
    }
    levVal[i] = levUnits * levNav[i]; oneVal[i] = oneUnits * oneNav[i];
  }
  return { levVal, oneVal, contributed };
}
function buildBacktest() {
  const etf = BUNDLE.etfs.find(e => e.id === bt.etf);
  if (!etf) return null;
  const under = BUNDLE.underlyings[etf.underlying];
  const uData = under.data;
  const from = bt.from || uData[0][0];
  const to = bt.to || uData[uData.length - 1][0];
  const win = uData.filter(r => r[0] >= from && r[0] <= to);
  if (win.length < 2) return null;
  const K = etf.leverage, inc = etf.inception;
  const annualCost = etf.expense + (K - 1) * etf.financing, dd = annualCost / 252;
  const rret = {};
  for (let i = 1; i < etf.real.length; i++) rret[etf.real[i][0]] = etf.real[i][1] / etf.real[i - 1][1] - 1;
  const dates = [win[0][0]], levNav = [1], oneNav = [1];
  let synthDays = 0;
  for (let i = 1; i < win.length; i++) {
    const d = win[i][0], ur = win[i][1] / win[i - 1][1] - 1;
    let lr;
    if (d >= inc && rret[d] != null) lr = rret[d];
    else { lr = K * ur - dd; synthDays++; }
    levNav.push(Math.max(levNav[i - 1] * (1 + lr), 0));
    oneNav.push(oneNav[i - 1] * (1 + ur));
    dates.push(d);
  }
  const { levVal, oneVal, contributed } = applyContrib(dates, levNav, oneNav);
  return {
    etf, dates, levNav, oneNav, levVal, oneVal, contributed, K, inc, annualCost,
    synthDays, actualStart: dates[0], lastDate: dates[dates.length - 1],
    synthetic: dates[0] < inc, underName: under.name,
  };
}

// ── DOM helpers ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function card(label, val, cls = '', sub = '') {
  return `<div class="lev-card"><div class="lc-label">${label}</div>` +
    `<div class="lc-val ${cls}">${val}</div>${sub ? `<div class="lc-sub">${sub}</div>` : ''}</div>`;
}
const setCards = h => { $('lev-cards').innerHTML = h; };
const setExtra = h => { $('lev-extra').innerHTML = h; };
const setDesc = t => { $('lev-mode-desc').textContent = t; };
const setStatus = t => { $('lev-status').textContent = t; };
function setBanner(h) {
  const b = $('lev-synth-banner');
  if (h) { b.style.display = 'block'; b.innerHTML = h; } else b.style.display = 'none';
}

// ── ECharts builders ──────────────────────────────────────────────────────
function lineOption({ series, xType, markInitial }) {
  const axisClr = PALETTE.muted, splitClr = tc('rgba(255,255,255,.06)', 'rgba(0,0,0,.07)');
  const tipBg = PALETTE.bg, tipBd = PALETTE.border, tipTx = PALETTE.text;
  const s = series.map((x, idx) => {
    const data = logScale ? x.data.map(p => [p[0], p[1] > 0 ? p[1] : null]) : x.data;
    const o = {
      name: x.name, type: 'line', data, showSymbol: false, sampling: 'lttb',
      lineStyle: { width: idx === 0 ? 2.2 : 1.6, color: x.color },
      itemStyle: { color: x.color },
    };
    if (idx === 0 && markInitial != null) o.markLine = {
      silent: true, symbol: 'none', lineStyle: { color: axisClr, type: 'dashed', width: 1 },
      label: { formatter: '投入本金', color: axisClr, position: 'insideEndTop', fontSize: 10 },
      data: [{ yAxis: markInitial }],
    };
    return o;
  });
  levChart.setOption({
    backgroundColor: 'transparent',
    grid: { top: 32, right: mob() ? 14 : 26, bottom: 44, left: mob() ? 54 : 68 },
    legend: { top: 2, textStyle: { color: tipTx, fontSize: 12 }, itemWidth: 18, itemHeight: 10 },
    tooltip: {
      trigger: 'axis', backgroundColor: tipBg, borderColor: tipBd, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return '';
        const ax = params[0].axisValue;
        const head = xType === 'time'
          ? (typeof ax === 'number' ? tsToLocalDate(ax) : ax)
          : `第 ${Math.round(ax).toLocaleString()} 天`;
        let str = `<b>${head}</b>`;
        for (const p of params) {
          const v = p.value && p.value[1];
          str += `<br/>${p.marker}${p.seriesName}: <b>${v == null ? '—' : fmtMoney(v)}</b>`;
        }
        return str;
      },
    },
    xAxis: {
      type: xType, ...(xType === 'value' ? { name: '交易日', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: axisClr, fontSize: 11 } } : {}),
      axisLine: { lineStyle: { color: axisClr } }, axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      type: logScale ? 'log' : 'value', scale: true, axisLine: { show: false },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => '$' + fmtK(v) },
      splitLine: { lineStyle: { color: splitClr } },
    },
    series: s, animation: false,
  }, { notMerge: true });
}

// ── Mode renderers ────────────────────────────────────────────────────────
function rankTable(title, eps) {
  const rows = eps.map((e, i) => `<tr>
    <td class="rk-no">#${i + 1}</td>
    <td>${e.peakDate} → ${e.troughDate} → ${e.recDate || '<span style="color:var(--accent)">未收復</span>'}
      <div class="rk-path">${e.days.toLocaleString()} 天</div></td>
    <td class="rk-depth neg">${fmtPct(e.depth)}</td></tr>`).join('');
  return `<div class="lev-rank"><h4>${title}</h4><table>${rows || '<tr><td>無</td></tr>'}</table></div>`;
}
function renderBacktest() {
  setDesc('真實歷史回測 · 槓桿 vs 無槓桿');
  const r = buildBacktest();
  if (!r) { setStatus('此區間無足夠資料，請調整日期'); setCards(''); setExtra(''); setBanner(''); levChart.clear(); return; }
  const levFinal = r.levVal[r.levVal.length - 1], oneFinal = r.oneVal[r.oneVal.length - 1];
  const totLev = levFinal / r.contributed - 1, totOne = oneFinal / r.contributed - 1;
  const mdd = maxDrawdown(r.levNav), luw = longestUnderwater(r.dates, r.levNav);
  const be = levFinal >= r.contributed;
  setCards(
    card(`${r.etf.id} 目前價值`, fmtMoney(levFinal), clsPN(levFinal - r.contributed), `投入 ${fmtMoney(r.contributed)}`) +
    card('無槓桿對照組', fmtMoney(oneFinal), '', `${r.etf.underlying} 含息 1x`) +
    card(`${r.K}x 總報酬率`, fmtPct(totLev), clsPN(totLev), `無槓桿 ${fmtPct(totOne)}`) +
    card('最大回撤', fmtPct(mdd), 'neg', `${r.K}x 期間最深跌幅`) +
    card('是否回本', be ? '✅ 已回本' : '❌ 未回本', be ? 'pos' : 'neg') +
    card('最長水下天數', luw.toLocaleString() + ' 天', '', '跌破前高→收復') +
    card('回測起始日', r.actualStart) +
    card('最新數據日', r.lastDate)
  );
  if (r.synthetic) {
    const realStart = r.etf.real[0] && r.etf.real[0][0];
    setBanner(`⚠️ <b>合成數據</b> — ${r.etf.id} 成立於 ${r.inc}，回測起點 ${r.actualStart} 之前尚未成立。` +
      `此段以 <b>${r.underName}</b> 的 ${r.K}x 每日重置合成（年化成本 ${(r.annualCost * 100).toFixed(1)}%）；` +
      `${realStart ? realStart + ' 起採真實基金淨值。' : ''}合成段為近似，僅供理解風險量級。`);
  } else setBanner('');
  // check_reuse: keep — 漲跌語意色,不屬 PALETTE 七組
  const levColor = r.K >= 3 ? '#f85149' : '#f0883e', oneColor = tc('#8b949e', '#9aa3ad');
  lineOption({
    xType: 'time',
    series: [
      { name: `${r.etf.id} (${r.K}x)`, color: levColor, data: r.dates.map((d, i) => [d, +r.levVal[i].toFixed(2)]) },
      { name: `無槓桿 ${r.etf.underlying}`, color: oneColor, data: r.dates.map((d, i) => [d, +r.oneVal[i].toFixed(2)]) },
    ],
    markInitial: !bt.dca ? r.contributed : null,
  });
  setExtra(`<div class="lev-rank-wrap">${rankTable(`最大回撤排名（${r.K}x 槓桿）`, drawdownEpisodes(r.dates, r.levNav))}` +
    `${rankTable('最大回撤排名（無槓桿）', drawdownEpisodes(r.dates, r.oneNav))}</div>`);
  setStatus(`${r.etf.id} ${r.etf.zh} · ${r.dates.length.toLocaleString()} 個交易日 · ${r.actualStart} → ${r.lastDate}` +
    `${r.synthDays ? ` · 含 ${r.synthDays.toLocaleString()} 天合成` : ''}`);
}
function renderSingle() {
  setDesc('單一隨機路徑 · 波動耗損示範'); setBanner('');
  const rng = mulberry32((sg.seed * 2654435761) >>> 0);
  const lv = gbmLevels(sg.days, sg.mu / 100, sg.sigma / 100, rng);
  const lev = leverageFromLevels(lv, sg.K, sg.cost / 100);
  const base = 10000, oneRet = lv[lv.length - 1] - 1, levRet = lev[lev.length - 1] - 1;
  const linear = sg.K * oneRet, decay = levRet - linear, mdd = maxDrawdown(lev);
  setCards(
    card('標的終值 (1x)', fmtMoney(base * (1 + oneRet)), clsPN(oneRet), fmtPct(oneRet)) +
    card(`${sg.K}x 終值`, fmtMoney(base * (1 + levRet)), clsPN(levRet), fmtPct(levRet)) +
    card(`理論線性 ${sg.K}×標的`, fmtPct(linear), clsPN(linear), '若無耗損應有報酬') +
    card('波動/成本耗損', fmtPct(decay), clsPN(decay), `${sg.K}x 實際 − 線性`) +
    card(`${sg.K}x 最大回撤`, fmtPct(mdd), 'neg', '此路徑期間')
  );
  const levColor = sg.K >= 3 ? '#f85149' : '#f0883e';
  lineOption({
    xType: 'value',
    series: [
      // check_reuse: keep — 刻意的次級灰 tc('#8b949e','#9aa3ad'),淺色端與 PALETTE.muted 差很多
      { name: '標的 (1x)', color: tc('#8b949e', '#9aa3ad'), data: lv.map((v, i) => [i, +(base * v).toFixed(0)]) },
      { name: `${sg.K}x 槓桿`, color: levColor, data: lev.map((v, i) => [i, +(base * v).toFixed(0)]) },
    ],
  });
  setExtra(`<div style="font-size:12.5px;color:var(--muted);line-height:1.7;padding:2px">同一條標的路徑下，` +
    `${sg.K}x 的實際終值與「線性 ${sg.K} 倍」差了 <b class="${clsPN(decay)}">${fmtPct(decay)}</b>——這就是` +
    `<b>波動耗損 + 成本</b>。年化波動越高、持有越久，落差越大。按「重新生成」看不同隨機路徑。</div>`);
  setStatus(`單次模擬 · ${sg.K}x · 年化報酬 ${sg.mu}% / 波動 ${sg.sigma}% / ${sg.days} 天 / 成本 ${sg.cost}%`);
}
function renderCrash() {
  setDesc('預設崩跌情境 · 槓桿放大與回本數學'); setBanner('');
  const lv = crashLevels(cr.scenario), lev = leverageFromLevels(lv, cr.K, cr.cost / 100), base = 10000;
  const oneTrough = Math.min(...lv) - 1, levTrough = Math.min(...lev) - 1;
  const oneEnd = lv[lv.length - 1] - 1, levEnd = lev[lev.length - 1] - 1;
  const recNeed = levTrough <= -1 ? Infinity : 1 / (1 + levTrough) - 1;
  setCards(
    card('標的谷底', fmtPct(oneTrough), 'neg') +
    card(`${cr.K}x 谷底`, fmtPct(levTrough), 'neg') +
    card('標的終值', fmtPct(oneEnd), clsPN(oneEnd)) +
    card(`${cr.K}x 終值`, fmtPct(levEnd), clsPN(levEnd)) +
    card('回本數學', recNeed === Infinity ? '已歸零' : '+' + (recNeed * 100).toFixed(0) + '%', recNeed === Infinity ? 'neg' : '', `${cr.K}x 從谷底回本需漲`)
  );
  const levColor = cr.K >= 3 ? '#f85149' : '#f0883e';
  lineOption({
    xType: 'value',
    series: [
      // check_reuse: keep — 刻意的次級灰 tc('#8b949e','#9aa3ad'),淺色端與 PALETTE.muted 差很多
      { name: '標的 (1x)', color: tc('#8b949e', '#9aa3ad'), data: lv.map((v, i) => [i, +(base * v).toFixed(0)]) },
      { name: `${cr.K}x 槓桿`, color: levColor, data: lev.map((v, i) => [i, +(base * v).toFixed(0)]) },
    ],
  });
  setExtra(`<div style="font-size:12.5px;color:var(--muted);line-height:1.7;padding:2px">標的最深跌 ` +
    `<b class="neg">${fmtPct(oneTrough)}</b>，${cr.K}x 卻被放大到 <b class="neg">${fmtPct(levTrough)}</b>；` +
    `${recNeed === Infinity ? '單日放大已使其歸零，永遠回不來。' : `要從谷底回本需再漲 <b>+${(recNeed * 100).toFixed(0)}%</b>（跌得越深、回本越難）。`}` +
    ` 這就是槓桿在崩跌中的不對稱風險。</div>`);
  setStatus(`暴跌事件 · ${SCENARIOS.find(s => s.k === cr.scenario).l} · ${cr.K}x · 成本 ${cr.cost}%`);
}
function renderMC() {
  setDesc('蒙地卡羅 · 終值機率分布'); setBanner('');
  const N = mc.n, finals = [], ones = [];
  let win = 0, ruin = 0;
  for (let p = 0; p < N; p++) {
    const rng = mulberry32(((mc.seed * 1000003) + (p + 1) * 2654435761) >>> 0);
    const lv = gbmLevels(mc.days, mc.mu / 100, mc.sigma / 100, rng);
    const lev = leverageFromLevels(lv, mc.K, mc.cost / 100);
    const fr = lev[lev.length - 1] - 1, or = lv[lv.length - 1] - 1;
    finals.push(fr); ones.push(or);
    if (fr > or) win++;
    if (fr <= -0.9) ruin++;
  }
  const sorted = [...finals].sort((a, b) => a - b);
  const q = pr => sorted[Math.max(0, Math.min(N - 1, Math.floor(pr * (N - 1))))];
  const mean = finals.reduce((a, b) => a + b, 0) / N, med = q(0.5);
  const oneMed = [...ones].sort((a, b) => a - b)[Math.floor(0.5 * (N - 1))];
  setCards(
    card(`${mc.K}x 中位數報酬`, fmtPct(med), clsPN(med), `標的中位 ${fmtPct(oneMed)}`) +
    card(`${mc.K}x 平均報酬`, fmtPct(mean), clsPN(mean), '長尾拉高的平均') +
    card('勝過標的機率', (win / N * 100).toFixed(0) + '%', win / N >= 0.5 ? 'pos' : 'neg', `${mc.K}x > 1x`) +
    card('近乎歸零機率', (ruin / N * 100).toFixed(0) + '%', 'neg', '終值 ≤ −90%') +
    card('95 百分位', fmtPct(q(0.95)), 'pos', '樂觀情境') +
    card('5 百分位', fmtPct(q(0.05)), 'neg', '悲觀情境')
  );
  drawMCHist(finals, med, oneMed);
  setExtra(`<div style="font-size:12.5px;color:var(--muted);line-height:1.7;padding:2px">${N.toLocaleString()} 條隨機路徑` +
    `（年化報酬 ${mc.mu}% / 波動 ${mc.sigma}% / ${mc.days} 天 / ${mc.K}x / 成本 ${mc.cost}%）。分布<b>右偏</b>是槓桿的本質：` +
    `少數路徑爆賺、多數被波動耗損拖累，所以<b>中位數常低於平均、也常輸給標的</b>。最左側貼近 −100% 即接近歸零。</div>`);
  setStatus(`蒙地卡羅 · ${N.toLocaleString()} 路徑 · 勝率 ${(win / N * 100).toFixed(0)}% · 中位 ${fmtPct(med)}`);
}
function drawMCHist(finals, med, oneMed) {
  const lo = -1, hi = 3, bins = 60, w = (hi - lo) / bins, counts = new Array(bins).fill(0);
  for (const v of finals) counts[Math.floor((Math.min(Math.max(v, lo), hi - 1e-9) - lo) / w)]++;
  // check_reuse: keep — 漲跌語意色,不屬 PALETTE 七組
  const pos = tc('#3fb950', '#1a7f37'), neg = '#f78166';
  const data = counts.map((c, i) => {
    const x = lo + w * (i + 0.5);
    return { value: [+x.toFixed(3), c], itemStyle: { color: x >= 0 ? pos : neg } };
  });
  const axisClr = PALETTE.muted, splitClr = tc('rgba(255,255,255,.06)', 'rgba(0,0,0,.07)');
  const tipBg = PALETTE.bg, tipBd = PALETTE.border, tipTx = PALETTE.text;
  const mLine = (x, color, txt) => ({ xAxis: x, lineStyle: { color, type: 'dashed', width: 1.4 }, label: { formatter: txt, color, fontSize: 10, position: 'insideEndTop' } });
  levChart.setOption({
    backgroundColor: 'transparent',
    grid: { top: 20, right: mob() ? 14 : 26, bottom: 46, left: mob() ? 44 : 56 },
    tooltip: {
      trigger: 'axis', backgroundColor: tipBg, borderColor: tipBd, textStyle: { color: tipTx, fontSize: 12 },
      formatter: ps => { const p = ps[0]; return `終值報酬 ≈ <b>${(p.value[0] * 100).toFixed(0)}%</b><br/>路徑數: <b>${p.value[1]}</b>`; },
    },
    xAxis: {
      type: 'value', min: lo, max: hi, name: '槓桿終值報酬', nameLocation: 'middle', nameGap: 28,
      nameTextStyle: { color: axisClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } }, axisLabel: { color: axisClr, fontSize: 11, formatter: v => (v * 100).toFixed(0) + '%' }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', name: '路徑數', axisLine: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { lineStyle: { color: splitClr } },
    },
    series: [{
      type: 'bar', data, barCategoryGap: '8%',
      markLine: { silent: true, symbol: 'none', data: [mLine(0, axisClr, '0%'), mLine(+med.toFixed(3), '#f0883e', '中位'), mLine(+oneMed.toFixed(3), PALETTE.muted, '標的中位')] },
    }],
    animation: false,
  }, { notMerge: true });
}
function renderMode() {
  if (!levChart) return;
  if (mode === 'backtest') { if (!BUNDLE) return; renderBacktest(); }
  else if (mode === 'single') renderSingle();
  else if (mode === 'crash') renderCrash();
  else renderMC();
}

// ── Panels ────────────────────────────────────────────────────────────────
function panelBacktest() {
  const etfOpts = ETF_ORDER.map(id => {
    const e = BUNDLE && BUNDLE.etfs.find(x => x.id === id);
    const lbl = e ? `${id} · ${e.zh} (${e.leverage}x)` : id;
    return `<option value="${id}" ${id === bt.etf ? 'selected' : ''}>${lbl}</option>`;
  }).join('');
  const events = EVENTS.map(ev => `<span class="chip ${ev.key === bt.event ? 'active' : ''}" data-event="${ev.key}">${ev.label}</span>`).join('');
  return `
    <div class="lev-field"><label>槓桿 ETF</label><select data-set="etf">${etfOpts}</select></div>
    <div class="lev-field"><label>歷史事件（崩跌起點 → 今日）</label><div class="lev-event-grid">${events}</div></div>
    <div class="lev-field"><label>回測區間</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="date" data-set="from" data-struct="1" value="${bt.from}" />
        <span style="color:var(--muted)">→</span>
        <input type="date" data-set="to" data-struct="1" value="${bt.to}" />
      </div></div>
    <div class="lev-field"><label>初始投入金額 <b data-lbl="initial">${fmtLbl(bt.initial, 'money')}</b></label>
      <input type="range" data-set="initial" data-unit="money" min="1000" max="100000" step="1000" value="${bt.initial}" /></div>
    <label class="lev-checkbox"><input type="checkbox" data-set="dca" data-struct="1" ${bt.dca ? 'checked' : ''}/> 定期定額（每月加碼）</label>
    ${bt.dca ? `<div class="lev-field"><label>每月加碼 <b data-lbl="dcaAmount">${fmtLbl(bt.dcaAmount, 'money')}</b></label>
      <input type="range" data-set="dcaAmount" data-unit="money" min="100" max="10000" step="100" value="${bt.dcaAmount}" /></div>` : ''}
    <span class="chip ${logScale ? 'active' : ''}" data-act="log" style="text-align:center">對數軸（看耗損更清楚）</span>`;
}
function rangeField(key, label, val, unit, min, max, step) {
  return `<div class="lev-field"><label>${label} <b data-lbl="${key}">${fmtLbl(val, unit)}</b></label>
    <input type="range" data-set="${key}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${val}" /></div>`;
}
function panelSingle() {
  return rangeField('K', '槓桿倍數', sg.K, 'x', 1, 5, 0.5) +
    rangeField('mu', '年化報酬（標的）', sg.mu, '%', -20, 30, 1) +
    rangeField('sigma', '年化波動', sg.sigma, '%', 5, 120, 1) +
    rangeField('days', '持有天數', sg.days, '天', 30, 1260, 10) +
    rangeField('cost', '年化成本（費用＋融資）', sg.cost, '%', 0, 6, 0.1) +
    `<button class="lev-btn" data-act="reroll">🎲 重新生成路徑</button>`;
}
function panelCrash() {
  const scen = SCENARIOS.map(s => `<span class="chip ${s.k === cr.scenario ? 'active' : ''}" data-scen="${s.k}">${s.l}</span>`).join('');
  return rangeField('K', '槓桿倍數', cr.K, 'x', 1, 5, 0.5) +
    `<div class="lev-field"><label>崩跌情境</label><div class="lev-event-grid">${scen}</div></div>` +
    rangeField('cost', '年化成本', cr.cost, '%', 0, 6, 0.1);
}
function panelMC() {
  return rangeField('K', '槓桿倍數', mc.K, 'x', 1, 5, 0.5) +
    rangeField('mu', '年化報酬', mc.mu, '%', -10, 20, 1) +
    rangeField('sigma', '年化波動', mc.sigma, '%', 5, 100, 1) +
    rangeField('days', '持有天數', mc.days, '天', 30, 1260, 10) +
    rangeField('cost', '年化成本', mc.cost, '%', 0, 6, 0.1) +
    rangeField('n', '模擬路徑數', mc.n, '', 200, 5000, 200) +
    `<button class="lev-btn" data-act="reroll">🎲 重新模擬</button>`;
}
function renderPanel() {
  $('lev-panel').innerHTML = mode === 'backtest' ? panelBacktest()
    : mode === 'single' ? panelSingle() : mode === 'crash' ? panelCrash() : panelMC();
}

// ── Events ────────────────────────────────────────────────────────────────
function onPanelInput(e) {
  const t = e.target, key = t.dataset.set;
  if (!key) return;
  const s = curSettings();
  const v = t.type === 'checkbox' ? t.checked : (t.type === 'number' || t.type === 'range' ? +t.value : t.value);
  s[key] = v;
  if (key === 'from' || key === 'to') bt.event = 'custom';
  const lbl = document.querySelector(`#lev-panel [data-lbl="${key}"]`);
  if (lbl) lbl.textContent = fmtLbl(v, t.dataset.unit);
  if (t.dataset.struct) renderPanel();
  renderMode();
}
function onPanelClick(e) {
  const ev = e.target.closest('.chip[data-event]');
  if (ev) {
    bt.event = ev.dataset.event;
    const def = EVENTS.find(x => x.key === bt.event);
    if (def && def.start) { bt.from = def.start; bt.to = ''; }
    renderPanel(); renderMode(); return;
  }
  const sc = e.target.closest('.chip[data-scen]');
  if (sc) { cr.scenario = sc.dataset.scen; renderPanel(); renderMode(); return; }
  const log = e.target.closest('[data-act="log"]');
  if (log) { logScale = !logScale; log.classList.toggle('active', logScale); renderMode(); return; }
  const re = e.target.closest('[data-act="reroll"]');
  if (re) { const s = curSettings(); s.seed = (s.seed || 1) + 1; renderMode(); return; }
}
function setupEvents() {
  if (wired) return;
  wired = true;
  $('lev-mode-picker').addEventListener('click', e => {
    const t = e.target.closest('.chip[data-lev-mode]');
    if (!t) return;
    mode = t.dataset.levMode;
    for (const c of document.querySelectorAll('#lev-mode-picker .chip')) c.classList.toggle('active', c === t);
    renderPanel(); renderMode();
  });
  const panel = $('lev-panel');
  panel.addEventListener('input', onPanelInput);
  panel.addEventListener('change', onPanelInput);
  panel.addEventListener('click', onPanelClick);
}

async function loadBundle() {
  if (BUNDLE) return BUNDLE;
  if (!loadPromise) loadPromise = fetch('data/leverage.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  BUNDLE = await loadPromise;
  return BUNDLE;
}

// ── Lifecycle (switcher API) ──────────────────────────────────────────────
export function activate() {
  if (!levChart) { levChart = echarts.init($('lev-chart'), isLight() ? null : 'dark'); }
  setupEvents();
  setTimeout(async () => {
    levChart.resize();
    renderPanel();
    if (!BUNDLE && mode === 'backtest') {
      setStatus('載入槓桿資料中…');
      try { await loadBundle(); } catch (e) { setStatus('載入失敗：' + e.message); return; }
    } else if (!BUNDLE) {
      loadBundle().catch(() => {});
    }
    renderMode();
  }, 50);
}
export function onThemeChange(light) {
  if (!levChart) return;
  levChart.dispose();
  levChart = echarts.init($('lev-chart'), light ? null : 'dark');
  renderMode();
}
export function resize() { levChart && levChart.resize(); }
