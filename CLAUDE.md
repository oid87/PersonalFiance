# CLAUDE.md — PersonalFiance

個人總經儀表板（長期願景：個人版財經 M 平方）。純前端 SPA：`index.html` + `js/boot.js` + `js/tabs/*.js`（ES module，目前 26 個 tab）+ ECharts (CDN)，無建置步驟。資料是 `data/*.json`，由 `scripts/fetch_*.py`（Python + yfinance/requests）抓取。本地預覽 `python -m http.server`。

## 資料更新管線（每天自動）

GitHub Actions `.github/workflows/fetch.yml` 每天自動跑、跑完 `git add data/` → commit → push：

- **06:00 台北（週二–週六）** — cron `0 22 * * 1-5`（美股收盤後）
- **18:00 台北（週一–週五）** — cron `0 10 * * 1-5`（台股收盤後）
- 也可手動 `workflow_dispatch`，或本地跑 `scripts/update_all.sh`（git pull → 所有 fetch → commit/push）。

每個 fetch 腳本：讀現有 `data/<x>.json` → 抓最新 → **idempotent 合併**（依日期，新蓋舊）→ 寫回。**新增資料來源時務必三處都加**：寫 `fetch_*.py` → 加進 `fetch.yml`（用 `continue-on-error: true`）→ 加進 `update_all.sh`。

FinMind 來源的腳本需 token：CI 用 GitHub secret `FINMIND_TOKEN`（workflow step 已設 env），本地讀 repo 根 `.finmind_token` 或 `../Financial_work/.finmind_token`。沒設則匿名（低額度，單次每日呼叫通常仍可）。

## Ground truth 原則

本文件**不再維護** tab／資料檔的完整對照表 — 歷史證明必 drift（上一版只覆蓋 26 個 tab 中的 7 個）。要查現況，直接看程式碼：

- `ls js/tabs/` = 目前所有 tab 清單
- `js/boot.js` 的 `CATEGORIES` 陣列 = 導覽結構（4 分類：sentiment／liquidity／position／analysis）；sub-nav 由 `renderSubNav()` 動態渲染，**`index.html` 沒有靜態 tab 按鈕**
- `ls scripts/` = 所有抓取腳本
- `.github/workflows/fetch.yml` = CI 實際跑的清單

## 不可變事實與陷阱

- **`VIX_early.json`** 是靜態檔（無對應 fetch 腳本），永不變、**必須保留在 repo，別刪**。
- 共用 `VIX.json` **不可亂改** — 多個 tab（情緒／相關係數等）依賴其百分位計算。
- 股價皆**原始收盤價**（`auto_adjust=False`）。
- `0050.TW` 有 2014 真實 4:1 分割造成的 yfinance 斷崖，`fetch_stocks.py` 的 `SPLICE_FIXES` 做 idempotent ratio-splice 修復。
- `fetch_stocks.py` 預設 `GLOBAL_START=2000`；需要更長歷史的 ticker 放進 `FULL_HISTORY` set（目前 `^GSPC`，從 1987 起 → `SP500.json`）。
- **AAII 官方 xls** 用 bare curl 會被 Incapsula 擋 403；Python `requests` 帶 `Referer: https://www.aaii.com/` + 完整瀏覽器 headers 才過得了。
- **散戶情緒 tab（`js/tabs/aaii.js`）** 用**指數 `^GSPC`**（`SP500.json`）而非 SPY ETF（SPY 1993 才上市、又被 GLOBAL_START 卡在 2000）。
- **CNN 恐懼貪婪無法早於 2011**（CNN 2012 才推出、只回填到 2011，硬限制）。

## 新增一個 tab

1. `js/tabs/<id>.js` — export `init`（首次切入載入）、選用 `onThemeChange(light)`、`resize()`。
2. `js/boot.js` 三處：`import * as xTab`、加進 `registerAll([...])`、在 `CATEGORIES` 選一個分類加入 `{ id, label }`。
3. `index.html` 加 `<section id="tab-<id>" class="tab-section" hidden>`（不用加 nav 按鈕，sub-nav 是動態渲染的）。
4. 主題色用 CSS 變數（`--bg/--panel/--border/--text/--muted`）。

詳細程序與 ECharts 眉角（axisValue 毫秒、雙 grid 同步、itemStyle.color）見 `.claude/skills/add-tab/`；新增資料源用 `.claude/skills/fetch-script/`。

<!-- JS_UTILS_CHEATSHEET_START -->
## js/utils 函式速查表(自動產生,勿手動編輯;來源:`../Financial_work/gen_cheatsheet.py`)

### theme.js(5)
- theme.isLight() — 
- theme.tc(dark, light) — 
- theme.mob() — 
- theme.PALETTE — Collapses the most common literal tc("#dark","#light") pairs repeated
- theme.echartsBase(overrides = {}) — 

### dates.js(11)
- dates.tsToLocalDate(ts) — ECharts time-axis parses "YYYY-MM-DD" as local midnight, not UTC
- dates.presetStart(preset) — 
- dates.cutoffDate(key) — 「今天往回 N 年」的 range cutoff(key: 1Y/3Y/5Y/10Y/MAX,未命中回 3 年)。
- dates.currentWindow() — 
- dates.filterRange(rows) — 
- dates.dateAddDays(dateStr, n) — 
- dates.closestOnOrAfter(key, dateStr) — 
- dates.minBetween(key, t0, t1) — 
- dates.lookupLE(arr, date) — Binary search: last entry where arr[i][0] <= date
- dates.toWeekly(dailyData) — 
- dates.toWeeklyHLC(dailyHLC) — 

### math.js(17)
- math.percentileRank(val, sortedAsc) — Binary-search rank of `val` within an ascending-sorted array
- math.percentile(sortedAsc, p) — Inverse of percentileRank: value at fraction `p` (0–1) of an
- math.mean(arr) — std uses ddof (delta degrees of freedom): divides by (n - ddof)
- math.std(arr, ddof = 0) — 
- math.zscore(arr, ddof = 0) — 
- math.computeMA(data, period) — 
- math.toArithReturns(data) — 
- math.pearsonCorr(x, y) — 
- math.computeM2YoY(m2data) — 
- math.computeLinearRegression(data) — 
- math.computeRSI(data, period = 14) — 
- math.computeKD(hlcData, period = 9) — 
- math.computeTDSetup(closeData) — 
- math.computeDDZones(dailyData, lookbackDays = 60, threshold = 0.10) — 
- math.computeBounceSignals(qqqData, fgData, ma200Data) — Bounce signal: QQQ < MA200 & F&G < 15 → 2%+ bounce within 14 days
- math.computeMACD(closes, fast = 12, slow = 26, signal = 9) — MACD: DIF = EMA(fast) - EMA(slow); DEA = EMA(DIF, signal); HIST = DIF - DEA
- math.computeChannelBands(weeklyAll) — 

### data.js(5)
- data.fetchJSON(url) — Generic fetch, not tied to the SERIES registry (unlike loadSeries below)
- data.isDataFresh(data) — 
- data.loadSeries(s) — 
- data.ensureLoaded(key) — 
- data.loadEarnings() — 

<!-- JS_UTILS_CHEATSHEET_END -->

## 部署

Vercel（personal-fiance-nine.vercel.app）連 GitHub `main`，push 即自動部署。**所有 `data/*.json` 必須 commit 進 repo**，前端才 fetch 得到。

## 協作模式(主模型通用:Fable/Opus/Sonnet)

標準迴圈:讀 memory 入口與本檔 → 用 write-spec skill 寫 spec(驗收條件要可機械核對)→ 實作交 executor subagent(sonnet, effort medium)→ 驗收交 verifier subagent(sonnet, effort high)→ 新結論/眉角收錄 memory。
- 主迴圈保持 context 乾淨:大量讀檔/盤點交 subagent,只收摘要。
- 同一判斷被糾正第二次 → 寫進本檔;同一套步驟重複第三次 → 做成 skill。目前 skills:add-tab、fetch-script。
- git:只 stage 該功能相關檔案,不要 git add -A;實作檔與 wiring 同一個 commit(教訓:twsectorflow 實作檔漏 add)。
