// 融資集中度 tab — 台股個股融資集中度(前十大佔全市場%)20年時序 + 清算天數榜
//   命題:抄「台日韓融資槓桿全景」文的集中度維度 — 清算天數 = 融資部位張數 / 日均成交量張數,
//   量化「融資有多擠、失火時門有多寬」。既有融資 tab(marginheat/tw_sentiment)只有大盤總量,
//   缺個股集中度,本 tab 補上。
//   資料:data/margin_concentration.json(scripts/fetch_margin_concentration.py 產出)
//        + data/TWII.json(現成,右軸疊指數收盤對照)。
//
// ⚠️ 誠實揭露(務必顯示在 UI,不得省略):
//   清算天數=融資餘額(張)/近20日日均量(張),量化失火時強制賣壓多久出得完;>2天=門窄踩踏風險高。
//   「佔全市場%」絕對水位受分母口徑影響(免費源用官方融資餘額換算,比部位市值口徑高約1.5x),
//   清算天數與集中度百分位不受影響,為可信主指標。
//   候選池是「今日」名單回溯套用到歷史,早期年份集中度可能被低估(倖存者偏誤變體)。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { requestJSON, clearRequestCache } from '../utils/data.js';

let chart = null;
let state = null; // { dates, pctData, percentileData, twiiData, currentValuePct, currentPercentile, leaderboard, note, asOf, latestDataDate, seriesStart, nSamples }

// ── data load ────────────────────────────────────────────────────────
async function loadAll(context = {}) {
  if (state) {
    if (state.twiiUnavailable) {
      const twii = await requestJSON('data/TWII.json', { signal: context.signal }).catch(() => null);
      const validTwii = Array.isArray(twii?.data)
        ? twii.data.filter(r => typeof r?.date === 'string' && Number.isFinite(r.close) && r.close > 0)
        : [];
      if (validTwii.length && !context.signal?.aborted && context.isCurrent?.() !== false) {
        const byDate = new Map(validTwii.map(r => [r.date, r.close]));
        state = { ...state, twiiData: state.dates.map(d => byDate.get(d) ?? null), twiiUnavailable: false };
      } else if (!validTwii.length) clearRequestCache('data/TWII.json');
    }
    return;
  }
  const [mc, twii] = await Promise.all([
    requestJSON('data/margin_concentration.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }).catch(() => null),
  ]);
  const series = mc?.concentration_series?.data;
  if (!Array.isArray(series) || !series.length ||
      !series.some(row => typeof row?.date === 'string' && Number.isFinite(row.top10_pct_of_market)) ||
      !Array.isArray(mc.leaderboard)) throw new Error('融資集中度資料格式不完整');
  const dates = series.map(r => r.date);
  const pctData = series.map(r => r.top10_pct_of_market);
  const percentileData = series.map(r => r.percentile);

  let twiiData = null;
  const validTwii = Array.isArray(twii?.data)
    ? twii.data.filter(r => typeof r?.date === 'string' && Number.isFinite(r.close) && r.close > 0)
    : [];
  if (validTwii.length) {
    const twiiByDate = new Map(validTwii.map(r => [r.date, r.close]));
    twiiData = dates.map(d => twiiByDate.get(d) ?? null);
  } else clearRequestCache('data/TWII.json');

  const next = {
    dates, pctData, percentileData, twiiData,
    currentValuePct: mc.concentration_series?.current_value_pct ?? null,
    currentPercentile: mc.concentration_series?.current_percentile ?? null,
    seriesStart: mc.concentration_series?.start_date ?? dates[0] ?? null,
    nSamples: mc.concentration_series?.n_samples ?? dates.length,
    leaderboard: mc.leaderboard ?? [],
    assumedLoanRatio: mc.assumed_loan_ratio,
    asOf: mc.as_of,
    latestDataDate: mc.latest_data_date,
    candidatePoolSize: mc.candidate_pool_size,
    candidatePoolFetchedOk: mc.candidate_pool_fetched_ok,
    twiiUnavailable: !validTwii.length,
  };
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  state = next;
}

// ── table ────────────────────────────────────────────────────────────
function fmtNum(v, digits = 1) {
  return v == null ? '<span style="color:var(--muted)">N/A</span>' : v.toFixed(digits);
}

function renderTable() {
  const host = document.getElementById('marginconc-table');
  if (!host || !state) return;

  const rows = state.leaderboard.map((item, i) => {
    const clr = item.clearance_days;
    const clrCls = clr != null && clr > 2 ? 'neg' : '';
    const clrHtml = clr != null
      ? `<span class="${clrCls}" style="${clrCls ? 'font-weight:700' : ''}">${clr.toFixed(2)}${clrCls ? ' ⚠' : ''}</span>`
      : '<span style="color:var(--muted)">N/A</span>';
    return `<tr>
      <td>${i + 1}</td>
      <td>${item.stock_id}${item.name ? ' ' + item.name : ''}</td>
      <td>${fmtNum(item.margin_money_yi, 1)}</td>
      <td>${fmtNum(item.pct_of_total_market_margin, 2)}%</td>
      <td>${item.pct_of_own_market_cap != null ? item.pct_of_own_market_cap.toFixed(2) + '%' : '<span style="color:var(--muted)">N/A</span>'}</td>
      <td>${clrHtml}</td>
    </tr>`;
  }).join('');

  const top10Sum = state.leaderboard.slice(0, 10)
    .reduce((s, x) => s + (x.pct_of_total_market_margin ?? 0), 0);

  host.innerHTML = `
    <div style="margin:8px 0 16px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12.5px;line-height:1.6">
      <b style="color:var(--text)">誠實揭露：</b>
      清算天數 = 融資餘額(張) / 近20日日均量(張)，量化失火時強制賣壓多久出得完；<b class="neg">&gt;2天 = 門窄、踩踏風險高</b>。
      ⚠️「佔全市場%」絕對水位受分母口徑影響（免費源用官方融資餘額換算，比部位市值口徑高約1.5x），
      <b>清算天數與集中度百分位不受此影響</b>，為可信主指標。
      候選池為「今日」名單回溯套用到 ${state.seriesStart ?? '起點'} 至今的歷史序列，早期年份集中度可能被低估
      （候選池外的歷史融資大戶未被納入，倖存者偏誤變體）。
      候選池 ${state.candidatePoolSize ?? '?'} 檔，成功抓取 ${state.candidatePoolFetchedOk ?? '?'} 檔。
    </div>
    <table class="info-table">
      <thead><tr>
        <th>排名</th><th>股票</th><th>融資市值(億)</th><th>佔全市場%</th><th>佔自身市值%</th><th>清算天數</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="border-top:2px solid var(--border);font-weight:600">
        <td colspan="3">前十大合計</td><td>${top10Sum.toFixed(2)}%</td><td colspan="2"></td>
      </tr></tfoot>
    </table>
  `;
}

// ── chart render ──────────────────────────────────────────────────────
function render() {
  if (!chart || !state) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const twiiClr = PALETTE.text;
  const pctClr  = '#f85149';

  const status = document.getElementById('marginconc-status');
  if (status) status.textContent =
    `融資集中度：前十大個股融資佔全市場% · ${state.dates.length} 個交易日（${state.seriesStart ?? ''} ~ ${state.dates[state.dates.length - 1] ?? ''}）` +
    (state.currentValuePct != null ? ` · 現值(${state.latestDataDate ?? ''}) = ${state.currentValuePct.toFixed(2)}%` : '') +
    (state.currentPercentile != null ? ` · 全期百分位 = 第${state.currentPercentile.toFixed(1)}百分位` : '');

  const hasTwii = !!state.twiiData;
  const L = mob() ? 40 : 52, R = hasTwii ? (mob() ? 48 : 62) : (mob() ? 20 : 24);

  const yAxis = [
    {
      type: 'value', scale: true,
      name: '前十大佔全市場%', nameTextStyle: { color: pctClr, fontSize: 10 },
      axisLine: { lineStyle: { color: pctClr } },
      axisLabel: { color: pctClr, fontSize: 10, formatter: v => v + '%' },
      splitLine: { lineStyle: { color: gridClr } },
    },
  ];
  if (hasTwii) {
    yAxis.push({
      type: 'log', scale: true, position: 'right',
      name: 'TWII', nameTextStyle: { color: twiiClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
    });
  }

  const currentMarkLine = state.currentValuePct != null ? {
    silent: true, symbol: 'none',
    lineStyle: { color: pctClr, type: 'dashed', width: 1.5 },
    label: {
      formatter: `現值 ${state.currentValuePct.toFixed(1)}%` + (state.currentPercentile != null ? ` (第${state.currentPercentile.toFixed(0)}百分位)` : ''),
      color: pctClr, fontSize: 10, position: 'insideEndTop',
    },
    data: [{ yAxis: state.currentValuePct }],
  } : null;

  const series = [
    {
      name: '前十大佔全市場%', type: 'line', data: state.pctData,
      symbol: 'none', z: 5,
      itemStyle: { color: pctClr }, lineStyle: { color: pctClr, width: 1.6 },
      areaStyle: { color: pctClr, opacity: 0.08 },
      markLine: currentMarkLine ?? undefined,
      yAxisIndex: 0,
    },
  ];
  if (hasTwii) {
    series.push({
      name: 'TWII', type: 'line', data: state.twiiData,
      symbol: 'none', z: 2, connectNulls: true,
      itemStyle: { color: twiiClr }, lineStyle: { color: twiiClr, width: 1.1 },
      yAxisIndex: 1,
    });
  }

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === 'TWII' ? Math.round(+p.value).toLocaleString() : (+p.value).toFixed(2) + '%';
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: hasTwii ? ['前十大佔全市場%', 'TWII'] : ['前十大佔全市場%'], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: '12%', bottom: '12%' },
    xAxis: {
      type: 'category', data: state.dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });

  renderTable();
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate(context = {}) {
  const host = document.getElementById('marginconc-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll(context);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    chart?.resize(); render();
    if (state.twiiUnavailable) document.getElementById('marginconc-status').textContent += ' · TWII對照暫缺';
  } catch (e) {
    const s = document.getElementById('marginconc-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[marginconc] load failed', e);
    throw e;
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById('marginconc-chart'), light ? null : 'dark');
  if (state) render();
}
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
export { render };
