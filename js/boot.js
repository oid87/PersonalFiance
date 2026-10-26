import { loaded, active } from './state.js';
import { isLight } from './utils/theme.js';
import { isDataFresh, ensureLoaded } from './utils/data.js';
import { chipPicker } from './utils/dom.js';
import { initSharedUI } from './utils/ui.js';
import { initChartFocus } from './utils/chartFocus.js';
import { installZoomFloor } from './utils/zoomFloor.js';
import { registerAll, switchTo, applyThemeAll, setupResizeHandler } from './switcher.js';
import { registryEntries } from './navigation-catalog.mjs';
import { initNavigation } from './navigation.js';

installZoomFloor();   // 全站 dataZoom 最短 1 年；要在任何 tab 呼叫 echarts.init 之前
const entries = registryEntries();
const entriesById = new Map(entries.map(entry => [entry.id, entry]));

function decorateLoad(entry, prepare) {
  const load = entry.load;
  entry.load = async () => prepare(await load());
  entry.load.needsReload = load.needsReload;
}

decorateLoad(entriesById.get('pentagram'), module => {
  module.renderPentaTickerPicker();
  return module;
});

decorateLoad(entriesById.get('trend'), module => ({
  ...module,
  async activate(context) {
    await module.activate(context);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    const status = document.getElementById('status');
    const lastDates = Object.values(loaded).map(rows => rows[rows.length - 1]?.[0]).filter(Boolean);
    const latestDate = lastDates.sort().at(-1);
    const allFresh = Object.values(loaded).every(isDataFresh);
    status.textContent = '已載入 ' + Object.keys(loaded).length + ' 個指標 · 最新資料 ' +
      latestDate + (allFresh ? '' : ' ⚠ 部分資料可能過期') + ' · 點選 chip 切換顯示';
    module.renderSignalPanel();
    ensureLoaded('VIX').then(() => module.renderSignalPanel()).catch(() => {});
  },
}));

registerAll(entries);
setupResizeHandler();
initSharedUI();
initChartFocus();

function applyTheme(light) {
  if (light === isLight()) return;
  document.body.classList.toggle('light', light);
  document.getElementById('theme-btn').textContent = light ? '☾' : '☀';
  void applyThemeAll(light);
}

// 主題跟隨系統深淺色；手動切換優先，但只到系統深淺色下次改變為止
// （localStorage 記下手動選擇當時的系統深淺色，不同就回到跟隨系統）。
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
const systemTheme = () => (systemDark?.matches ? 'dark' : 'light');

function followSystem() {
  try { localStorage.removeItem('theme'); localStorage.removeItem('themeSystem'); } catch {}
  applyTheme(systemTheme() === 'light');
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const light = !isLight();
  applyTheme(light);
  try {
    localStorage.setItem('theme', light ? 'light' : 'dark');
    localStorage.setItem('themeSystem', systemTheme());
  } catch {}
});
systemDark?.addEventListener('change', followSystem);
try {
  const savedTheme = localStorage.getItem('theme');
  if (localStorage.getItem('themeSystem') === systemTheme() && (savedTheme === 'light' || savedTheme === 'dark')) {
    applyTheme(savedTheme === 'light');
  } else followSystem();
} catch { applyTheme(systemTheme() === 'light'); }

initNavigation({
  switchTo,
  needsReload: id => entriesById.get(id)?.load.needsReload?.() || false,
});

document.getElementById('penta-fpe-toggle')?.addEventListener('click', () => {
  void entriesById.get('pentagram')?.loadedModule?.toggleFpe();
});
document.getElementById('trend-fpe-toggle')?.addEventListener('click', () => {
  void entriesById.get('trend')?.loadedModule?.toggleTrendFpe();
});
chipPicker(document.getElementById('val-range-picker'), 'val-range', value => {
  entriesById.get('valuation')?.loadedModule?.setRange(value);
});

document.querySelectorAll('.info-panel-header').forEach(header => {
  header.addEventListener('click', () => {
    header.classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
  });
});
