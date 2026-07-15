// 融資斷頭地圖 tab — 台股融資「成本位階 / 斷頭地圖」
//   命題:單一大盤融資維持率(如 180%)藏掉分布。用每日融資買進/賣出/償還金額
//   還原「未平倉融資建立在哪些加權指數位階(vintage)」,推算「指數再跌 X% 會
//   觸發多少 % 融資觸及 130% 追繳」。
//
//   模型(已由主 session 驗收定案,前端純顯示,不做任何計算邏輯):
//   - blend 衰減 f=0.75(75% LIFO 新倉先出 + 25% 比例分攤)還原每日融資建倉/出清。
//   - R0=166.67(=1/融資成數 60%),vintage 維持率 = R0 × index_now / index_open。
//   - 追繳門檻維持率 130% ⇔ index_open ≥ index_now × 1.2821(相當於指數從建倉價跌 22%)。
//   - 權威實作:scripts/fetch_margin_costmap.py → data/margin_costmap.json。
//
//   ⚠️ 誠實揭露(務必顯示在 UI):
//   - 衰減是中性假設,非真實個別投資人出場順序,是本模型最大不確定點。
//   - recon 是重建值,不是券商回報的整戶實際維持率(actual 為 TWSE 官方逐日維持率對照)。
//   - Vintage 只由每日融資買進建倉,2020-01-02 以前既有存量的建倉價位未知,不追蹤。
//   - 僅涵蓋上市(TWSE MI_MARGN),不含上櫃;$-weighted 大盤 aggregate,非逐檔/逐投資人。

import { isLight, tc, mob } from '../utils/theme.js';

let chartA = null, chartB = null, chartC = null;
let state = null;

// ── data load ────────────────────────────────────────────────────────
async function loadAll() {
  if (state) return;
  const res = await fetch('data/margin_costmap.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`margin_costmap.json: HTTP ${res.status}`);
  const d = await res.json();
  state = d;
}

// ── summary card ─────────────────────────────────────────────────────
function fmt(v, digits = 1) {
  return v == null ? 'N/A' : v.toFixed(digits);
}

function cascadeAt(dropPct) {
  const c = (state.cascade ?? []).find(x => x.drop_pct === dropPct);
  return c ? c.triggered_pct : null;
}

function renderSummary() {
  const host = document.getElementById('marginmap-summary');
  if (!host || !state) return;

  const c20 = cascadeAt(-20);
  const c25 = cascadeAt(-25);

  host.innerHTML = `
    <div class="breadth-card" style="flex:1;min-width:260px">
      <div class="bc-label">目前大盤融資維持率(重建 vs 官方實際)</div>
      <div class="bc-main">
        <span class="bc-pct">${fmt(state.recon_now)}%</span>
        <span style="font-size:13px;color:var(--muted)">/ 實際 ${fmt(state.maint_now)}%</span>
      </div>
      <div class="bc-count">追繳區佔比 ${fmt(state.trigger_now_pct, 2)}%</div>
    </div>
    <div class="breadth-card" style="flex:1;min-width:260px">
      <div class="bc-label">指數再跌 20% → 觸及追繳</div>
      <div class="bc-main"><span class="bc-pct">${fmt(c20, 1)}%</span></div>
      <div class="bc-count">跌 25% → ${fmt(c25, 1)}% 觸及追繳</div>
    </div>
    <div style="flex:2;min-width:280px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12.5px;line-height:1.6">
      <b style="color:var(--text)">誠實揭露:</b>
      衰減假設(75% LIFO 新倉先出 + 25% 比例分攤)是中性假設,不是真實個別投資人出場順序,
      是本模型<b>最大不確定點</b>。recon 為模型重建值,不是券商回報的整戶實際維持率。
      僅涵蓋上市(TWSE MI_MARGN),不含上櫃;2020-01-02 以前既有存量的建倉價位未知不追蹤。
      MAE(重建 vs 實際,2022-12 起)整體 ${fmt(state.mae_overall, 2)}%pt、2026 年迄今
      ${fmt(state.mae_bull_2026, 2)}%pt。
    </div>
  `;
}

// ── Panel A: 歷史驗證(recon vs actual) ─────────────────────────────
function renderChartA() {
  if (!chartA || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const reconClr = '#58a6ff';
  const actualClr = '#f0883e';

  const hist = state.history ?? [];
  const dates = hist.map(r => r.date);
  const recon = hist.map(r => r.recon);
  const actual = hist.map(r => r.actual);

  const actualVals = actual.filter(v => v != null);
  const reconVals = recon.filter(v => v != null);
  const allVals = actualVals.concat(reconVals);
  const yLo = allVals.length ? Math.floor(Math.min(...allVals) - 5) : 100;
  const yHi = allVals.length ? Math.ceil(Math.max(...allVals) + 5) : 220;

  chartA.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: `Panel A｜融資維持率重建 vs 實際(MAE 整體 ${fmt(state.mae_overall, 2)}%pt · 2026年迄今 ${fmt(state.mae_bull_2026, 2)}%pt)`,
      textStyle: { color: textClr, fontSize: 13, fontWeight: 400 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
    },
    legend: {
      data: ['recon(重建)', 'actual(官方實際)'], top: 26,
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: mob() ? 40 : 56, right: mob() ? 16 : 24, top: 64, bottom: 70 },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10, rotate: 45 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', min: yLo, max: yHi, name: '維持率 %',
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', bottom: 8, height: 16 }],
    series: [
      {
        name: 'recon(重建)', type: 'line', data: recon, showSymbol: false, connectNulls: false,
        lineStyle: { color: reconClr, width: 1.6 }, z: 4,
        markLine: {
          silent: true, symbol: 'none',
          label: { formatter: '{b}', color: textClr, fontSize: 10 },
          lineStyle: { color: '#f85149', type: 'dashed', width: 1.3 },
          data: [
            { xAxis: '2024-08-05', name: '2024-08-05 崩盤' },
            { xAxis: '2025-04-09', name: '2025-04-09 崩盤' },
          ],
        },
      },
      {
        name: 'actual(官方實際)', type: 'line', data: actual, showSymbol: false, connectNulls: false,
        lineStyle: { color: actualClr, width: 1.4, type: 'dashed' }, z: 3,
      },
    ],
  }, { notMerge: true });
}

// ── Panel B: 目前融資成本位階分布 ────────────────────────────────────
function renderChartB() {
  if (!chartB || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const barClr  = '#58a6ff';

  const profile = state.profile ?? [];
  // xAxis 用 value 軸(而非 category)才能讓 markLine 的 index_now / 追繳線精準定位
  // ——category 軸的 markLine 只能對齊「剛好等於某個 bucket 中心」的值,index_now/追繳線
  // 幾乎不可能剛好等於某個 bucket 中心,會造成臨界線靜默消失(違反圖表鐵則)。
  const xy = profile.map(p => [p.level, p.amount_yi]);
  const bucketWidth = profile.length > 1 ? (profile[1].level - profile[0].level) : 1000;

  const indexNow = state.index_now;
  const triggerLine = state.R0 != null ? indexNow * (state.R0 / 130.0) : indexNow * 1.2821;
  const triggerPct = cascadeAt(0);

  const levels = profile.map(p => p.level);
  const dataMax = levels.length ? Math.max(...levels) + bucketWidth / 2 : indexNow;
  const dataMin = levels.length ? Math.min(...levels) - bucketWidth / 2 : indexNow;
  // 軸範圍只涵蓋實際分布 + index_now(不為了遠在天邊的追繳線硬撐 x 軸留一半空白 →
  // 圖表鐵則:別讓分布被壓縮)。追繳線若超出範圍,改用標題註記交代,不畫線也不誤導。
  const axisMax = Math.max(dataMax, indexNow) * 1.03;
  const axisMin = Math.min(dataMin, indexNow) * 0.98;
  const triggerInRange = triggerLine <= axisMax;

  const offChartNote = triggerLine > dataMax
    ? `　⚠ 追繳線在 ${Math.round(triggerLine)}(遠高於分布最高 ${Math.round(dataMax)})→ 目前無部位逼近追繳`
    : '';

  chartB.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: `Panel B｜目前融資成本位階分布(index_now≈${Math.round(indexNow)} · 追繳線≈${Math.round(triggerLine)} · 追繳區佔比 ${fmt(triggerPct, 2)}%)${offChartNote}`,
      textStyle: { color: textClr, fontSize: 12.5, fontWeight: 400 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        const lvl = Math.round(p.value[0]);
        return `加權指數位階 ~${lvl}<br/>${p.marker}未平倉融資: <b>${(+p.value[1]).toFixed(1)} 億</b>`;
      },
    },
    grid: { left: mob() ? 44 : 60, right: mob() ? 16 : 24, top: 56, bottom: 44 },
    xAxis: {
      type: 'value', name: '加權指數位階(建倉時)', min: axisMin, max: axisMax,
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', name: '未平倉融資(億)',
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { lineStyle: { color: gridClr } },
    },
    series: [
      {
        type: 'bar', data: xy, itemStyle: { color: barClr },
        barWidth: 14,
        markLine: {
          silent: true, symbol: 'none',
          label: { color: textClr, fontSize: 10 },
          data: [
            { xAxis: indexNow, lineStyle: { color: '#3fb950', width: 1.8 }, name: '目前指數' },
            ...(triggerInRange
              ? [{ xAxis: triggerLine, lineStyle: { color: '#f85149', width: 1.8, type: 'dashed' }, name: '追繳線(維持率130%)' }]
              : []),
          ],
        },
      },
    ],
  }, { notMerge: true });
}

// ── Panel C: 斷頭階梯(前瞻) ──────────────────────────────────────────
function renderChartC() {
  if (!chartC || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const lineClr = '#f85149';

  const cascade = state.cascade ?? [];
  const x = cascade.map(c => c.drop_pct);
  const y = cascade.map(c => c.triggered_pct);

  chartC.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: 'Panel C｜斷頭階梯(指數自目前往下跌,累計觸及追繳融資佔總額 %)',
      textStyle: { color: textClr, fontSize: 13, fontWeight: 400 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        return `指數跌幅 ${p.axisValue}%<br/>${p.marker}觸及追繳: <b>${(+p.value).toFixed(1)}%</b>`;
      },
    },
    grid: { left: mob() ? 44 : 60, right: mob() ? 16 : 24, top: 50, bottom: 44 },
    xAxis: {
      type: 'category', data: x, name: '指數跌幅 %',
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', name: '觸及追繳佔總額 %', min: 0, max: 100,
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10, formatter: v => v + '%' },
      splitLine: { lineStyle: { color: gridClr } },
    },
    series: [
      {
        type: 'line', data: y, showSymbol: false,
        lineStyle: { color: lineClr, width: 2 },
        areaStyle: { color: lineClr, opacity: 0.12 },
        markLine: {
          silent: true, symbol: 'none',
          label: { color: textClr, fontSize: 10, formatter: '目前(跌幅0%)' },
          lineStyle: { color: '#3fb950', type: 'dashed', width: 1.4 },
          data: [{ xAxis: 0 }],
        },
      },
    ],
  }, { notMerge: true });
}

function render() {
  renderSummary();
  renderChartA();
  renderChartB();
  renderChartC();
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const hostA = document.getElementById('marginmap-chartA');
  const hostB = document.getElementById('marginmap-chartB');
  const hostC = document.getElementById('marginmap-chartC');
  if (!hostA || !hostB || !hostC) return;
  if (!chartA) chartA = echarts.init(hostA, isLight() ? null : 'dark');
  if (!chartB) chartB = echarts.init(hostB, isLight() ? null : 'dark');
  if (!chartC) chartC = echarts.init(hostC, isLight() ? null : 'dark');
  try {
    await loadAll();
    setTimeout(() => {
      chartA?.resize(); chartB?.resize(); chartC?.resize();
      render();
    }, 50);
  } catch (e) {
    const s = document.getElementById('marginmap-summary');
    if (s) s.innerHTML = `<div style="color:var(--muted)">載入失敗:${e.message || e}</div>`;
    console.error('[marginmap] load failed', e);
  }
}

export function onThemeChange(light) {
  const hostA = document.getElementById('marginmap-chartA');
  const hostB = document.getElementById('marginmap-chartB');
  const hostC = document.getElementById('marginmap-chartC');
  if (chartA) { chartA.dispose(); chartA = echarts.init(hostA, light ? null : 'dark'); }
  if (chartB) { chartB.dispose(); chartB = echarts.init(hostB, light ? null : 'dark'); }
  if (chartC) { chartC.dispose(); chartC = echarts.init(hostC, light ? null : 'dark'); }
  if (state) render();
}

export function resize() {
  chartA?.resize(); chartB?.resize(); chartC?.resize();
}

export { render };
