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
      computeLinearRegression, computeChannelBands,
    } from './utils/math.js';

    const chartEl = document.getElementById("chart");
    let chart = echarts.init(chartEl, null); // light by default
    chart.on("updateAxisPointer", evt => {
      try {
        const ts = evt?.axesInfo?.[0]?.value;
        if (typeof ts !== "number") return;
        renderSignalPanel(tsToLocalDate(ts));
      } catch (_) {}
    });
    chart.on("globalout", () => { if (sigMaps) renderSignalPanel(); });
    let pentaChart = null;
    let pentaActiveTicker = "VOO";
    let pentaPeriod = "3.5Y";
    let pentaMode = "pentagram";
    let pentaFgActive   = false;
    let pentaVixActive  = false;
    let penta125Active  = false;
    let pentaMaPeriod   = 125;

    let _dragAnchor = null;
    let _docMupHandler = null;

    function _getPentaPrice(tsMs) {
      const raw = loaded[pentaActiveTicker];
      if (!raw || !raw.length) return null;
      let best = null, bestDiff = Infinity;
      for (const [dateStr, price] of raw) {
        const diff = Math.abs(new Date(dateStr).getTime() - tsMs);
        if (diff < bestDiff) { bestDiff = diff; best = price; }
      }
      return best;
    }

    function attachDragMeasure(chartInstance) {
      // Canvas overlay — 完全不呼叫 setOption，避免污染 ECharts series 設定
      const container = chartInstance.getDom();
      container.style.position = 'relative';
      let cv = container.querySelector('canvas.__dm');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.className = '__dm';
        cv.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10;';
        container.appendChild(cv);
      }
      cv.width  = chartInstance.getWidth();
      cv.height = chartInstance.getHeight();
      const ctx = cv.getContext('2d');

      const zr = chartInstance.getZr();
      if (attachDragMeasure._down) zr.off('mousedown', attachDragMeasure._down);
      if (attachDragMeasure._move) zr.off('mousemove', attachDragMeasure._move);
      if (attachDragMeasure._up)   zr.off('mouseup',   attachDragMeasure._up);
      if (_docMupHandler) document.removeEventListener('mouseup', _docMupHandler);

      // 切換標的時清除殘留狀態
      _dragAnchor = null;
      ctx.clearRect(0, 0, cv.width, cv.height);

      let dragging = false;
      let startPixel = null;
      let startTs = null;

      const onDown = e => {
        const pt = chartInstance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
        if (!pt || pt[0] == null) return;
        const price = _getPentaPrice(pt[0]);
        if (price == null) return;
        dragging = true;
        startPixel = [e.offsetX, e.offsetY];
        startTs = pt[0];
        _dragAnchor = { date: tsToLocalDate(pt[0]), price };
      };

      const onMove = e => {
        if (!dragging || startTs == null) return;
        const endPt = chartInstance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
        if (!endPt || endPt[0] == null) return;
        const endPrice = _getPentaPrice(endPt[0]);
        if (endPrice == null) return;

        const endDate = tsToLocalDate(endPt[0]);
        _dragAnchor.endDate  = endDate;
        _dragAnchor.endPrice = endPrice;

        const color = endPrice >= _dragAnchor.price ? '#26a69a' : '#ef5350';
        const x1 = startPixel[0], x2 = e.offsetX;
        const yTop = 20, yBot = chartInstance.getHeight() - 50;
        const yMid = (yTop + yBot) / 2;

        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#888';
        ctx.beginPath(); ctx.moveTo(x1, yTop); ctx.lineTo(x1, yBot); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, yTop); ctx.lineTo(x2, yBot); ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x1, yMid); ctx.lineTo(x2, yMid); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#aaa';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(_dragAnchor.date, x1, yBot + 14);
        ctx.fillText(endDate, x2, yBot + 14);
        ctx.restore();
      };

      const clearOverlay = () => {
        if (!dragging) return;
        dragging = false;
        startPixel = null;
        startTs = null;
        _dragAnchor = null;
        ctx.clearRect(0, 0, cv.width, cv.height);
      };

      attachDragMeasure._down = onDown;
      attachDragMeasure._move = onMove;
      attachDragMeasure._up   = clearOverlay;

      zr.on('mousedown', onDown);
      zr.on('mousemove', onMove);
      zr.on('mouseup',   clearOverlay);
      _docMupHandler = clearOverlay;
      document.addEventListener('mouseup', clearOverlay);
    }

    let fearActive    = false;
    let fearThreshold = 20;

    let earningsActive  = false;
    let loadedEarnings  = [];
    let ddZoneActive    = false;
    let sigZoneActive   = false;
    let sigMaps         = null;   // invalidated when new data loads

    let pentaWeekly = false;

    let macroChart       = null;
    let macroRangePreset = "10Y";
    let macroShowM2      = false;

    let macroShowCAPE    = false;

    let corrChart  = null;
    let corrPeriod = "1Y";

    // ── 情緒 tab state ─────────────────────────────────────────────
    let sentChart       = null;
    let sentGaugeChart  = null;
    let sentData        = null;
    let sentRangePreset = "5Y";

    let sectorChart   = null;
    let sectorSortCol = "1M";

    // ── 市場廣度 state ─────────────────────────────────────────────
    let breadthChart     = null;
    let breadthData      = null;
    let breadthSpy       = {};   // { date: close }
    let breadthVixMap    = {};   // { date: value }
    let breadthFgMap     = {};   // { date: value }
    let breadthVixActive = false;
    let breadthFgActive  = false;
    let breadthRange     = "2Y";

    // ── 現金王 state ───────────────────────────────────────────────
    const ckRaw = {};
    let ckFilter = "all";
    let ckMode = "4w";
    let ckWindow = 4;
    let ckAssetMode = "4a";   // "4a" = GLD/BTC/TLT/QQQ | "3a" = GLD/TLT/QQQ
    let ckData4a = null;
    let ckData3a = null;
    let ckInited = false;

    const dateFrom = document.getElementById("date-from");
    const dateTo   = document.getElementById("date-to");

    // ── Resize handler ─────────────────────────────────────────────
    function setupResizeHandler() {
      if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
      window._resizeHandler = () => {
        chart.resize();
        if (pentaChart)  pentaChart.resize();
        if (macroChart)  macroChart.resize();
        if (corrChart)   corrChart.resize();
        if (sectorChart) sectorChart.resize();
        if (sentChart)   sentChart.resize();
        if (sentGaugeChart) sentGaugeChart.resize();
        if (breadthChart) breadthChart.resize();
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

      if (pentaChart) {
        pentaChart.dispose();
        pentaChart = echarts.init(document.getElementById("penta-chart"), light ? null : "dark");
        renderPentagram();
      }
      if (macroChart) {
        macroChart.dispose();
        macroChart = echarts.init(document.getElementById("macro-chart"), light ? null : "dark");
        renderMacroTab();
      }
      if (corrChart) {
        corrChart.dispose();
        corrChart = echarts.init(document.getElementById("corr-chart"), light ? null : "dark");
        renderCorrTab();
      }
      if (sectorChart) {
        sectorChart.dispose();
        sectorChart = echarts.init(document.getElementById("sector-chart"), light ? null : "dark");
        renderSectorTab();
      }
      if (ckInited) renderCKTab();
      if (sentChart) {
        sentChart.dispose();
        sentChart = echarts.init(document.getElementById("sentiment-chart"), light ? null : "dark");
        renderSentimentChart();
      }
      if (sentGaugeChart) {
        sentGaugeChart.dispose();
        sentGaugeChart = echarts.init(document.getElementById("sentiment-gauge"), light ? null : "dark");
        renderSentimentGauge(sentData.latest.composite);
      }
      if (breadthChart) {
        breadthChart.dispose();
        breadthChart = echarts.init(document.getElementById("breadth-chart"), light ? null : "dark");
        renderBreadthChart();
      }
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
        const el = document.getElementById("penta-chart");
        if (!pentaChart) {
          pentaChart = echarts.init(el, isLight() ? null : "dark");
          setupResizeHandler();
        }
        setTimeout(() => { pentaChart.resize(); renderPentagram(); }, 50);
      } else if (tabName === "macro") {
        const el = document.getElementById("macro-chart");
        if (!macroChart) {
          macroChart = echarts.init(el, isLight() ? null : "dark");
          setupResizeHandler();
        }
        setTimeout(() => { macroChart.resize(); renderMacroTab(); }, 50);
      } else if (tabName === "corr") {
        const el = document.getElementById("corr-chart");
        if (!corrChart) {
          corrChart = echarts.init(el, isLight() ? null : "dark");
          setupResizeHandler();
        }
        setTimeout(() => { corrChart.resize(); renderCorrTab(); }, 50);
      } else if (tabName === "sector") {
        const el = document.getElementById("sector-chart");
        if (!sectorChart) {
          sectorChart = echarts.init(el, isLight() ? null : "dark");
          setupResizeHandler();
        }
        setTimeout(() => { sectorChart.resize(); renderSectorTab(); }, 50);
      } else if (tabName === "cashking") {
        initCKTab();
      } else if (tabName === "sentiment") {
        initSentimentTab();
      } else if (tabName === "breadth") {
        initBreadthTab();
      } else if (tabName === "earnings") {
        renderEarningsCalendar();
      }
    }

    document.querySelectorAll(".tab-btn").forEach(btn =>
      btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

    // ── Date utils ─────────────────────────────────────────────────
    // ── Loading ────────────────────────────────────────────────────
    function isDataFresh(data) {
      if (!data || data.length === 0) return false;
      const lastDate = data[data.length - 1][0];
      // stale if last entry is more than 4 calendar days ago (covers weekends + Monday)
      return (Date.now() - new Date(lastDate + "T00:00:00Z")) / 86400000 <= 4;
    }

    async function loadSeries(s) {
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
      sigMaps = null; // invalidate signal lookup cache
    }

    async function ensureLoaded(key) {
      const s = SERIES.find(x => x.key === key);
      if (s) await loadSeries(s);
    }

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
        sigMaps = null;

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

    async function loadEarnings() {
      try {
        const r = await fetch("data/earnings.json", { cache: "no-cache" });
        if (!r.ok) return;
        const j = await r.json();
        loadedEarnings = j.data || [];
      } catch { loadedEarnings = []; }
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

    // ── Bounce signal: QQQ<MA200 & F&G<15 → 2%+ bounce within 14 days ──
    function computeBounceSignals(qqqData, fgData, ma200Data) {
      const fgMap    = new Map(fgData.map(r => [r[0], r[1]]));
      const ma200Map = new Map(ma200Data.map(r => [r[0], r[1]]));
      const MS14     = 14 * 86400000;

      // Trigger days: QQQ close < MA200 AND F&G < 15
      const triggerMs = [];
      for (const [date, close] of qqqData) {
        const fg = fgMap.get(date);
        const ma = ma200Map.get(date);
        if (fg != null && fg < 15 && ma != null && close < ma)
          triggerMs.push(new Date(date + "T00:00:00Z").getTime());
      }
      if (!triggerMs.length) return { bounceSignals: [], bounceRetMap: new Map() };

      // Bounce days: within 14 calendar days after any trigger AND daily gain > 2%
      const bounceSignals = [];
      const bounceRetMap  = new Map();
      for (let i = 1; i < qqqData.length; i++) {
        const [date, close] = qqqData[i];
        const prev = qqqData[i - 1][1];
        const ret  = (close - prev) / prev;
        if (ret <= 0.02) continue;
        const dMs = new Date(date + "T00:00:00Z").getTime();
        if (triggerMs.some(t => t <= dMs && dMs <= t + MS14)) {
          const ma   = ma200Map.get(date);
          const vsMa = ma != null ? (close - ma) / ma * 100 : null;
          bounceSignals.push([date, close]);
          bounceRetMap.set(date, { ret, fg: fgMap.get(date) ?? null, vsMa });
        }
      }
      return { bounceSignals, bounceRetMap };
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
        if (!sigMaps) buildSigMaps();
        if (sigMaps?.scoreArr) {
          const zones = [];
          let zStart = null, prev = null;
          for (const [date, score] of sigMaps.scoreArr) {
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

      if (earningsActive && loadedEarnings.length > 0) {
        const { from, to } = currentWindow();
        const toDate = to || new Date().toISOString().slice(0, 10);
        const inRange = loadedEarnings.filter(e => (!from || e.date >= from) && e.date <= toDate);
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

    // ── Pentagram: linear regression channel ───────────────────────
    function getPentaData() {
      const raw = loaded[pentaActiveTicker];
      if (!raw) return [];
      const d = new Date();
      if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
      else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
      else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
      const fromDate = d.toISOString().slice(0, 10);
      const filtered = raw.filter(r => r[0] >= fromDate);
      return pentaWeekly ? toWeekly(filtered) : filtered;
    }

    function getPentaFgData() {
      const fg = loaded["F&G"];
      if (!fg) return [];
      const d = new Date();
      if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
      else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
      else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
      const fromDate = d.toISOString().slice(0, 10);
      return fg.filter(r => r[0] >= fromDate);
    }

    function getPentaVixData() {
      const vix = loaded["VIX_H"]; // daily high, not close
      if (!vix) return [];
      const d = new Date();
      if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
      else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
      else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
      const fromDate = d.toISOString().slice(0, 10);
      return vix.filter(r => r[0] >= fromDate);
    }

    function computeCustomMA(dailyData, N) {
      const out = [];
      for (let i = N - 1; i < dailyData.length; i++) {
        let sum = 0;
        for (let j = i - N + 1; j <= i; j++) sum += dailyData[j][1];
        out.push([dailyData[i][0], +(sum / N).toFixed(4)]);
      }
      return out;
    }

    function buildSigMaps() {
      const qqq = loaded["QQQ"];
      if (!qqq?.length) return;
      const weekly = toWeekly(qqq);
      const wHLC   = loadedHLC["QQQ"] ? toWeeklyHLC(loadedHLC["QQQ"]) : null;

      // Weekly KD + RSI + TD merged into [date, K, D, RSI, tdCount, tdDir]
      const kdArr  = wHLC ? computeKD(wHLC, 9) : [];
      const rsiArr = computeRSI(weekly, 14);
      const tdArr  = computeTDSetup(weekly);
      const rsiMap = new Map(rsiArr.map(r => [r[0], r[1]]));
      const tdMap  = new Map(tdArr.map(r => [r.date, r]));
      const weeklySignals = kdArr.map(r => {
        const td = tdMap.get(r[0]);
        return [r[0], r[1], r[2], rsiMap.get(r[0]) ?? null, td?.count ?? 0, td?.dir ?? null];
      });

      // Daily MA200 for QQQ
      const ma200 = computeMA(qqq, 200);

      // Daily rolling drawdown helpers (lookback = n trading days)
      const makeDDArr = (n) => {
        const arr = [];
        for (let i = 0; i < qqq.length; i++) {
          if (i < n) { arr.push([qqq[i][0], null]); continue; }
          let peak = 0;
          for (let j = i - n; j < i; j++) if (qqq[j][1] > peak) peak = qqq[j][1];
          arr.push([qqq[i][0], (qqq[i][1] - peak) / peak * 100]);
        }
        return arr;
      };
      const ddArr   = makeDDArr(60);  // 12 trading weeks

      const fg  = loaded["F&G"]    || [];
      const vix = loaded["VIX"]    || [];
      const vol = loadedVol["QQQ"] || [];

      // Pre-compute daily composite score (0-9)
      const scoreArr = [];
      for (const [date, close] of qqq) {
        const ws     = lookupLE(weeklySignals, date);
        const fgV    = lookupLE(fg,     date)?.[1] ?? null;
        const vixV   = lookupLE(vix,    date)?.[1] ?? null;
        const ma200V = lookupLE(ma200,  date)?.[1] ?? null;
        const volV   = lookupLE(vol,    date)?.[1] ?? null;
        const ddV    = lookupLE(ddArr,  date)?.[1] ?? null;
        const dev    = (ma200V && close) ? (close - ma200V) / ma200V * 100 : null;
        const score = [
          ws?.[1] != null && ws[1] < 30,
          ws?.[3] != null && ws[3] < 30,
          fgV   != null && fgV  < 25,
          vixV  != null && vixV > 20,
          dev   != null && dev  < 0,
          ws?.[5] === 'down' && (ws[4] ?? 0) >= 7,
          ddV   != null && ddV  <= -10,
          volV  != null && volV >= 80_000_000,
        ].filter(Boolean).length;
        scoreArr.push([date, score]);
      }

      const dailyRetArr = qqq.slice(1).map((r, i) => [r[0], (r[1] - qqq[i][1]) / qqq[i][1]]);
      const { bounceSignals: bSigs } = computeBounceSignals(qqq, fg, ma200);
      const bounceSignalSet = new Set(bSigs.map(r => r[0]));
      sigMaps = { qqq, weeklySignals, ma200, ddArr, fg, vix, vol, scoreArr, dailyRetArr, bounceSignalSet };
    }

    function renderSignalPanel(date) {
      if (!sigMaps) buildSigMaps();
      if (!sigMaps) return;

      const isLive = !date;
      const d = date || sigMaps.qqq.at(-1)?.[0];
      if (!d) return;

      const ws     = lookupLE(sigMaps.weeklySignals, d);
      const fgRow  = lookupLE(sigMaps.fg,   d);
      const vixRow = lookupLE(sigMaps.vix,  d);
      const ma200R = lookupLE(sigMaps.ma200, d);
      const volRow  = lookupLE(sigMaps.vol,   d);
      const ddRow   = lookupLE(sigMaps.ddArr, d);
      const qRow    = lookupLE(sigMaps.qqq,   d);

      const kdK     = ws?.[1]  ?? null;
      const rsiVal  = ws?.[3]  ?? null;
      const tdCount = ws?.[4]  ?? 0;
      const tdDir   = ws?.[5]  ?? null;
      const fgVal   = fgRow?.[1]   ?? null;
      const vixVal  = vixRow?.[1]  ?? null;
      const ma200V  = ma200R?.[1]  ?? null;
      const qClose  = qRow?.[1]    ?? null;
      const ma200Dev = (ma200V && qClose) ? (qClose - ma200V) / ma200V * 100 : null;
      const volVal  = volRow?.[1] ?? null;
      const ddVal   = ddRow?.[1]  ?? null;
      const dailyRetRow = lookupLE(sigMaps.dailyRetArr, d);
      const dailyRetV   = dailyRetRow?.[0] === d ? dailyRetRow[1] : null;

      const kdHit  = kdK      != null && kdK      < 30;
      const rsiHit = rsiVal   != null && rsiVal   < 30;
      const fgHit  = fgVal    != null && fgVal    < 25;
      const vixHit = vixVal   != null && vixVal   > 20;
      const maHit  = ma200Dev != null && ma200Dev < 0;
      const tdHit  = tdDir === 'down' && tdCount >= 7;
      const ddHit  = ddVal    != null && ddVal    <= -10;
      const volHit    = volVal   != null && volVal   >= 80_000_000;
      const bounceHit = sigMaps.bounceSignalSet?.has(d) ?? false;

      const set = (id, label, txt, hit) => {
        const el = document.getElementById(id); if (!el) return;
        el.textContent = txt != null ? `${label} ${txt}` : `${label} —`;
        el.classList.toggle("hit", !!hit);
      };
      set("sig-kd",   "週K",   kdK      != null ? kdK.toFixed(1)    : null, kdHit);
      set("sig-rsi",  "週RSI", rsiVal   != null ? rsiVal.toFixed(1)  : null, rsiHit);
      set("sig-fg",   "F&G",   fgVal    != null ? fgVal.toFixed(0)   : null, fgHit);
      set("sig-vix",  "VIX",   vixVal   != null ? vixVal.toFixed(1)  : null, vixHit);
      set("sig-ma",   "MA200", ma200Dev != null ? `${ma200Dev >= 0 ? "↑" : "↓"}${Math.abs(ma200Dev).toFixed(1)}%` : null, maHit);
      set("sig-td",   "九轉",  tdDir === 'down' && tdCount > 0 ? `${tdCount}計` : "0計", tdHit);
      set("sig-dd",   "12W",   ddVal    != null ? `${ddVal.toFixed(1)}%`    : null, ddHit);
      set("sig-vol",  "量",    volVal   != null ? `${(volVal / 1e6).toFixed(0)}M` : null, volHit);
      set("sig-bounce", "恐慌反彈", bounceHit ? `F&G:${fgVal.toFixed(0)} +${(dailyRetV * 100).toFixed(1)}%` : null, bounceHit);
      const hits = [kdHit, rsiHit, fgHit, vixHit, maHit, tdHit, ddHit, volHit].filter(Boolean).length;
      const countEl = document.getElementById("sig-count");
      if (countEl) {
        countEl.textContent = `${hits}/8`;
        countEl.style.color = hits >= 5 ? "#f85149" : hits >= 3 ? "#e3b341" : "var(--muted)";
      }
      const labelEl = document.querySelector("#signal-panel > span:first-child");
      if (labelEl) labelEl.textContent = isLive ? "QQQ 極端低點" : `QQQ @ ${d}`;
    }

    // ── Channel helpers ────────────────────────────────────────────
    // 樂活通道倍數：sentimentinsideout 對 QQQ 0.5Y 的 555/611/666 對應到
    // MA20 ± 2.5σ（我們算 611.74 ± 2.5×21.71 = [557.5, 666.0]）。
    function renderChannelMode() {
      if (!pentaChart) return;
      const statusEl = document.getElementById("penta-status");

      if (!pentaActiveTicker || !loaded[pentaActiveTicker]) {
        pentaChart.clear();
        statusEl.textContent = "← 選擇標的以顯示通道";
        return;
      }

      const allDaily = loaded[pentaActiveTicker];
      const weekly   = toWeekly(allDaily);
      const bands    = computeChannelBands(weekly);

      if (!bands.ma20.length) {
        statusEl.textContent = "數據不足";
        pentaChart.clear();
        return;
      }

      const d = new Date();
      if      (pentaPeriod === "0.5Y") d.setMonth(d.getMonth() - 6);
      else if (pentaPeriod === "1.5Y") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
      else if (pentaPeriod === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
      const fromDate = d.toISOString().slice(0, 10);

      const priceW   = weekly.filter(r => r[0] >= fromDate);
      const ma20w    = bands.ma20.filter(r => r[0] >= fromDate);
      const upperW   = bands.upper.filter(r => r[0] >= fromDate);
      const lowerW   = bands.lower.filter(r => r[0] >= fromDate);
      const maLabel  = `MA${pentaMaPeriod}`;
      const ma125Chw = penta125Active ? computeCustomMA(allDaily, pentaMaPeriod).filter(r => r[0] >= fromDate) : null;

      const s        = SERIES.find(x => x.key === pentaActiveTicker);
      const axisClr  = tc("#8b949e", "#57606a");
      const gridClr  = tc("#21262d", "#e1e4e8");
      const tipBg    = tc("#161b22", "#ffffff");
      const tipBdr   = tc("#30363d", "#d0d7de");
      const tipText  = tc("#e6edf3", "#1f2328");
      const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

      const isMobCh   = mob();
      const axisOffCh = isMobCh ? 42 : 55;
      const vixDataCh = pentaVixActive && loaded["VIX_H"] ? getPentaVixData() : null;
      const fgDataCh  = pentaFgActive  && loaded["F&G"] ? getPentaFgData()  : null;

      const rightAxesCh = [];
      let vixIdxCh = -1, fgIdxCh = -1;
      if (vixDataCh) {
        vixIdxCh = 1 + rightAxesCh.length;
        rightAxesCh.push({ scale: true, position: "right", offset: rightAxesCh.length * axisOffCh,
          axisLine: { lineStyle: { color: "#f0883e" } }, axisLabel: { fontSize: 11, color: "#f0883e" }, splitLine: { show: false } });
      }
      if (fgDataCh) {
        fgIdxCh = 1 + rightAxesCh.length;
        rightAxesCh.push({ min: 0, max: 100, position: "right", offset: rightAxesCh.length * axisOffCh,
          axisLine: { lineStyle: { color: "#e3b341" } }, axisLabel: { fontSize: 11, color: "#e3b341" }, splitLine: { show: false } });
      }
      const nRtCh    = rightAxesCh.length;
      const rsiIdxCh = 1 + nRtCh;
      const kdIdxCh  = 2 + nRtCh;
      const gridRCh  = nRtCh === 0 ? (isMobCh ? 12 : 24) : nRtCh === 1 ? (isMobCh ? 38 : 58) : (isMobCh ? 65 : 105);

      // ── Weekly indicator data ──────────────────────────────────────
      const wHLCCh    = loadedHLC[pentaActiveTicker] ? toWeeklyHLC(loadedHLC[pentaActiveTicker]) : weekly.map(r => [r[0],r[1],r[1],r[1]]);
      const rsiDataCh = computeRSI(weekly, 14).filter(r => r[0] >= fromDate);
      const kdDataCh  = computeKD(wHLCCh, 9).filter(r => r[0] >= fromDate);
      const tdInRgCh  = computeTDSetup(weekly).filter(p => p.date >= fromDate);
      const pmapCh    = new Map(weekly.map(r => [r[0], r[1]]));

      // ── yAxis (multi-grid) ─────────────────────────────────────────
      const priceAxisCh = { gridIndex:0, scale:true, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:12}, splitLine:{lineStyle:{color:gridClr}} };
      const rtAxWithGCh = rightAxesCh.map(a => ({ ...a, gridIndex: 0 }));
      const rsiAxisCh   = { gridIndex:1, min:0, max:100, name:'RSI', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#a371f7',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#a371f7'}, splitLine:{show:false} };
      const kdAxisCh    = { gridIndex:2, min:0, max:100, name:'KD',  nameLocation:'start', nameGap:2, nameTextStyle:{color:'#f0883e',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#f0883e'}, splitLine:{show:false} };
      const yAxisCh     = [priceAxisCh, ...rtAxWithGCh, rsiAxisCh, kdAxisCh];

      // ── TD annotation series ──────────────────────────────────────
      const mkTDCh = (items, pos, clr, c9) => {
        const norm = items.filter(p => p.count < 9);
        const sig9 = items.filter(p => p.count === 9);
        const out  = [];
        if (norm.length) out.push({ type:'scatter', name:`__tdc_${pos}`, xAxisIndex:0, yAxisIndex:0, data:norm.map(p=>[p.date,pmapCh.get(p.date)??0,p.count]), symbolSize:0, silent:true, label:{show:true, formatter:p=>String(p.data[2]), position:pos, fontSize:9, color:clr} });
        if (sig9.length) out.push({ type:'scatter', name:`__tdc9_${pos}`, xAxisIndex:0, yAxisIndex:0, data:sig9.map(p=>[p.date,pmapCh.get(p.date)??0]), symbol:'circle', symbolSize:11, silent:true, itemStyle:{color:c9,borderColor:'#fff',borderWidth:1.5}, label:{show:true, formatter:'9', position:pos, fontSize:10, fontWeight:'bold', color:c9, distance:4} });
        return out;
      };
      const tdSeriesCh = [
        ...mkTDCh(tdInRgCh.filter(p=>p.dir==='down'), 'top',    '#3fb950', '#56d364'),
        ...mkTDCh(tdInRgCh.filter(p=>p.dir==='up'),   'bottom', '#f85149', '#f85149'),
      ];

      pentaChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis", axisPointer: { type: "cross" },
          backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
          formatter(params) {
            if (!params?.length) return '';
            const ts = params[0]?.axisValue;
            const dateLabel = ts ? tsToLocalDate(ts) : "";
            let out = `<b>${dateLabel}</b><br/>`;
            const priceV = params.find(p => p.seriesName === "價格")?.value?.[1];
            for (const p of params) {
              if (p.seriesName.startsWith("__")) continue;
              const v = p.value?.[1]; if (v == null) continue;
              const fmt = p.seriesName==="F&G" ? v.toFixed(0) : p.seriesName==="VIX" ? v.toFixed(2) : v.toLocaleString(undefined,{maximumFractionDigits:2});
              out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmt}</b><br/>`;
            }
            if (_dragAnchor && priceV != null) {
              const pct = (priceV - _dragAnchor.price) / _dragAnchor.price * 100;
              const clr = pct >= 0 ? '#26a69a' : '#ef5350';
              const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
              out += `<span style="color:#888">↔ ${_dragAnchor.date} <b style="color:#ccc">${fmt(_dragAnchor.price)}</b> → <b style="color:${clr}">${fmt(priceV)}</b>　<b style="color:${clr}">${pct>=0?'+':''}${pct.toFixed(2)}%</b></span><br/>`;
            }
            return out;
          },
        },
        legend: {
          data: ["上軌 +2.5σ","MA20","價格","下軌 -2.5σ",...(ma125Chw?[maLabel]:[]),...(vixIdxCh>=0?["VIX"]:[]),...(fgIdxCh>=0?["F&G"]:[])],
          textStyle: { color: tipText, fontSize: 13 }, top: 6,
        },
        grid: [
          { left:isMobCh?45:72, right:gridRCh, top:48, bottom:'38%' },
          { left:isMobCh?45:72, right:50, top:'65%', bottom:'22%' },
          { left:isMobCh?45:72, right:50, top:'81%', bottom:36 },
        ],
        xAxis: [
          { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
          { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
          { gridIndex:2, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobCh?10:12}, splitLine:{show:false} },
        ],
        yAxis: yAxisCh,
        dataZoom: [
          { type:"inside", xAxisIndex:[0,1,2] },
          { type:"slider", height:18, bottom:14, xAxisIndex:[0,1,2] },
        ],
        series: [
          { ...lineBase, name:"上軌 +2.5σ", data:upperW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#e91e63"}, itemStyle:{color:"#e91e63"} },
          { ...lineBase, name:"MA20",       data:ma20w,  xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#9e9e9e",type:"dashed"}, itemStyle:{color:"#9e9e9e"} },
          { ...lineBase, name:"價格",       data:priceW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.8,color:s.color}, itemStyle:{color:s.color} },
          { ...lineBase, name:"下軌 -2.5σ", data:lowerW, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#1565c0"}, itemStyle:{color:"#1565c0"} },
          ...(ma125Chw ? [{ ...lineBase, name:maLabel, data:ma125Chw, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:2,color:"#ff9800"}, itemStyle:{color:"#ff9800"} }] : []),
          ...(vixIdxCh>=0 ? [{ ...lineBase, name:"VIX", data:vixDataCh, xAxisIndex:0, yAxisIndex:vixIdxCh, lineStyle:{width:1.5,color:"#f0883e",type:"dashed"}, itemStyle:{color:"#f0883e"}, areaStyle:{color:"rgba(240,136,62,0.06)"} }] : []),
          ...(fgIdxCh>=0  ? [{ ...lineBase, name:"F&G", data:fgDataCh,  xAxisIndex:0, yAxisIndex:fgIdxCh,  lineStyle:{width:1.5,color:"#e3b341",type:"dashed"}, itemStyle:{color:"#e3b341"}, areaStyle:{color:"rgba(227,179,65,0.06)"} }] : []),
          ...(rsiDataCh.length ? [{ type:'line', name:'RSI', xAxisIndex:1, yAxisIndex:rsiIdxCh, data:rsiDataCh, showSymbol:false, lineStyle:{width:1.5,color:'#a371f7'}, itemStyle:{color:'#a371f7'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:70,label:{formatter:'70',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:30,label:{formatter:'30',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} }] : []),
          ...(kdDataCh.length ? [
            { type:'line', name:'K', xAxisIndex:2, yAxisIndex:kdIdxCh, data:kdDataCh.map(r=>[r[0],r[1]]), showSymbol:false, lineStyle:{width:1.5,color:'#f0883e'}, itemStyle:{color:'#f0883e'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:80,label:{formatter:'80',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:20,label:{formatter:'20',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} },
            { type:'line', name:'D', xAxisIndex:2, yAxisIndex:kdIdxCh, data:kdDataCh.map(r=>[r[0],r[2]]), showSymbol:false, lineStyle:{width:1.5,color:'#79c0ff',type:'dashed'}, itemStyle:{color:'#79c0ff'} },
          ] : []),
          ...tdSeriesCh,
        ],
      }, { notMerge: true });

      statusEl.textContent =
        `${pentaActiveTicker} 樂活通道 · ${pentaPeriod} · MA20 週線 ±2.5σ · ${weekly.length} 週完整歷史`;
      attachDragMeasure(pentaChart);
    }

    // ── Pentagram render ───────────────────────────────────────────
    function renderPentagram() {
      if (pentaMode === "channel") { renderChannelMode(); return; }
      if (!pentaChart) return;
      const statusEl = document.getElementById("penta-status");

      if (!pentaActiveTicker || !loaded[pentaActiveTicker]) {
        pentaChart.clear();
        statusEl.textContent = "← 選擇標的以顯示五線譜";
        return;
      }

      const data   = getPentaData();
      const result = computeLinearRegression(data);

      if (!result) {
        statusEl.textContent = `數據不足`;
        pentaChart.clear();
        return;
      }

      // ── Zone badge: detect current position ───────────────────────
      const rLen      = result.upper2.length;
      const lastDate  = data[data.length - 1][0];
      const lastPrice = data[data.length - 1][1];
      const lastU2    = result.upper2[rLen - 1][1];
      const lastU1    = result.upper1[rLen - 1][1];
      const lastTr    = result.trend [rLen - 1][1];
      const lastL1    = result.lower1[rLen - 1][1];
      const lastL2    = result.lower2[rLen - 1][1];
      let zoneName, zoneClr;
      if      (lastPrice >= lastU2) { zoneName = "超漲"; zoneClr = "#e91e63"; }
      else if (lastPrice >= lastU1) { zoneName = "偏貴"; zoneClr = "#f06292"; }
      else if (lastPrice >= lastTr) { zoneName = "偏強"; zoneClr = "#78909c"; }
      else if (lastPrice >= lastL1) { zoneName = "偏弱"; zoneClr = "#64b5f6"; }
      else if (lastPrice >= lastL2) { zoneName = "便宜"; zoneClr = "#1976d2"; }
      else                          { zoneName = "超跌"; zoneClr = "#1565c0"; }
      // Badge goes below the dot when price is high (to avoid clipping at top edge)
      const badgePos = lastPrice >= lastTr ? "bottom" : "top";

      // ── Custom MA ─────────────────────────────────────────────────
      const maLabelPt   = `MA${pentaMaPeriod}`;
      const fromDatePt  = data.length > 0 ? data[0][0] : "";
      const ma125DataPt = penta125Active
        ? computeCustomMA(loaded[pentaActiveTicker], pentaMaPeriod).filter(r => r[0] >= fromDatePt)
        : null;

      // 乖離率：(price - MA) / MA × 100%
      let deviationStr = "";
      let badgeLabel   = zoneName;
      if (ma125DataPt && ma125DataPt.length > 0) {
        const lastMA = ma125DataPt[ma125DataPt.length - 1][1];
        const dev    = (lastPrice - lastMA) / lastMA * 100;
        deviationStr = `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`;
        badgeLabel   = `${zoneName}  ${deviationStr}`;
      }

      const s        = SERIES.find(x => x.key === pentaActiveTicker);
      const axisClr  = tc("#8b949e", "#57606a");
      const gridClr  = tc("#21262d", "#e1e4e8");
      const tipBg    = tc("#161b22", "#ffffff");
      const tipBdr   = tc("#30363d", "#d0d7de");
      const tipText  = tc("#e6edf3", "#1f2328");
      const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

      const isMobPt   = mob();
      const axisOffPt = isMobPt ? 42 : 55;
      const vixDataPt = pentaVixActive && loaded["VIX_H"] ? getPentaVixData() : null;
      const fgDataPt  = pentaFgActive  && loaded["F&G"] ? getPentaFgData()  : null;

      const rightAxesPt = [];
      let vixIdxPt = -1, fgIdxPt = -1;
      if (vixDataPt) {
        vixIdxPt = 1 + rightAxesPt.length;
        rightAxesPt.push({ scale: true, position: "right", offset: rightAxesPt.length * axisOffPt,
          axisLine: { lineStyle: { color: "#f0883e" } }, axisLabel: { fontSize: 11, color: "#f0883e" }, splitLine: { show: false } });
      }
      if (fgDataPt) {
        fgIdxPt = 1 + rightAxesPt.length;
        rightAxesPt.push({ min: 0, max: 100, position: "right", offset: rightAxesPt.length * axisOffPt,
          axisLine: { lineStyle: { color: "#e3b341" } }, axisLabel: { fontSize: 11, color: "#e3b341" }, splitLine: { show: false } });
      }
      const nRtPt    = rightAxesPt.length;
      const rsiIdxPt = 1 + nRtPt;
      const kdIdxPt  = 2 + nRtPt;
      const gridRPt  = nRtPt === 0 ? (isMobPt ? 12 : 24) : nRtPt === 1 ? (isMobPt ? 38 : 58) : (isMobPt ? 65 : 105);

      // ── Weekly indicator data (always weekly regardless of pentaWeekly) ─
      const wklyPt   = toWeekly(loaded[pentaActiveTicker] || []);
      const wHLCPt   = loadedHLC[pentaActiveTicker] ? toWeeklyHLC(loadedHLC[pentaActiveTicker]) : wklyPt.map(r => [r[0],r[1],r[1],r[1]]);
      const rsiDataPt = computeRSI(wklyPt, 14).filter(r => r[0] >= fromDatePt);
      const kdDataPt  = computeKD(wHLCPt, 9).filter(r => r[0] >= fromDatePt);
      const tdInRgPt  = computeTDSetup(wklyPt).filter(p => p.date >= fromDatePt);
      const pmapPt    = new Map(wklyPt.map(r => [r[0], r[1]]));

      // ── yAxis (multi-grid) ─────────────────────────────────────────
      const priceAxisPt = { gridIndex:0, scale:true, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:12}, splitLine:{lineStyle:{color:gridClr}} };
      const rtAxWithGPt = rightAxesPt.map(a => ({ ...a, gridIndex: 0 }));
      const rsiAxisPt   = { gridIndex:1, min:0, max:100, name:'RSI', nameLocation:'start', nameGap:2, nameTextStyle:{color:'#a371f7',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#a371f7'}, splitLine:{show:false} };
      const kdAxisPt    = { gridIndex:2, min:0, max:100, name:'KD',  nameLocation:'start', nameGap:2, nameTextStyle:{color:'#f0883e',fontSize:9}, axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:9,color:'#f0883e'}, splitLine:{show:false} };
      const yAxisPt     = [priceAxisPt, ...rtAxWithGPt, rsiAxisPt, kdAxisPt];

      // ── TD annotation series ──────────────────────────────────────
      const mkTDPt = (items, pos, clr, c9) => {
        const norm = items.filter(p => p.count < 9);
        const sig9 = items.filter(p => p.count === 9);
        const out  = [];
        if (norm.length) out.push({ type:'scatter', name:`__tdp_${pos}`, xAxisIndex:0, yAxisIndex:0, data:norm.map(p=>[p.date,pmapPt.get(p.date)??0,p.count]), symbolSize:0, silent:true, label:{show:true, formatter:p=>String(p.data[2]), position:pos, fontSize:9, color:clr} });
        if (sig9.length) out.push({ type:'scatter', name:`__tdp9_${pos}`, xAxisIndex:0, yAxisIndex:0, data:sig9.map(p=>[p.date,pmapPt.get(p.date)??0]), symbol:'circle', symbolSize:11, silent:true, itemStyle:{color:c9,borderColor:'#fff',borderWidth:1.5}, label:{show:true, formatter:'9', position:pos, fontSize:10, fontWeight:'bold', color:c9, distance:4} });
        return out;
      };
      const tdSeriesPt = [
        ...mkTDPt(tdInRgPt.filter(p=>p.dir==='down'), 'top',    '#3fb950', '#56d364'),
        ...mkTDPt(tdInRgPt.filter(p=>p.dir==='up'),   'bottom', '#f85149', '#f85149'),
      ];

      // ── Price series (sorted by zone for legend order) ────────────
      const sU2 = { ...lineBase, name:"極度貪婪", data:result.upper2, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#e91e63"}, itemStyle:{color:"#e91e63"} };
      const sU1 = { ...lineBase, name:"貪婪",     data:result.upper1, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#f48fb1"}, itemStyle:{color:"#f48fb1"} };
      const sTr = { ...lineBase, name:"趨勢線",   data:result.trend,  xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#9e9e9e"}, itemStyle:{color:"#9e9e9e"} };
      const sL1 = { ...lineBase, name:"恐懼",     data:result.lower1, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#64b5f6"}, itemStyle:{color:"#64b5f6"} };
      const sL2 = { ...lineBase, name:"極度恐懼", data:result.lower2, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:"#1565c0"}, itemStyle:{color:"#1565c0"} };
      const sPr = { ...lineBase, name:"價格",     data,               xAxisIndex:0, yAxisIndex:0, lineStyle:{width:1.5,color:s.color},   itemStyle:{color:s.color},
        markPoint: { silent:true, animation:false, data:[{ coord:[lastDate,lastPrice], symbol:"circle", symbolSize:10, itemStyle:{color:zoneClr,borderColor:"#fff",borderWidth:2}, label:{show:true, formatter:badgeLabel, position:badgePos, distance:8, color:"#fff", backgroundColor:zoneClr, borderRadius:4, padding:[3,8], fontSize:12, fontWeight:"bold"} }] }
      };
      let bandsSorted;
      if      (lastPrice >= lastU2) bandsSorted = [sPr, sU2, sU1, sTr, sL1, sL2];
      else if (lastPrice >= lastU1) bandsSorted = [sU2, sPr, sU1, sTr, sL1, sL2];
      else if (lastPrice >= lastTr) bandsSorted = [sU2, sU1, sPr, sTr, sL1, sL2];
      else if (lastPrice >= lastL1) bandsSorted = [sU2, sU1, sTr, sPr, sL1, sL2];
      else if (lastPrice >= lastL2) bandsSorted = [sU2, sU1, sTr, sL1, sPr, sL2];
      else                          bandsSorted = [sU2, sU1, sTr, sL1, sL2, sPr];

      pentaChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis", axisPointer: { type: "cross" },
          backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
          formatter(params) {
            if (!params?.length) return '';
            const ts = params[0]?.axisValue;
            const dateLabel = ts ? tsToLocalDate(ts) : "";
            let out = `<b>${dateLabel}</b><br/>`;
            const priceV = params.find(p => p.seriesName === "價格")?.value?.[1];
            for (const p of params) {
              if (p.seriesName.startsWith("__")) continue;
              const v = p.value?.[1]; if (v == null) continue;
              const fmt = p.seriesName==="F&G" ? v.toFixed(0) : p.seriesName==="VIX" ? v.toFixed(2) : v.toLocaleString(undefined,{maximumFractionDigits:2});
              out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmt}</b>`;
              if (p.seriesName === maLabelPt && priceV != null) {
                const dev = (priceV - v) / v * 100;
                out += `  <span style="color:${dev>=0?"#f48fb1":"#64b5f6"};font-size:11px">${dev>=0?"+":""}${dev.toFixed(2)}%</span>`;
              }
              out += "<br/>";
            }
            if (_dragAnchor && priceV != null) {
              const pct = (priceV - _dragAnchor.price) / _dragAnchor.price * 100;
              const clr = pct >= 0 ? '#26a69a' : '#ef5350';
              const fmt = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
              out += `<span style="color:#888">↔ ${_dragAnchor.date} <b style="color:#ccc">${fmt(_dragAnchor.price)}</b> → <b style="color:${clr}">${fmt(priceV)}</b>　<b style="color:${clr}">${pct>=0?'+':''}${pct.toFixed(2)}%</b></span><br/>`;
            }
            return out;
          },
        },
        legend: {
          data: [...bandsSorted.map(x=>x.name),...(ma125DataPt?[maLabelPt]:[]),...(vixIdxPt>=0?["VIX"]:[]),...(fgIdxPt>=0?["F&G"]:[])],
          textStyle: { color: tipText, fontSize: 13 }, top: 6,
        },
        grid: [
          { left:isMobPt?45:72, right:gridRPt, top:48, bottom:'38%' },
          { left:isMobPt?45:72, right:50, top:'65%', bottom:'22%' },
          { left:isMobPt?45:72, right:50, top:'81%', bottom:36 },
        ],
        xAxis: [
          { gridIndex:0, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
          { gridIndex:1, type:"time", axisLabel:{show:false}, splitLine:{show:false} },
          { gridIndex:2, type:"time", axisLine:{lineStyle:{color:axisClr}}, axisLabel:{fontSize:isMobPt?10:12}, splitLine:{show:false} },
        ],
        yAxis: yAxisPt,
        dataZoom: [
          { type:"inside", xAxisIndex:[0,1,2] },
          { type:"slider", height:18, bottom:14, xAxisIndex:[0,1,2] },
        ],
        series: [
          ...bandsSorted,
          ...(ma125DataPt ? [{ ...lineBase, name:maLabelPt, data:ma125DataPt, xAxisIndex:0, yAxisIndex:0, lineStyle:{width:2,color:"#ff9800"}, itemStyle:{color:"#ff9800"} }] : []),
          ...(vixIdxPt>=0 ? [{ ...lineBase, name:"VIX", data:vixDataPt, xAxisIndex:0, yAxisIndex:vixIdxPt, lineStyle:{width:1.5,color:"#f0883e",type:"dashed"}, itemStyle:{color:"#f0883e"}, areaStyle:{color:"rgba(240,136,62,0.06)"} }] : []),
          ...(fgIdxPt>=0  ? [{ ...lineBase, name:"F&G", data:fgDataPt,  xAxisIndex:0, yAxisIndex:fgIdxPt,  lineStyle:{width:1.5,color:"#e3b341",type:"dashed"}, itemStyle:{color:"#e3b341"}, areaStyle:{color:"rgba(227,179,65,0.06)"} }] : []),
          ...(rsiDataPt.length ? [{ type:'line', name:'RSI', xAxisIndex:1, yAxisIndex:rsiIdxPt, data:rsiDataPt, showSymbol:false, lineStyle:{width:1.5,color:'#a371f7'}, itemStyle:{color:'#a371f7'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:70,label:{formatter:'70',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:30,label:{formatter:'30',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} }] : []),
          ...(kdDataPt.length ? [
            { type:'line', name:'K', xAxisIndex:2, yAxisIndex:kdIdxPt, data:kdDataPt.map(r=>[r[0],r[1]]), showSymbol:false, lineStyle:{width:1.5,color:'#f0883e'}, itemStyle:{color:'#f0883e'}, markLine:{silent:true,symbol:['none','none'],animation:false,data:[{yAxis:80,label:{formatter:'80',fontSize:9},lineStyle:{color:'#f85149',type:'dashed',width:1,opacity:0.5}},{yAxis:20,label:{formatter:'20',fontSize:9},lineStyle:{color:'#3fb950',type:'dashed',width:1,opacity:0.5}}]} },
            { type:'line', name:'D', xAxisIndex:2, yAxisIndex:kdIdxPt, data:kdDataPt.map(r=>[r[0],r[2]]), showSymbol:false, lineStyle:{width:1.5,color:'#79c0ff',type:'dashed'}, itemStyle:{color:'#79c0ff'} },
          ] : []),
          ...tdSeriesPt,
        ],
      }, { notMerge: true });

      statusEl.textContent =
        `${pentaActiveTicker} 五線譜 · ${pentaPeriod} · 線性迴歸通道 · ${data.length} 筆${pentaWeekly ? "週" : "日"}線 · 目前：${zoneName}${deviationStr ? ` · ${maLabelPt} 乖離：${deviationStr}` : ""}`;
      attachDragMeasure(pentaChart);
    }

    // ── Pentagram ticker picker ────────────────────────────────────
    function renderPentaTickerPicker() {
      const wrap = document.getElementById("penta-ticker-picker");
      wrap.innerHTML = "";
      for (const key of PENTA_TICKERS) {
        const s  = SERIES.find(x => x.key === key);
        const on = pentaActiveTicker === key;
        const el = document.createElement("span");
        el.className = "chip";
        el.textContent = key;
        el.style.borderColor = on ? s.color : "";
        el.style.color       = on ? s.color : "";
        el.onclick = async () => {
          pentaActiveTicker = key;
          renderPentaTickerPicker();
          if (!loaded[key]) {
            document.getElementById("penta-status").textContent = "載入中…";
            await loadSeries(s);
          }
          renderPentagram();
        };
        wrap.appendChild(el);
      }
    }

    // ── Pentagram period picker ────────────────────────────────────
    document.getElementById("penta-period-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-period]");
      if (!t) return;
      pentaPeriod = t.dataset.period;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      renderPentagram();
    });

    // ── Pentagram mode picker ──────────────────────────────────────
    document.getElementById("penta-mode-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-mode]");
      if (!t) return;
      pentaMode = t.dataset.mode;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      renderPentagram();
    });

    // ── Pentagram VIX toggle ───────────────────────────────────────
    document.getElementById("penta-vix-toggle").addEventListener("click", async () => {
      pentaVixActive = !pentaVixActive;
      document.getElementById("penta-vix-toggle").classList.toggle("vix-on", pentaVixActive);
      if (pentaVixActive && !loaded["VIX_H"]) {
        const resp = await fetch("data/VIX.json", { cache: "no-cache" });
        const j = await resp.json();
        loaded["VIX_H"] = (j.data || []).map(r => [r.date, r.high]);
      }
      renderPentagram();
    });

    // ── Pentagram F&G toggle ───────────────────────────────────────
    document.getElementById("penta-fg-toggle").addEventListener("click", async () => {
      pentaFgActive = !pentaFgActive;
      document.getElementById("penta-fg-toggle").classList.toggle("fg-on", pentaFgActive);
      if (pentaFgActive && !loaded["F&G"]) {
        await loadSeries(SERIES.find(x => x.key === "F&G"));
      }
      renderPentagram();
    });

    // ── Pentagram MA toggle ────────────────────────────────────────
    document.getElementById("penta-ma125-toggle").addEventListener("click", () => {
      penta125Active = !penta125Active;
      document.getElementById("penta-ma125-toggle").classList.toggle("ma125-on", penta125Active);
      renderPentagram();
    });

    // ── Pentagram weekly toggle ────────────────────────────────────
    document.getElementById("penta-weekly-toggle").addEventListener("click", () => {
      pentaWeekly = !pentaWeekly;
      document.getElementById("penta-weekly-toggle").classList.toggle("active", pentaWeekly);
      renderPentagram();
    });

    // ── Macro: yield curve ─────────────────────────────────────────
    function filterMacroRange(rows) {
      if (macroRangePreset === "MAX") return rows;
      const d = new Date();
      if      (macroRangePreset === "5Y")  d.setFullYear(d.getFullYear() - 5);
      else if (macroRangePreset === "10Y") d.setFullYear(d.getFullYear() - 10);
      else if (macroRangePreset === "20Y") d.setFullYear(d.getFullYear() - 20);
      const from = d.toISOString().slice(0, 10);
      return rows.filter(r => r[0] >= from);
    }

    async function loadMacroData() {
      for (const stem of ["US10Y", "US2Y", "M2", "CAPE"]) {
        if (macroLoaded[stem]) continue;
        const resp = await fetch(`data/${stem}.json`, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`${stem}: HTTP ${resp.status}`);
        const j = await resp.json();
        macroLoaded[stem] = (j.data || []).map(r => [r.date, r.value]);
      }
    }

    function renderMacroTab() {
      if (!macroChart) return;
      const statusEl = document.getElementById("macro-status");
      const us10y = macroLoaded["US10Y"];
      const us2y  = macroLoaded["US2Y"];
      if (!us10y || !us2y) { statusEl.textContent = "數據未載入"; return; }

      const map2y = new Map(us2y.map(r => [r[0], r[1]]));
      const spreadRaw = [];
      for (const [date, v10] of us10y) {
        const v2 = map2y.get(date);
        if (v2 != null) spreadRaw.push([date, +(v10 - v2).toFixed(4)]);
      }

      const y10f    = filterMacroRange(us10y);
      const y2f     = filterMacroRange(us2y);
      const spreadF = filterMacroRange(spreadRaw);

      const invZones = [];
      let invStart = null, invLast = null;
      for (const [date, v] of spreadF) {
        if (v < 0)    { if (!invStart) invStart = date; invLast = date; }
        else if (invStart) { invZones.push([invStart, invLast]); invStart = null; }
      }
      if (invStart) invZones.push([invStart, invLast]);

      const markAreaData = invZones.map(([s, e]) => [
        { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.12)" } },
        { xAxis: e },
      ]);

      const axisClr = tc("#8b949e", "#57606a");
      const gridClr = tc("#21262d", "#e1e4e8");
      const tipBg   = tc("#161b22", "#ffffff");
      const tipBdr  = tc("#30363d", "#d0d7de");
      const tipText = tc("#e6edf3", "#1f2328");
      const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

      // Build dynamic right-axis overlays
      const yAxisList = [
        { scale: true, axisLine: { lineStyle: { color: axisClr } },
          axisLabel: { formatter: v => v + "%", fontSize: 12 },
          splitLine: { lineStyle: { color: gridClr } } },
      ];
      let m2AxisIdx = -1, capeAxisIdx = -1;
      if (macroShowM2) {
        m2AxisIdx = yAxisList.length;
        yAxisList.push({ scale: true, position: "right", offset: 0,
          axisLine: { lineStyle: { color: "#3fb950" } },
          axisLabel: { formatter: v => v + "%", fontSize: 11, color: "#3fb950" },
          splitLine: { show: false } });
      }
      if (macroShowCAPE) {
        capeAxisIdx = yAxisList.length;
        yAxisList.push({ scale: true, position: "right", offset: macroShowM2 ? (mob() ? 42 : 70) : 0,
          axisLine: { lineStyle: { color: "#a371f7" } },
          axisLabel: { fontSize: 11, color: "#a371f7" },
          splitLine: { show: false } });
      }
      const yAxisCfg = yAxisList.length === 1 ? yAxisList[0] : yAxisList;

      const overlayCount = (macroShowM2 ? 1 : 0) + (macroShowCAPE ? 1 : 0);
      const gridRight = mob()
        ? (overlayCount === 0 ? 12 : overlayCount === 1 ? 42 : 80)
        : (overlayCount === 0 ? 24 : overlayCount === 1 ? 72 : 130);

      let m2yoyF = [];
      if (macroShowM2 && macroLoaded["M2"]) m2yoyF = filterMacroRange(computeM2YoY(macroLoaded["M2"]));

      let capeF = [];
      if (macroShowCAPE && macroLoaded["CAPE"]) capeF = filterMacroRange(macroLoaded["CAPE"]);

      const legendData = ["美債10Y", "美債2Y", "利差 10Y-2Y"];
      if (macroShowM2)   legendData.push("M2年增率");
      if (macroShowCAPE) legendData.push("CAPE");

      const seriesList = [
        { ...lineBase, name: "美債10Y", data: y10f, yAxisIndex: 0,
          lineStyle: { width: 1.8, color: "#58a6ff" }, itemStyle: { color: "#58a6ff" } },
        { ...lineBase, name: "美債2Y",  data: y2f,  yAxisIndex: 0,
          lineStyle: { width: 1.8, color: "#f778ba" }, itemStyle: { color: "#f778ba" } },
        { ...lineBase, name: "利差 10Y-2Y", data: spreadF, yAxisIndex: 0,
          lineStyle: { width: 1.5, color: "#e3b341", type: "dashed" },
          itemStyle: { color: "#e3b341" },
          markArea: { silent: true, data: markAreaData },
          markLine: { silent: true, symbol: "none",
            data: [{ yAxis: 0, lineStyle: { color: "rgba(239,68,68,0.55)", type: "solid", width: 1 } }],
            label: { show: false } },
        },
      ];
      if (macroShowM2)   seriesList.push({ ...lineBase, name: "M2年增率", data: m2yoyF,
        yAxisIndex: m2AxisIdx, lineStyle: { width: 1.5, color: "#3fb950" }, itemStyle: { color: "#3fb950" } });
      if (macroShowCAPE) seriesList.push({ ...lineBase, name: "CAPE", data: capeF,
        yAxisIndex: capeAxisIdx, lineStyle: { width: 1.5, color: "#a371f7" }, itemStyle: { color: "#a371f7" },
        markLine: { silent: true, symbol: "none",
          data: [{ yAxis: 16.8, lineStyle: { color: "rgba(163,113,247,0.45)", type: "dashed", width: 1 } }],
          label: { formatter: "均值 16.8", color: "#a371f7", fontSize: 10, position: "insideEndTop" } },
      });

      macroChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis", axisPointer: { type: "cross" },
          backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
          formatter(params) {
            const ts = params[0]?.axisValue;
            const dateLabel = ts ? tsToLocalDate(ts) : "";
            let out = `<b>${dateLabel}</b><br/>`;
            for (const p of params) {
              if (p.seriesName.startsWith("__")) continue;
              const v = p.value?.[1];
              if (v == null) continue;
              const unit = p.seriesName === "CAPE" ? "" : "%";
              out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${v.toFixed(2)}${unit}</b><br/>`;
            }
            return out;
          },
        },
        legend: { data: legendData, textStyle: { color: tipText }, top: 6 },
        grid: { left: mob() ? 45 : 72, right: gridRight, top: 44, bottom: 56 },
        xAxis: { type: "time", axisLine: { lineStyle: { color: axisClr } }, splitLine: { show: false } },
        yAxis: yAxisCfg,
        dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 14 }],
        series: seriesList,
      }, { notMerge: true });

      const latestSpread = spreadF.at(-1)?.[1];
      const spreadStr = latestSpread != null
        ? `${latestSpread >= 0 ? "+" : ""}${latestSpread.toFixed(2)}%` : "—";
      const latestDate = y10f.at(-1)?.[0] ?? "—";
      statusEl.textContent =
        `美債殖利率曲線 · ${macroRangePreset} · 目前利差 ${spreadStr} · 倒掛事件 ${invZones.length} 次 · 最新 ${latestDate}`;
    }

    document.getElementById("m2-toggle").addEventListener("click", () => {
      macroShowM2 = !macroShowM2;
      document.getElementById("m2-toggle").classList.toggle("active", macroShowM2);
      renderMacroTab();
    });

    document.getElementById("cape-toggle").addEventListener("click", () => {
      macroShowCAPE = !macroShowCAPE;
      document.getElementById("cape-toggle").classList.toggle("active", macroShowCAPE);
      renderMacroTab();
    });

    document.getElementById("macro-range-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-macro-range]");
      if (!t) return;
      macroRangePreset = t.dataset.macroRange;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      renderMacroTab();
    });

    // ── Sector rotation ────────────────────────────────────────────
    async function loadSectorData() {
      await Promise.all(SECTOR_ETFS.map(async etf => {
        if (sectorLoaded[etf]) return;
        const resp = await fetch(`data/${etf}.json`, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`${etf}: HTTP ${resp.status}`);
        const j = await resp.json();
        sectorLoaded[etf] = (j.data || []).map(r => [r.date, r.close]);
      }));
    }

    function sectorReturn(data, nDays, ytd) {
      if (!data || data.length < 2) return null;
      const latest = data[data.length - 1][1];
      if (ytd) {
        const yearStart = data[data.length - 1][0].slice(0, 4) + "-01-01";
        const base = data.find(r => r[0] >= yearStart);
        return base ? (latest / base[1] - 1) * 100 : null;
      }
      if (data.length <= nDays) return null;
      const base = data[data.length - 1 - nDays][1];
      return base > 0 ? (latest / base - 1) * 100 : null;
    }

    const SECTOR_PERIODS = ["1W","1M","3M","6M","YTD","1Y"];
    const SECTOR_DAYS    = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };

    async function renderSectorTab() {
      if (!sectorChart) return;
      const statusEl = document.getElementById("sector-status");
      statusEl.textContent = "載入中…";
      try { await loadSectorData(); } catch(e) { statusEl.textContent = `載入失敗：${e.message}`; return; }

      // Compute returns for each ETF × period
      const returns = {};
      for (const etf of SECTOR_ETFS) {
        returns[etf] = {};
        for (const p of SECTOR_PERIODS) {
          returns[etf][p] = p === "YTD"
            ? sectorReturn(sectorLoaded[etf], 0, true)
            : sectorReturn(sectorLoaded[etf], SECTOR_DAYS[p], false);
        }
      }

      // Sort ETFs by selected column
      const sortedETFs = [...SECTOR_ETFS].sort((a, b) => {
        const va = returns[a][sectorSortCol] ?? -Infinity;
        const vb = returns[b][sectorSortCol] ?? -Infinity;
        return vb - va;
      });

      // ECharts heatmap: rows = periods, cols = ETFs (sorted)
      const heatData = [];
      for (let pi = 0; pi < SECTOR_PERIODS.length; pi++) {
        for (let ei = 0; ei < sortedETFs.length; ei++) {
          const v = returns[sortedETFs[ei]][SECTOR_PERIODS[pi]];
          heatData.push([ei, pi, v != null ? +v.toFixed(2) : null]);
        }
      }

      const maxAbs = heatData.reduce((m, d) => d[2] != null ? Math.max(m, Math.abs(d[2])) : m, 1);
      const tipBg   = tc("#161b22","#ffffff"), tipBdr = tc("#30363d","#d0d7de");
      const tipText = tc("#e6edf3","#1f2328"), axisClr = tc("#8b949e","#57606a");

      const xLabels = sortedETFs.map(e => mob() ? e : `${SECTOR_LABEL[e]}\n${e}`);

      sectorChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
          formatter: p => {
            const v = p.value?.[2];
            const etf = sortedETFs[p.value?.[0]];
            const per = SECTOR_PERIODS[p.value?.[1]];
            if (v == null || !etf) return "";
            return `<b>${etf} ${SECTOR_LABEL[etf]}</b><br/>${per}: <b style="color:${v>=0?"#3fb950":"#f78166"}">${v>=0?"+":""}${v.toFixed(2)}%</b>`;
          },
        },
        visualMap: {
          min: -maxAbs, max: maxAbs, calculable: false,
          orient: "horizontal", left: "center", bottom: 10,
          itemWidth: 12, itemHeight: 120,
          text: ["+", "−"], textStyle: { color: tipText, fontSize: 11 },
          inRange: { color: ["#c62828","#ef9a9a","#f5f5f5","#a5d6a7","#1b5e20"] },
        },
        grid: { top: 16, bottom: 72, left: mob() ? 40 : 56, right: 16 },
        xAxis: {
          type: "category", data: xLabels, splitArea: { show: true },
          axisLine: { lineStyle: { color: axisClr } },
          axisLabel: { color: tipText, fontSize: 11, interval: 0 },
        },
        yAxis: {
          type: "category", data: SECTOR_PERIODS, splitArea: { show: true },
          axisLine: { lineStyle: { color: axisClr } },
          axisLabel: { color: tipText, fontSize: 12 },
        },
        series: [{
          type: "heatmap", data: heatData,
          label: {
            show: !mob(), fontSize: 11,
            formatter: p => p.value?.[2] != null ? (p.value[2] >= 0 ? "+" : "") + p.value[2].toFixed(1) + "%" : "—",
          },
          emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
        }],
      }, { notMerge: true });

      const latest = SECTOR_ETFS.map(e => sectorLoaded[e]?.at(-1)?.[0]).filter(Boolean).sort().at(-1) ?? "—";
      statusEl.textContent = `美股11大產業 ETF · 以${sectorSortCol}排序 · 資料截至 ${latest}`;
    }

    document.getElementById("sector-sort-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-sector-col]");
      if (!t) return;
      sectorSortCol = t.dataset.sectorCol;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      renderSectorTab();
    });

    // ── 現金王 tab ────────────────────────────────────────────────
    async function loadCKData() {
      const allAssets = [...CK_ASSETS,
        ...CK_ASSETS_3.filter(a => !CK_ASSETS.some(b => b.key === a.key))];
      await Promise.all([
        ...allAssets.map(async ({ key, file }) => {
          if (ckRaw[key]) return;
          const resp = await fetch(file, { cache: "no-cache" });
          if (!resp.ok) throw new Error(`${key}: HTTP ${resp.status}`);
          const j = await resp.json();
          ckRaw[key] = (j.data || []).map(r => [r.date, r.close]);
        }),
        (async () => {
          if (ckRaw["F&G"]) return;
          const resp = await fetch("data/fear_greed.json", { cache: "no-cache" });
          if (!resp.ok) throw new Error("F&G: HTTP " + resp.status);
          const j = await resp.json();
          ckRaw["F&G"] = (j.data || []).map(r => [r.date, r.value]);
        })(),
      ]);
    }

    function ckWeekStart(dateStr) {
      const d = new Date(dateStr + "T12:00:00Z");
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
      return d.toISOString().slice(0, 10);
    }

    function ckWeeklyCloses(data) {
      const m = {};
      for (const [d, c] of data) m[ckWeekStart(d)] = c;
      return m;
    }

    function computeCKWeekly(assets, startDate) {
      const n = assets.length;
      const closes = {};
      for (const { key } of assets) {
        closes[key] = ckRaw[key] ? ckWeeklyCloses(ckRaw[key]) : {};
      }

      // F&G min per week
      const fgWk = {};
      for (const [d, v] of (ckRaw["F&G"] || [])) {
        const w = ckWeekStart(d);
        if (!(w in fgWk) || v < fgWk[w]) fgWk[w] = v;
      }

      // 逃往黃金: all non-gold assets down, gold asset up
      const goldKey = (assets.find(a => a.isGold) || {}).key;
      const ftgKeys = assets.map(a => a.key).filter(k => k !== goldKey);

      const weeks = Object.keys(closes["QQQ"]).filter(w => w >= startDate).sort();

      const rows = [];
      for (let i = 8; i < weeks.length; i++) {
        const w = weeks[i], wPrev = weeks[i - 1];
        const w4 = weeks[i - 4], w8 = weeks[i - 8];

        const weekRets = {}, cum4Rets = {}, cum8Rets = {};
        let weekDown = 0, cum4Down = 0, cum8Down = 0;

        for (const { key } of assets) {
          const cW = closes[key][w], cP = closes[key][wPrev];
          const c4 = closes[key][w4], c8 = closes[key][w8];
          weekRets[key] = (cP && cW) ? (cW - cP) / cP : null;
          cum4Rets[key] = (c4 && cW) ? (cW - c4) / c4 : null;
          cum8Rets[key] = (c8 && cW) ? (cW - c8) / c8 : null;
          if (weekRets[key] != null && weekRets[key] < 0) weekDown++;
          if (cum4Rets[key] != null && cum4Rets[key] < 0) cum4Down++;
          if (cum8Rets[key] != null && cum8Rets[key] < 0) cum8Down++;
        }

        // F&G min across 4-week and 8-week windows
        let fgMin4w = null, fgMin8w = null;
        for (let j = i - 7; j <= i; j++) {
          const v = fgWk[weeks[j]];
          if (v == null) continue;
          if (fgMin8w == null || v < fgMin8w) fgMin8w = v;
          if (j >= i - 3 && (fgMin4w == null || v < fgMin4w)) fgMin4w = v;
        }

        const cNow = closes["QQQ"][w];
        const cF4  = i + 4 < weeks.length ? closes["QQQ"][weeks[i + 4]] : null;
        const cF8  = i + 8 < weeks.length ? closes["QQQ"][weeks[i + 8]] : null;

        const ftg4w = goldKey && ftgKeys.every(k => cum4Rets[k] != null && cum4Rets[k] < 0)
          && cum4Rets[goldKey] != null && cum4Rets[goldKey] > 0;
        const ftg8w = goldKey && ftgKeys.every(k => cum8Rets[k] != null && cum8Rets[k] < 0)
          && cum8Rets[goldKey] != null && cum8Rets[goldKey] > 0;

        rows.push({
          w, weekRets, cum4Rets, cum8Rets,
          weekDown, cum4Down, cum8Down,
          fgMin4w, fgMin8w, ftg4w, ftg8w,
          fwd4w: (cNow && cF4) ? (cF4 / cNow - 1) : null,
          fwd8w: (cNow && cF8) ? (cF8 / cNow - 1) : null,
        });
      }
      return rows;
    }

    function ckActiveAssets() { return ckAssetMode === "3a" ? CK_ASSETS_3 : CK_ASSETS; }
    function getCKData() {
      if (ckAssetMode === "3a") {
        if (!ckData3a) ckData3a = computeCKWeekly(CK_ASSETS_3, "2002-08-01");
        return ckData3a;
      }
      if (!ckData4a) ckData4a = computeCKWeekly(CK_ASSETS, "2014-10-01");
      return ckData4a;
    }

    function renderCKTab() {
      const data = getCKData();
      if (!data) return;
      const assets = ckActiveAssets();
      const n = assets.length;
      const pct = v => v != null ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "—";
      const clr = v => v == null ? "" : v >= 0 ? "pos" : "neg";
      const use4w = ckMode === "4w";
      const wn = ckWindow;
      const cumRetsKey = wn === 8 ? "cum8Rets" : "cum4Rets";
      const cumDownKey = wn === 8 ? "cum8Down" : "cum4Down";
      const fgMinKey   = wn === 8 ? "fgMin8w"  : "fgMin4w";
      const ftgKey     = wn === 8 ? "ftg8w"    : "ftg4w";
      const startLabel = ckAssetMode === "3a" ? "2002/08" : "2014/10";

      // Update description + filter chip labels
      document.getElementById("ck-desc").textContent =
        ckAssetMode === "3a"
          ? "黃金期貨 · TLT · QQQ — 累積同跌 · 現金為王訊號 · 2002/08 起"
          : "GLD · BTC · TLT · QQQ — 累積同跌 · 現金為王訊號";
      document.getElementById("ck-filter-picker").innerHTML = `
        <span class="chip ${ckFilter==="all"?"active":""}" data-ck-filter="all" data-tooltip="顯示所有週次，不篩選">全部</span>
        <span class="chip ${ckFilter==="3"?"active":""}" data-ck-filter="3" data-tooltip="${n}資產中至少${n-1}個同週下跌">≥${n-1}/${n} 跌</span>
        <span class="chip ${ckFilter==="4"?"active":""}" data-ck-filter="4" data-tooltip="${n}資產全部同週下跌，現金為王時刻最強訊號">${n}/${n} 全跌</span>
      `;

      const ckAllN = data.filter(r => r[cumDownKey] === n);
      const signalRows = ckAllN.filter(r => r[fgMinKey] != null && r[fgMinKey] < 25);
      const flightRows = data.filter(r => r[ftgKey] && r[fgMinKey] != null && r[fgMinKey] < 25);
      const f4 = ckAllN.filter(r => r.fwd4w != null), f8 = ckAllN.filter(r => r.fwd8w != null);
      const avg4w = f4.length ? f4.reduce((s, r) => s + r.fwd4w, 0) / f4.length : null;
      const avg8w = f8.length ? f8.reduce((s, r) => s + r.fwd8w, 0) / f8.length : null;

      document.getElementById("ck-summary").innerHTML = `
        <span>${n}/${n} 全跌（${wn}週）<span class="ck-stat-val">${ckAllN.length}</span> 週</span>
        <span><span class="ck-badge">現金為王</span> +F&amp;G&lt;25：<span class="ck-stat-val">${signalRows.length}</span> 週</span>
        <span><span class="ck-badge-gold">逃往黃金</span> +F&amp;G&lt;25：<span class="ck-stat-val">${flightRows.length}</span> 週</span>
        <span>現金為王後4W QQQ：<span class="ck-stat-val ${clr(avg4w)}">${pct(avg4w)}</span></span>
        <span>現金為王後8W QQQ：<span class="ck-stat-val ${clr(avg8w)}">${pct(avg8w)}</span></span>
      `;

      const filtered = data.filter(r => {
        const dc = r[cumDownKey];
        if (ckFilter === "4") return dc === n;
        if (ckFilter === "3") return dc >= n - 1;
        return true;
      }).slice().reverse();

      const modeLabel = use4w ? `${wn}週累積` : "當週";
      document.getElementById("ck-head").innerHTML = `<tr>
        <th style="text-align:left">週(一)</th>
        ${assets.map(a => `<th style="color:${a.color}">${a.label||a.key}<br/><span style="font-weight:400;font-size:10px;opacity:.7">${modeLabel}</span></th>`).join("")}
        <th>${wn}週下跌</th>
        <th>F&amp;G低<br/><span style="font-weight:400;font-size:10px;opacity:.7">${wn}週內</span></th>
        <th>訊號</th>
      </tr>`;

      document.getElementById("ck-body").innerHTML = filtered.map(r => {
        const rets    = use4w ? r[cumRetsKey] : r.weekRets;
        const cumDown = r[cumDownKey];
        const fgMin   = r[fgMinKey];
        const isSignal = cumDown === n && fgMin != null && fgMin < 25;
        const isFlight = r[ftgKey] && fgMin != null && fgMin < 25;
        const rowCls   = isSignal ? "ck-row-4" : isFlight ? "ck-row-gold" : cumDown === n ? "ck-row-3" : "";
        const badge    = isSignal
          ? `<span class="ck-badge">現金為王</span>`
          : isFlight
            ? `<span class="ck-badge-gold">逃往黃金</span>`
            : cumDown === n ? `<span style="color:var(--muted);font-size:11px">${n}/${n}</span>` : "";
        const fgCls = fgMin != null && fgMin < 25 ? "fear-val" : "";
        return `<tr class="${rowCls}">
          <td style="text-align:left;font-weight:500;font-size:11px">${r.w}</td>
          ${assets.map(a => `<td class="${clr(rets[a.key])}">${pct(rets[a.key])}</td>`).join("")}
          <td style="color:var(--muted)">${cumDown}/${n}</td>
          <td class="${fgCls}">${fgMin != null ? fgMin : "—"}</td>
          <td>${badge}</td>
        </tr>`;
      }).join("");

      document.getElementById("ck-status").textContent =
        `顯示 ${filtered.length} 週 · 資料 ${startLabel} 起 · 訊號 = ${wn}週累積全跌 + F&G < 25`;
    }

    function renderBounceSection() {
      const section = document.getElementById("bounce-section");
      if (!section) return;
      const qqqD  = ckRaw["QQQ"] || [];
      const fgArr = ckRaw["F&G"] || [];
      if (!qqqD.length || !fgArr.length) { section.style.display = "none"; return; }

      const ma200 = computeMA(qqqD, 200);
      const { bounceSignals, bounceRetMap } = computeBounceSignals(qqqD, fgArr, ma200);

      const rows = bounceSignals.map(([date, close]) => {
        const info = bounceRetMap.get(date) ?? {};
        return { date, close, fg: info.fg, ret: info.ret, vsMa: info.vsMa };
      });

      const display = [...rows].reverse().slice(0, 30);
      document.getElementById("bounce-count").textContent =
        `歷史共 ${rows.length} 次，顯示最近 ${display.length} 次`;

      document.getElementById("bounce-head").innerHTML =
        `<tr style="color:var(--muted);font-size:.75rem">
           <th style="text-align:left;padding:3px 6px">日期</th>
           <th style="text-align:right;padding:3px 6px">QQQ</th>
           <th style="text-align:right;padding:3px 6px">單日漲幅</th>
           <th style="text-align:right;padding:3px 6px">F&amp;G</th>
           <th style="text-align:right;padding:3px 6px">vs MA200</th>
         </tr>`;

      document.getElementById("bounce-body").innerHTML = display.map(r =>
        `<tr style="border-top:1px solid rgba(255,255,255,.06)">
           <td style="padding:3px 6px">${r.date}</td>
           <td style="text-align:right;padding:3px 6px">$${r.close.toFixed(2)}</td>
           <td style="text-align:right;padding:3px 6px;color:#4ade80">+${(r.ret * 100).toFixed(2)}%</td>
           <td style="text-align:right;padding:3px 6px;color:#f87171">${r.fg}</td>
           <td style="text-align:right;padding:3px 6px;color:${r.vsMa != null && r.vsMa > 0 ? "#4ade80" : "#f87171"}">
             ${r.vsMa != null ? (r.vsMa > 0 ? "↑" : "↓") + Math.abs(r.vsMa).toFixed(1) + "%" : "—"}
           </td>
         </tr>`
      ).join("");

      section.style.display = rows.length ? "block" : "none";
    }

    async function initCKTab() {
      if (ckInited) { renderCKTab(); renderBounceSection(); return; }
      const statusEl = document.getElementById("ck-status");
      statusEl.textContent = "載入中…";
      try {
        await loadCKData();
        ckInited = true;
        renderCKTab();
        renderBounceSection();
      } catch (e) {
        statusEl.textContent = `載入失敗：${e.message}`;
      }
    }

    document.getElementById("ck-asset-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ck-asset]");
      if (!t) return;
      ckAssetMode = t.dataset.ckAsset;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      if (ckInited) renderCKTab();
    });

    document.getElementById("ck-filter-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ck-filter]");
      if (!t) return;
      ckFilter = t.dataset.ckFilter;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      if (ckInited) renderCKTab();
    });

    document.getElementById("ck-mode-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ck-mode]");
      if (!t) return;
      ckMode = t.dataset.ckMode;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      if (ckInited) renderCKTab();
    });

    document.getElementById("ck-window-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ck-window]");
      if (!t) return;
      ckWindow = +t.dataset.ckWindow;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      if (ckInited) renderCKTab();
    });

    // ── Correlation matrix ─────────────────────────────────────────
    async function renderCorrTab() {
      if (!corrChart) return;
      const statusEl = document.getElementById("corr-status");
      statusEl.textContent = "載入資料中…";

      try {
        await Promise.all(SERIES.map(loadSeries));
      } catch (e) {
        statusEl.textContent = `載入失敗：${e.message}`; return;
      }

      const d = new Date();
      if      (corrPeriod === "6M") d.setMonth(d.getMonth() - 6);
      else if (corrPeriod === "1Y") d.setFullYear(d.getFullYear() - 1);
      else if (corrPeriod === "2Y") d.setFullYear(d.getFullYear() - 2);
      else if (corrPeriod === "5Y") d.setFullYear(d.getFullYear() - 5);
      const fromDate = d.toISOString().slice(0, 10);

      // F&G is a 0–100 sentiment oscillator, not a price series — arithmetic
      // returns on a bounded index don't carry the same meaning as on prices.
      const keys = SERIES.map(s => s.key).filter(k => loaded[k] && k !== "F&G");

      // Arithmetic returns per ticker, filtered to period
      const retMaps = {};
      for (const k of keys) {
        const rets = toArithReturns(loaded[k]).filter(r => r[0] >= fromDate);
        retMaps[k] = new Map(rets.map(r => [r[0], r[1]]));
      }

      // Intersection of trading dates across all tickers
      const dateSets = Object.values(retMaps).map(m => new Set(m.keys()));
      let common = dateSets[0];
      for (const s of dateSets.slice(1)) common = new Set([...common].filter(x => s.has(x)));
      const dates = [...common].sort();

      if (dates.length < 30) {
        corrChart.clear();
        statusEl.textContent = "共同交易日不足（< 30）"; return;
      }

      const aligned = {};
      for (const k of keys) aligned[k] = dates.map(dt => retMaps[k].get(dt) ?? NaN);

      const heatData = [];
      for (let i = 0; i < keys.length; i++) {
        for (let j = 0; j < keys.length; j++) {
          const r = pearsonCorr(aligned[keys[i]], aligned[keys[j]]);
          heatData.push([j, i, isNaN(r) ? null : +r.toFixed(3)]);
        }
      }

      const tipBg   = tc("#161b22", "#ffffff");
      const tipBdr  = tc("#30363d", "#d0d7de");
      const tipText = tc("#e6edf3", "#1f2328");
      const axisClr = tc("#8b949e", "#57606a");

      corrChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item",
          backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
          formatter: p => {
            const v = p.value?.[2];
            if (v == null) return "";
            return `<b>${keys[p.value[1]]} × ${keys[p.value[0]]}</b><br/>r = <b>${v.toFixed(3)}</b>`;
          },
        },
        visualMap: {
          min: -1, max: 1, orient: "horizontal", left: "center", bottom: 14,
          itemWidth: 12, itemHeight: 100,
          text: ["+1", "−1"], textStyle: { color: tipText, fontSize: 11 },
          inRange: { color: ["#1565c0", "#c8d8f0", "#f5f5f5", "#f5c0c0", "#c62828"] },
        },
        grid: { top: 24, bottom: 72, left: mob() ? 40 : 56, right: 20 },
        xAxis: {
          type: "category", data: keys, splitArea: { show: true },
          axisLine: { lineStyle: { color: axisClr } },
          axisLabel: { color: tipText, fontSize: 12 },
        },
        yAxis: {
          type: "category", data: keys, splitArea: { show: true },
          axisLine: { lineStyle: { color: axisClr } },
          axisLabel: { color: tipText, fontSize: 12 },
        },
        series: [{
          type: "heatmap",
          data: heatData,
          label: {
            show: true,
            fontSize: 12,
            formatter: p => p.value?.[2] != null ? p.value[2].toFixed(2) : "—",
          },
          emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
        }],
      }, { notMerge: true });

      statusEl.textContent =
        `日報酬率相關係數 · ${corrPeriod} · ${dates.length} 個共同交易日 · 對角線 = 完全正相關`;
    }

    document.getElementById("corr-period-picker").addEventListener("click", e => {
      const t = e.target.closest(".chip[data-corr-period]");
      if (!t) return;
      corrPeriod = t.dataset.corrPeriod;
      for (const c of e.currentTarget.querySelectorAll(".chip"))
        c.classList.toggle("active", c === t);
      renderCorrTab();
    });


    // ── Init ───────────────────────────────────────────────────────
    (async () => {
      const status = document.getElementById("status");
      // default = light; override only if user explicitly saved dark
      if (localStorage.getItem("theme") === "dark") applyTheme(false);
      try {
        await Promise.all(SERIES.filter(s => active.has(s.key)).map(loadSeries));
        renderSeriesPicker();
        render();
        renderPentaTickerPicker();
        const lastDates = Object.values(loaded).map(d => d[d.length - 1]?.[0]).filter(Boolean);
        const latestDate = lastDates.sort().at(-1);
        const allFresh = Object.values(loaded).every(isDataFresh);
        status.textContent = `已載入 ${Object.keys(loaded).length} 個指標 · 最新資料 ${latestDate}${allFresh ? "" : " ⚠ 部分資料可能過期"} · 點選 chip 切換顯示`;

        // Pre-load VIX for signal panel, macro data in background
        ensureLoaded("VIX").then(() => renderSignalPanel()).catch(() => {});
        loadMacroData().catch(() => {});
        renderSignalPanel();

      } catch (err) {
        status.textContent = `載入失敗：${err.message}`;
      }
    })();

    // ── 情緒 tab ───────────────────────────────────────────────────

    async function initSentimentTab() {
      const status = document.getElementById("sent-status");
      if (sentData) { renderSentimentTab(); return; }
      status.textContent = "載入中…";
      try {
        const [sResp, spyResp, fgResp] = await Promise.all([
          fetch("data/sentiment.json"),
          fetch("data/SPY.json"),
          fetch("data/fear_greed.json"),
        ]);
        sentData = await sResp.json();
        const spyJson = await spyResp.json();
        const fgJson  = await fgResp.json();
        sentData._spy = {};
        for (const r of spyJson.data) sentData._spy[r.date] = r.close;
        sentData._fg = {};
        for (const r of fgJson.data) sentData._fg[r.date] = r.value;

        document.querySelectorAll("[data-sent-range]").forEach(el => {
          el.addEventListener("click", () => {
            sentRangePreset = el.dataset.sentRange;
            document.querySelectorAll("[data-sent-range]").forEach(e =>
              e.classList.toggle("active", e.dataset.sentRange === sentRangePreset));
            renderSentimentChart();
          });
        });

        renderSentimentTab();
        status.textContent = `已載入 ${sentData.data.length} 日資料 · 更新至 ${sentData.updated}`;
      } catch (err) {
        status.textContent = `載入失敗：${err.message}`;
      }
    }

    function sentLabel(v) {
      if (v < 20) return "極度恐懼";
      if (v < 40) return "恐懼";
      if (v < 60) return "中性";
      if (v < 80) return "貪婪";
      return "極度貪婪";
    }

    function sentColor(v) {
      if (v < 20) return "#ef4444";
      if (v < 40) return "#f97316";
      if (v < 60) return "#eab308";
      if (v < 80) return "#22c55e";
      return "#16a34a";
    }

    function renderSentimentTab() {
      const lat = sentData.latest;
      document.getElementById("sent-score-label").textContent = sentLabel(lat.composite);
      document.getElementById("sent-score-label").style.color = sentColor(lat.composite);
      document.getElementById("sent-updated").textContent = `資料截至 ${lat.date}`;

      function setBar(id, val) {
        document.getElementById("bar-" + id).style.width = val + "%";
        document.getElementById("val-" + id).textContent = Math.round(val);
        document.getElementById("val-" + id).style.color = sentColor(val);
      }
      setBar("vix",    lat.vix_pct);
      setBar("credit", lat.credit_pct);
      setBar("trend",  lat.trend_pct);
      setBar("safety", lat.safety_pct);

      if (!sentGaugeChart) {
        sentGaugeChart = echarts.init(document.getElementById("sentiment-gauge"), isLight() ? null : "dark");
      }
      renderSentimentGauge(lat.composite);

      if (!sentChart) {
        sentChart = echarts.init(document.getElementById("sentiment-chart"), isLight() ? null : "dark");
        window.addEventListener("resize", () => sentChart && sentChart.resize());
      }
      renderSentimentChart();
      renderSentimentBacktest(sentData.backtest);
    }

    function renderSentimentGauge(score) {
      sentGaugeChart.setOption({
        backgroundColor: "transparent",
        series: [{
          type: "gauge",
          startAngle: 180, endAngle: 0,
          min: 0, max: 100,
          radius: "95%", center: ["50%", "82%"],
          axisLine: {
            lineStyle: {
              width: 20,
              color: [[0.2,"#ef4444"],[0.4,"#f97316"],[0.6,"#eab308"],[0.8,"#22c55e"],[1,"#16a34a"]]
            }
          },
          pointer: { length: "60%", width: 5, itemStyle: { color: "auto" } },
          axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
          detail: {
            offsetCenter: [0, "-25%"], fontSize: 42, fontWeight: 700,
            color: sentColor(score), formatter: v => Math.round(v)
          },
          title: { show: false },
          data: [{ value: Math.round(score) }],
        }]
      });
    }

    function renderSentimentChart() {
      if (!sentData || !sentChart) return;
      const fromDate = sentRangePreset === "all" ? null : (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - parseInt(sentRangePreset));
        return d.toISOString().slice(0, 10);
      })();
      const rows = fromDate ? sentData.data.filter(r => r.date >= fromDate) : sentData.data;

      const sentSeries = rows.map(r => [r.date, r.composite]);
      const spySeries  = rows.map(r => [r.date, sentData._spy[r.date] ?? null]).filter(r => r[1] != null);
      const fgSeries   = rows.map(r => [r.date, sentData._fg[r.date]  ?? null]).filter(r => r[1] != null);

      const tipBg = tc("#161b22","#ffffff"), tipBdr = tc("#30363d","#d0d7de");
      const tipTx = tc("#e6edf3","#1f2328"), axCl = tc("#8b949e","#57606a");
      const gridCl = tc("rgba(48,54,61,0.5)","rgba(208,215,222,0.4)");

      sentChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis",
          backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
          formatter: params => {
            const raw = params[0]?.axisValue;
            const date = raw ? tsToLocalDate(raw) : "";
            let html = `<b>${date}</b><br/>`;
            for (const p of params) {
              if (!p.value?.[1]) continue;
              const v = p.value[1];
              if (p.seriesName === "情緒指數")
                html += `<span style="color:${sentColor(v)}">● 情緒: <b>${v.toFixed(1)}</b> ${sentLabel(v)}</span><br/>`;
              else if (p.seriesName === "CNN F&G")
                html += `<span style="color:#e3b341">● CNN F&G: <b>${v.toFixed(0)}</b></span><br/>`;
              else
                html += `<span style="color:#58a6ff">● SPY: <b>$${v.toFixed(2)}</b></span><br/>`;
            }
            return html;
          }
        },
        legend: { data:["情緒指數","CNN F&G","SPY"], top:8, right:24, textStyle:{ color:axCl, fontSize:12 } },
        grid: { top:44, right: mob() ? 50 : 70, bottom:40, left: mob() ? 40 : 54 },
        xAxis: { type:"time", splitLine:{show:false}, axisLabel:{color:axCl,fontSize:11} },
        yAxis: [
          { type:"value", min:0, max:100, name:"情緒", nameTextStyle:{color:axCl,fontSize:11},
            splitLine:{lineStyle:{color:gridCl}}, axisLabel:{color:axCl,fontSize:11} },
          { type:"value", name:"SPY", nameTextStyle:{color:"#58a6ff",fontSize:11},
            position:"right", splitLine:{show:false}, axisLabel:{color:"#58a6ff",fontSize:11} },
        ],
        series: [
          {
            name:"情緒指數", type:"line", data:sentSeries, yAxisIndex:0, symbol:"none",
            lineStyle:{ color:"#f778ba", width:1.5 },
            areaStyle:{ color:{ type:"linear",x:0,y:0,x2:0,y2:1,
              colorStops:[{offset:0,color:"rgba(247,120,186,0.2)"},{offset:1,color:"rgba(247,120,186,0.01)"}] } },
            markArea:{ silent:true, data:[
              [{yAxis:0},{yAxis:25,itemStyle:{color:"rgba(239,68,68,0.07)"}}],
              [{yAxis:85},{yAxis:100,itemStyle:{color:"rgba(34,197,94,0.07)"}}],
            ]},
            markLine:{ silent:true, symbol:"none", data:[
              {yAxis:25,lineStyle:{color:"#ef4444",type:"dashed",width:1},
               label:{show:!mob(),formatter:"恐懼<25",color:"#ef4444",fontSize:10,position:"end"}},
              {yAxis:85,lineStyle:{color:"#22c55e",type:"dashed",width:1},
               label:{show:!mob(),formatter:"貪婪>85",color:"#22c55e",fontSize:10,position:"end"}},
            ]}
          },
          { name:"CNN F&G", type:"line", data:fgSeries, yAxisIndex:0, symbol:"none",
            lineStyle:{ color:"#e3b341", width:1.2, type:"dashed" } },
          { name:"SPY", type:"line", data:spySeries, yAxisIndex:1, symbol:"none",
            lineStyle:{ color:"#58a6ff", width:1.5 } },
        ],
        dataZoom:[
          {type:"inside",xAxisIndex:0},
          {type:"slider",xAxisIndex:0,height:18,bottom:4,
           fillerColor:"rgba(88,166,255,0.1)",borderColor:tc("#30363d","#d0d7de")},
        ],
      });
    }

    function renderSentimentBacktest(bt) {
      const thead = `<tr><th>日期</th><th>分數</th><th>1M SPY</th><th>3M SPY</th><th>6M SPY</th><th>1Y SPY</th></tr>`;
      function pct(v) {
        if (v == null) return `<span style="color:var(--muted)">—</span>`;
        return `<span class="${v>=0?"pos":"neg"}">${v>=0?"+":""}${v.toFixed(2)}%</span>`;
      }
      function buildTable(signals, thi, tbi) {
        document.getElementById(thi).innerHTML = thead;
        const tbody = document.getElementById(tbi);
        if (!signals.length) {
          tbody.innerHTML = `<tr><td colspan="6" style="color:var(--muted);text-align:center">無訊號</td></tr>`;
          return;
        }
        const keys = ["spy_ret_1m","spy_ret_3m","spy_ret_6m","spy_ret_1y"];
        tbody.innerHTML = signals.map(s => `<tr>
          <td>${s.date}</td>
          <td style="color:${sentColor(s.composite)};font-weight:600">${s.composite.toFixed(1)}</td>
          ${keys.map(k => `<td>${pct(s[k])}</td>`).join("")}
        </tr>`).join("");
      }
      function buildStats(signals, sid) {
        const el = document.getElementById(sid);
        if (!signals.length) { el.innerHTML = ""; return; }
        const keys = ["spy_ret_1m","spy_ret_3m","spy_ret_6m","spy_ret_1y"];
        const labels = ["1個月後","3個月後","6個月後","1年後"];
        const avgs = keys.map(k => {
          const vals = signals.map(s=>s[k]).filter(v=>v!=null);
          return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
        });
        el.innerHTML = `
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px">SPY 平均報酬（n=${signals.length} 個訊號）</div>
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            ${avgs.map((v,i)=>`<div>
              <div class="sent-stat-label">${labels[i]}</div>
              <div class="sent-stat-val" style="color:${v!=null&&v>=0?"#3fb950":"#f78166"}">
                ${v!=null?(v>=0?"+":"")+v.toFixed(2)+"%":"—"}
              </div>
            </div>`).join("")}
          </div>`;
      }
      buildTable(bt.fear_signals,  "sent-fear-thead",  "sent-fear-tbody");
      buildStats(bt.fear_signals,  "sent-fear-stats");
      buildTable(bt.greed_signals, "sent-greed-thead", "sent-greed-tbody");
      buildStats(bt.greed_signals, "sent-greed-stats");
    }
    // ── 市場廣度 tab ───────────────────────────────────────────────

    function breadthSignal(pct, is200) {
      if (pct == null) return { label: "—", color: "var(--muted)" };
      if (is200) {
        if (pct >= 70) return { label: "長期多頭確認", color: "#3fb950" };
        if (pct >= 55) return { label: "偏多格局",     color: "#7ee787" };
        if (pct >= 35) return { label: "整理格局",     color: "#f0883e" };
        if (pct >= 20) return { label: "偏空格局",     color: "#f0883e" };
        return                { label: "長期空頭警戒", color: "#f85149" };
      }
      if (pct >= 75) return { label: "強勢多頭", color: "#3fb950" };
      if (pct >= 55) return { label: "多方主導", color: "#7ee787" };
      if (pct >= 35) return { label: "多空拉鋸", color: "#e3b341" };
      if (pct >= 20) return { label: "空方壓力", color: "#f0883e" };
      return               { label: "弱勢超賣", color: "#f85149" };
    }

    async function initBreadthTab() {
      const status = document.getElementById("breadth-status");
      if (breadthData) { renderBreadthChart(); return; }
      status.textContent = "載入中…";
      try {
        const [bResp, spyResp] = await Promise.all([
          fetch("data/breadth.json", { cache: "no-cache" }),
          fetch("data/SPY.json",     { cache: "no-cache" }),
        ]);
        if (!bResp.ok) throw new Error(`HTTP ${bResp.status}`);
        breadthData = await bResp.json();
        const spyJson = await spyResp.json();
        breadthSpy = {};
        for (const r of spyJson.data) breadthSpy[r.date] = r.close;

        document.querySelectorAll("[data-breadth-range]").forEach(el => {
          el.addEventListener("click", () => {
            breadthRange = el.dataset.breadthRange;
            document.querySelectorAll("[data-breadth-range]").forEach(e =>
              e.classList.toggle("active", e.dataset.breadthRange === breadthRange));
            renderBreadthChart();
          });
        });

        async function loadAndToggle(key, mapRef, file, btnId) {
          const active = key === "VIX" ? breadthVixActive : breadthFgActive;
          document.getElementById(btnId).classList.toggle("active", active);
          if (active && Object.keys(mapRef).length === 0) {
            try {
              const r = await fetch(file, { cache: "no-cache" });
              const j = await r.json();
              for (const row of (j.data || []))
                mapRef[row.date] = row.close !== undefined ? row.close : row.value;
            } catch (e) { console.warn("breadth overlay load failed:", e); }
          }
          renderBreadthChart();
        }

        document.getElementById("breadth-vix-toggle").addEventListener("click", () => {
          breadthVixActive = !breadthVixActive;
          loadAndToggle("VIX", breadthVixMap, "data/VIX.json", "breadth-vix-toggle");
        });
        document.getElementById("breadth-fg-toggle").addEventListener("click", () => {
          breadthFgActive = !breadthFgActive;
          loadAndToggle("F&G", breadthFgMap, "data/fear_greed.json", "breadth-fg-toggle");
        });

        const rows   = breadthData.data;
        const latest = rows[rows.length - 1];

        function setCard(suffix, pct, count, total, is200) {
          document.getElementById(`bc-${suffix}-pct`).textContent =
            pct != null ? pct.toFixed(1) : "—";
          document.getElementById(`bc-${suffix}-count`).textContent =
            count != null ? `${count} / ${total}` : "— / —";
          const sig = breadthSignal(pct, is200);
          const el  = document.getElementById(`bc-${suffix}-signal`);
          el.textContent  = sig.label;
          el.style.color  = sig.color;
        }
        setCard("50",  latest.above50_pct,  latest.above50_count,  latest.total, false);
        setCard("200", latest.above200_pct, latest.above200_count, latest.total, true);

        if (!breadthChart) {
          breadthChart = echarts.init(
            document.getElementById("breadth-chart"), isLight() ? null : "dark");
          setupResizeHandler();
        }
        renderBreadthChart();
        status.textContent =
          `S&P 500 市場廣度 · ${rows.length} 個交易日 · 更新至 ${breadthData.updated}`;
      } catch (err) {
        status.textContent = `載入失敗：${err.message}`;
      }
    }

    // ── Earnings calendar ──────────────────────────────────────────
    let earnCalYear  = new Date().getFullYear();
    let earnCalMonth = new Date().getMonth(); // 0-based

    async function renderEarningsCalendar() {
      const el = document.getElementById("earnings-cal");
      if (!el) return;
      if (!loadedEarnings.length) {
        el.innerHTML = '<p style="color:var(--muted);padding:16px">載入中…</p>';
        await loadEarnings();
      }

      const today = new Date().toISOString().slice(0, 10);
      // Build date → { earn: [], conf: [] } lookup
      const byDate = {};
      for (const e of loadedEarnings) {
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
      document.getElementById("earn-month-label").textContent =
        `${earnCalYear}年${earnCalMonth + 1}月`;
    }

    document.getElementById("earn-prev").addEventListener("click", () => {
      earnCalMonth--;
      if (earnCalMonth < 0) { earnCalMonth = 11; earnCalYear--; }
      renderEarningsCalendar();
    });
    document.getElementById("earn-next").addEventListener("click", () => {
      earnCalMonth++;
      if (earnCalMonth > 11) { earnCalMonth = 0; earnCalYear++; }
      renderEarningsCalendar();
    });

    function renderBreadthChart() {
      if (!breadthData || !breadthChart) return;
      const axisClr = tc("#8b949e", "#57606a");
      const gridClr = tc("#21262d", "#e1e4e8");
      const tipBg   = tc("#161b22", "#ffffff");
      const tipBdr  = tc("#30363d", "#d0d7de");
      const tipText = tc("#e6edf3", "#1f2328");

      let rows = breadthData.data;
      if (breadthRange !== "MAX") {
        const years   = breadthRange === "1Y" ? 1 : breadthRange === "2Y" ? 2 : 3;
        const cutoff  = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - years);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        rows = rows.filter(r => r.date >= cutoffStr);
      }

      const dates    = rows.map(r => r.date);
      const above50  = rows.map(r => r.above50_pct  != null ? r.above50_pct  : null);
      const above200 = rows.map(r => r.above200_pct != null ? r.above200_pct : null);
      const spyVals  = rows.map(r => breadthSpy[r.date]   != null ? +breadthSpy[r.date].toFixed(2)   : null);
      const vixVals  = rows.map(r => breadthVixMap[r.date] != null ? +breadthVixMap[r.date].toFixed(2) : null);
      const fgVals   = rows.map(r => breadthFgMap[r.date]  != null ? +breadthFgMap[r.date].toFixed(1)  : null);

      // ── build dynamic yAxis list ──────────────────────────────────
      const yAxes = [
        { // [0] left: breadth %
          type: "value", min: 0, max: 100,
          splitLine: { lineStyle: { color: gridClr } },
          axisLine: { show: false },
          axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + "%" },
        },
        { // [1] right: SPY price
          type: "value", position: "right", offset: 0,
          splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: "#a371f7", fontSize: 10, formatter: v => "$" + v },
        },
      ];
      let overlayIdx = -1;
      if (breadthVixActive || breadthFgActive) {
        overlayIdx = yAxes.length;
        yAxes.push({
          type: "value", position: "right", offset: mob() ? 44 : 58,
          scale: true,
          splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { show: false },
        });
      }

      // ── tooltip formatter ─────────────────────────────────────────
      const overlayFmt = { VIX: v => v.toFixed(1), "F&G": v => v.toFixed(0) };

      breadthChart.setOption({
        backgroundColor: "transparent",
        tooltip: {
          trigger: "axis",
          backgroundColor: tipBg, borderColor: tipBdr,
          textStyle: { color: tipText, fontSize: 12 },
          formatter(params) {
            const d   = params[0].axisValue;
            const row = rows[params[0].dataIndex];
            let html  = `<div style="margin-bottom:4px;font-size:11px;color:${axisClr}">${d}</div>`;
            for (const p of params) {
              if (p.value == null) continue;
              let val;
              if (p.seriesName === "SPY")        val = `$${p.value.toFixed(2)}`;
              else if (p.seriesName === "VIX")   val = p.value.toFixed(1);
              else if (p.seriesName === "F&G")   val = p.value.toFixed(0);
              else                               val = `${p.value.toFixed(1)}%`;
              html += `<div>${p.marker}${p.seriesName}: <b>${val}</b></div>`;
            }
            if (row) html +=
              `<div style="margin-top:4px;font-size:11px;color:${axisClr}">` +
              `50MA: ${row.above50_count}/${row.total} · 200MA: ${row.above200_count ?? "—"}/${row.total}</div>`;
            return html;
          },
        },
        grid: { top: 28, bottom: 36, left: mob() ? 48 : 56,
                right: mob() ? 56 : (overlayIdx >= 0 ? 112 : 68) },
        xAxis: {
          type: "category", data: dates, boundaryGap: false,
          axisLine: { lineStyle: { color: axisClr } },
          axisTick: { show: false },
          axisLabel: { color: axisClr, fontSize: 11 },
        },
        yAxis: yAxes,
        series: [
          {
            name: "SPY",
            type: "line", data: spyVals, smooth: 0.3, symbol: "none",
            yAxisIndex: 1, z: 1,
            lineStyle: { width: 1.5, color: "#a371f7", opacity: 0.7 },
          },
          {
            name: "50日均線以上",
            type: "line", data: above50, smooth: 0.3, symbol: "none",
            yAxisIndex: 0, z: 3,
            lineStyle: { width: 2, color: "#58a6ff" },
            areaStyle: { color: "rgba(88,166,255,0.08)" },
            markLine: {
              silent: true, symbol: "none",
              data: [
                { yAxis: 20, lineStyle: { type: "dashed", color: "rgba(248,81,73,0.5)",  width: 1 },
                  label: { formatter: "20%", color: "#f85149", fontSize: 10, position: "insideEndTop" } },
                { yAxis: 50, lineStyle: { type: "dashed", color: "rgba(139,148,158,0.4)", width: 1 },
                  label: { formatter: "50%", color: axisClr,   fontSize: 10, position: "insideEndTop" } },
                { yAxis: 80, lineStyle: { type: "dashed", color: "rgba(63,185,80,0.5)",  width: 1 },
                  label: { formatter: "80%", color: "#3fb950",  fontSize: 10, position: "insideEndTop" } },
              ],
            },
            markArea: {
              silent: true,
              data: [
                [{ yAxis: 0,  itemStyle: { color: "rgba(248,81,73,0.06)" } }, { yAxis: 20  }],
                [{ yAxis: 80, itemStyle: { color: "rgba(63,185,80,0.06)"  } }, { yAxis: 100 }],
              ],
            },
          },
          {
            name: "200日均線以上",
            type: "line", data: above200, smooth: 0.3, symbol: "none",
            yAxisIndex: 0, z: 2,
            lineStyle: { width: 2, color: "#3fb950" },
            areaStyle: { color: "rgba(63,185,80,0.05)" },
          },
          ...(breadthVixActive ? [{
            name: "VIX",
            type: "line", data: vixVals, smooth: 0.3, symbol: "none",
            yAxisIndex: overlayIdx, z: 2,
            lineStyle: { width: 1.5, color: "#f0883e", type: "dashed" },
            areaStyle: { color: "rgba(240,136,62,0.06)" },
          }] : []),
          ...(breadthFgActive ? [{
            name: "F&G",
            type: "line", data: fgVals, smooth: 0.3, symbol: "none",
            yAxisIndex: overlayIdx, z: 2,
            lineStyle: { width: 1.5, color: "#e3b341", type: "dashed" },
            areaStyle: { color: "rgba(227,179,65,0.05)" },
          }] : []),
        ],
      }, { notMerge: true });
    }

    document.querySelectorAll(".info-panel-header").forEach(h => {
      h.addEventListener("click", () => {
        h.classList.toggle("open");
        h.nextElementSibling.classList.toggle("open");
      });
    });
