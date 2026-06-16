import { SERIES, loaded, active } from './state.js';
import { isLight } from './utils/theme.js';
import { isDataFresh, loadSeries, ensureLoaded } from './utils/data.js';
import { registerAll, switchTo, applyThemeAll, setupResizeHandler } from './switcher.js';

import * as trendTab     from './tabs/trend.js';
import * as pentagramTab from './tabs/pentagram.js';
import * as macroTab     from './tabs/macro.js';
import * as corrTab      from './tabs/corr.js';
import * as sectorTab    from './tabs/sector.js';
import * as cashkingTab  from './tabs/cashking.js';
import * as sentimentTab from './tabs/sentiment.js';
import * as breadthTab   from './tabs/breadth.js';
import * as earningsTab  from './tabs/earnings.js';
import * as valuationTab from './tabs/valuation.js';
import * as leverageTab  from './tabs/leverage.js';

registerAll([
  { id: 'trend',     module: trendTab     },
  { id: 'pentagram', module: pentagramTab },
  { id: 'macro',     module: macroTab     },
  { id: 'corr',      module: corrTab      },
  { id: 'sector',    module: sectorTab    },
  { id: 'cashking',  module: cashkingTab  },
  { id: 'sentiment', module: sentimentTab },
  { id: 'breadth',   module: breadthTab   },
  { id: 'earnings',  module: earningsTab  },
  { id: 'valuation', module: valuationTab },
  { id: 'leverage',  module: leverageTab  },
]);

setupResizeHandler();

function applyTheme(light) {
  document.body.classList.toggle("light", light);
  document.getElementById("theme-btn").textContent = light ? "☾" : "☀";
  localStorage.setItem("theme", light ? "light" : "dark");
  applyThemeAll(light);
}

document.getElementById("theme-btn").addEventListener("click", () => applyTheme(!isLight()));

document.querySelectorAll(".tab-btn").forEach(btn =>
  btn.addEventListener("click", () => switchTo(btn.dataset.tab)));

(async () => {
  const status = document.getElementById("status");
  if (localStorage.getItem("theme") === "dark") applyTheme(false);
  try {
    await Promise.all(SERIES.filter(s => active.has(s.key)).map(loadSeries));
    trendTab.renderSeriesPicker();
    trendTab.render();
    pentagramTab.renderPentaTickerPicker();
    const lastDates = Object.values(loaded).map(d => d[d.length - 1]?.[0]).filter(Boolean);
    const latestDate = lastDates.sort().at(-1);
    const allFresh = Object.values(loaded).every(isDataFresh);
    status.textContent = `已載入 ${Object.keys(loaded).length} 個指標 · 最新資料 ${latestDate}${allFresh ? "" : " ⚠ 部分資料可能過期"} · 點選 chip 切換顯示`;

    // Pre-load VIX for signal panel, macro data in background
    ensureLoaded("VIX").then(() => trendTab.renderSignalPanel()).catch(() => {});
    macroTab.loadMacroData().catch(() => {});
    trendTab.renderSignalPanel();
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
})();

document.getElementById("penta-fpe-toggle")?.addEventListener("click", () => pentagramTab.toggleFpe());
document.getElementById("trend-fpe-toggle")?.addEventListener("click", () => trendTab.toggleTrendFpe());

document.querySelectorAll("#val-range-picker .chip").forEach(chip =>
  chip.addEventListener("click", () => {
    document.querySelectorAll("#val-range-picker .chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    valuationTab.setRange(chip.dataset.valRange);
  })
);

document.querySelectorAll(".info-panel-header").forEach(h => {
  h.addEventListener("click", () => {
    h.classList.toggle("open");
    h.nextElementSibling.classList.toggle("open");
  });
});
