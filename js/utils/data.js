import { loaded, loadedHLC, loadedVol, SERIES, state } from '../state.js';

const REQUEST_TIMEOUT_MS = 15_000;

async function requestJSON(url, label = url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (err) {
      throw new Error(`${label}: invalid JSON`, { cause: err });
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label}: request timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause: err });
    }
    if (err?.message?.startsWith(`${label}:`)) throw err;
    throw new Error(`${label}: ${err?.message || err}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseSeriesRows(s, payload) {
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error(`${s.key}: missing or empty data rows`);
  }

  const rows = payload.data.map((row, index) => {
    const value = row?.close !== undefined ? row.close : row?.value;
    if (!isValidDate(row?.date) || typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${s.key}: invalid row ${index + 1}`);
    }
    return [row.date, value];
  });

  let hlc;
  if (payload.data[0]?.high !== undefined) {
    hlc = payload.data.map((row, index) => {
      if (![row.high, row.low, row.close].every(v => typeof v === "number" && Number.isFinite(v))) {
        throw new Error(`${s.key}: invalid HLC row ${index + 1}`);
      }
      return [row.date, row.high, row.low, row.close];
    });
  }

  let volume;
  if (payload.data[0]?.volume !== undefined) {
    volume = payload.data.map((row, index) => {
      if (typeof row.volume !== "number" || !Number.isFinite(row.volume)) {
        throw new Error(`${s.key}: invalid volume row ${index + 1}`);
      }
      return [row.date, row.volume];
    });
  }
  return { rows, hlc, volume };
}

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
  const j = await requestJSON(url, `fetchJSON (${url})`);
  return j.data || j;
}

export function isDataFresh(data) {
  if (!data || data.length === 0) return false;
  const lastDate = data[data.length - 1][0];
  // stale if last entry is more than 4 calendar days ago (covers weekends + Monday)
  return (Date.now() - new Date(lastDate + "T00:00:00Z")) / 86400000 <= 4;
}

export async function loadSeries(s) {
  if (!s?.key || !s?.file) throw new Error("loadSeries: invalid series descriptor");
  if (loaded[s.key] && isDataFresh(loaded[s.key])) return; // cache hit, still fresh
  const payload = await requestJSON(s.file, s.key);
  const next = parseSeriesRows(s, payload);
  loaded[s.key] = next.rows;
  if (next.hlc) loadedHLC[s.key] = next.hlc;
  else delete loadedHLC[s.key];
  if (next.volume) loadedVol[s.key] = next.volume;
  else delete loadedVol[s.key];
  state.sigMaps = null; // invalidate signal lookup cache
}

export async function ensureLoaded(key) {
  const s = SERIES.find(x => x.key === key);
  if (!s) throw new Error(`Unknown series: ${key}`);
  await loadSeries(s);
}

export async function loadEarnings() {
  try {
    const j = await requestJSON("data/earnings.json", "earnings");
    if (!Array.isArray(j?.data)) throw new Error("earnings: missing event rows");
    state.loadedEarnings = j.data;
  } catch { /* Keep the last successful calendar when refresh fails. */ }
}

// {date, <field>} rows -> [[date, value], ...], skipping rows where the field is null/undefined.
export function toPoints(rows, field) {
  return (rows ?? [])
    .filter(r => r[field] != null)
    .map(r => [r.date, r[field]]);
}

// Last [date, value] point of toPoints(rows, field), or null when there is none.
export function latestOf(rows, field) {
  const pts = toPoints(rows, field);
  return pts.length ? pts[pts.length - 1] : null;
}
