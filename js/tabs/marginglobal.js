// js/tabs/marginglobal.js — 全球融資餘額 tab
//   上表:6 個市場(台股上市/上櫃、中國滬深、日本、美國、韓國)最新融資餘額 + 月變動,可點列切換。
//   下圖:雙軸(左軸=融資餘額 bar,右軸=對應大盤指數 line),同一 tab section 內切換,不離開分頁。
//
// 資料:各市場 bespoke JSON(見 MARKETS),仿 margincost.js 的 loadAll()/loadIndex() 直接 fetch,
//       不走 js/state.js 的 SERIES 登記表(那是給通用價格序列設計的,這裡是 tab 專屬多檔讀取)。

import { isLight, mob, PALETTE, echartsBase } from '../utils/theme.js';
import { cutoffDate, presetStart, tsToLocalDate, lookupLE } from '../utils/dates.js';

const MARGIN_COLOR = '#f778ba';
const INDEX_COLOR  = '#58a6ff';
const DIVERGE_UP    = '#f0883e'; // 差值為正:融資成長快於指數 → 槓桿堆積
const DIVERGE_DOWN  = '#3fb950'; // 差值為負:融資成長慢於指數 / 去槓桿快於價格下跌
const VWAC_COLOR = '#e3b341'; // 琥珀色:估計平均融資成本(VWAC近似)線

const MARKETS = [
  {
    id: 'tw_listed', label: '台股上市',
    marginFile: 'data/taiwan_margin_total.json', marginField: 'margin_money', marginUnit: '億元',
    indexFile: 'data/TWII.json', indexLabel: '加權指數',
  },
  {
    id: 'tw_otc', label: '台股上櫃',
    marginFile: 'data/tpex_margin.json', marginField: 'margin_lots', marginUnit: '張(非金額！)',
    indexFile: 'data/TWOII.json', indexLabel: '櫃買指數',
    isProxy: true,
  },
  {
    id: 'cn', label: '中國滬深',
    marginFile: 'data/margin_global_cn.json', marginUnit: '元(人民幣)',
    needsExchangeSum: true,
    indexFile: 'data/SSE.json', indexLabel: '上證指數',
  },
  {
    id: 'jp', label: '日本',
    marginFile: 'data/margin_global_jp.json', marginField: 'margin_balance', marginUnit: '百萬日圓',
    indexFile: 'data/N225.json', indexLabel: '日經225',
  },
  {
    id: 'us', label: '美國',
    marginFile: 'data/margin_global_us.json', marginField: 'margin_balance', marginUnit: '百萬美元',
    indexFile: 'data/SP500.json', indexLabel: 'S&P500',
    altIndexes: [
      { key: 'sp500', file: 'data/SP500.json', label: 'S&P500' },
      { key: 'qqq',   file: 'data/QQQ.json',   label: 'QQQ(那斯達克100)' },
      { key: 'mags',  file: 'data/MAGS.json',  label: 'MAGS(七巨頭ETF)' },
    ],
  },
  {
    id: 'kr', label: '韓國',
    marginFile: 'data/margin_global_kr.json', marginField: 'margin_balance', marginUnit: '百萬韓元',
    indexFile: 'data/KS11.json', indexLabel: 'KOSPI',
  },
];

let chart = null;
let pctChart = null;
let activeMarket = 'tw_listed';
let range = '3Y';
let anchorDate = null; // 錨點日期(YYYY-MM-DD),null = 未設定
let activeAltIndexKey = 'sp500'; // 美股專用:目前選用的集中度代理指數(sp500/qqq/mags)
let showVwac = true; // 是否顯示「估計平均融資成本(VWAC近似)」線

const marginCache = {}; // { id: [[date, value], ...] | null(載入失敗/無資料) }
const indexCache = {};  // { id: [[date, close], ...] | null }
const altIndexCache = {}; // { key: [[date, close], ...] | null } — 美股專用代理指數,延遲載入

// cutoffDate() 本身不支援 '6M'(該函式明確禁止擴充 key 集合),但 presetStart() 已經
// 支援 '6M' 且回傳格式相同(YYYY-MM-DD),故在此包一層,不動共用檔案。
function mgCutoffDate(key) {
  if (key === '6M') return presetStart('6M');
  return cutoffDate(key); // 1Y/3Y/5Y/10Y/MAX 皆已由 cutoffDate 原生支援
}

// ── data load ────────────────────────────────────────────────────────────
function normalizeMarginRows(market, rawData) {
  if (!Array.isArray(rawData) || !rawData.length) return [];
  if (market.needsExchangeSum) {
    // SZSE 資料比 SSE 晚一天公布(實測現象),若某天只有部分交易所回報就加總,
    // 會把「當天沒公布的交易所」誤算成 0,讓最新一天看起來像腰斬。因此只保留
    // 「該資料集出現過的所有交易所都已回報」的日期,避免用不完整的加總誤導。
    const allExchanges = new Set(rawData.map(r => r.exchange).filter(Boolean));
    const byDate = new Map(); // date -> { sum, exchanges: Set }
    for (const r of rawData) {
      if (r.margin_balance == null || r.date == null) continue;
      if (!byDate.has(r.date)) byDate.set(r.date, { sum: 0, exchanges: new Set() });
      const entry = byDate.get(r.date);
      entry.sum += r.margin_balance;
      entry.exchanges.add(r.exchange);
    }
    return [...byDate.entries()]
      .filter(([, v]) => allExchanges.size === 0 || v.exchanges.size === allExchanges.size)
      .map(([date, v]) => [date, v.sum])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return rawData
    .map(r => [r.date, r[market.marginField]])
    .filter(([, v]) => v != null);
}

async function loadMarketMargin(market) {
  if (marginCache[market.id] !== undefined) return marginCache[market.id];
  try {
    const r = await fetch(market.marginFile, { cache: 'no-cache' });
    if (!r.ok) { marginCache[market.id] = null; return null; }
    const j = await r.json();
    const rows = normalizeMarginRows(market, j.data ?? []);
    marginCache[market.id] = rows.length ? rows : null;
  } catch (e) {
    console.error(`[marginglobal] load ${market.marginFile} failed`, e);
    marginCache[market.id] = null;
  }
  return marginCache[market.id];
}

async function loadMarketIndex(market) {
  if (indexCache[market.id] !== undefined) return indexCache[market.id];
  try {
    const r = await fetch(market.indexFile, { cache: 'no-cache' });
    if (!r.ok) { indexCache[market.id] = null; return null; }
    const j = await r.json();
    const rows = (j.data ?? [])
      .map(x => [x.date, x.close])
      .filter(([, v]) => v != null);
    indexCache[market.id] = rows.length ? rows : null;
  } catch (e) {
    console.error(`[marginglobal] load ${market.indexFile} failed`, e);
    indexCache[market.id] = null;
  }
  return indexCache[market.id];
}

async function loadAll() {
  await Promise.all(MARKETS.map(m => Promise.all([loadMarketMargin(m), loadMarketIndex(m)])));
}

// 美股集中度代理指數(QQQ/MAGS),延遲載入:只在使用者切到美國市場且點選非預設選項時才 fetch。
async function loadAltIndex(key) {
  if (altIndexCache[key] !== undefined) return altIndexCache[key];
  const us = MARKETS.find(m => m.id === 'us');
  const alt = us?.altIndexes?.find(a => a.key === key);
  if (!alt) { altIndexCache[key] = null; return null; }
  try {
    const r = await fetch(alt.file, { cache: 'no-cache' });
    if (!r.ok) { altIndexCache[key] = null; return null; }
    const j = await r.json();
    const rows = (j.data ?? [])
      .map(x => [x.date, x.close])
      .filter(([, v]) => v != null);
    altIndexCache[key] = rows.length ? rows : null;
  } catch (e) {
    console.error(`[marginglobal] load ${alt.file} failed`, e);
    altIndexCache[key] = null;
  }
  return altIndexCache[key];
}

// ── table ────────────────────────────────────────────────────────────────
function monthChange(rows) {
  if (!rows || rows.length < 2) return null;
  const latestDate = rows[rows.length - 1][0];
  const latestVal = rows[rows.length - 1][1];
  const cutoff = new Date(latestDate);
  cutoff.setMonth(cutoff.getMonth() - 1);
  const cutoffStr = tsToLocalDate(cutoff.getTime());
  // 找「一個月前」最接近(不晚於)的一筆
  let prevVal = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] <= cutoffStr) { prevVal = rows[i][1]; break; }
  }
  if (prevVal == null || prevVal === 0) return null;
  return (latestVal - prevVal) / Math.abs(prevVal);
}

function fmtNumber(v) {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function renderTable() {
  const host = document.getElementById('mg-table');
  if (!host) return;
  const isMob = mob();

  const rowsHtml = MARKETS.map(m => {
    const rows = marginCache[m.id];
    const active = m.id === activeMarket;
    const latest = rows && rows.length ? rows[rows.length - 1] : null;
    const chg = monthChange(rows);
    const chgStr = chg == null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`;
    const chgColor = chg == null ? 'var(--muted)' : (chg >= 0 ? '#f85149' : '#3fb950');
    const proxyBadge = m.isProxy
      ? ` <span style="color:#e3b341;font-size:11px;border:1px solid #e3b341;border-radius:3px;padding:0 4px">張數(非金額)</span>`
      : '';
    return `
      <tr data-mg-id="${m.id}" style="cursor:pointer;background:${active ? 'rgba(88,166,255,0.12)' : 'transparent'}">
        <td style="padding:6px 8px;font-weight:${active ? '700' : '400'};color:var(--text)">${m.label}</td>
        <td style="padding:6px 8px;color:var(--text)">${latest ? fmtNumber(latest[1]) : '—'} ${m.marginUnit}${proxyBadge}</td>
        <td style="padding:6px 8px;color:var(--muted)">${latest ? latest[0] : '（無資料）'}</td>
        <td style="padding:6px 8px;color:${chgColor}">${chgStr}</td>
      </tr>`;
  }).join('');

  const cols = isMob
    ? ['市場', '融資餘額', '日期', '月變動']
    : ['市場', '最新融資餘額', '最新資料日期', '月變動'];

  host.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:${isMob ? '12px' : '13px'}">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            ${cols.map(c => `<th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:600">${c}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  if (!host.dataset.built) {
    host.dataset.built = '1';
    host.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-mg-id]');
      if (!tr) return;
      activeMarket = tr.dataset.mgId;
      anchorDate = null; // 換市場後錨點語意不通用,重設
      activeAltIndexKey = 'sp500'; // 換市場後代理指數選擇語意不通用,重設回預設
      renderTable();
      renderChart();
      renderPctChart();
      updateAnchorClearVisibility();
    });
  }
}

// ── anchor % 比較 ────────────────────────────────────────────────────────
// 以 anchor 當天(找 <= anchor 的最後一筆)為基準,把後續每一筆換算成相對基準的 % 變動。
// 找不到基準值(anchor 早於該市場資料起始)回傳 null。
function rebaseToPercent(rows, anchor) {
  if (!rows || !rows.length || !anchor) return null;
  let anchorVal = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] <= anchor) { anchorVal = rows[i][1]; break; }
  }
  if (anchorVal == null || anchorVal === 0) return null;
  return rows.filter(([d]) => d >= anchor).map(([d, v]) => [d, (v / anchorVal - 1) * 100]);
}

// 差值(槓桿堆積訊號)= 融資%變動 - 指數%變動,逐日期對齊,缺一邊就跳過(不插值)。
function computeDivergence(marginPct, indexPct) {
  if (!marginPct || !indexPct) return [];
  const idxMap = new Map(indexPct.map(([d, v]) => [d, v]));
  const out = [];
  for (const [d, mv] of marginPct) {
    if (idxMap.has(d)) out.push([d, mv - idxMap.get(d)]);
  }
  return out;
}

function updateAnchorClearVisibility() {
  const btn = document.getElementById('mg-anchor-clear');
  if (btn) btn.style.display = anchorDate ? '' : 'none';
}

// 用「融資餘額淨增額」當新增融資量的權重,滾動算出一個近似的「平均建倉成本(指數位階)」。
// 這是台股 marginmap.js 精緻 LIFO 衰減模型的簡化版——沒有拆買賣、沒有衰減假設,只用
// 淨額(Δbalance)當權重,淨減少(還款)時假設不改變平均成本(比例攤還的簡化假設,非事實)。
function computeVWAC(marginRows, indexRows) {
  if (!marginRows || !marginRows.length || !indexRows || !indexRows.length) return [];
  const out = [];
  let avgCost = null;
  let prevBalance = null;
  for (const [date, balance] of marginRows) {
    const idxEntry = lookupLE(indexRows, date);
    if (!idxEntry) continue; // 該日期早於指數資料起點,跳過(無法對照)
    const idxPrice = idxEntry[1];
    if (avgCost == null) {
      avgCost = idxPrice; // 初始化:資料集第一筆融資餘額,假設當下就是這個成本(已知限制,見info-panel揭露)
    } else {
      const delta = balance - prevBalance;
      if (delta > 0 && prevBalance > 0) {
        avgCost = (avgCost * prevBalance + delta * idxPrice) / balance;
      }
      // delta <= 0(淨還款)或 prevBalance<=0:avgCost 維持不變(比例攤還簡化假設)
    }
    out.push([date, avgCost]);
    prevBalance = balance;
  }
  return out;
}

// 目前畫面上實際顯示的指數序列:美股市場且選了非預設代理指數(QQQ/MAGS)時用代理指數,
// 否則用該市場預設指數。renderChart() 與拖曳量測都需要用「畫面上實際顯示的那條指數線」查值,
// 抽出來共用,避免兩處各寫一份同樣的判斷邏輯。
function getActiveIndexRows() {
  const market = MARKETS.find(m => m.id === activeMarket);
  const usingAltIndex = activeMarket === 'us' && activeAltIndexKey !== 'sp500';
  if (usingAltIndex) {
    const altDef = market.altIndexes?.find(a => a.key === activeAltIndexKey);
    return { rows: altIndexCache[activeAltIndexKey] || [], label: altDef ? altDef.label : market.indexLabel };
  }
  return { rows: indexCache[activeMarket] || [], label: market.indexLabel };
}

// ── chart ────────────────────────────────────────────────────────────────
function renderChart() {
  if (!chart) return;
  const market = MARKETS.find(m => m.id === activeMarket);
  const marginRows = marginCache[activeMarket] || [];

  // 美股專用集中度代理指數選單:顯示/隱藏 + active chip 狀態統一在這裡處理,
  // 跟著 activeMarket/activeAltIndexKey 每次 renderChart() 都會同步一次。
  const altPicker = document.getElementById('mg-altindex-picker');
  if (altPicker) {
    altPicker.style.display = activeMarket === 'us' ? 'flex' : 'none';
    if (activeMarket === 'us') {
      altPicker.querySelectorAll('.chip[data-mg-altindex]').forEach(c => {
        c.classList.toggle('active', c.dataset.mgAltindex === activeAltIndexKey);
      });
    }
  }

  const { rows: indexRows, label: indexLabel } = getActiveIndexRows();

  const cut = mgCutoffDate(range);
  const marginView = marginRows.filter(([d]) => d >= cut);
  const indexView = indexRows.filter(([d]) => d >= cut);

  // VWAC(估計平均融資成本近似):用完整(未經 range 篩選)序列算,再用 cut 篩出檢視範圍。
  const vwacFull = computeVWAC(marginRows, indexRows);
  const vwacView = vwacFull.filter(([d]) => d >= cut);
  const showVwacSeries = showVwac && vwacView.length > 0;

  const status = document.getElementById('mg-status');
  if (status) {
    status.textContent = marginRows.length
      ? `目前顯示：${market.label} · 融資餘額 ${marginView.length} 筆 · 指數 ${indexView.length} 筆 · 最新資料 ${marginRows[marginRows.length - 1][0]}`
      : `目前顯示：${market.label} · 融資餘額資料尚無或載入失敗（可能是背景資料回補中）`;
  }

  const vwacStatus = document.getElementById('mg-vwac-status');
  if (vwacStatus) {
    if (showVwacSeries) {
      const vwacLatest = vwacView[vwacView.length - 1][1];
      const currentIndex = indexView.length ? indexView[indexView.length - 1][1] : null;
      if (currentIndex != null && vwacLatest) {
        const gapPct = (currentIndex / vwacLatest - 1) * 100;
        vwacStatus.textContent = `估計平均融資成本 ${fmtNumber(vwacLatest)} vs 目前指數 ${fmtNumber(currentIndex)}（指數距平均成本 ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%，正值代表現在指數高於平均建倉成本、負值代表低於）`;
      } else {
        vwacStatus.textContent = '';
      }
    } else {
      vwacStatus.textContent = '';
    }
  }

  // tooltip 除了絕對數字,還要顯示「相對錨點(拖曳/點擊設定的那個點)的%變動」——用
  // anchorDate 對完整序列(非 range 篩選後的 view)做 lookupLE,錨點可能落在目前
  // range 之外(例如設完錨點後又切換 range chip),仍要能正確找到基準值。
  // 尚未設定錨點時(anchorDate 為 null)不顯示%,只顯示絕對數字。
  const seriesBase = anchorDate ? {
    [`融資餘額（${market.marginUnit}）`]: lookupLE(marginRows, anchorDate)?.[1],
    [`${indexLabel}（右軸）`]: lookupLE(indexRows, anchorDate)?.[1],
    '估計平均融資成本(VWAC近似)': lookupLE(vwacFull, anchorDate)?.[1],
  } : {};

  const isMob = mob();
  const option = echartsBase({
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter(params) {
        if (!params.length) return '';
        const axisVal = params[0]?.axisValue;
        const dateStr = typeof axisVal === 'number' ? tsToLocalDate(axisVal) : (axisVal ?? '');
        if (!dateStr) return '';
        // 不能只信 ECharts 自動給的 params——月頻(美國)/週頻(日本)資料在大多數
        // hover 到的日期上根本沒有精確對應的資料點,ECharts 的 axis-trigger 只會把
        // 「當下 x 座標剛好有值」的 series 塞進 params,導致融資餘額/VWAC 這兩條
        // 稀疏線常常整條消失、只剩天天有值的指數線。改成用 lookupLE 對三條完整序列
        // 各自做「以此日期為準,往前找最近一筆」(forward-fill),三條線永遠都顯示;
        // 若該筆實際資料日期跟滑鼠位置不同,額外標出真實資料日期避免誤讀成當天更新。
        const lookupRow = arr => (arr && arr.length ? lookupLE(arr, dateStr) : null);
        const rowsToShow = [
          { name: `融資餘額（${market.marginUnit}）`, marker: `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${MARGIN_COLOR};"></span>`, entry: lookupRow(marginRows) },
          { name: `${indexLabel}（右軸）`, marker: `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${INDEX_COLOR};"></span>`, entry: lookupRow(indexRows) },
          ...(showVwacSeries ? [{ name: '估計平均融資成本(VWAC近似)', marker: `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${VWAC_COLOR};"></span>`, entry: lookupRow(vwacFull) }] : []),
        ];
        let html = `<div style="font-weight:600;margin-bottom:4px">${dateStr}</div>`;
        for (const p of rowsToShow) {
          if (!p.entry) continue;
          const [rowDate, val] = p.entry;
          if (val == null) continue;
          const base = seriesBase[p.name];
          let pctHtml = '';
          if (base != null && base !== 0) {
            const pct = (val / base - 1) * 100;
            const color = pct >= 0 ? '#f85149' : '#3fb950';
            pctHtml = ` <span style="color:${color}">(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</span>`;
          }
          // 頻率較低的序列(如美國月頻/日本週頻)常常沒有剛好落在滑鼠位置的資料點,
          // lookupLE 會往前找最近一筆——若那筆的實際日期跟目前 hover 的日期不同,
          // 附註真實資料日期,避免使用者誤以為這是當天更新的數字。
          const asOfNote = rowDate !== dateStr
            ? ` <span style="color:${PALETTE.muted};font-size:10px">(最新資料 ${rowDate})</span>`
            : '';
          html += `<div>${p.marker}${p.name}：<b>${fmtNumber(val)}</b>${pctHtml}${asOfNote}</div>`;
        }
        return html;
      },
    },
    legend: {
      data: [
        `融資餘額（${market.marginUnit}）`,
        `${indexLabel}（右軸）`,
        ...(showVwacSeries ? ['估計平均融資成本(VWAC近似)'] : []),
      ],
      top: 2, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    grid: { left: isMob ? 44 : 58, right: isMob ? 44 : 58, top: '14%', bottom: isMob ? '18%' : '12%' },
    xAxis: {
      type: 'time',
      axisLabel: { color: PALETTE.muted, fontSize: 11, rotate: isMob ? 30 : 0 },
      axisLine: { lineStyle: { color: PALETTE.muted } },
      splitLine: { show: false },
    },
    yAxis: [
      { type: 'value', scale: true, name: `融資餘額(${market.marginUnit})`,
        nameTextStyle: { color: MARGIN_COLOR, fontSize: 10 },
        axisLabel: { color: MARGIN_COLOR, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', scale: true, position: 'right', name: indexLabel,
        nameTextStyle: { color: INDEX_COLOR, fontSize: 10 },
        axisLabel: { color: INDEX_COLOR, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [
      {
        name: `融資餘額（${market.marginUnit}）`, type: 'bar', yAxisIndex: 0,
        data: marginView.map(([d, v]) => [d, v]),
        itemStyle: { color: MARGIN_COLOR, opacity: 0.75 },
        markLine: anchorDate ? {
          silent: true, symbol: 'none',
          lineStyle: { color: PALETTE.text2, type: 'dashed', width: 1.4 },
          label: { formatter: `錨點：${anchorDate}`, color: PALETTE.text2, fontSize: 10, position: 'insideEndTop' },
          data: [{ xAxis: anchorDate }],
        } : undefined,
      },
      {
        name: `${indexLabel}（右軸）`, type: 'line', yAxisIndex: 1,
        data: indexView.map(([d, v]) => [d, v]),
        symbol: 'none', connectNulls: false,
        itemStyle: { color: INDEX_COLOR }, lineStyle: { color: INDEX_COLOR, width: 1.6 },
      },
      ...(showVwacSeries ? [{
        name: '估計平均融資成本(VWAC近似)', type: 'line', yAxisIndex: 1,
        data: vwacView,
        symbol: 'none', connectNulls: false,
        itemStyle: { color: VWAC_COLOR }, lineStyle: { color: VWAC_COLOR, width: 1.4, type: 'dashed' },
      }] : []),
    ],
  });

  chart.setOption(option, { notMerge: true });
}

// ── anchor % 比較圖 ─────────────────────────────────────────────────────
// 不受 range 篩選:固定顯示「錨點日期到目前最新資料」全部範圍。
function renderPctChart() {
  const host = document.getElementById('mg-pct-chart');
  const pctStatus = document.getElementById('mg-pct-status');
  if (!host) return;

  if (!anchorDate) {
    host.style.display = 'none';
    if (pctStatus) pctStatus.textContent = '';
    return;
  }

  const market = MARKETS.find(m => m.id === activeMarket);
  const marginRows = marginCache[activeMarket] || [];
  const indexRows = indexCache[activeMarket] || [];
  const marginPct = rebaseToPercent(marginRows, anchorDate);
  const indexPct = rebaseToPercent(indexRows, anchorDate);

  if (!marginPct || !indexPct) {
    host.style.display = 'none';
    if (pctStatus) pctStatus.textContent = '錨點早於此市場資料起始，無法計算';
    return;
  }

  host.style.display = 'block';
  if (!pctChart) pctChart = echarts.init(host, isLight() ? null : 'dark');

  const divergence = computeDivergence(marginPct, indexPct);
  const isMob = mob();

  const option = echartsBase({
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['融資餘額%變動', `${market.indexLabel}%變動`, '差值(槓桿堆積訊號)'],
      top: 2, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    grid: { left: isMob ? 44 : 58, right: isMob ? 20 : 30, top: '20%', bottom: isMob ? '18%' : '12%' },
    xAxis: {
      type: 'time',
      axisLabel: { color: PALETTE.muted, fontSize: 11, rotate: isMob ? 30 : 0 },
      axisLine: { lineStyle: { color: PALETTE.muted } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: '%',
      nameTextStyle: { color: PALETTE.text2, fontSize: 10 },
      axisLabel: { color: PALETTE.text2, fontSize: 11, formatter: '{value}%' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [
      {
        name: '融資餘額%變動', type: 'line', data: marginPct,
        symbol: 'none', connectNulls: false,
        itemStyle: { color: MARGIN_COLOR }, lineStyle: { color: MARGIN_COLOR, width: 1.6 },
      },
      {
        name: `${market.indexLabel}%變動`, type: 'line', data: indexPct,
        symbol: 'none', connectNulls: false,
        itemStyle: { color: INDEX_COLOR }, lineStyle: { color: INDEX_COLOR, width: 1.6 },
      },
      {
        name: '差值(槓桿堆積訊號)', type: 'bar', data: divergence,
        itemStyle: { color: p => (p.value[1] >= 0 ? DIVERGE_UP : DIVERGE_DOWN), opacity: 0.5 },
      },
    ],
  });

  pctChart.setOption(option, { notMerge: true });

  if (pctStatus) {
    const lastMargin = marginPct.length ? marginPct[marginPct.length - 1][1] : null;
    const lastIndex = indexPct.length ? indexPct[indexPct.length - 1][1] : null;
    if (lastMargin != null && lastIndex != null) {
      const diff = lastMargin - lastIndex;
      const fmtPct = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
      const desc = diff >= 0
        ? '融資成長快於指數 → 槓桿堆積訊號'
        : '融資成長慢於指數 / 去槓桿快於價格下跌';
      pctStatus.textContent = `自 ${anchorDate} 起：融資餘額 ${fmtPct(lastMargin)} vs ${market.indexLabel} ${fmtPct(lastIndex)}（差值 ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp，${desc}）`;
    } else {
      pctStatus.textContent = '';
    }
  }
}

// ── 拖曳即時量測 → 放開設定錨點 ─────────────────────────────────────────
// 重用 pentagram.js 的 attachDragMeasure() 架構(canvas overlay,不呼叫 setOption,
// zr mousedown/mousemove/mouseup + document 層級保險 mouseup)。查值改用 lookupLE
// (binary search)而非 pentagram 原本的線性掃描,因為這裡拖曳時(mousemove 高頻觸發)
// 要同時查融資餘額+指數兩個序列,指數資料量可能上千筆,線性掃描效能較差。
let _dmCanvas = null;
let _dmDragging = false;
let _dmStart = null; // { date, marginVal, indexVal, pixelX }
let _mgDocMupHandler = null;

function _mgLookupAt(offsetX, offsetY) {
  if (!chart) return null;
  let grid;
  try {
    grid = chart.getModel().getComponent('grid').coordinateSystem.getRect();
  } catch (e) { return null; }
  if (!grid || offsetX < grid.x || offsetX > grid.x + grid.width || offsetY < grid.y || offsetY > grid.y + grid.height) {
    return null; // 點在繪圖區外(標題/legend/軸標籤/dataZoom 滑桿等)不處理
  }
  let ts;
  try {
    ts = chart.convertFromPixel({ xAxisIndex: 0 }, offsetX);
  } catch (e) { return null; }
  if (ts == null || Number.isNaN(ts)) return null;
  const date = tsToLocalDate(ts);
  const marginRows = marginCache[activeMarket] || [];
  const { rows: indexRows } = getActiveIndexRows();
  const marginEntry = lookupLE(marginRows, date);
  const indexEntry = lookupLE(indexRows, date);
  if (!marginEntry || !indexEntry) return null;
  return { date, marginVal: marginEntry[1], indexVal: indexEntry[1] };
}

function updateDragStatus(info) {
  const el = document.getElementById('mg-drag-status');
  if (!el) return;
  if (!info) { el.textContent = ''; return; }
  const fmtPct = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  el.textContent = `${info.startDate} → ${info.curDate}：指數 ${fmtPct(info.indexPct)} ／ 融資 ${fmtPct(info.marginPct)}（差 ${fmtPct(info.marginPct - info.indexPct)}pp）`;
}

function attachMarginDragMeasure() {
  if (!chart) return;
  const container = chart.getDom();
  container.style.position = 'relative';
  let cv = container.querySelector('canvas.__mg-dm');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = '__mg-dm';
    cv.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10;';
    container.appendChild(cv);
  }
  cv.width = chart.getWidth();
  cv.height = chart.getHeight();
  _dmCanvas = cv;
  const ctx = cv.getContext('2d');

  const zr = chart.getZr();
  if (attachMarginDragMeasure._down) zr.off('mousedown', attachMarginDragMeasure._down);
  if (attachMarginDragMeasure._move) zr.off('mousemove', attachMarginDragMeasure._move);
  if (attachMarginDragMeasure._up)   zr.off('mouseup',   attachMarginDragMeasure._up);
  if (_mgDocMupHandler) document.removeEventListener('mouseup', _mgDocMupHandler);

  _dmDragging = false;
  _dmStart = null;
  ctx.clearRect(0, 0, cv.width, cv.height);
  updateDragStatus(null);

  const onDown = e => {
    const pt = _mgLookupAt(e.offsetX, e.offsetY);
    if (!pt) return;
    _dmDragging = true;
    _dmStart = { ...pt, pixelX: e.offsetX };
  };

  const onMove = e => {
    if (!_dmDragging || !_dmStart) return;
    const cur = _mgLookupAt(e.offsetX, e.offsetY);
    if (!cur) return;

    const indexPct = (cur.indexVal - _dmStart.indexVal) / _dmStart.indexVal * 100;
    const marginPct = (cur.marginVal - _dmStart.marginVal) / _dmStart.marginVal * 100;

    const x1 = _dmStart.pixelX, x2 = e.offsetX;
    const yTop = 20, yBot = cv.height - 50;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = PALETTE.muted;
    ctx.beginPath(); ctx.moveTo(x1, yTop); ctx.lineTo(x1, yBot); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, yTop); ctx.lineTo(x2, yBot); ctx.stroke();
    ctx.setLineDash([]);
    const color = marginPct >= indexPct ? DIVERGE_UP : DIVERGE_DOWN;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    const yMid = (yTop + yBot) / 2;
    ctx.beginPath(); ctx.moveTo(x1, yMid); ctx.lineTo(x2, yMid); ctx.stroke();
    ctx.fillStyle = PALETTE.text2;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(_dmStart.date, x1, yBot + 14);
    ctx.fillText(cur.date, x2, yBot + 14);
    ctx.restore();

    updateDragStatus({ startDate: _dmStart.date, curDate: cur.date, indexPct, marginPct });
  };

  const onUp = () => {
    if (!_dmDragging) return;
    _dmDragging = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    updateDragStatus(null);
    // 放開才 commit 錨點,沿用既有 renderPctChart() 的「錨點→最新資料」子圖行為不變。
    // 純點擊(拖曳距離為0)也視為有效:_dmStart 本身就是 mousedown 當下查到的日期/數值。
    if (_dmStart) {
      anchorDate = _dmStart.date;
      renderChart();
      renderPctChart();
      updateAnchorClearVisibility();
    }
    _dmStart = null;
  };

  attachMarginDragMeasure._down = onDown;
  attachMarginDragMeasure._move = onMove;
  attachMarginDragMeasure._up = onUp;
  zr.on('mousedown', onDown);
  zr.on('mousemove', onMove);
  zr.on('mouseup', onUp);
  _mgDocMupHandler = onUp;
  document.addEventListener('mouseup', onUp);
}

// ── controls ─────────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById('mg-range-picker');
  if (rp && !rp.dataset.built) {
    rp.dataset.built = '1';
    rp.addEventListener('click', e => {
      const clearBtn = e.target.closest('#mg-anchor-clear');
      if (clearBtn) {
        anchorDate = null;
        renderChart();
        renderPctChart();
        updateAnchorClearVisibility();
        return;
      }
      const vwacBtn = e.target.closest('#mg-vwac-toggle');
      if (vwacBtn) {
        showVwac = !showVwac;
        vwacBtn.classList.toggle('active', showVwac);
        renderChart();
        return;
      }
      const t = e.target.closest('.chip[data-mg-range]');
      if (!t) return;
      range = t.dataset.mgRange;
      // 只切換 range chip 彼此的 active 狀態,不動同容器內的錨點清除/VWAC 開關 chip。
      rp.querySelectorAll('.chip[data-mg-range]').forEach(c => c.classList.toggle('active', c === t));
      renderChart();
    });
  }

  const altPicker = document.getElementById('mg-altindex-picker');
  if (altPicker && !altPicker.dataset.built) {
    altPicker.dataset.built = '1';
    altPicker.addEventListener('click', async e => {
      const t = e.target.closest('.chip[data-mg-altindex]');
      if (!t) return;
      const key = t.dataset.mgAltindex;
      if (key === activeAltIndexKey) return;
      activeAltIndexKey = key;
      if (key !== 'sp500') await loadAltIndex(key);
      renderChart();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById('mg-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  attachMarginDragMeasure();
  buildControls();
  const status = document.getElementById('mg-status');
  if (status) status.textContent = '載入中…';
  try {
    await loadAll();
    renderTable();
    setTimeout(() => {
      chart?.resize();
      pctChart?.resize();
      renderChart();
      renderPctChart();
      updateAnchorClearVisibility();
    }, 50);
  } catch (e) {
    if (status) status.textContent = '載入失敗：' + (e.message || e);
    console.error('[marginglobal] load failed', e);
  }
}

export function onThemeChange(light) {
  if (!chart) return; // tab 從未 activate 過,不必補渲染
  chart.dispose();
  chart = echarts.init(document.getElementById('mg-chart'), light ? null : 'dark');
  attachMarginDragMeasure();
  if (anchorDate && pctChart) {
    pctChart.dispose();
    pctChart = echarts.init(document.getElementById('mg-pct-chart'), light ? null : 'dark');
  }
  renderTable();
  renderChart();
  renderPctChart();
}

export function resize() {
  chart?.resize();
  if (_dmCanvas && chart) {
    _dmCanvas.width = chart.getWidth();
    _dmCanvas.height = chart.getHeight();
  }
  if (anchorDate) pctChart?.resize();
}
