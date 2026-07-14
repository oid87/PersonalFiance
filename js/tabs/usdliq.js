// 美元流動性 tab — Fed 操作層 → 財政現金層 → 銀行資金層 → 非銀行貨幣層 →
//   Repo/抵押品層 → 美債市場層 → 支付清算層 → 全球美元層，八層融資壓力狀態燈
//   + 短端利率走廊 + 緩衝墊耗盡(Reserves/TGA/ON RRP) + 供給側(Fails/標售 Bid-to-Cover)
//   資料：data/usdliq.json（fetch_usdliq.py 抓 FRED / NY Fed Markets API / Treasury Fiscal Data / TreasuryDirect，免 key）
//   ⚠️ 本表判斷的是「融資壓力」，不是方向訊號。ON RRP 幾近歸零 = 緩衝墊耗盡，不是現金荒本身。
//   ⚠️ daily 陣列最後一筆常態性部分缺值（IORB 當天就有、SOFR/ON RRP 隔日才公布）；
//      「最新值」一律 = 該欄最後一筆非 null 的值，不是陣列最後一筆。

import { isLight, tc, mob } from '../utils/theme.js';

// ── 格式化 helpers ───────────────────────────────────────────────────
function fmtB(v, dp = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtSigned(v, dp = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + fmtB(v, dp);
}
function fmtTip(v) {
  if (v == null) return '—';
  return Math.abs(v) >= 10 ? (+v).toFixed(1) : (+v).toFixed(3);
}

function lastNonNullIn(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][key] != null) return rows[i];
  }
  return null;
}
function minDate(arr) {
  const xs = arr.filter(Boolean);
  return xs.length ? xs.sort()[0] : null;
}
function percentileRank(arr, v) {
  if (!arr.length || v == null) return null;
  const below = arr.filter(x => x < v).length;
  return (below / arr.length) * 100;
}
function last3yCutoff(anchorDate) {
  const d = new Date(anchorDate);
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
}
function unionDates(...sources) {
  const s = new Set();
  for (const arr of sources) for (const r of arr) s.add(r.date);
  return [...s].sort();
}

// ── 新鮮度 ────────────────────────────────────────────────────────────
function freshCls(date, anchorDate) {
  if (!date) return 'na';
  const diff = (new Date(anchorDate) - new Date(date)) / 86400000;
  if (diff <= 3) return 'fresh';
  if (diff <= 14) return 'carry';
  return 'na';
}
function freshDot(cls) {
  const map = { fresh: '#3fb950', carry: '#e3b341', na: '#8b949e' };
  const label = { fresh: 'Fresh（≤3天）', carry: 'Carry-forward（4–14天）', na: 'N/A（>14天或缺值）' };
  const c = map[cls] || map.na;
  return `<span title="${label[cls] || label.na}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-left:6px;flex:none"></span>`;
}
function badge(status) {
  const map = {
    Easing:     { bg: 'rgba(63,185,80,0.15)',  fg: '#3fb950', label: 'Easing' },
    Neutral:    { bg: 'rgba(227,179,65,0.15)', fg: '#e3b341', label: 'Neutral' },
    Tightening: { bg: 'rgba(248,81,73,0.15)',  fg: '#f85149', label: 'Tightening' },
    'N/A':      { bg: 'rgba(139,148,158,0.15)', fg: '#8b949e', label: 'N/A' },
  };
  const s = map[status] || map['N/A'];
  return `<span style="padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;letter-spacing:.2px;background:${s.bg};color:${s.fg}">${s.label}</span>`;
}

// ── state ─────────────────────────────────────────────────────────────
let chartCorridor = null;
let chartBuffer   = null;
let chartSupply   = null;
let range = '3Y';
let bufferScale = 'linear'; // 'linear' | 'log'
let doc = null; // 整份 usdliq.json
let daily = null, weekly = null, auctions = null, fails = null;

async function loadAll() {
  if (doc) return;
  const r = await fetch('data/usdliq.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  doc = await r.json();
  daily = doc.daily ?? [];
  weekly = doc.weekly ?? [];
  auctions = doc.auctions ?? [];
  fails = doc.fails ?? [];
}

function cutoffDate(key) {
  if (key === 'MAX') return '0000-00-00';
  const d = new Date();
  const yrs = { '1Y': 1, '3Y': 3 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

// ── ① 八層狀態燈 ─────────────────────────────────────────────────────
function computeLayers() {
  const anchorDate = daily[daily.length - 1].date;
  const cutoff3y = last3yCutoff(anchorDate);
  const layers = [];

  // L1 Fed 操作層
  {
    const effrR = lastNonNullIn(daily, 'effr');
    const iorbR = lastNonNullIn(daily, 'iorb');
    const resLatest = weekly[weekly.length - 1];
    const resPrev = weekly[weekly.length - 2];
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (effrR && iorbR && resLatest && resPrev) {
      const spreadBp = (effrR.effr - iorbR.iorb) * 100;
      const chg = resLatest.reserves - resPrev.reserves;
      status = (spreadBp <= -2 && chg >= 0) ? 'Easing' : (spreadBp >= 0 ? 'Tightening' : 'Neutral');
      line1 = `Reserves ${fmtB(resLatest.reserves)}B（週${fmtSigned(chg)}B）`;
      line2 = `EFFR−IORB ${fmtSigned(spreadBp)}bp`;
      fresh = freshCls(minDate([effrR.date, iorbR.date, resLatest.date]), anchorDate);
    }
    layers.push({ title: 'L1 Fed 操作層', status, fresh, line1, line2 });
  }

  // L2 財政現金層
  {
    const tgaRows = daily.filter(r => r.tga != null);
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (tgaRows.length > 20) {
      const latest = tgaRows[tgaRows.length - 1];
      const prior = tgaRows[tgaRows.length - 21];
      const chg = latest.tga - prior.tga;
      status = Math.abs(chg) < 20 ? 'Neutral' : (chg < 0 ? 'Easing' : 'Tightening');
      line1 = `TGA ${fmtB(latest.tga)}B（${latest.date}）`;
      line2 = `20日變化 ${fmtSigned(chg)}B`;
      fresh = freshCls(latest.date, anchorDate);
    }
    layers.push({ title: 'L2 財政現金層', status, fresh, line1, line2 });
  }

  // L3 銀行資金層
  {
    const pcRows = weekly.filter(r => r.date >= cutoff3y && r.primary_credit != null);
    const pcLatest = lastNonNullIn(weekly, 'primary_credit');
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (pcLatest && pcRows.length) {
      const pct = percentileRank(pcRows.map(r => r.primary_credit), pcLatest.primary_credit);
      status = pct > 90 ? 'Tightening' : 'Neutral';
      line1 = `Primary Credit ${fmtB(pcLatest.primary_credit, 2)}B`;
      line2 = `3年百分位 ${pct.toFixed(0)}%`;
      fresh = freshCls(pcLatest.date, anchorDate);
    }
    layers.push({ title: 'L3 銀行資金層', status, fresh, line1, line2 });
  }

  // L4 非銀行貨幣層
  {
    const onrrpR = lastNonNullIn(daily, 'onrrp');
    let status = 'N/A', fresh = 'na', line1 = '—';
    if (onrrpR) {
      const v = onrrpR.onrrp;
      status = v > 100 ? 'Easing' : (v >= 10 ? 'Neutral' : 'Tightening');
      line1 = `ON RRP ${v.toFixed(3)}B（${onrrpR.date}）`;
      fresh = freshCls(onrrpR.date, anchorDate);
    }
    layers.push({ title: 'L4 非銀行貨幣層', status, fresh, line1, line2: null });
  }

  // L5 Repo/抵押品層
  {
    const sofrR = lastNonNullIn(daily, 'sofr');
    const iorbFallback = lastNonNullIn(daily, 'iorb');
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (sofrR) {
      const sameDay = daily.find(r => r.date === sofrR.date) || {};
      const iorbVal = sameDay.iorb != null ? sameDay.iorb : (iorbFallback ? iorbFallback.iorb : null);
      if (iorbVal != null) {
        const spreadBp = (sofrR.sofr - iorbVal) * 100;
        const s99bp = sameDay.sofr99 != null ? (sameDay.sofr99 - sofrR.sofr) * 100 : null;
        const geIorb = sofrR.sofr >= iorbVal;
        if (geIorb || (s99bp != null && s99bp >= 15)) status = 'Tightening';
        else if (spreadBp <= -8 && s99bp != null && s99bp < 10) status = 'Easing';
        else status = 'Neutral';
        line1 = `SOFR−IORB ${fmtSigned(spreadBp)}bp`;
        line2 = s99bp != null ? `SOFR99−SOFR ${fmtSigned(s99bp)}bp` : '—';
        fresh = freshCls(minDate([sofrR.date, iorbFallback ? iorbFallback.date : null]), anchorDate);
      }
    }
    layers.push({ title: 'L5 Repo/抵押品層', status, fresh, line1, line2 });
  }

  // L6 美債市場層
  {
    const anchor = new Date(anchorDate);
    const c90 = new Date(anchor); c90.setDate(c90.getDate() - 90);
    const c180 = new Date(anchor); c180.setDate(c180.getDate() - 180);
    const c90s = c90.toISOString().slice(0, 10);
    const c180s = c180.toISOString().slice(0, 10);
    const recent = auctions.filter(a => a.date >= c90s && a.btc != null).map(a => a.btc);
    const prior = auctions.filter(a => a.date >= c180s && a.date < c90s && a.btc != null).map(a => a.btc);
    const cp90R = lastNonNullIn(daily, 'cp90');
    const effrR = lastNonNullIn(daily, 'effr');
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (recent.length && prior.length) {
      const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
      const avgP = prior.reduce((a, b) => a + b, 0) / prior.length;
      const chgPct = (avgR - avgP) / avgP * 100;
      const cpBp = (cp90R && effrR) ? (cp90R.cp90 - effrR.effr) * 100 : null;
      status = 'Neutral';
      if (chgPct < -10 || (cpBp != null && cpBp >= 35)) status = 'Tightening';
      else if (chgPct > 10) status = 'Easing';
      line1 = `BTC(90d) ${avgR.toFixed(2)} vs 前90d ${avgP.toFixed(2)}（${fmtSigned(chgPct, 1)}%）`;
      line2 = cpBp != null ? `CP90−EFFR ${fmtSigned(cpBp, 1)}bp` : '—';
      const auctionLatest = auctions[auctions.length - 1];
      fresh = freshCls(minDate([auctionLatest ? auctionLatest.date : null, cp90R ? cp90R.date : null]), anchorDate);
    }
    layers.push({ title: 'L6 美債市場層', status, fresh, line1, line2 });
  }

  // L7 支付清算層
  {
    const failsRows = fails.filter(r => r.date >= cutoff3y && r.ftd != null && r.ftr != null);
    const latest = fails[fails.length - 1];
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (latest && latest.ftd != null && latest.ftr != null && failsRows.length) {
      const sum = latest.ftd + latest.ftr;
      const pct = percentileRank(failsRows.map(r => r.ftd + r.ftr), sum);
      status = pct > 90 ? 'Tightening' : 'Neutral';
      line1 = `FTD+FTR ${fmtB(sum)}B（${latest.date}）`;
      line2 = `3年百分位 ${pct.toFixed(0)}%`;
      fresh = freshCls(latest.date, anchorDate);
    }
    layers.push({ title: 'L7 支付清算層', status, fresh, line1, line2 });
  }

  // L8 全球美元層
  {
    const swapsR = lastNonNullIn(weekly, 'swaps');
    const frrpR = lastNonNullIn(weekly, 'foreign_rrp');
    let status = 'N/A', fresh = 'na', line1 = '—', line2 = '—';
    if (swapsR) {
      status = swapsR.swaps > 1 ? 'Tightening' : 'Neutral';
      line1 = `Swaps ${swapsR.swaps.toFixed(2)}B`;
      line2 = frrpR ? `Foreign RRP ${fmtB(frrpR.foreign_rrp)}B（${frrpR.date}）` : '—';
      fresh = freshCls(minDate([swapsR.date, frrpR ? frrpR.date : null]), anchorDate);
    }
    layers.push({ title: 'L8 全球美元層', status, fresh, line1, line2 });
  }

  return layers;
}

function renderStack() {
  const host = document.getElementById('ul-stack');
  if (!host || !daily?.length) return;
  const layers = computeLayers();
  host.innerHTML = layers.map(l => `
    <div class="breadth-card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="bc-label" style="margin-bottom:0">${l.title}</div>
        ${freshDot(l.fresh)}
      </div>
      <div style="margin:6px 0 4px">${badge(l.status)}</div>
      <div class="bc-count">${l.line1}</div>
      ${l.line2 ? `<div class="bc-count">${l.line2}</div>` : ''}
    </div>
  `).join('');
}

// ── ② 短端利率走廊 ────────────────────────────────────────────────────
const CORRIDOR_LINES = [
  { key: 'iorb', name: 'IORB', color: '#e3b341', width: 2.6, on: true },
  { key: 'sofr', name: 'SOFR', color: '#58a6ff', width: 1.7, on: true },
  { key: 'effr', name: 'EFFR', color: '#3fb950', width: 1.7, on: true },
  { key: 'tgcr', name: 'TGCR', color: '#8b949e', width: 1.1, on: false },
  { key: 'bgcr', name: 'BGCR', color: '#d2a8ff', width: 1.1, on: false },
  { key: 'obfr', name: 'OBFR', color: '#f0883e', width: 1.1, on: false },
];
const BAND_NAME = 'SOFR區間(1%–99%)';

function renderCorridor() {
  if (!chartCorridor || !daily?.length) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = tc('#161b22', '#ffffff');
  const tipBdr = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const isMob = mob();

  const cut = cutoffDate(range);
  const view = daily.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const L = isMob ? 40 : 52;
  const R = isMob ? 16 : 28;

  const series = [];
  for (const ln of CORRIDOR_LINES) {
    series.push({
      name: ln.name, type: 'line',
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: 'none', connectNulls: false,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.width },
      z: ln.key === 'iorb' ? 6 : 4,
    });
  }
  const bandBase = view.map(r => (r.sofr1 != null && r.sofr99 != null) ? +r.sofr1.toFixed(3) : null);
  const bandDelta = view.map(r => (r.sofr1 != null && r.sofr99 != null) ? +(r.sofr99 - r.sofr1).toFixed(3) : null);
  series.push({
    name: BAND_NAME, type: 'line', stack: 'sofrband',
    data: bandBase, symbol: 'none', connectNulls: false, silent: true,
    lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, tooltip: { show: false }, z: 1,
  });
  series.push({
    name: BAND_NAME, type: 'line', stack: 'sofrband',
    data: bandDelta, symbol: 'none', connectNulls: false, silent: true,
    lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.14, color: '#58a6ff' }, tooltip: { show: false }, z: 1,
  });

  chartCorridor.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.seriesName === BAND_NAME || p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: [...CORRIDOR_LINES.map(l => l.name), BAND_NAME], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
      selected: {
        TGCR: false, BGCR: false, OBFR: false, [BAND_NAME]: false,
      },
    },
    grid: { left: L, right: R, top: '12%', bottom: '12%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11, rotate: isMob ? 30 : 0 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: '利率 %',
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + '%' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });
}

// ── ③ 緩衝墊耗盡 ──────────────────────────────────────────────────────
const LOG_FLOOR = 0.001;

function renderBuffer() {
  if (!chartBuffer) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = tc('#161b22', '#ffffff');
  const tipBdr = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const isMob = mob();

  const cut = cutoffDate(range);
  const dates = unionDates(
    daily.filter(r => r.date >= cut && r.tga != null),
    weekly.filter(r => r.date >= cut && r.reserves != null),
    daily.filter(r => r.date >= cut && r.onrrp != null),
  );

  const resMap = new Map(weekly.filter(r => r.reserves != null).map(r => [r.date, r.reserves]));
  const tgaMap = new Map(daily.filter(r => r.tga != null).map(r => [r.date, r.tga]));
  const onrrpMap = new Map(daily.filter(r => r.onrrp != null).map(r => [r.date, r.onrrp]));

  const reservesData = dates.map(d => resMap.has(d) ? +resMap.get(d).toFixed(1) : null);
  const tgaData = dates.map(d => tgaMap.has(d) ? +tgaMap.get(d).toFixed(1) : null);
  const onrrpDisplay = dates.map(d => {
    if (!onrrpMap.has(d)) return null;
    const raw = onrrpMap.get(d);
    if (bufferScale === 'log' && raw <= 0) return { value: LOG_FLOOR, raw };
    return { value: +raw.toFixed(3), raw };
  });

  const L = isMob ? 44 : 58;
  const R = isMob ? 44 : 58;

  const series = [
    {
      name: 'Reserves', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: reservesData, symbol: 'none', step: 'end', connectNulls: true,
      lineStyle: { color: '#58a6ff', width: 1.8 }, itemStyle: { color: '#58a6ff' }, z: 4,
    },
    {
      name: 'TGA', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: tgaData, symbol: 'none', connectNulls: false,
      lineStyle: { color: '#e3b341', width: 1.3 }, itemStyle: { color: '#e3b341' }, z: 3,
    },
    {
      name: 'ON RRP', type: 'line', xAxisIndex: 1, yAxisIndex: 1,
      data: onrrpDisplay, symbol: 'none', connectNulls: false,
      lineStyle: { color: '#3fb950', width: 1.6 }, itemStyle: { color: '#3fb950' }, z: 5,
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#3fb950', type: 'dashed', width: 1 },
        label: { formatter: '100B（緩衝墊仍厚）', color: '#3fb950', fontSize: 9, position: 'insideEndTop' },
        data: [{ yAxis: 100 }],
      },
    },
  ];

  const axBase = {
    type: 'category', data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chartBuffer.setOption({
    backgroundColor: 'transparent', animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          let val = null, note = '';
          if (p.data && typeof p.data === 'object' && 'raw' in p.data) {
            val = p.data.raw;
            if (val <= 0) note = '（≈0，對數軸顯示於下限，非真實裁切）';
          } else if (p.value != null) {
            val = p.value;
          }
          if (val == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${fmtTip(val)}B</b>${note}</div>`;
        }
        return html;
      },
    },
    legend: {
      data: ['Reserves', 'TGA', 'ON RRP'], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [
      { left: L, right: R, top: '12%', height: '48%' },
      { left: L, right: R, top: '68%', height: '24%' },
    ],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axBase, gridIndex: 1, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: 'value', scale: true, name: 'Reserves/TGA (B)',
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        gridIndex: 1, type: bufferScale === 'log' ? 'log' : 'value', scale: true,
        logBase: 10, name: 'ON RRP (B)',
        nameTextStyle: { color: '#3fb950', fontSize: 10 },
        axisLabel: { color: '#3fb950', fontSize: 10, formatter: v => (+v).toLocaleString() },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' }],
    series,
  }, { notMerge: true });
}

// ── ④ 供給側 ──────────────────────────────────────────────────────────
const BILL_TERMS = ['4-Week', '8-Week', '13-Week', '26-Week', '52-Week'];
const BILL_COLORS = ['#58a6ff', '#3fb950', '#e3b341', '#f0883e', '#d2a8ff', '#f85149'];

function renderSupply() {
  if (!chartSupply) return;
  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = tc('#161b22', '#ffffff');
  const tipBdr = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const isMob = mob();

  const cut = cutoffDate(range);
  const failsView = fails.filter(r => r.date >= cut);
  let auctionsView = auctions.filter(a => a.date >= cut && a.btc != null && BILL_TERMS.includes(a.term));

  // 保底：若允許清單以外仍超過 6 種(理論上不會發生,BILL_TERMS 固定 5 種),取出現次數前 6 種
  const termCounts = new Map();
  for (const a of auctionsView) termCounts.set(a.term, (termCounts.get(a.term) || 0) + 1);
  let terms = [...termCounts.keys()];
  if (terms.length > 6) {
    terms = terms.sort((a, b) => termCounts.get(b) - termCounts.get(a)).slice(0, 6);
    auctionsView = auctionsView.filter(a => terms.includes(a.term));
  } else {
    terms = BILL_TERMS.filter(t => termCounts.has(t));
  }

  const dates = unionDates(failsView, auctionsView);

  const ftdMap = new Map(failsView.filter(r => r.ftd != null).map(r => [r.date, r.ftd]));
  const ftrMap = new Map(failsView.filter(r => r.ftr != null).map(r => [r.date, r.ftr]));
  const ftdData = dates.map(d => ftdMap.has(d) ? +ftdMap.get(d).toFixed(2) : null);
  const ftrData = dates.map(d => ftrMap.has(d) ? +ftrMap.get(d).toFixed(2) : null);

  const L = isMob ? 44 : 56;
  const R = isMob ? 44 : 56;

  const series = [
    {
      name: 'FTD（未交割）', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: ftdData, symbol: 'none', connectNulls: true,
      lineStyle: { color: '#58a6ff', width: 1.4 },
      areaStyle: { color: '#58a6ff', opacity: 0.22 }, z: 3,
    },
    {
      name: 'FTR（未收受）', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: ftrData, symbol: 'none', connectNulls: true,
      lineStyle: { color: '#f0883e', width: 1.4 },
      areaStyle: { color: '#f0883e', opacity: 0.22 }, z: 2,
    },
  ];

  terms.forEach((term, i) => {
    const map = new Map(auctionsView.filter(a => a.term === term).map(a => [a.date, a.btc]));
    series.push({
      name: term, type: 'scatter', xAxisIndex: 1, yAxisIndex: 1,
      data: dates.map(d => map.has(d) ? +map.get(d).toFixed(2) : null),
      symbolSize: 6, itemStyle: { color: BILL_COLORS[i % BILL_COLORS.length] }, z: 4,
      markLine: i === 0 ? {
        silent: true, symbol: 'none',
        lineStyle: { color: '#f85149', type: 'dashed', width: 1 },
        label: { formatter: 'BTC=2.5（參考門檻）', color: '#f85149', fontSize: 9, position: 'insideEndTop' },
        data: [{ yAxis: 2.5 }],
      } : undefined,
    });
  });

  const axBase = {
    type: 'category', data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chartSupply.setOption({
    backgroundColor: 'transparent', animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: ['FTD（未交割）', 'FTR（未收受）', ...terms], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [
      { left: L, right: R, top: '12%', height: '38%' },
      { left: L, right: R, top: '60%', height: '30%' },
    ],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axBase, gridIndex: 1, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: 'value', scale: true, name: 'Fails (B)',
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        gridIndex: 1, type: 'value', scale: true, name: 'Bid-to-Cover',
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' }],
    series,
  }, { notMerge: true });
}

// ── status ────────────────────────────────────────────────────────────
function updateStatus() {
  const el = document.getElementById('ul-status');
  if (!el || !doc) return;
  const dLatest = daily[daily.length - 1]?.date;
  const wLatest = weekly[weekly.length - 1]?.date;
  const fLatest = fails[fails.length - 1]?.date;
  const aLatest = auctions[auctions.length - 1]?.date;
  el.textContent = `美元流動性 · 資料更新 ${doc.updated} · daily 最新 ${dLatest} · weekly(H.4.1) 最新 ${wLatest} · fails 最新 ${fLatest} · auctions 最新 ${aLatest} · ${range}`;
}

// ── master render ────────────────────────────────────────────────────
function renderAll() {
  renderStack();
  renderCorridor();
  renderBuffer();
  renderSupply();
  updateStatus();
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById('ul-range-picker');
  if (rp && !rp.dataset.built) {
    rp.dataset.built = '1';
    rp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-ul-range]');
      if (!t) return;
      range = t.dataset.ulRange;
      rp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      renderCorridor(); renderBuffer(); renderSupply(); updateStatus();
    });
  }
  const sp = document.getElementById('ul-buffer-scale');
  if (sp && !sp.dataset.built) {
    sp.dataset.built = '1';
    sp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-ul-scale]');
      if (!t) return;
      bufferScale = t.dataset.ulScale;
      sp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      renderBuffer();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const hostC = document.getElementById('ul-corridor');
  const hostB = document.getElementById('ul-buffer');
  const hostS = document.getElementById('ul-supply');
  if (!hostC || !hostB || !hostS) return;
  if (!chartCorridor) chartCorridor = echarts.init(hostC, isLight() ? null : 'dark');
  if (!chartBuffer) chartBuffer = echarts.init(hostB, isLight() ? null : 'dark');
  if (!chartSupply) chartSupply = echarts.init(hostS, isLight() ? null : 'dark');
  buildControls();
  try {
    await loadAll();
    setTimeout(() => {
      chartCorridor?.resize(); chartBuffer?.resize(); chartSupply?.resize();
      renderAll();
    }, 50);
  } catch (e) {
    const s = document.getElementById('ul-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[usdliq] load failed', e);
  }
}
export function onThemeChange(light) {
  if (!chartCorridor && !chartBuffer && !chartSupply) return;
  chartCorridor?.dispose(); chartBuffer?.dispose(); chartSupply?.dispose();
  const hostC = document.getElementById('ul-corridor');
  const hostB = document.getElementById('ul-buffer');
  const hostS = document.getElementById('ul-supply');
  chartCorridor = hostC ? echarts.init(hostC, light ? null : 'dark') : null;
  chartBuffer = hostB ? echarts.init(hostB, light ? null : 'dark') : null;
  chartSupply = hostS ? echarts.init(hostS, light ? null : 'dark') : null;
  if (doc) renderAll();
}
export function resize() {
  chartCorridor?.resize(); chartBuffer?.resize(); chartSupply?.resize();
}
