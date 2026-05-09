import { state } from '../state.js';
import { loadEarnings } from '../utils/data.js';

let earnCalYear  = new Date().getFullYear();
let earnCalMonth = new Date().getMonth(); // 0-based

export async function renderEarningsCalendar() {
  const el = document.getElementById("earnings-cal");
  if (!el) return;
  if (!state.loadedEarnings.length) {
    el.innerHTML = '<p style="color:var(--muted);padding:16px">載入中…</p>';
    await loadEarnings();
  }

  const today = new Date().toISOString().slice(0, 10);
  // Build date → { earn: [], conf: [] } lookup
  const byDate = {};
  for (const e of state.loadedEarnings) {
    if (!byDate[e.date]) byDate[e.date] = { earn: [], conf: [] };
    const display = e.ticker.replace(".TW", "");
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

export function init() {
  renderEarningsCalendar();
}

// Wire the prev/next month buttons once at module load.
document.getElementById("earn-prev")?.addEventListener("click", () => {
  earnCalMonth--;
  if (earnCalMonth < 0) { earnCalMonth = 11; earnCalYear--; }
  renderEarningsCalendar();
});
document.getElementById("earn-next")?.addEventListener("click", () => {
  earnCalMonth++;
  if (earnCalMonth > 11) { earnCalMonth = 0; earnCalYear++; }
  renderEarningsCalendar();
});
