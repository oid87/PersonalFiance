import { loaded, loadedHLC, loadedVol, SERIES, state } from '../state.js';

// ── fetchJSON ────────────────────────────────────────────────────────────
// Generic fetch, not tied to the SERIES registry (unlike loadSeries below).
// Does NOT do field alignment (r.close ?? r.value etc.) — that stays the
// job of loadSeries; fetchJSON only returns the raw parsed JSON's payload.
//
// Majority convention across ~46 self-written `await fetch(...)` sites in
// js/tabs/*.js (grep 2026-07): most unwrap `j.data` (or `j?.data ?? []`),
// e.g. js/tabs/wkrev.js:319-320, struct.js:31-32, sector.js:229-230,
// qqqmacd.js:337-338, net_liquidity.js:23, money_market.js:21. A minority
// use a different top-level key (umich.js: `j.umich`) or keep the raw
// payload (relstrength.js: `payload = j`) or a nested non-`data` key
// (putcall.js: `j.total`/`j.equity` etc.) — those sites are NOT retrofitted
// to fetchJSON in P0 and are documented here as divergent, not silently
// unified.
export async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetchJSON: HTTP ${res.status} (${url})`);
  const j = await res.json();
  return j.data || j;
}

export function isDataFresh(data) {
  if (!data || data.length === 0) return false;
  const lastDate = data[data.length - 1][0];
  // stale if last entry is more than 4 calendar days ago (covers weekends + Monday)
  return (Date.now() - new Date(lastDate + "T00:00:00Z")) / 86400000 <= 4;
}

export async function loadSeries(s) {
  if (loaded[s.key] && isDataFresh(loaded[s.key])) return; // cache hit, still fresh
  delete loaded[s.key]; // evict stale cache before re-fetch
  const resp = await fetch(s.file, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${s.key}: HTTP ${resp.status}`);
  const j = await resp.json();
  loaded[s.key] = (j.data || []).map(r => [
    r.date,
    r.close !== undefined ? r.close : r.value,
  ]);
  if (j.data?.[0]?.high !== undefined) {
    loadedHLC[s.key] = j.data.map(r => [r.date, r.high, r.low, r.close]);
  }
  if (j.data?.[0]?.volume !== undefined) {
    loadedVol[s.key] = j.data.map(r => [r.date, r.volume ?? 0]);
  }
  state.sigMaps = null; // invalidate signal lookup cache
}

export async function ensureLoaded(key) {
  const s = SERIES.find(x => x.key === key);
  if (s) await loadSeries(s);
}

export async function loadEarnings() {
  try {
    const r = await fetch("data/earnings.json", { cache: "no-cache" });
    if (!r.ok) return;
    const j = await r.json();
    state.loadedEarnings = j.data || [];
  } catch { state.loadedEarnings = []; }
}
