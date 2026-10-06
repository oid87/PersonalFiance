import { state } from '../state.js';
import { requestJSON, clearRequestCache } from '../utils/data.js';

let earnCalYear  = new Date().getFullYear();
let earnCalMonth = new Date().getMonth(); // 0-based

function validEvent(event) {
  const date = event?.date;
  const time = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(date + 'T')
    && typeof event.ticker === 'string' && event.ticker.length > 0
    && ['earnings', 'conference'].includes(event.type);
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export async function renderEarningsCalendar(context = {}) {
  const el = document.getElementById("earnings-cal");
  if (!el) return;
  if (!state.loadedEarnings.length) {
    el.innerHTML = '<p style="color:var(--muted);padding:16px">載入中…</p>';
    const payload = await requestJSON('data/earnings.json', { signal: context.signal });
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    if (!Array.isArray(payload?.data) || !payload.data.length || !payload.data.every(validEvent)) {
      clearRequestCache('data/earnings.json');
      throw new Error('earnings.json: missing or invalid event rows');
    }
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    state.loadedEarnings = payload.data;
  }

  // check_reuse: keep — new Date() 取今天的日期字串,共用層無對應 helper
  const today = new Date().toISOString().slice(0, 10);
  // Build date → { earn: [], conf: [] } lookup
  const byDate = {};
  for (const e of state.loadedEarnings) {
    if (!byDate[e.date]) byDate[e.date] = { earn: [], conf: [] };
    const display = escapeHTML(e.ticker.replace(".TW", ""));
    if (e.type === "conference") byDate[e.date].conf.push(display);
    else                         byDate[e.date].earn.push(display);
  }

  const DOWS = ['日','一','二','三','四','五','六'];
  // Show earnCalMonth - 1, earnCalMonth, earnCalMonth + 1 (3 months)
  let html = '<div class="earn-months">';
  for (let offset = -1; offset <= 1; offset++) {
    let y = earnCalYear, m = earnCalMonth + offset;
    if (m < 0)  { m += 12; y--; }
    if (m > 11) { m -= 12; y++; }
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const firstDow = new Date(y, m, 1).getDay();
    const monthLabel = `${y}年${m + 1}月`;
    html += `<div class="earn-month"><h3>${monthLabel}</h3><div class="earn-grid">`;
    for (const d of DOWS) html += `<div class="earn-dow">${d}</div>`;
    for (let i = 0; i < firstDow; i++) html += '<div class="earn-day empty"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const cell = byDate[ds];
      const hasEvent = cell && (cell.earn.length || cell.conf.length);
      const isToday = ds === today;
      let cls = 'earn-day';
      if (isToday)  cls += ' today';
      if (hasEvent) cls += ' has-earn';
      html += `<div class="${cls}"><div class="earn-day-num">${day}</div>`;
      if (hasEvent) {
        html += '<div class="earn-tickers">';
        for (const t of cell.earn) html += `<span class="earn-tick">${t}</span>`;
        for (const t of cell.conf) html += `<span class="earn-tick conf">${t}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
  const labelEl = document.getElementById("earn-month-label");
  if (labelEl) labelEl.textContent = `${earnCalYear}年${earnCalMonth + 1}月`;
}

export async function init(context = {}) {
  try { await renderEarningsCalendar(context); }
  catch (err) {
    document.getElementById('earnings-cal').textContent = `載入失敗：${err.message}`;
    throw err;
  }
}

// Wire the prev/next month buttons once at module load.
document.getElementById("earn-prev")?.addEventListener("click", () => {
  earnCalMonth--;
  if (earnCalMonth < 0) { earnCalMonth = 11; earnCalYear--; }
  void renderEarningsCalendar().catch(err => { document.getElementById("earnings-cal").textContent = `載入失敗：${err.message}`; });
});
document.getElementById("earn-next")?.addEventListener("click", () => {
  earnCalMonth++;
  if (earnCalMonth > 11) { earnCalMonth = 0; earnCalYear++; }
  void renderEarningsCalendar().catch(err => { document.getElementById("earnings-cal").textContent = `載入失敗：${err.message}`; });
});
