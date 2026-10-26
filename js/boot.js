import { loaded, active } from './state.js';
import { isLight, isDim } from './utils/theme.js';
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

// 主題四選一：白（預設）／米白／灰／黑。存在 cookie「theme」（一年），不跟系統深淺色。
// 白與米白都是 body.light（圖表配色相同，只換背景變數）；灰＝body.dim（深色配色，格線等幾色調亮）。
// 圖表配色組（淺／灰／黑）有變才重建圖表，白↔米白不用。
const THEMES = ['white', 'beige', 'dim', 'dark'];
const readTheme = () => document.cookie.match(/(?:^|;\s*)theme=(white|beige|dim|dark)(?:;|$)/)?.[1] || 'white';
const chartGroup = () => (isLight() ? 'light' : isDim() ? 'dim' : 'dark');
function applyTheme(choice) {
  const light = choice === 'white' || choice === 'beige', before = chartGroup();
  document.body.classList.toggle('light', light);
  document.body.classList.toggle('beige', choice === 'beige');
  document.body.classList.toggle('dim', choice === 'dim');
  for (const b of document.querySelectorAll('#theme-picker [data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  if (chartGroup() !== before) void applyThemeAll(light);
}
document.getElementById('theme-picker').addEventListener('click', e => {
  const choice = e.target.closest?.('[data-theme-choice]')?.dataset.themeChoice;
  if (!THEMES.includes(choice)) return;
  document.cookie = `theme=${choice}; max-age=31536000; path=/; SameSite=Lax`;
  applyTheme(choice);
});
try { localStorage.removeItem('theme'); localStorage.removeItem('themeSystem'); } catch {}   // 舊版（跟隨系統＋localStorage）留下的設定
applyTheme(readTheme());

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
