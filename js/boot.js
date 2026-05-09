    import {
      SERIES, PENTA_TICKERS, CUSTOM_COLORS,
      CK_ASSETS, CK_ASSETS_3, SECTOR_ETFS, SECTOR_LABEL,
      loaded, loadedHLC, loadedVol, customSeries,
      active, maActive, macroLoaded, sectorLoaded,
      state,
    } from './state.js';
    import { isLight, tc, mob } from './utils/theme.js';
    import {
      tsToLocalDate, presetStart, currentWindow, filterRange,
      dateAddDays, closestOnOrAfter, minBetween, lookupLE,
      toWeekly, toWeeklyHLC,
    } from './utils/dates.js';
    import {
      computeMA, toArithReturns, pearsonCorr, computeM2YoY,
      computeRSI, computeKD, computeTDSetup, computeDDZones,
      computeLinearRegression, computeChannelBands, computeBounceSignals,
    } from './utils/math.js';
    import { isDataFresh, loadSeries, ensureLoaded, loadEarnings } from './utils/data.js';
    import * as breadthTab from './tabs/breadth.js';
    import * as earningsTab from './tabs/earnings.js';
    import * as corrTab from './tabs/corr.js';
    import * as sectorTab from './tabs/sector.js';
    import * as cashkingTab from './tabs/cashking.js';
    import * as macroTab from './tabs/macro.js';
    import * as sentimentTab from './tabs/sentiment.js';
    import * as pentagramTab from './tabs/pentagram.js';
    import * as trendTab from './tabs/trend.js';


    // ── Resize handler ─────────────────────────────────────────────
    function setupResizeHandler() {
      if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
      window._resizeHandler = () => {
        trendTab.resize();
        pentagramTab.resize();
        macroTab.resize();
        corrTab.resize();
        sectorTab.resize();
        sentimentTab.resize();
        breadthTab.resize();
      };
      window.addEventListener("resize", window._resizeHandler);
    }
    setupResizeHandler();

    // ── Theme ──────────────────────────────────────────────────────
    function applyTheme(light) {
      document.body.classList.toggle("light", light);
      document.getElementById("theme-btn").textContent = light ? "☾" : "☀";
      localStorage.setItem("theme", light ? "light" : "dark");

      trendTab.onThemeChange(light);
      pentagramTab.onThemeChange(light);
      macroTab.onThemeChange(light);
      corrTab.onThemeChange(light);
      sectorTab.onThemeChange(light);
      cashkingTab.onThemeChange(light);
      sentimentTab.onThemeChange(light);
      breadthTab.onThemeChange(light);
    }

    document.getElementById("theme-btn").addEventListener("click", () => applyTheme(!isLight()));

    // ── Tab switching ──────────────────────────────────────────────
    function switchTab(tabName) {
      document.querySelectorAll(".tab-section").forEach(s => { s.hidden = true; });
      document.getElementById("tab-" + tabName).hidden = false;
      document.querySelectorAll(".tab-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === tabName));

      if (tabName === "trend") {
        trendTab.activate();
      } else if (tabName === "pentagram") {
        pentagramTab.activate();
      } else if (tabName === "macro") {
        macroTab.activate();
      } else if (tabName === "corr") {
        corrTab.activate();
      } else if (tabName === "sector") {
        sectorTab.activate();
      } else if (tabName === "cashking") {
        cashkingTab.init();
      } else if (tabName === "sentiment") {
        sentimentTab.init();
      } else if (tabName === "breadth") {
        breadthTab.init();
      } else if (tabName === "earnings") {
        earningsTab.init();
      }
    }

    document.querySelectorAll(".tab-btn").forEach(btn =>
      btn.addEventListener("click", () => switchTab(btn.dataset.tab)));


    // ── Correlation matrix ─────────────────────────────────────────
    // ── Init ───────────────────────────────────────────────────────
    (async () => {
      const status = document.getElementById("status");
      // default = light; override only if user explicitly saved dark
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
    document.querySelectorAll(".info-panel-header").forEach(h => {
      h.addEventListener("click", () => {
        h.classList.toggle("open");
        h.nextElementSibling.classList.toggle("open");
      });
    });
