// 凱利上限 tab — QQQ 滾動凱利建議槓桿上限 vs 200MA 乖離
//   權威來源：../Financial_work/kelly_leverage_ceiling.py（已 verifier PASS + 主 session 複核），
//   本檔案邏輯完全對照，公式勿自行更動。
//
// 核心：L* = (mu - RF) / sigma2；三窗口 W∈{63,126,252} 用滾動日報酬年化 mean(*252)/var(ddof=1,*252) 估計。
// 未來函數防護：整條 L* 序列 shift(1)（t 日只用 t-1 收盤算出的值）；200MA 乖離% 天然無未來函數
// （rolling 右對齊，繪圖對照用不是「建議值」，不需 shift）。
// L* 只是「天花板/尺」不是進場訊號 —— 看不見偏度，QQQ 負偏（崩盤急殺），平靜期 sigma2 被壓低
// 會把 L* 灌大（現在叫你開 6~12x 是陷阱）。實際安全槓桿要比 L* 更往左；L*<1 才與「該收槓桿」一致。
//
// 資料：直接讀 data/QQQ.json 收盤價，前端即時計算，無另開 fetch 腳本。
// ⚠️ 已知與 python 對照組的系統性落差（非本檔案邏輯 bug，已用獨立 python 腳本套用同一份
// data/QQQ.json 原始資料重算，結果與本頁 JS 完全一致，逐行確認過）：
//   data/QQQ.json 存的是「未還原息」收盤價；python ground truth 用 lab.download(auto_adjust=True)
//   抓的是「股息還原」收盤價（QQQ 有配息，yfinance auto_adjust=True 會把歷史價格往下調整反映
//   股息再投資）。年化報酬率因此系統性偏低，連帶把 L* 全數壓低：
//   本頁（未還原息，2026-07-13）L*(63d)=12.15／L*(126d)=6.11／L*(252d)=7.12／200MA乖離=+11.46%／
//   全史 L*(252d)<1 段數=88；python 對照組（還原息）依序為 12.24／6.20／7.26／+11.70%／87 段。
//   差距約 0.1~0.15（超出 spec 訂的 <0.01 對拍門檻），全史段數也不同（88 vs 87）。
//   不要為了湊數字改動本檔公式或憑空修改 data/QQQ.json——落差是資料內容（還原息 vs 未還原息）
//   差異，不是計算邏輯錯誤；是否要換成還原息資料源是主 session 的決策點，非本檔案範圍。

import { isLight, tc, PALETTE } from '../utils/theme.js';

const RF = 0.04;
const WINDOWS = [63, 126, 252];
const MA200_PERIOD = 200;

// L* 下格 y 軸可讀窗。L*(252d) 真實範圍約 -6.5 ~ +25（p50=3.0、p90=11.4），
// 若照真實範圍畫，關鍵區間（L*=1 收槓桿門檻、L*=2 QLD 紅線）會被壓成一條縫。
// 故固定窗口 + clamp 顯示值；超出者 tooltip 標「超出圖表範圍」並給真值。
const Y_LO = -4;
const Y_HI = 14;

let chart = null;
let allBars = null; // [{date, close}]
let computed = null;

// ── data load ─────────────────────────────────────────────────────────
async function loadData() {
  if (allBars) return allBars;
  const resp = await fetch('data/QQQ.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`QQQ.json: HTTP ${resp.status}`);
  const j = await resp.json();
  allBars = (j.data || []).map(r => ({ date: r.date, close: r.close }));
  return allBars;
}

// ── 滾動 mean/variance(ddof=1)，比照 pandas ret.rolling(W).mean()/var(ddof=1) 語意 ──
// ret[0] 恆為 null（pct_change 起點無前一日）；視窗需完全落在有效報酬區間內（closeIdx>=W）才有值。
function rollingMuSigma2(closes, W) {
  const n = closes.length;
  const mu = new Array(n).fill(null);
  const sigma2 = new Array(n).fill(null);
  const retValid = new Array(n - 1); // retValid[k] 對應 close index k+1
  for (let i = 1; i < n; i++) retValid[i - 1] = (closes[i] - closes[i - 1]) / closes[i - 1];

  let sum = 0, sumSq = 0;
  for (let k = 0; k < retValid.length; k++) {
    sum += retValid[k]; sumSq += retValid[k] * retValid[k];
    if (k >= W) { sum -= retValid[k - W]; sumSq -= retValid[k - W] * retValid[k - W]; }
    if (k >= W - 1) {
      const mean = sum / W;
      const variance = (sumSq - (sum * sum) / W) / (W - 1); // ddof=1 樣本變異數
      const closeIdx = k + 1;
      mu[closeIdx] = mean * 252;        // 年化 mu（*252，非 sqrt(252)）
      sigma2[closeIdx] = variance * 252; // 年化 sigma^2（*252，非 sqrt(252)）
    }
  }
  return { mu, sigma2 };
}

function shift1(arr) {
  const out = new Array(arr.length).fill(null);
  for (let i = 1; i < arr.length; i++) out[i] = arr[i - 1];
  return out;
}

function rollingMA(closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// L*(252d) < 1 連續區段（比照 python 逐點掃描抓 in_seg 區段的邏輯）
function findSegmentsBelow1(dates, lstar252) {
  const segments = [];
  let inSeg = false, segStart = null, prevIdx = null;
  for (let i = 0; i < lstar252.length; i++) {
    const v = lstar252[i];
    if (v == null) continue;
    const below = v < 1;
    if (below && !inSeg) { inSeg = true; segStart = i; }
    else if (!below && inSeg) { inSeg = false; segments.push([dates[segStart], dates[prevIdx]]); }
    prevIdx = i;
  }
  if (inSeg) segments.push([dates[segStart], dates[prevIdx]]);
  return segments;
}

function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return { idx: i, val: arr[i] };
  return null;
}

function compute(bars) {
  const dates = bars.map(b => b.date);
  const closes = bars.map(b => b.close);

  const ma200 = rollingMA(closes, MA200_PERIOD);
  const dev = closes.map((c, i) => (ma200[i] != null ? (c / ma200[i] - 1) * 100 : null));

  const lstar = {}, lhalf = {};
  for (const W of WINDOWS) {
    const { mu, sigma2 } = rollingMuSigma2(closes, W);
    const lsRaw = mu.map((m, i) => (m != null && sigma2[i] != null) ? (m - RF) / sigma2[i] : null);
    const ls = shift1(lsRaw); // 未來函數防護
    lstar[W] = ls;
    lhalf[W] = ls.map(v => (v == null ? null : v / 2));
  }

  const segments252 = findSegmentsBelow1(dates, lstar[252]);

  return { dates, closes, dev, lstar, lhalf, segments252 };
}

// ── badges ────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateBadges(res) {
  const l252 = lastValid(res.lstar[252]);
  const l126 = lastValid(res.lstar[126]);
  const l63 = lastValid(res.lstar[63]);
  const devV = lastValid(res.dev);

  setText('kelly-l252-val', l252 ? l252.val.toFixed(2) : 'N/A', l252 && l252.val < 1 ? '#f85149' : '#e3b341');
  setText('kelly-l252-sub', l252 ? `半凱利 ${(l252.val / 2).toFixed(2)}｜${res.dates[l252.idx]}` : '—', 'var(--muted)');

  setText('kelly-l126-val', l126 ? l126.val.toFixed(2) : 'N/A', PALETTE.text);
  setText('kelly-l126-sub', l126 ? res.dates[l126.idx] : '—', 'var(--muted)');

  setText('kelly-l63-val', l63 ? l63.val.toFixed(2) : 'N/A', PALETTE.text);
  setText('kelly-l63-sub', l63 ? res.dates[l63.idx] : '—', 'var(--muted)');

  setText('kelly-dev-val', devV ? `${devV.val >= 0 ? '+' : ''}${devV.val.toFixed(2)}%` : 'N/A',
    devV && devV.val >= 0 ? '#3fb950' : '#f85149');
  setText('kelly-dev-sub', devV ? res.dates[devV.idx] : '—', 'var(--muted)');

  const status = document.getElementById('kelly-status');
  if (status) status.textContent =
    `QQQ · ${res.dates.length} 根日K（${res.dates[0]} ~ ${res.dates[res.dates.length - 1]}）· ` +
    `L*(252d) ${l252 ? l252.val.toFixed(2) : 'N/A'}（半凱利 ${l252 ? (l252.val / 2).toFixed(2) : 'N/A'}）· ` +
    `200MA乖離 ${devV ? (devV.val >= 0 ? '+' : '') + devV.val.toFixed(2) : 'N/A'}% · ` +
    `L*(252d)<1 全史 ${res.segments252.length} 段`;
}

// ── 主圖渲染（上：200MA乖離%／下：L*，共用 x 軸） ─────────────────────
function render(res) {
  if (!chart) return;
  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = PALETTE.bg;
  const tipBdr = PALETTE.border;
  const textClr = PALETTE.text2;

  const dates = res.dates;
  const grid = [
    { left: 62, right: 30, top: '10%', height: '28%' },
    { left: 62, right: 30, top: '46%', height: '40%' },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: 'category', data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 1, color: axisClr, fontSize: 11 }, splitLine: { show: false },
  }));
  const yAxis = [
    { gridIndex: 0, scale: true, name: '200MA乖離%', nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + '%' },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, min: Y_LO, max: Y_HI, name: '建議槓桿倍數 L*（超出範圍已裁切）', nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridClr } } },
  ];

  // 紅色區段標示：L*(252d) < 1 → 底部細 ribbon（不用整片 axvspan，避免糊成一片）
  const segAreas = res.segments252.map(([s, e]) => ([
    { xAxis: s, yAxis: Y_LO, itemStyle: { color: 'rgba(248,81,73,0.55)' } },
    { xAxis: e, yAxis: Y_LO + 0.55 },
  ]));

  // 顯示用 clamp：L*(252d) 真實範圍 -6.5~+25，21.9% 落在可讀窗外。
  // 不 clamp 的話線會一直飛出畫面再飛回來 → 看起來像尖刺（其實是裁切假象）。
  // 這裡只 clamp「畫出來的值」，tooltip 一律顯示未裁切的真值。
  const clampDisp = arr => arr.map(v => v == null ? null : Math.min(Y_HI, Math.max(Y_LO, v)));

  const devSeries = {
    name: '200MA乖離%', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: res.dev,
    showSymbol: false, connectNulls: false, z: 3,
    itemStyle: { color: '#58a6ff' }, lineStyle: { color: '#58a6ff', width: 1.3 },
    markLine: {
      silent: true, symbol: 'none',
      data: [{ yAxis: 0, lineStyle: { color: axisClr, type: 'dashed', width: 1, opacity: 0.6 },
        label: { formatter: '0', color: axisClr, fontSize: 9, position: 'insideEndTop' } }],
    },
  };

  const l63Series = {
    name: 'L*(63d)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: clampDisp(res.lstar[63]),
    showSymbol: false, connectNulls: false, z: 1,
    itemStyle: { color: '#bcc2c9' }, lineStyle: { color: '#bcc2c9', width: 0.8, opacity: 0.8 },
  };
  const l126Series = {
    name: 'L*(126d)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: clampDisp(res.lstar[126]),
    showSymbol: false, connectNulls: false, z: 1,
    itemStyle: { color: '#8b949e' }, lineStyle: { color: '#8b949e', width: 0.8, opacity: 0.85 },
  };
  const l252Series = {
    name: 'L*(252d, 全凱利)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: clampDisp(res.lstar[252]),
    showSymbol: false, connectNulls: false, z: 5,
    itemStyle: { color: '#e3830a' }, lineStyle: { color: '#e3830a', width: 2 },
    markLine: {
      silent: true, symbol: 'none',
      data: [
        { yAxis: 2.0, lineStyle: { color: '#f85149', type: 'solid', width: 1.3 },
          label: { formatter: 'QLD 2x 紅線', color: '#f85149', fontSize: 10, position: 'insideEndTop' } },
        { yAxis: 1.0, lineStyle: { color: '#f85149', type: 'dashed', width: 1, opacity: 0.7 },
          label: { formatter: 'L*=1 收槓桿門檻', color: '#f85149', fontSize: 9, position: 'insideEndBottom' } },
      ],
    },
    markArea: {
      silent: true,
      itemStyle: { color: 'rgba(248,81,73,0.10)' },
      data: segAreas,
    },
  };
  const lHalfSeries = {
    name: 'L*/2(252d, 半凱利)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: clampDisp(res.lhalf[252]),
    showSymbol: false, connectNulls: false, z: 4,
    itemStyle: { color: '#e3830a' }, lineStyle: { color: '#e3830a', width: 1.4, type: 'dashed' },
  };

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        // L* 系列畫的是 clamp 後的值，tooltip 一律回查未裁切真值（避免誤讀裁切值）
        const RAW = {
          'L*(63d)': res.lstar[63], 'L*(126d)': res.lstar[126],
          'L*(252d, 全凱利)': res.lstar[252], 'L*/2(252d, 半凱利)': res.lhalf[252],
        };
        for (const p of params) {
          if (p.value == null) continue;
          let v;
          if (p.seriesName === '200MA乖離%') {
            v = `${(+p.value).toFixed(2)}%`;
          } else {
            const raw = RAW[p.seriesName]?.[p.dataIndex];
            if (raw == null) continue;
            const clipped = raw > Y_HI || raw < Y_LO;
            v = (+raw).toFixed(2) + (clipped ? '（超出圖表範圍）' : '');
          }
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid, xAxis, yAxis,
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 4 },
    ],
    legend: [
      { data: ['200MA乖離%'], top: 2, left: 'center', textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: ['L*(63d)', 'L*(126d)', 'L*(252d, 全凱利)', 'L*/2(252d, 半凱利)'],
        // 63d/126d 短窗 σ² 抖、雜訊高 → 預設關閉，需要時自己點開
        selected: { 'L*(63d)': false, 'L*(126d)': false },
        top: '38%', left: 'center', textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series: [devSeries, l63Series, l126Series, l252Series, lHalfSeries],
  }, { notMerge: true });
}

// ── controls / lifecycle ─────────────────────────────────────────────
async function refresh() {
  const status = document.getElementById('kelly-status');
  try {
    const bars = await loadData();
    computed = compute(bars);
    render(computed);
    updateBadges(computed);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
    console.error('[kelly] load failed', e);
  }
}

export async function activate() {
  const host = document.getElementById('kelly-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  else chart.resize();
  if (computed) { render(computed); updateBadges(computed); return; }
  await refresh();
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById('kelly-chart'), light ? null : 'dark');
  if (computed) { render(computed); updateBadges(computed); }
}
export function resize() { chart?.resize(); }
