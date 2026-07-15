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

// ── pin-to-date(追加需求 2 + 2b)────────────────────────────────────────
// 點 Panel A 某天 → 釘住摘要卡 + Panel B(成本位階分布)+ Panel C(斷頭階梯)
// 在該日的快照(state.daily 逐日 dump,由 fetch_margin_costmap.py 同一趟 vintage
// 迴圈順手算好,不另抓資料)。未釘住(pinnedDate=null)時,外觀與行為與延伸前完全一致。
let pinnedDate = null;
let dailyMap = null; // date -> {d, idx, m, casc[36], prof[35]}

function cascadeValueAt(dropPct) {
  // 統一存取「當前有效日」(釘住日或最新日)的斷頭階梯某一格,drop_pct 例如 -20。
  if (pinnedDate && dailyMap && dailyMap.has(pinnedDate)) {
    const arr = dailyMap.get(pinnedDate).casc ?? [];
    const i = -dropPct;
    return (i >= 0 && i < arr.length) ? arr[i] : null;
  }
  return cascadeAt(dropPct);
}

function activeCascadeArray() {
  // Panel C 用:回傳 [{drop_pct, triggered_pct}] 形狀,釘住時來自 daily.casc,否則沿用頂層 cascade。
  if (pinnedDate && dailyMap && dailyMap.has(pinnedDate)) {
    const arr = dailyMap.get(pinnedDate).casc ?? [];
    return arr.map((v, i) => ({ drop_pct: -i, triggered_pct: v }));
  }
  return state.cascade ?? [];
}

function activeProfile() {
  // Panel B 用:回傳 [[level, amount_yi], ...] 形狀。釘住時用 daily.prof(對應 prof_edges 固定分箱,
  // 整數億);否則沿用頂層 profile(最新日、原 30 桶格式,外觀與延伸前完全一致)。
  if (pinnedDate && dailyMap && dailyMap.has(pinnedDate)) {
    const row = dailyMap.get(pinnedDate);
    const edges = state.prof_edges ?? [];
    const prof = row.prof ?? [];
    const out = [];
    for (let i = 0; i < prof.length && i + 1 < edges.length; i++) {
      const level = (edges[i] + edges[i + 1]) / 2;
      out.push([level, prof[i]]);
    }
    return out;
  }
  return (state.profile ?? []).map(p => [p.level, p.amount_yi]);
}

function activeIndexNow() {
  if (pinnedDate && dailyMap && dailyMap.has(pinnedDate)) {
    return dailyMap.get(pinnedDate).idx;
  }
  return state.index_now;
}

// ── data load ────────────────────────────────────────────────────────
async function loadAll() {
  if (state) return;
  const res = await fetch('data/margin_costmap.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`margin_costmap.json: HTTP ${res.status}`);
  const d = await res.json();
  state = d;
  dailyMap = new Map();
  for (const row of d.daily ?? []) dailyMap.set(row.d, row);
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

  const pinned = !!(pinnedDate && dailyMap && dailyMap.has(pinnedDate));
  const c20 = cascadeValueAt(-20);
  const c25 = cascadeValueAt(-25);

  let card1;
  if (pinned) {
    const row = dailyMap.get(pinnedDate);
    const actualStart = state.actual_start || '2022-12-01';
    const isRecon = pinnedDate < actualStart;
    card1 = `
      <div class="breadth-card" style="flex:1;min-width:260px">
        <div class="bc-label">目前大盤融資維持率 @${pinnedDate}${isRecon ? '(重建值·無官方對照)' : ''}</div>
        <div class="bc-main"><span class="bc-pct">${fmt(row.m)}%</span></div>
        <div class="bc-count">
          指數 ${Math.round(row.idx)} · 追繳區佔比 ${fmt(cascadeValueAt(0), 2)}%
          <button id="marginmap-unpin" style="margin-left:10px;padding:2px 9px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer">回到最新</button>
        </div>
      </div>`;
  } else {
    card1 = `
      <div class="breadth-card" style="flex:1;min-width:260px">
        <div class="bc-label">目前大盤融資維持率(重建 vs 官方實際)</div>
        <div class="bc-main">
          <span class="bc-pct">${fmt(state.recon_now)}%</span>
          <span style="font-size:13px;color:var(--muted)">/ 實際 ${fmt(state.maint_now)}%</span>
        </div>
        <div class="bc-count">追繳區佔比 ${fmt(state.trigger_now_pct, 2)}%</div>
      </div>`;
  }

  host.innerHTML = `
    ${card1}
    <div class="breadth-card" style="flex:1;min-width:260px">
      <div class="bc-label">指數再跌 20% → 觸及追繳${pinned ? ` @${pinnedDate}` : ''}</div>
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

  const unpinBtn = document.getElementById('marginmap-unpin');
  if (unpinBtn) unpinBtn.addEventListener('click', unpinDate);
}

function unpinDate() {
  if (!pinnedDate) return;
  pinnedDate = null;
  render();
}

// ── Panel A: 歷史驗證(recon vs actual, 2004→今) ────────────────────
function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function findExtremeDate(hist, lo, hi) {
  // 2004 延伸:動態找區間內 recon 最低點日期(而非硬編日期),用來標 2008-11/2020-03 崩盤 markLine。
  let best = null;
  for (const r of hist) {
    if (r.date >= lo && r.date <= hi && r.recon != null) {
      if (!best || r.recon < best.recon) best = r;
    }
  }
  return best;
}

function renderChartA() {
  if (!chartA || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const reconClr = '#58a6ff';
  const reconPreClr = tc('#6e7681', '#8c959f'); // 灰:2022-12 前無官方對照的重建值
  const actualClr = '#f0883e';

  const hist = state.history ?? [];
  const actualStart = state.actual_start || '2022-12-01';
  const dates = hist.map(r => r.date);
  const recon = hist.map(r => r.recon);
  const actual = hist.map(r => r.actual);

  // ── 圖表鐵則:先看全序列 min/max 與分位再定軸,不得讓線飛出畫面 ──
  // pre-2022 暖機後的重建值範圍可能超出現行 [~120,215],用 1st/99th 分位(去極端)
  // 設軸範圍,並把「顯示用」的線 clamp 到軸範圍內(保持連續),原始值仍留在 tooltip。
  const allVals = actual.filter(v => v != null).concat(recon.filter(v => v != null)).sort((a, b) => a - b);
  let yLo = 100, yHi = 220;
  if (allVals.length) {
    const p1 = percentile(allVals, 1);
    const p99 = percentile(allVals, 99);
    yLo = Math.floor(p1 - 5);
    yHi = Math.ceil(p99 + 5);
    if (yHi - yLo < 20) { yLo -= 10; yHi += 10; } // 避免分位太窄把正常波動也裁掉
  }
  const clamp = v => (v == null ? null : Math.min(Math.max(v, yLo), yHi));

  const reconPre = dates.map((d, i) => (d <= actualStart ? clamp(recon[i]) : null));
  const reconPost = dates.map((d, i) => (d >= actualStart ? clamp(recon[i]) : null));
  const actualDisp = actual.map(v => clamp(v));

  // 崩盤 markLine:既有 2024-08-05 / 2025-04-09 + 2004 延伸新增 2008-11(GFC)、2020-03(COVID)
  // 附近 recon 最低點(動態找,不假設精準日期;暖機後 2008 段須是有意義低點而非暖機殘影)。
  const gfc = findExtremeDate(hist, '2008-10-01', '2008-12-31');
  const covid = findExtremeDate(hist, '2020-02-15', '2020-04-15');
  const crashLines = [
    { xAxis: '2024-08-05', name: '2024-08-05 崩盤' },
    { xAxis: '2025-04-09', name: '2025-04-09 崩盤' },
  ];
  if (gfc) crashLines.push({ xAxis: gfc.date, name: `${gfc.date} 金融海嘯低點` });
  if (covid) crashLines.push({ xAxis: covid.date, name: `${covid.date} COVID 低點` });

  chartA.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: `Panel A｜融資維持率重建 vs 實際,2004→今(MAE 整體 ${fmt(state.mae_overall, 2)}%pt · 2026年迄今 ${fmt(state.mae_bull_2026, 2)}%pt · 點任一天可釘住摘要卡/B/C)`,
      textStyle: { color: textClr, fontSize: 13, fontWeight: 400 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params || !params.length) return '';
        const i = params[0].dataIndex;
        const d = dates[i];
        const lines = [`<b>${d}</b>${d < actualStart ? `<br/><span style="color:${axisClr}">2022-12前無官方對照·純重建值</span>` : ''}`];
        const rv = recon[i];
        if (rv != null) {
          const off = rv < yLo || rv > yHi ? ' <span style="color:#f85149">(超出顯示範圍,原始值)</span>' : '';
          lines.push(`recon(重建): <b>${rv.toFixed(2)}%</b>${off}`);
        }
        const av = actual[i];
        if (av != null) lines.push(`actual(官方實際): <b>${av.toFixed(2)}%</b>`);
        return lines.join('<br/>');
      },
    },
    legend: {
      data: ['recon 2004-2022(重建·無官方對照)', 'recon(重建)', 'actual(官方實際)'], top: 26,
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
        name: 'recon 2004-2022(重建·無官方對照)', type: 'line', data: reconPre,
        showSymbol: false, connectNulls: false,
        lineStyle: { color: reconPreClr, width: 1.4, type: 'dashed' }, z: 2,
      },
      {
        name: 'recon(重建)', type: 'line', data: reconPost, showSymbol: false, connectNulls: false,
        lineStyle: { color: reconClr, width: 1.6 }, z: 4,
        markLine: {
          silent: true, symbol: 'none',
          label: { formatter: '{b}', color: textClr, fontSize: 10 },
          lineStyle: { color: '#f85149', type: 'dashed', width: 1.3 },
          data: crashLines,
        },
      },
      {
        name: 'actual(官方實際)', type: 'line', data: actualDisp, showSymbol: false, connectNulls: false,
        lineStyle: { color: actualClr, width: 1.4, type: 'dashed' }, z: 3,
      },
    ],
  }, { notMerge: true });
}

// ── Panel B: 融資成本位階分布(釘住某日時改吃該日快照,追加需求 2b) ──
function renderChartB() {
  if (!chartB || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const barClr  = '#58a6ff';

  const pinned = !!(pinnedDate && dailyMap && dailyMap.has(pinnedDate));
  const xy = activeProfile(); // [[level, amount_yi], ...] — 未釘住=頂層 profile(現行外觀不變),
                               // 釘住=daily.prof 對應 prof_edges 固定分箱
  const bucketWidth = xy.length > 1 ? (xy[1][0] - xy[0][0]) : 1000;

  const indexNow = activeIndexNow();
  const triggerLine = state.R0 != null ? indexNow * (state.R0 / 130.0) : indexNow * 1.2821;
  const triggerPct = cascadeValueAt(0);

  // 釘住模式用固定全時期分箱(prof_edges),多數箱在特定某天是空的;軸範圍只看「有量」的箱,
  // 否則圖會被硬拉開到 2001-2026 整個指數範圍(違反圖表鐵則:別讓分布被壓縮/過度留白)。
  const nonzero = xy.filter(p => p[1] > 0);
  const levels = (nonzero.length ? nonzero : xy).map(p => p[0]);
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

  const titlePrefix = pinned
    ? `Panel B｜融資成本位階分布 @${pinnedDate}(index≈${Math.round(indexNow)}`
    : `Panel B｜目前融資成本位階分布(index_now≈${Math.round(indexNow)}`;
  chartB.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: `${titlePrefix} · 追繳線≈${Math.round(triggerLine)} · 追繳區佔比 ${fmt(triggerPct, 2)}%)${offChartNote}`,
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

// ── Panel C: 斷頭階梯(前瞻;釘住某日時改吃該日 casc,追加需求 2) ──────
function renderChartC() {
  if (!chartC || !state) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const lineClr = '#f85149';

  const pinned = !!(pinnedDate && dailyMap && dailyMap.has(pinnedDate));
  const cascade = activeCascadeArray();
  const x = cascade.map(c => c.drop_pct);
  const y = cascade.map(c => c.triggered_pct);

  chartC.setOption({
    backgroundColor: 'transparent', animation: false,
    title: {
      text: pinned
        ? `Panel C｜斷頭階梯 @${pinnedDate}(該日指數自身往下跌,累計觸及追繳融資佔總額 %)`
        : 'Panel C｜斷頭階梯(指數自目前往下跌,累計觸及追繳融資佔總額 %)',
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

// ── pin-to-date 點擊處理(追加需求 2)──────────────────────────────────
// 用 zrender 層級的 click(而非 chart.on('click') 只認精準點中細線的 series 事件)+
// convertFromPixel 反查最近的 x 類別索引。原因(實測發現的真實 UX bug,不只是測試工具問題):
// history 有 5515 個交易日,線寬只有 1.6px、showSymbol:false,plot 區約 1200px 寬 → 平均每個
// 資料點只佔 ~0.2px,要求使用者「精準點中那條細線」在畫面上幾乎不可能命中(實測 chart.on('click')
// 的 series 命中判定,即使滑鼠像素座標與資料點理論像素完全對齊,大多數情況仍判定未命中)。
// 改成「點繪圖區內任一位置 → 找最近的那一天」對使用者才是可用的互動。
function chartAGridRect() {
  const hostA = document.getElementById('marginmap-chartA');
  if (!hostA) return null;
  const rect = hostA.getBoundingClientRect();
  return {
    left: mob() ? 40 : 56,
    right: rect.width - (mob() ? 16 : 24),
    top: 64,
    bottom: rect.height - 70,
  };
}

function handleChartAClick(e) {
  if (!chartA || !state) return;
  const hist = state.history ?? [];
  if (!hist.length) return;
  const g = chartAGridRect();
  if (g && (e.offsetX < g.left || e.offsetX > g.right || e.offsetY < g.top || e.offsetY > g.bottom)) {
    return; // 點在繪圖區外(標題/legend/軸標籤/dataZoom 滑桿等)不當成選日
  }
  let pt;
  try {
    pt = chartA.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
  } catch (err) {
    return;
  }
  if (!pt) return;
  let idx = Math.round(pt[0]);
  if (idx < 0) idx = 0;
  if (idx >= hist.length) idx = hist.length - 1;
  const date = hist[idx].date;
  if (!date || !dailyMap || !dailyMap.has(date)) return;
  pinnedDate = (pinnedDate === date) ? null : date; // 再點同一天 = 取消釘住
  render();
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const hostA = document.getElementById('marginmap-chartA');
  const hostB = document.getElementById('marginmap-chartB');
  const hostC = document.getElementById('marginmap-chartC');
  if (!hostA || !hostB || !hostC) return;
  if (!chartA) { chartA = echarts.init(hostA, isLight() ? null : 'dark'); chartA.getZr().on('click', handleChartAClick); }
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
  if (chartA) { chartA.dispose(); chartA = echarts.init(hostA, light ? null : 'dark'); chartA.getZr().on('click', handleChartAClick); }
  if (chartB) { chartB.dispose(); chartB = echarts.init(hostB, light ? null : 'dark'); }
  if (chartC) { chartC.dispose(); chartC = echarts.init(hostC, light ? null : 'dark'); }
  if (state) render();
}

export function resize() {
  chartA?.resize(); chartB?.resize(); chartC?.resize();
}

export { render };
