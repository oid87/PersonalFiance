import { CK_ASSETS, CK_ASSETS_3 } from '../state.js';
import { computeMA, computeBounceSignals } from '../utils/math.js';

const ckRaw = {};
let ckFilter = "all";
let ckMode = "4w";
let ckWindow = 4;
let ckAssetMode = "4a";   // "4a" = GLD/BTC/TLT/QQQ | "3a" = GLD/TLT/QQQ
let ckData4a = null;
let ckData3a = null;
let ckInited = false;

async function loadCKData() {
  const allAssets = [...CK_ASSETS,
    ...CK_ASSETS_3.filter(a => !CK_ASSETS.some(b => b.key === a.key))];
  await Promise.all([
    ...allAssets.map(async ({ key, file }) => {
      if (ckRaw[key]) return;
      const resp = await fetch(file, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`${key}: HTTP ${resp.status}`);
      const j = await resp.json();
      ckRaw[key] = (j.data || []).map(r => [r.date, r.close]);
    }),
    (async () => {
      if (ckRaw["F&G"]) return;
      const resp = await fetch("data/fear_greed.json", { cache: "no-cache" });
      if (!resp.ok) throw new Error("F&G: HTTP " + resp.status);
      const j = await resp.json();
      ckRaw["F&G"] = (j.data || []).map(r => [r.date, r.value]);
    })(),
  ]);
}

function ckWeekStart(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  // check_reuse: keep — UTC 建構的時間戳轉日期鍵,slice 與建構端同為 UTC 故自洽;tsToLocalDate 是給 ECharts 本地午夜 axisValue 用的,換過去反而會差一天
  return d.toISOString().slice(0, 10);
}

function ckWeeklyCloses(data) {
  const m = {};
  for (const [d, c] of data) m[ckWeekStart(d)] = c;
  return m;
}

function computeCKWeekly(assets, startDate) {
  const n = assets.length;
  const closes = {};
  for (const { key } of assets) {
    closes[key] = ckRaw[key] ? ckWeeklyCloses(ckRaw[key]) : {};
  }

  // F&G min per week
  const fgWk = {};
  for (const [d, v] of (ckRaw["F&G"] || [])) {
    const w = ckWeekStart(d);
    if (!(w in fgWk) || v < fgWk[w]) fgWk[w] = v;
  }

  // 逃往黃金: all non-gold assets down, gold asset up
  const goldKey = (assets.find(a => a.isGold) || {}).key;
  const ftgKeys = assets.map(a => a.key).filter(k => k !== goldKey);

  const weeks = Object.keys(closes["QQQ"]).filter(w => w >= startDate).sort();

  const rows = [];
  for (let i = 8; i < weeks.length; i++) {
    const w = weeks[i], wPrev = weeks[i - 1];
    const w4 = weeks[i - 4], w8 = weeks[i - 8];

    const weekRets = {}, cum4Rets = {}, cum8Rets = {};
    let weekDown = 0, cum4Down = 0, cum8Down = 0;

    for (const { key } of assets) {
      const cW = closes[key][w], cP = closes[key][wPrev];
      const c4 = closes[key][w4], c8 = closes[key][w8];
      weekRets[key] = (cP && cW) ? (cW - cP) / cP : null;
      cum4Rets[key] = (c4 && cW) ? (cW - c4) / c4 : null;
      cum8Rets[key] = (c8 && cW) ? (cW - c8) / c8 : null;
      if (weekRets[key] != null && weekRets[key] < 0) weekDown++;
      if (cum4Rets[key] != null && cum4Rets[key] < 0) cum4Down++;
      if (cum8Rets[key] != null && cum8Rets[key] < 0) cum8Down++;
    }

    // F&G min across 4-week and 8-week windows
    let fgMin4w = null, fgMin8w = null;
    for (let j = i - 7; j <= i; j++) {
      const v = fgWk[weeks[j]];
      if (v == null) continue;
      if (fgMin8w == null || v < fgMin8w) fgMin8w = v;
      if (j >= i - 3 && (fgMin4w == null || v < fgMin4w)) fgMin4w = v;
    }

    const cNow = closes["QQQ"][w];
    const cF4  = i + 4 < weeks.length ? closes["QQQ"][weeks[i + 4]] : null;
    const cF8  = i + 8 < weeks.length ? closes["QQQ"][weeks[i + 8]] : null;

    const ftg4w = goldKey && ftgKeys.every(k => cum4Rets[k] != null && cum4Rets[k] < 0)
      && cum4Rets[goldKey] != null && cum4Rets[goldKey] > 0;
    const ftg8w = goldKey && ftgKeys.every(k => cum8Rets[k] != null && cum8Rets[k] < 0)
      && cum8Rets[goldKey] != null && cum8Rets[goldKey] > 0;

    rows.push({
      w, weekRets, cum4Rets, cum8Rets,
      weekDown, cum4Down, cum8Down,
      fgMin4w, fgMin8w, ftg4w, ftg8w,
      fwd4w: (cNow && cF4) ? (cF4 / cNow - 1) : null,
      fwd8w: (cNow && cF8) ? (cF8 / cNow - 1) : null,
    });
  }
  return rows;
}

function ckActiveAssets() { return ckAssetMode === "3a" ? CK_ASSETS_3 : CK_ASSETS; }
function getCKData() {
  if (ckAssetMode === "3a") {
    if (!ckData3a) ckData3a = computeCKWeekly(CK_ASSETS_3, "2002-08-01");
    return ckData3a;
  }
  if (!ckData4a) ckData4a = computeCKWeekly(CK_ASSETS, "2014-10-01");
  return ckData4a;
}

export function renderCKTab() {
  const data = getCKData();
  if (!data) return;
  const assets = ckActiveAssets();
  const n = assets.length;
  const pct = v => v != null ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "—";
  const clr = v => v == null ? "" : v >= 0 ? "pos" : "neg";
  const use4w = ckMode === "4w";
  const wn = ckWindow;
  const cumRetsKey = wn === 8 ? "cum8Rets" : "cum4Rets";
  const cumDownKey = wn === 8 ? "cum8Down" : "cum4Down";
  const fgMinKey   = wn === 8 ? "fgMin8w"  : "fgMin4w";
  const ftgKey     = wn === 8 ? "ftg8w"    : "ftg4w";
  const startLabel = ckAssetMode === "3a" ? "2002/08" : "2014/10";

  // Update description + filter chip labels
  document.getElementById("ck-desc").textContent =
    ckAssetMode === "3a"
      ? "黃金期貨 · TLT · QQQ — 累積同跌 · 現金為王訊號 · 2002/08 起"
      : "GLD · BTC · TLT · QQQ — 累積同跌 · 現金為王訊號";
  document.getElementById("ck-filter-picker").innerHTML = `
    <span class="chip ${ckFilter==="all"?"active":""}" data-ck-filter="all" data-tooltip="顯示所有週次，不篩選">全部</span>
    <span class="chip ${ckFilter==="3"?"active":""}" data-ck-filter="3" data-tooltip="${n}資產中至少${n-1}個同週下跌">≥${n-1}/${n} 跌</span>
    <span class="chip ${ckFilter==="4"?"active":""}" data-ck-filter="4" data-tooltip="${n}資產全部同週下跌，現金為王時刻最強訊號">${n}/${n} 全跌</span>
  `;

  const ckAllN = data.filter(r => r[cumDownKey] === n);
  const signalRows = ckAllN.filter(r => r[fgMinKey] != null && r[fgMinKey] < 25);
  const flightRows = data.filter(r => r[ftgKey] && r[fgMinKey] != null && r[fgMinKey] < 25);
  const f4 = ckAllN.filter(r => r.fwd4w != null), f8 = ckAllN.filter(r => r.fwd8w != null);
  const avg4w = f4.length ? f4.reduce((s, r) => s + r.fwd4w, 0) / f4.length : null;
  const avg8w = f8.length ? f8.reduce((s, r) => s + r.fwd8w, 0) / f8.length : null;

  document.getElementById("ck-summary").innerHTML = `
    <span>${n}/${n} 全跌（${wn}週）<span class="ck-stat-val">${ckAllN.length}</span> 週</span>
    <span><span class="ck-badge">現金為王</span> +F&amp;G&lt;25：<span class="ck-stat-val">${signalRows.length}</span> 週</span>
    <span><span class="ck-badge-gold">逃往黃金</span> +F&amp;G&lt;25：<span class="ck-stat-val">${flightRows.length}</span> 週</span>
    <span>現金為王後4W QQQ：<span class="ck-stat-val ${clr(avg4w)}">${pct(avg4w)}</span></span>
    <span>現金為王後8W QQQ：<span class="ck-stat-val ${clr(avg8w)}">${pct(avg8w)}</span></span>
  `;

  const filtered = data.filter(r => {
    const dc = r[cumDownKey];
    if (ckFilter === "4") return dc === n;
    if (ckFilter === "3") return dc >= n - 1;
    return true;
  }).slice().reverse();

  const modeLabel = use4w ? `${wn}週累積` : "當週";
  document.getElementById("ck-head").innerHTML = `<tr>
    <th style="text-align:left">週(一)</th>
    ${assets.map(a => `<th style="color:${a.color}">${a.label||a.key}<br/><span style="font-weight:400;font-size:10px;opacity:.7">${modeLabel}</span></th>`).join("")}
    <th>${wn}週下跌</th>
    <th>F&amp;G低<br/><span style="font-weight:400;font-size:10px;opacity:.7">${wn}週內</span></th>
    <th>訊號</th>
  </tr>`;

  document.getElementById("ck-body").innerHTML = filtered.map(r => {
    const rets    = use4w ? r[cumRetsKey] : r.weekRets;
    const cumDown = r[cumDownKey];
    const fgMin   = r[fgMinKey];
    const isSignal = cumDown === n && fgMin != null && fgMin < 25;
    const isFlight = r[ftgKey] && fgMin != null && fgMin < 25;
    const rowCls   = isSignal ? "ck-row-4" : isFlight ? "ck-row-gold" : cumDown === n ? "ck-row-3" : "";
    const badge    = isSignal
      ? `<span class="ck-badge">現金為王</span>`
      : isFlight
        ? `<span class="ck-badge-gold">逃往黃金</span>`
        : cumDown === n ? `<span style="color:var(--muted);font-size:11px">${n}/${n}</span>` : "";
    const fgCls = fgMin != null && fgMin < 25 ? "fear-val" : "";
    return `<tr class="${rowCls}">
      <td style="text-align:left;font-weight:500;font-size:11px">${r.w}</td>
      ${assets.map(a => `<td class="${clr(rets[a.key])}">${pct(rets[a.key])}</td>`).join("")}
      <td style="color:var(--muted)">${cumDown}/${n}</td>
      <td class="${fgCls}">${fgMin != null ? fgMin : "—"}</td>
      <td>${badge}</td>
    </tr>`;
  }).join("");

  document.getElementById("ck-status").textContent =
    `顯示 ${filtered.length} 週 · 資料 ${startLabel} 起 · 訊號 = ${wn}週累積全跌 + F&G < 25`;
}

function renderBounceSection() {
  const section = document.getElementById("bounce-section");
  if (!section) return;
  const qqqD  = ckRaw["QQQ"] || [];
  const fgArr = ckRaw["F&G"] || [];
  if (!qqqD.length || !fgArr.length) { section.style.display = "none"; return; }

  const ma200 = computeMA(qqqD, 200);
  const { bounceSignals, bounceRetMap } = computeBounceSignals(qqqD, fgArr, ma200);

  const rows = bounceSignals.map(([date, close]) => {
    const info = bounceRetMap.get(date) ?? {};
    return { date, close, fg: info.fg, ret: info.ret, vsMa: info.vsMa };
  });

  const display = [...rows].reverse().slice(0, 30);
  document.getElementById("bounce-count").textContent =
    `歷史共 ${rows.length} 次，顯示最近 ${display.length} 次`;

  document.getElementById("bounce-head").innerHTML =
    `<tr style="color:var(--muted);font-size:.75rem">
       <th style="text-align:left;padding:3px 6px">日期</th>
       <th style="text-align:right;padding:3px 6px">QQQ</th>
       <th style="text-align:right;padding:3px 6px">單日漲幅</th>
       <th style="text-align:right;padding:3px 6px">F&amp;G</th>
       <th style="text-align:right;padding:3px 6px">vs MA200</th>
     </tr>`;

  document.getElementById("bounce-body").innerHTML = display.map(r =>
    `<tr style="border-top:1px solid rgba(255,255,255,.06)">
       <td style="padding:3px 6px">${r.date}</td>
       <td style="text-align:right;padding:3px 6px">$${r.close.toFixed(2)}</td>
       <td style="text-align:right;padding:3px 6px;color:#4ade80">+${(r.ret * 100).toFixed(2)}%</td>
       <td style="text-align:right;padding:3px 6px;color:#f87171">${r.fg}</td>
       <td style="text-align:right;padding:3px 6px;color:${r.vsMa != null && r.vsMa > 0 ? "#4ade80" : "#f87171"}">
         ${r.vsMa != null ? (r.vsMa > 0 ? "↑" : "↓") + Math.abs(r.vsMa).toFixed(1) + "%" : "—"}
       </td>
     </tr>`
  ).join("");

  section.style.display = rows.length ? "block" : "none";
}

export async function init() {
  if (ckInited) { renderCKTab(); renderBounceSection(); return; }
  const statusEl = document.getElementById("ck-status");
  statusEl.textContent = "載入中…";
  try {
    await loadCKData();
    ckInited = true;
    renderCKTab();
    renderBounceSection();
  } catch (e) {
    statusEl.textContent = `載入失敗：${e.message}`;
  }
}

export function onThemeChange(_light) {
  // Cashking is HTML-only; theme change handled by CSS variables.
  if (ckInited) renderCKTab();
}

export function resize() { /* no chart */ }

document.getElementById("ck-asset-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ck-asset]");
  if (!t) return;
  ckAssetMode = t.dataset.ckAsset;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  if (ckInited) renderCKTab();
});

document.getElementById("ck-filter-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ck-filter]");
  if (!t) return;
  ckFilter = t.dataset.ckFilter;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  if (ckInited) renderCKTab();
});

document.getElementById("ck-mode-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ck-mode]");
  if (!t) return;
  ckMode = t.dataset.ckMode;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  if (ckInited) renderCKTab();
});

document.getElementById("ck-window-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ck-window]");
  if (!t) return;
  ckWindow = +t.dataset.ckWindow;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  if (ckInited) renderCKTab();
});
