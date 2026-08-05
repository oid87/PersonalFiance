// js/tabs/roc4.js — QQQ 四日變動率（ROC4）急漲急跌事件
//
// ROC(4) = Close[t] / Close[t-4] - 1，以「交易日」計（非日曆日），單位 %。
// 上圖 QQQ 收盤（對數軸），下圖 ROC4 長條，超標染色；超標日以垂直線貫穿上下兩圖。
// 事件統計一律用「去重後的首日」（連續同向超標只算第一天），避免同一波重複計數。
// 防前視：事件在第 i 日收盤才確立，T+h 報酬一律從 i 之後的收盤取，且 i+h 超出資料
// 末端者直接排除（不補值），故表格末端樣本數會比事件數少。

import { isLight, PALETTE } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';
import { fetchJSON } from '../utils/data.js';

const TAB_ID = 'roc4';
const HORIZONS = [1, 5, 10, 20, 60];

let chart = null;
let raw = null;          // { dates: [], closes: [], roc: [] } 全歷史
let range = '10Y';
let thr = 5;
let showUp = true, showDn = true, firstOnly = true;

// ── data ─────────────────────────────────────────────────────────────────
async function loadAll() {
  if (raw) return raw;
  const rows = await fetchJSON('data/QQQ.json');
  const dates = rows.map(r => r.date);
  const closes = rows.map(r => r.close);
  const roc = closes.map((c, i) => (i < 4 ? null : (c / closes[i - 4] - 1) * 100));
  raw = { dates, closes, roc };
  return raw;
}

// 顯示窗（range chips）→ 全歷史陣列上的起始 index
function startIdx() {
  const cut = cutoffDate(range);
  if (range === 'MAX' || !cut) return 0;
  const i = raw.dates.findIndex(d => d >= cut);
  return i < 0 ? 0 : i;
}

// 事件：i0 起、超過門檻的交易日；firstOnly=true 時同向連續只留第一天
function events(i0) {
  const { roc } = raw;
  const out = [];
  let prev = 0;
  for (let i = 0; i < roc.length; i++) {
    const r = roc[i];
    const s = r == null ? 0 : (r > thr ? 1 : (r < -thr ? -1 : 0));
    if (s !== 0 && i >= i0 && (!firstOnly || s !== prev)) out.push({ i, date: raw.dates[i], dir: s, roc: r });
    prev = s;
  }
  return out;
}

// T+h 報酬（%），超出資料末端回 null
function fwd(i, h) {
  const { closes } = raw;
  return i + h < closes.length ? (closes[i + h] / closes[i] - 1) * 100 : null;
}

const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const clr = v => (v >= 0 ? '#3fb950' : '#f85149');

// ── chart ────────────────────────────────────────────────────────────────
function render() {
  if (!chart || !raw) return;
  const i0 = startIdx();
  const dates = raw.dates.slice(i0);
  const closes = raw.closes.slice(i0);
  const roc = raw.roc.slice(i0);

  const evs = events(i0);
  const shown = evs.filter(e => (e.dir > 0 && showUp) || (e.dir < 0 && showDn));
  // 事件密集時（MAX range 動輒 300+ 條）壓低不透明度，否則垂直線會蓋掉價格線
  const op = shown.length > 120 ? 0.3 : 0.7;
  const markData = shown.map(e => ({
    xAxis: e.date,
    lineStyle: { color: e.dir > 0 ? '#3fb950' : '#f85149', width: 1, type: 'dashed', opacity: op },
  }));
  const markLine = { silent: true, symbol: 'none', label: { show: false }, data: markData };

  const axisClr = PALETTE.muted, gridClr = PALETTE.grid;

  chart.setOption({
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text2, fontSize: 12 },
      formatter(params) {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        const r = roc[i];
        return `<div style="font-weight:600;margin-bottom:4px">${dates[i]}</div>`
          + `<div>收盤 ${closes[i].toFixed(2)}</div>`
          + `<div>ROC4 ${r == null ? '—' : `<span style="color:${clr(r)}">${fmtPct(r)}</span>`}</div>`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 62, right: 30, top: 24, height: '52%' },
      { left: 62, right: 30, top: '68%', height: '20%' },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, boundaryGap: false,
        axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
        axisLabel: { show: false }, splitLine: { show: false } },
      { type: 'category', data: dates, gridIndex: 1, boundaryGap: false,
        axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
        axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
    ],
    yAxis: [
      { type: 'log', gridIndex: 0, scale: true, name: 'QQQ 收盤', nameTextStyle: { color: axisClr },
        axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } } },
      { type: 'value', gridIndex: 1, name: 'ROC4 %', nameTextStyle: { color: axisClr },
        axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' },
      { type: 'slider', xAxisIndex: [0, 1], height: 18, bottom: 4 },
    ],
    series: [
      {
        name: 'QQQ', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
        data: closes, showSymbol: false,
        lineStyle: { color: PALETTE.text, width: 1.2 },
        itemStyle: { color: PALETTE.text },
        markLine,
      },
      {
        name: 'ROC4', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: roc.map(v => ({
          value: v,
          itemStyle: { color: v == null ? '#e3b341' : (v > thr ? '#3fb950' : (v < -thr ? '#f85149' : '#e3b341')) },
        })),
        barWidth: '90%',
        markLine: {
          silent: true, symbol: 'none', label: { show: false },
          data: [
            ...markData,
            { yAxis: 0, lineStyle: { color: axisClr, type: 'solid', width: 1 }, label: { show: false } },
            { yAxis: thr, lineStyle: { color: axisClr, type: 'dashed' }, label: { show: false } },
            { yAxis: -thr, lineStyle: { color: axisClr, type: 'dashed' }, label: { show: false } },
          ],
        },
      },
    ],
  }, { notMerge: true });

  const status = document.getElementById(`${TAB_ID}-status`);
  if (status) {
    status.textContent = `QQQ ${dates[0]} ～ ${dates[dates.length - 1]}（${dates.length} 個交易日）`
      + ` · 門檻 ±${thr}% · 圖上標記${firstOnly ? '（去重後首日）' : '（所有超標日，未去重）'}`
      + ` 上穿 ${evs.filter(e => e.dir > 0).length} 筆 / 下穿 ${evs.filter(e => e.dir < 0).length} 筆`
      + (firstOnly ? '' : ' · ⚠ 統計表仍一律用去重後首日');
  }

  renderTables(i0);
}

// ── tables ───────────────────────────────────────────────────────────────
function renderTables(i0) {
  const host = document.getElementById(`${TAB_ID}-tables`);
  if (!host) return;

  // 統計一律用去重後首日，不受「只標事件首日」勾選影響
  const savedFirst = firstOnly;
  firstOnly = true;
  const evs = events(i0);
  firstOnly = savedFirst;

  const up = evs.filter(e => e.dir > 0), dn = evs.filter(e => e.dir < 0);
  const cell = (arr, h) => {
    const v = arr.map(e => fwd(e.i, h)).filter(x => x != null);
    if (!v.length) return '<td>—</td><td>—</td>';
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const w = v.filter(z => z > 0).length / v.length * 100;
    return `<td style="color:${clr(m)}">${fmtPct(m)}</td><td>${w.toFixed(0)}% (n=${v.length})</td>`;
  };
  const t1 = HORIZONS.map(h =>
    `<tr><td>T+${h}</td>${cell(up, h)}${cell(dn, h)}</tr>`).join('')
    + `<tr><td>事件樣本數</td><td colspan="2">${up.length}</td><td colspan="2">${dn.length}</td></tr>`;

  const t2 = evs.slice(-12).reverse().map(e => {
    const a = fwd(e.i, 10), b = fwd(e.i, 20);
    return `<tr><td>${e.date}</td>`
      + `<td style="color:${e.dir > 0 ? '#3fb950' : '#f85149'}">${e.dir > 0 ? `上穿 +${thr}%` : `下穿 −${thr}%`}</td>`
      + `<td style="color:${clr(e.roc)}">${fmtPct(e.roc)}</td>`
      + `<td${a == null ? '' : ` style="color:${clr(a)}"`}>${a == null ? '—' : fmtPct(a)}</td>`
      + `<td${b == null ? '' : ` style="color:${clr(b)}"`}>${b == null ? '—' : fmtPct(b)}</td></tr>`;
  }).join('');

  host.innerHTML = `
    <h4 style="margin:12px 0 4px">表1・事件後報酬（事件＝去重後首日；統計範圍＝目前 range）</h4>
    <table class="info-table">
      <thead><tr><th>期間</th><th>上穿 平均報酬</th><th>上穿 勝率</th><th>下穿 平均報酬</th><th>下穿 勝率</th></tr></thead>
      <tbody>${t1}</tbody>
    </table>
    <h4 style="margin:16px 0 4px">表2・最近 12 筆事件</h4>
    <table class="info-table">
      <thead><tr><th>日期</th><th>方向</th><th>ROC4</th><th>T+10</th><th>T+20</th></tr></thead>
      <tbody>${t2 || '<tr><td colspan="5">此 range 內無事件</td></tr>'}</tbody>
    </table>
    <p style="margin-top:6px;color:var(--muted)">n = 該 horizon 實際可計算的樣本數（i+h 超出資料末端者排除，不補值）。事件之間高度重疊（急殺常連續數週出現），並非獨立樣本，平均與勝率會被單一波段主導。</p>
  `;
}

// ── controls ─────────────────────────────────────────────────────────────
function buildControls() {
  const host = document.getElementById(`${TAB_ID}-controls`);
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';

  host.querySelectorAll('[data-roc4-range]').forEach(c => c.addEventListener('click', () => {
    host.querySelectorAll('[data-roc4-range]').forEach(e => e.classList.remove('active'));
    c.classList.add('active');
    range = c.dataset.roc4Range;
    render();
  }));

  const bind = (id, fn) => {
    const c = document.getElementById(id);
    c?.addEventListener('click', () => { c.classList.toggle('active'); fn(c.classList.contains('active')); render(); });
  };
  bind(`${TAB_ID}-up`, v => { showUp = v; });
  bind(`${TAB_ID}-dn`, v => { showDn = v; });
  bind(`${TAB_ID}-first`, v => { firstOnly = v; });

  const inp = document.getElementById(`${TAB_ID}-thr`);
  inp?.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) return;
    thr = v;
    render();
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById(`${TAB_ID}-chart`);
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  buildControls();
  const status = document.getElementById(`${TAB_ID}-status`);
  try {
    await loadAll();
    render();
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
  }
}

export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById(`${TAB_ID}-chart`), light ? null : 'dark');
  render();
}

export function resize() { chart?.resize(); }
