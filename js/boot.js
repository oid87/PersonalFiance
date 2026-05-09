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

    const chartEl = document.getElementById("chart");
    let chart = echarts.init(chartEl, null); // light by default
    chart.on("updateAxisPointer", evt => {
      try {
        const ts = evt?.axesInfo?.[0]?.value;
        if (typeof ts !== "number") return;
        renderSignalPanel(tsToLocalDate(ts));
      } catch (_) {}
    });
    chart.on("globalout", () => { if (state.sigMaps) renderSignalPanel(); });
    let fearActive    = false;
    let fearThreshold = 20;

    let earningsActive  = false;
    let ddZoneActive    = false;
    let sigZoneActive   = false;
    // ── 情緒 tab state ─────────────────────────────────────────────
    // ── 市場廣度 state ─────────────────────────────────────────────
    // ── 現金王 state ───────────────────────────────────────────────
    const dateFrom = document.getElementById("date-from");
    const dateTo   = document.getElementById("date-to");

    // ── Resize handler ─────────────────────────────────────────────
    function setupResizeHandler() {
      if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
      window._resizeHandler = () => {
        chart.resize();
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

      chart.dispose();
      chart = echarts.init(chartEl, light ? null : "dark");
      setupResizeHandler();
      render();

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
        setTimeout(() => chart.resize(), 50);
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

    async function loadCustomTicker(rawSymbol) {
      const key = rawSymbol.trim().toUpperCase();
      if (!key) return;
      if (SERIES.find(s => s.key === key) || customSeries.find(s => s.key === key)) {
        // already known — just activate it
        active.add(key);
        renderSeriesPicker();
        render();
        return;
      }

      const status = document.getElementById("status");
      status.textContent = `載入 ${key} 中…`;

      try {
        let j;
        // Try pre-fetched static file first (covers all tickers already in data/)
        const staticResp = await fetch(`data/${key}.json`, { cache: "no-cache" });
        if (staticResp.ok) {
          j = await staticResp.json();
        } else {
          // Fallback: Vercel serverless function → Yahoo Finance live
          const apiResp = await fetch(`/api/stock?ticker=${encodeURIComponent(key)}`);
          if (!apiResp.ok) {
            const e = await apiResp.json().catch(() => ({}));
            throw new Error(e.error || `HTTP ${apiResp.status}`);
          }
          j = await apiResp.json();
        }

        const rows = (j.data || []).filter(r => r.close != null);
        if (!rows.length) throw new Error("無資料");

        loaded[key]    = rows.map(r => [r.date, r.close]);
        loadedHLC[key] = rows.map(r => [r.date, r.high, r.low, r.close]);
        loadedVol[key] = rows.map(r => [r.date, r.volume ?? 0]);
        state.sigMaps = null;

        const color = CUSTOM_COLORS[customSeries.length % CUSTOM_COLORS.length];
        customSeries.push({ key, file: null, color, yAxis: 0, custom: true });
        active.add(key);

        renderSeriesPicker();
        render();
        const latest = rows[rows.length - 1].date;
        status.textContent = `已載入 ${key}（${rows.length} 筆，至 ${latest}）`;
      } catch (err) {
        status.textContent = `⚠ 無法載入 ${key}：${err.message}`;
        setTimeout(() => { status.textContent = ""; }, 5000);
      }
    }

    // ── Fear helpers ───────────────────────────────────────────────
    function fearZones(threshold) {
      const fg = loaded["F&G"];
      if (!fg) return [];
      const out = [];
      let s = null, last = null;
      for (const [d, v] of fg) {
        if (v <= threshold) { if (!s) s = d; last = d; }
        else if (s)         { out.push([s, last]); s = null; }
      }
      if (s) out.push([s, last]);
      return out;
    }

    function fearEpisodes(threshold) {
      const fg = loaded["F&G"];
      if (!fg) return [];
      const out = [];
      let s = null, fgMin = 100, last = null;
      for (const [d, v] of fg) {
        if (v <= threshold) {
          if (!s) { s = d; fgMin = 100; }
          if (v < fgMin) fgMin = v;
          last = d;
        } else if (s) {
          out.push({ start: s, end: last, fgMin,
            days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
          s = null;
        }
      }
      if (s) out.push({ start: s, end: last, fgMin,
        days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
      return out;
    }

    // ── Fear panel ─────────────────────────────────────────────────
    function updateChartHeight() {
      const h = (fearActive && loaded["F&G"]) ? 212 : 0;
      document.documentElement.style.setProperty("--fear-h", h + "px");
      setTimeout(() => chart.resize(), 220);
    }

    function renderFearPanel() {
      const panel = document.getElementById("fear-panel");
      if (!fearActive || !loaded["F&G"]) {
        panel.style.display = "none";
        updateChartHeight();
        return;
      }
      panel.style.display = "block";
      document.getElementById("fear-thresh-label").textContent = fearThreshold;
      updateChartHeight();

      const pk = loaded["SPY"] ? "SPY" : (loaded["VOO"] ? "VOO" : null);
      const eps = fearEpisodes(fearThreshold).reverse();

      document.getElementById("fear-ep-count").textContent = `${eps.length} 個事件`;
      document.getElementById("fear-price-note").textContent =
        pk ? `以 ${pk} 計算` : "（請啟用 SPY 或 VOO 顯示價格）";

      document.getElementById("fp-head").innerHTML = `<tr>
        <th>#</th><th>期間</th><th>天數</th><th>F&G低</th>
        ${pk ? `<th>${pk}最低</th><th>最低日</th><th>3M後</th><th>6M後</th><th>漲幅3M</th><th>漲幅6M</th>` : ""}
      </tr>`;

      if (!pk) {
        document.getElementById("fp-body").innerHTML =
          `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:10px">啟用 SPY 或 VOO 以顯示價格欄位</td></tr>`;
        return;
      }

      const f  = v => v != null ? "$" + v.toFixed(2) : "—";
      const fp = (base, v) => {
        if (base == null || v == null) return `<td style="color:var(--muted)">—</td>`;
        const pct = (v / base - 1) * 100;
        return `<td class="${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</td>`;
      };

      document.getElementById("fp-body").innerHTML = eps.map((ep, i) => {
        const minP = minBetween(pk, ep.start, ep.end);
        const p3m  = closestOnOrAfter(pk, dateAddDays(ep.end, 90));
        const p6m  = closestOnOrAfter(pk, dateAddDays(ep.end, 180));
        return `<tr>
          <td style="color:var(--muted)">${eps.length - i}</td>
          <td>${ep.start} ~ ${ep.end}</td>
          <td style="color:var(--muted)">${ep.days}天</td>
          <td class="fear-val">${ep.fgMin}</td>
          <td><b>${f(minP?.price)}</b></td>
          <td style="color:var(--muted);font-size:11px">${minP?.date ?? "—"}</td>
          <td>${f(p3m)}</td>
          <td>${f(p6m)}</td>
          ${fp(minP?.price, p3m)}
          ${fp(minP?.price, p6m)}
        </tr>`;
      }).join("");
    }

    // ── Chart render ───────────────────────────────────────────────
    function render() {
      const series = [];
      const axisClr  = tc("#8b949e", "#57606a");
      const gridClr  = tc("#21262d", "#e1e4e8");
      const tipBg    = tc("#161b22", "#ffffff");
      const tipBdr   = tc("#30363d", "#d0d7de");
      const tipText  = tc("#e6edf3", "#1f2328");

      const isMob = mob();
      const yAxisDef = [
        { id: "price", name: "USD Price", position: "left",
          axisLine: { lineStyle: { color: axisClr } },
          splitLine: { lineStyle: { color: gridClr } } },
        { id: "vix",  name: "VIX",  position: "right",
          axisLine: { lineStyle: { color: "#f0883e" } }, splitLine: { show: false } },
        { id: "fg",   name: "F&G",  position: "right", offset: isMob ? 35 : 55, min: 0, max: 100,
          axisLine: { lineStyle: { color: "#e3b341" } }, splitLine: { show: false } },
        { id: "tw",   name: "TWD",  position: "left",  offset: isMob ? 45 : 70,
          axisLine: { lineStyle: { color: "#3fb950" } }, splitLine: { show: false } },
        { id: "btc",  name: "BTC",  position: "right", offset: isMob ? 65 : 110,
          axisLine: { lineStyle: { color: "#f7931a" } }, splitLine: { show: false } },
      ];

      for (const s of [...SERIES, ...customSeries]) {
        if (!active.has(s.key) || !loaded[s.key]) continue;
        series.push({
          name: s.key,
          type: "line",
          data: filterRange(loaded[s.key]),
          yAxisIndex: s.yAxis,
          showSymbol: false,
          lineStyle: { width: 1.5, color: s.color },
          itemStyle: { color: s.color },
          emphasis: { focus: "series" },
        });
      }

      if (maActive.size > 0) {
        const MA_SKIP = new Set(["F&G", "VIX"]);
        for (const s of [...SERIES, ...customSeries]) {
          if (!active.has(s.key) || !loaded[s.key] || MA_SKIP.has(s.key)) continue;
          for (const period of [20, 50, 200]) {
            if (!maActive.has(period)) continue;
            const maData   = computeMA(loaded[s.key], period);
            const filtered = filterRange(maData);
            series.push({
              name: `__ma_${s.key}_${period}`,
              type: "line",
              data: filtered,
              yAxisIndex: s.yAxis,
              showSymbol: false,
              lineStyle: { width: 1, color: s.color, type: "dashed", opacity: 0.55 },
              itemStyle:  { color: s.color },
              silent: true,
              tooltip: {
                formatter: () => "",
                show: true,
              },
            });
          }
        }
      }

      if (fearActive && loaded["F&G"]) {
        const DEEP = 15;
        const markAreaData = [
          ...fearZones(fearThreshold).map(([s, e]) => [
            { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.10)" } },
            { xAxis: e },
          ]),
          ...(fearThreshold > DEEP ? fearZones(DEEP) : []).map(([s, e]) => [
            { xAxis: s, itemStyle: { color: "rgba(185,28,28,0.22)" } },
            { xAxis: e },
          ]),
        ];
        series.push({
          name: "__fearZone",
          type: "line",
          data: [],
          yAxisIndex: 0,
          lineStyle: { width: 0 },
          symbol: "none",
          silent: true,
          markArea: { silent: true, data: markAreaData },
        });
      }

      if (sigZoneActive && loaded["QQQ"]) {
        if (!state.sigMaps) buildSigMaps();
        if (state.sigMaps?.scoreArr) {
          const zones = [];
          let zStart = null, prev = null;
          for (const [date, score] of state.sigMaps.scoreArr) {
            if (score >= 4) { if (!zStart) zStart = date; }
            else            { if (zStart) { zones.push([zStart, prev]); zStart = null; } }
            prev = date;
          }
          if (zStart) zones.push([zStart, prev]);
          if (zones.length) {
            series.push({
              name: "__sigZone", type: "line", data: [], yAxisIndex: 0,
              lineStyle: { width: 0 }, symbol: "none", silent: true,
              markArea: { silent: true, data: zones.map(([s, e]) => [
                { xAxis: s, itemStyle: { color: "rgba(63,185,80,0.13)" } },
                { xAxis: e },
              ])},
            });
          }
        }
      }

      if (ddZoneActive && loaded["QQQ"]) {
        const zones = computeDDZones(loaded["QQQ"], 60, 0.10);
        if (zones.length) {
          series.push({
            name: "__ddZone", type: "line", data: [], yAxisIndex: 0,
            lineStyle: { width: 0 }, symbol: "none", silent: true,
            markArea: { silent: true, data: zones.map(([s, e]) => [
              { xAxis: s, itemStyle: { color: "rgba(248,81,73,0.10)" } },
              { xAxis: e },
            ])},
          });
        }
      }

      if (earningsActive && state.loadedEarnings.length > 0) {
        const { from, to } = currentWindow();
        const toDate = to || new Date().toISOString().slice(0, 10);
        const inRange = state.loadedEarnings.filter(e => (!from || e.date >= from) && e.date <= toDate);
        const byDate = {};
        for (const e of inRange) {
          if (!byDate[e.date]) byDate[e.date] = [];
          byDate[e.date].push(e.ticker);
        }
        const mlData = Object.entries(byDate).map(([dt, tickers]) => ({
          xAxis: dt,
          name: tickers.join("/"),
          lineStyle: { color: "#58a6ff", type: "dashed", width: 1, opacity: 0.55 },
          label: { show: true, position: "insideEndTop", fontSize: 9, color: "#58a6ff", formatter: "{b}" },
        }));
        if (mlData.length > 0) {
          series.push({
            name: "__earnings",
            type: "line", data: [], yAxisIndex: 0,
            lineStyle: { width: 0 }, symbol: "none", silent: true,
            markLine: { silent: true, symbol: ["none", "none"], animation: false, data: mlData },
          });
        }
      }

      if (loaded["QQQ"] && loaded["F&G"]) {
        const qqqD   = loaded["QQQ"];
        const ma200B = computeMA(qqqD, 200);
        const { bounceSignals, bounceRetMap } = computeBounceSignals(qqqD, loaded["F&G"], ma200B);
        const filteredBouncePoints = filterRange(bounceSignals);
        if (filteredBouncePoints.length) {
          series.push({
            name: "__bounceSignal",
            type: "scatter",
            data: filteredBouncePoints,
            xAxisIndex: 0,
            yAxisIndex: 0,
            symbol: "triangle",
            symbolSize: 10,
            itemStyle: { color: "#f97316", opacity: 0.85 },
            z: 5,
            legendHoverLink: false,
            tooltip: {
              trigger: "item",
              formatter: p => {
                const info = bounceRetMap.get(p.data[0]);
                return `<b>${p.data[0]}</b><br/>恐慌反彈<br/>QQQ: $${(+p.data[1]).toFixed(2)}<br/>單日: +${((info?.ret ?? 0) * 100).toFixed(2)}%`;
              },
            },
          });
        }
      }

      chart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          backgroundColor: tipBg,
          borderColor: tipBdr,
          textStyle: { color: tipText },
          formatter(params) {
            let out = `<b>${params[0]?.axisValueLabel}</b><br/>`;
            for (const p of params) {
              if (p.seriesName.startsWith("__")) continue;
              out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${
                typeof p.value?.[1] === "number" ? p.value[1].toLocaleString() : "—"
              }</b><br/>`;
            }
            return out;
          },
        },
        legend: {
          data: series.filter(s => !s.name.startsWith("__")).map(s => s.name),
          textStyle: { color: tipText },
          top: 6,
        },
        grid: { left: isMob ? 75 : 115, right: isMob ? 100 : 160, top: 44, bottom: 56 },
        xAxis: {
          type: "time",
          axisLine: { lineStyle: { color: axisClr } },
          splitLine: { show: false },
        },
        yAxis: yAxisDef,
        dataZoom: [
          { type: "inside" },
          { type: "slider", height: 18, bottom: 14 },
        ],
        series,
      }, { notMerge: true });
    }

    // ── Series picker ──────────────────────────────────────────────
    function renderSeriesPicker() {
      const wrap = document.getElementById("series-picker");
      wrap.innerHTML = "";
      for (const s of SERIES) {
        const on = active.has(s.key);
        const el = document.createElement("span");
        el.className = "chip";
        el.textContent = s.key;
        el.style.borderColor = on ? s.color : "";
        el.style.color       = on ? s.color : "";
        el.onclick = async () => {
          if (active.has(s.key)) { active.delete(s.key); }
          else { active.add(s.key); await loadSeries(s); }
          renderSeriesPicker();
          render();
          if (fearActive) renderFearPanel();
        };
        wrap.appendChild(el);
      }
      // Custom (session-only) tickers
      for (const s of customSeries) {
        const on = active.has(s.key);
        const el = document.createElement("span");
        el.className = "chip";
        el.style.borderColor = on ? s.color : "";
        el.style.color       = on ? s.color : "";
        el.style.fontStyle   = "italic";
        const label = document.createTextNode(s.key + " ");
        const x = document.createElement("span");
        x.textContent = "×";
        x.style.cssText = "opacity:.55;cursor:pointer;font-style:normal";
        x.onclick = e => {
          e.stopPropagation();
          const idx = customSeries.indexOf(s);
          if (idx !== -1) customSeries.splice(idx, 1);
          active.delete(s.key);
          delete loaded[s.key]; delete loadedHLC[s.key]; delete loadedVol[s.key];
          renderSeriesPicker(); render();
        };
        el.appendChild(label); el.appendChild(x);
        el.onclick = () => {
          if (active.has(s.key)) active.delete(s.key); else active.add(s.key);
          renderSeriesPicker(); render();
        };
        wrap.appendChild(el);
      }
    }

    // ── MA picker ──────────────────────────────────────────────────
    document.getElementById("ma-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ma]");
      if (!t) return;
      const p = +t.dataset.ma;
      if (maActive.has(p)) maActive.delete(p); else maActive.add(p);
      document.querySelectorAll("#ma-picker .chip[data-ma]").forEach(el =>
        el.classList.toggle("active", maActive.has(+el.dataset.ma)));
      render();
    });

    // ── Custom ticker input ────────────────────────────────────────
    (function () {
      const input = document.getElementById("custom-ticker-input");
      const btn   = document.getElementById("custom-ticker-btn");
      function submit() {
        const val = input.value.trim();
        if (!val) return;
        input.value = "";
        loadCustomTicker(val);
      }
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    })();

    // ── Fear toggle & threshold ────────────────────────────────────
    document.getElementById("fear-toggle").addEventListener("click", async () => {
      fearActive = !fearActive;
      document.getElementById("fear-toggle").classList.toggle("fear-on", fearActive);
      if (fearActive) {
        await Promise.all([ensureLoaded("F&G"), ensureLoaded("SPY")]);
      }
      render();
      renderFearPanel();
    });

    document.getElementById("dd-toggle").addEventListener("click", () => {
      ddZoneActive = !ddZoneActive;
      document.getElementById("dd-toggle").classList.toggle("active", ddZoneActive);
      render();
    });

    document.getElementById("sig-zone-toggle").addEventListener("click", () => {
      sigZoneActive = !sigZoneActive;
      document.getElementById("sig-zone-toggle").classList.toggle("active", sigZoneActive);
      render();
    });

    let fThreshTimer = null;
    document.getElementById("fear-threshold").addEventListener("input", e => {
      clearTimeout(fThreshTimer);
      fThreshTimer = setTimeout(() => {
        const v = parseInt(e.target.value);
        if (!isNaN(v) && v >= 1 && v <= 99) {
          fearThreshold = v;
          render();
          if (fearActive) renderFearPanel();
        }
      }, 300);
    });

    // ── Range controls ─────────────────────────────────────────────
    document.getElementById("range-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-range]");
      if (!t) return;
      state.rangePreset = t.dataset.range;
      state.customFrom = ""; state.customTo = "";
      dateFrom.value = ""; dateTo.value = "";
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      render();
    });

    function onDateChange() {
      state.customFrom = dateFrom.value;
      state.customTo   = dateTo.value;
      if (state.customFrom || state.customTo)
        for (const c of document.querySelectorAll("#range-picker .chip"))
          c.classList.remove("active");
      render();
    }
    dateFrom.addEventListener("change", onDateChange);
    dateTo.addEventListener("change", onDateChange);

    dateTo.value = new Date().toISOString().slice(0, 10);
    dateTo.max   = dateTo.value;
    // ── Correlation matrix ─────────────────────────────────────────
    // ── Init ───────────────────────────────────────────────────────
    (async () => {
      const status = document.getElementById("status");
      // default = light; override only if user explicitly saved dark
      if (localStorage.getItem("theme") === "dark") applyTheme(false);
      try {
        await Promise.all(SERIES.filter(s => active.has(s.key)).map(loadSeries));
        renderSeriesPicker();
        render();
        pentagramTab.renderPentaTickerPicker();
        const lastDates = Object.values(loaded).map(d => d[d.length - 1]?.[0]).filter(Boolean);
        const latestDate = lastDates.sort().at(-1);
        const allFresh = Object.values(loaded).every(isDataFresh);
        status.textContent = `已載入 ${Object.keys(loaded).length} 個指標 · 最新資料 ${latestDate}${allFresh ? "" : " ⚠ 部分資料可能過期"} · 點選 chip 切換顯示`;

        // Pre-load VIX for signal panel, macro data in background
        ensureLoaded("VIX").then(() => renderSignalPanel()).catch(() => {});
        macroTab.loadMacroData().catch(() => {});
        renderSignalPanel();

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
