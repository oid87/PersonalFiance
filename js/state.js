// ── Frozen constants ────────────────────────────────────────────
export const SERIES = Object.freeze([
  { key: "VOO",   file: "data/VOO.json",        color: "#58a6ff", yAxis: 0, default: true  },
  { key: "QQQ",   file: "data/QQQ.json",         color: "#f778ba", yAxis: 0, default: true  },
  { key: "SPY",   file: "data/SPY.json",          color: "#a371f7", yAxis: 0, default: false },
  { key: "0050",  file: "data/0050.TW.json",      color: "#3fb950", yAxis: 3, default: false },
  { key: "GLD",   file: "data/GLD.json",          color: "#d4a843", yAxis: 0, default: false },
  { key: "BTC",   file: "data/BTC.json",          color: "#f7931a", yAxis: 4, default: false },
  { key: "SOXX",  file: "data/SOXX.json",         color: "#22d3ee", yAxis: 0, default: false },
  { key: "MAGS",  file: "data/MAGS.json",         color: "#ff6b6b", yAxis: 0, default: false },
  { key: "VIX",   file: "data/VIX.json",          color: "#f0883e", yAxis: 1, default: false },
  { key: "F&G",   file: "data/fear_greed.json",   color: "#e3b341", yAxis: 2, default: true  },
]);

export const PENTA_TICKERS = Object.freeze(["VOO", "QQQ", "SPY", "0050", "GLD", "BTC", "SOXX", "MAGS"]);

export const CUSTOM_COLORS = Object.freeze(["#e879f9","#34d399","#fb923c","#60a5fa","#a3e635","#f472b6","#38bdf8","#fbbf24","#c084fc","#2dd4bf"]);

export const CK_ASSETS = Object.freeze([
  { key: "GLD", color: "#d4a843", file: "data/GLD.json", isGold: true },
  { key: "BTC", color: "#f7931a", file: "data/BTC.json" },
  { key: "TLT", color: "#58d9f9", file: "data/TLT.json" },
  { key: "QQQ", color: "#f778ba", file: "data/QQQ.json" },
]);

export const CK_ASSETS_3 = Object.freeze([
  { key: "GCF", label: "黃金", color: "#d4a843", file: "data/GCF.json", isGold: true },
  { key: "TLT", color: "#58d9f9", file: "data/TLT.json" },
  { key: "QQQ", color: "#f778ba", file: "data/QQQ.json" },
]);

export const CORR_EXTRA = Object.freeze([
  { key: "TLT",   file: "data/TLT.json"   },
  { key: "DXY",   file: "data/DXY.json"   },
  { key: "US10Y", file: "data/US10Y.json" },
]);

export const SECTOR_ETFS = Object.freeze(["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLU","XLRE","XLB","XLC"]);

export const SECTOR_LABEL = Object.freeze({
  XLK:"科技", XLF:"金融", XLV:"醫療", XLE:"能源", XLI:"工業",
  XLY:"非必需消費", XLP:"必需消費", XLU:"公用", XLRE:"不動產", XLB:"材料", XLC:"通訊",
});

// ── Mutable containers (mutated in place, never reassigned) ─────
export const loaded = {};
export const loadedHLC = {};
export const loadedVol = {};
export const customSeries = [];
export const active = new Set(SERIES.filter(s => s.default).map(s => s.key));
export const maActive = new Set();
export const macroLoaded = {};
export const sectorLoaded = {};

// ── Reassigned scalars (cross-cutting, mutated via state.X = ...) ─
export const state = {
  rangePreset: "5Y",
  customFrom: "",
  customTo: "",
  sigMaps: null,
  loadedEarnings: [],
};
