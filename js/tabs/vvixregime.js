// VVIX波動象限 tab — VIX水位 + VIX期限結構(ts_ratio) + VVIX 三維波動率 regime 分類
//   查證 X @3PeaksTrading 三維波動率四象限宣稱（見 Financial_work/vvix_term_regime_backtest.py）。
//   方向性成立：VVIX 背離 regime 的遠期波動率/回撤確實比平靜 regime 更高更深。
//
// Regime 分類門檻（與已驗證研究腳本 vvix_term_regime_backtest.py 逐字一致，鎖定不可更動）：
//   regime1（平靜）        : vix<18 AND ts_ratio<1 AND vvix<90
//   regime2（VVIX背離/謹慎）: vix<18 AND ts_ratio<1 AND vvix>100
//   regime3（極端恐慌）     : vix>35 AND ts_ratio>=1 AND vvix>100
//   其餘 = none，不分類、不上色
//   ⚠️ regime3 的 vvix>100 門檻是延伸假設，非原推文明確數字（原推文只寫 "High VVIX"）。
//
// 資料：data/vix_term.json（CBOE，現成）／data/VVIX.json（yfinance ^VVIX，本 tab 新增消費者）／
//       data/QQQ.json（現成）。以 QQQ 交易日為主軸，inner join 對齊三者（同 python dropna()）。
// 已驗證研究結論（靜態文字，見 info-panel，非本檔重算）：見 vvix_term_regime_backtest.py baseline。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';

const REGIME_COLOR = {
  regime1: "#3fb950", // 平靜 — 綠
  regime2: "#f0883e", // VVIX背離 — 橘
  regime3: "#f85149", // 極端恐慌 — 紅
};
const REGIME_AREA_COLOR = {
  regime1: "rgba(63,185,80,0.10)",
  regime2: "rgba(240,136,62,0.14)",
  regime3: "rgba(248,81,73,0.18)",
};
const REGIME_LABEL = {
  regime1: "平靜",
  regime2: "VVIX背離，謹慎",
  regime3: "極端恐慌",
};

let chart = null;
let range = "3Y";
let merged = null; // [{date, close, vix, ts_ratio, vvix, regime}]

// ── regime 分類（純函式，門檻與研究腳本逐字一致） ───────────────────
function classifyRegime({ vix, ts_ratio, vvix }) {
  if (vix == null || ts_ratio == null || vvix == null) return null;
  if (vix < 18 && ts_ratio < 1 && vvix < 90) return "regime1";
  if (vix < 18 && ts_ratio < 1 && vvix > 100) return "regime2";
  if (vix > 35 && ts_ratio >= 1 && vvix > 100) return "regime3";
  return null;
}

// ── 資料載入 + 合併（inner join：QQQ 交易日為主軸，三者皆存在才分類） ──
async function loadAll() {
  if (merged) return;
  const [vtResp, vvixResp, qqqResp] = await Promise.all([
    fetch("data/vix_term.json", { cache: "no-cache" }),
    fetch("data/VVIX.json",     { cache: "no-cache" }),
    fetch("data/QQQ.json",      { cache: "no-cache" }),
  ]);
  if (!vtResp.ok)   throw new Error(`vix_term: HTTP ${vtResp.status}`);
  if (!vvixResp.ok) throw new Error(`VVIX: HTTP ${vvixResp.status}`);
  if (!qqqResp.ok)  throw new Error(`QQQ: HTTP ${qqqResp.status}`);

  const [vtJson, vvixJson, qqqJson] = await Promise.all([
    vtResp.json(), vvixResp.json(), qqqResp.json(),
  ]);

  const vtByDate = new Map();
  for (const r of (vtJson.data || [])) vtByDate.set(r.date, { vix: r.vix, ts_ratio: r.ts_ratio });
  const vvixByDate = new Map();
  for (const r of (vvixJson.data || [])) vvixByDate.set(r.date, r.close);

  const rows = [];
  for (const r of (qqqJson.data || [])) {
    const vt = vtByDate.get(r.date);
    const vvix = vvixByDate.get(r.date);
    const vix = vt?.vix ?? null;
    const ts_ratio = vt?.ts_ratio ?? null;
    const hasAll = vix != null && ts_ratio != null && vvix != null;
    rows.push({
      date: r.date,
      close: r.close,
      vix, ts_ratio,
      vvix: vvix ?? null,
      regime: hasAll ? classifyRegime({ vix, ts_ratio, vvix }) : null,
    });
  }
  merged = rows;
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function lastNonNull(key) {
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i][key] != null) return merged[i];
  }
  return null;
}

function updateCards() {
  // 「目前」= 資料最新一天的實際分類，不是回溯找最近一次符合門檻的歷史日
  // （若今天不符合任一 regime 門檻就該誠實顯示「無明確分類」，不能用舊分類頂替）。
  const latest = merged[merged.length - 1];
  if (latest?.regime) {
    const clr = REGIME_COLOR[latest.regime];
    setText("vvixregime-cur-val", REGIME_LABEL[latest.regime], clr);
    setText("vvixregime-cur-sub", `${latest.date}`, "var(--muted)");
    setText("vvixregime-cur-signal", latest.regime, clr);
  } else {
    setText("vvixregime-cur-val", "無明確分類", PALETTE.text);
    setText("vvixregime-cur-sub", latest ? `${latest.date}` : "—", "var(--muted)");
    setText("vvixregime-cur-signal", "當前不符合任一 regime 門檻", PALETTE.muted);
  }

  const vvixRow = lastNonNull("vvix");
  if (vvixRow) {
    const v = vvixRow.vvix;
    let sig, clr;
    if      (v > 100) { sig = "高於100，避險需求偏高"; clr = "#f85149"; }
    else if (v > 90)  { sig = "介於90–100之間";        clr = "#f0883e"; }
    else               { sig = "低於90，無避險背離跡象"; clr = "#3fb950"; }
    setText("vvixregime-vvix-val", v.toFixed(2), PALETTE.text);
    setText("vvixregime-vvix-sub", `${vvixRow.date} · VVIX（VIX的VIX）`, "var(--muted)");
    setText("vvixregime-vvix-signal", sig, clr);
  }

  const vixRow = [...merged].reverse().find(r => r.vix != null && r.ts_ratio != null);
  if (vixRow) {
    const back = vixRow.ts_ratio > 1;
    const clr = back ? "#f85149" : "#3fb950";
    setText("vvixregime-vixts-val", `VIX ${vixRow.vix.toFixed(1)} / ts ${vixRow.ts_ratio.toFixed(3)}`, PALETTE.text);
    setText("vvixregime-vixts-sub", `${vixRow.date}`, "var(--muted)");
    setText("vvixregime-vixts-signal", back ? "backwardation 近月恐慌" : "contango 正常", clr);
  }
}

// ── regime 連續區段（同 vix_term.js backAreas 模式，避免逐點markPoint糊成一片） ──
function regimeAreas(view, dates, key) {
  const areas = [];
  let segStart = null;
  for (let i = 0; i < view.length; i++) {
    const on = view[i].regime === key;
    if (on && segStart === null) segStart = dates[i];
    if (!on && segStart !== null) {
      areas.push([{ xAxis: segStart }, { xAxis: dates[i - 1] }]);
      segStart = null;
    }
  }
  if (segStart !== null) areas.push([{ xAxis: segStart }, { xAxis: dates[dates.length - 1] }]);
  return areas;
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !merged?.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const isMob   = mob();

  updateCards();

  const cut  = cutoffDate(range);
  const view = merged.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("vvixregime-status");
  if (status) status.textContent =
    `VVIX波動regime · ${dates.length} 個交易日（${range}）· 資料 CBOE VIX/VVIX（yfinance）/QQQ`;

  const L = isMob ? 44 : 56;
  const R = isMob ? 16 : 24;

  const markAreaData = [
    ...regimeAreas(view, dates, "regime1").map(seg => [
      { ...seg[0], itemStyle: { color: REGIME_AREA_COLOR.regime1 } }, seg[1],
    ]),
    ...regimeAreas(view, dates, "regime2").map(seg => [
      { ...seg[0], itemStyle: { color: REGIME_AREA_COLOR.regime2 } }, seg[1],
    ]),
    ...regimeAreas(view, dates, "regime3").map(seg => [
      { ...seg[0], itemStyle: { color: REGIME_AREA_COLOR.regime3 } }, seg[1],
    ]),
  ];

  const series = [
    {
      name: "QQQ", type: "line", xAxisIndex: 0, yAxisIndex: 0,
      data: view.map(r => r.close != null ? +r.close.toFixed(2) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: "#58a6ff" },
      lineStyle: { color: "#58a6ff", width: 1.6 },
      z: 5,
      markArea: { silent: true, data: markAreaData },
    },
    {
      name: "VVIX", type: "line", xAxisIndex: 1, yAxisIndex: 1,
      data: view.map(r => r.vvix != null ? +r.vvix.toFixed(2) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: "#d2a8ff" },
      lineStyle: { color: "#d2a8ff", width: 1.6 },
      z: 5,
      markLine: {
        silent: true, symbol: "none",
        lineStyle: { type: "dashed", width: 1 },
        label: { fontSize: 9, position: "insideEndTop" },
        data: [
          { yAxis: 90,  lineStyle: { color: REGIME_COLOR.regime1 }, label: { formatter: "90（平靜門檻）", color: REGIME_COLOR.regime1 } },
          { yAxis: 100, lineStyle: { color: REGIME_COLOR.regime2 }, label: { formatter: "100（背離門檻）", color: REGIME_COLOR.regime2 } },
        ],
      },
    },
  ];

  const axBase = {
    type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: ["QQQ", "VVIX"], top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [
      { left: L, right: R, top: "12%", height: "52%" },
      { left: L, right: R, top: "70%", height: "20%" },
    ],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axBase, gridIndex: 1, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: "value", scale: true, name: "QQQ",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        gridIndex: 1, type: "value", scale: true, name: "VVIX",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("vvixregime-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-vvixregime-range]");
      if (!t) return;
      range = t.dataset.vvixregimeRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("vvixregime-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("vvixregime-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[vvixregime] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("vvixregime-chart"), light ? null : "dark");
  if (merged) render();
}
export function resize() { chart?.resize(); }
