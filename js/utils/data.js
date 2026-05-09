import { loaded, loadedHLC, loadedVol, SERIES, state } from '../state.js';

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
