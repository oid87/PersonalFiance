# AGENTS.md — PersonalFiance

> 本檔由 `CLAUDE.md` 自動產生（`python3 scripts/sync_agent_docs.py`），**勿直接編輯**；要改請改 `CLAUDE.md` 後重跑。Codex / ChatGPT 讀本檔與 `.agents/skills/`，Claude Code 讀 `CLAUDE.md` 與 `.claude/skills/`，內容相同。

個人總經儀表板（長期願景：個人版財經 M 平方）。純前端 SPA：`index.html` + `js/boot.js` + `js/tabs/*.js`（ES module，數量以 `ls js/tabs/` 為準）+ ECharts (CDN)，無建置步驟。資料是 `data/*.json`，由 `scripts/fetch_*.py`（Python + yfinance/requests）抓取。本地預覽 `python -m http.server`。

## 工程知識與協作入口

先核對 [CURRENT_STATE](CURRENT_STATE.md) 的日期與 checkout，再按任務讀 [PROJECT_CONTEXT](PROJECT_CONTEXT.md)、[ARCHITECTURE](ARCHITECTURE.md) 的改動 map。
[AGENT_RULES](AGENT_RULES.md) 定義 file ownership、WIP 保護、PM → Coding → QA／Browser → PM review 與 artifact handoff；[TESTING](TESTING.md) 定義局部／全庫驗證與限制。
根文件是短索引，既有 runtime／source／navigation／UI 合約仍是詳細權威；memory 與歷史報告不能代替原碼或授權。

## 資料更新管線（每天自動）

GitHub Actions `.github/workflows/fetch.yml` 每天自動跑、跑完 `git add data/` → commit → push：

- **06:00 台北（週二–週六）** — cron `0 22 * * 1-5`（美股收盤後）
- **18:00 台北（週一–週五）** — cron `0 10 * * 1-5`（台股收盤後）
- 另有 `.github/workflows/forward_pe.yml`：**13:00 台北（週一–週五）** cron `0 5 * * 1-5`，只跑 `fetch_forward_pe.py`（VOO / QQQ），不在 `fetch.yml` 裡。
- 也可手動 `workflow_dispatch`。本地 `scripts/update_all.sh` = 所有 fetch（`fetch_forward_pe.py` 除外，只由 `forward_pe.yml` 跑）→ `validate_data.py`，**不 commit / 不 push、不切分支、不丟棄本地 data、不自動 pull**。`--dry-run` 只列步驟；明確指定 `--sync-data` 才在 main 且 data 無已追蹤／未追蹤變動時執行 `git pull --ff-only origin main`。本地資料只供 preview，仍由 Action 發佈。

每個 fetch 腳本：讀現有 `data/<x>.json` → 抓最新 → **idempotent 合併**（依日期，新蓋舊）→ 寫回。**新增資料來源時同步登錄** `scripts/source_manifest.json`（輸出、profile、路由、依賴）與實際 workflow／本地入口；生產來源加進 `fetch.yml` 及 `update_all.sh`，獨立排程／手動來源明確列例外。`scripts/check_pipeline.py` 驗路由與依賴，`scripts/validate_data.py` 驗資料契約；詳見 `docs/source-contracts.md`。

FinMind 來源的腳本需 token：CI 用 GitHub secret `FINMIND_TOKEN`（workflow step 已設 env），本地讀 repo 根 `.finmind_token` 或 `../Financial_work/.finmind_token`。沒設則匿名（低額度，單次每日呼叫通常仍可）。新腳本一律用 `_common.get_finmind_token()`，別再自寫查找。

### scripts 共用模組（2026-09-25 建立）

- `scripts/_common.py`：`get_finmind_token()`、`fetch_fred_csv(series_id, *, headers, timeout=30)`（回傳未 round 的 `[(date, float)]`，round／容器由呼叫端決定）、`load_rows_by_date(path)`（`{"data":[...]}` → `OrderedDict[date, row]`）、`load_rows(path)`（同上但回 list）、`idempotent_merge(existing_path, new_rows, key_field="date")`（整列新蓋舊；遇缺 key 的列中止並保留已讀部分，容錯和 `load_rows_by_date` 不同，別互換）、`retry_call(fn, *, attempts, backoff, retry_on, retry_if, on_retry, on_final)`（最後一次失敗後不 sleep；節流 sleep 留在 fn 內）。腳本直接 `import _common`，CI（repo 根跑 `python scripts/x.py`）與 `update_all.sh`（`cd scripts`）兩種呼叫都 resolve 得到，別加 `sys.path` hack。多條 FRED 序列組成一列的腳本（`fetch_real_rates`／`fetch_yield_curve`／`fetch_money_market`／`fetch_central_banks`）任一序列整條回空就 raise、保留舊檔——否則整列覆蓋會把其他日期的舊值蓋成 null。**`get_fred_api_key()`／`fred_csv_text(series_id, *, headers, timeout=30)`**（2026-09-26 加）：CI 上 GitHub Actions runner 的 IP 會被 FRED 的 `fredgraph.csv` 端點 Read timeout 擋下（本機不會），改走官方 API `api.stlouisfed.org/fred/series/observations`（需 key）繞過；`get_fred_api_key()` 依序讀 env `FRED_API_KEY`（secret 未設時 workflow 仍會傳入空字串，視同無 key）→ repo 根 `.fred_api_key` 檔 → 都沒有回 `None`；`fred_csv_text()` 有 key 時打官方 API 把 JSON 組回 fredgraph.csv 同格式的 CSV 文字，沒 key 時照舊打免費 CSV 端點，`fetch_fred_csv()` 內部已改呼叫它，呼叫端不用改。API key 絕不可出現在例外訊息裡（`FredApiError` 已遮蔽）。CI secret 由 `.github/workflows/fetch.yml` 的 us/tw job-level `env:` 注入；本地放 `.fred_api_key`（`.gitignore` 已排除）。
- `scripts/_breadth.py`：breadth 四支（`fetch_breadth{,_ndx,_tw50,_xlg}.py`）的共同核心 `run(get_tickers, out_path, min_coverage, label)`；各檔只留常數與取成分股／成員快取。
- `scripts/_valuation.py`：valuation 系列共用的 `ntm_pe(sym, *, throttle, retries=3)`、`weighted_means(pairs)`（算術＋調和）、`write_daily_snapshot(out_path, today, entry, note)`；各檔自己的 HOLDINGS、cap、`MIN_STOCKS`、coverage 算法留在原檔。
- **刻意沒收斂**（寫法看似重複但語意不同，別硬套）：JSON 寫檔（序列化參數至少 10 種組合，改了就改輸出位元組）、各檔的 User-Agent／headers（每站不同，有的站會擋 bot UA）、依狀態碼分流或兩種 backoff 公式並存的重試迴圈（`fetch_margin_concentration`、`fetch_margin_costmap`、`fetch_taifex_foreign_oi`、`fetch_taiwan_sector_index`、`fetch_tw_sector_flow`、`get_json` 系列，以及 `_breadth.py` 的 chunk 迴圈）、`fetch_tw_valuation.py` 的寫檔尾段、`backfill_tw_valuation_finmind.py` 的 token 順序、`fetch_liquidity*.py` 與 `fetch_inflation_exp.py` 的 FRED 解析。
- 重試邏輯的重構：即時實跑幾乎走不到重試分支，位元組比對驗不到。要用 `git show HEAD:` 取出舊版，在同一組假資料（patch `yfinance.Ticker` 與 `time.sleep`）下比對回傳值、呼叫次數、sleep 秒數序列（2026-09-25 V 包做法）。
- 測試：`python3 -m unittest discover -s scripts/tests`（離線；`.github/workflows/checks.yml` 會執行）。CI 用 Python 3.11、本地 miniconda 3.13 → 共用模組別用 3.12+ 語法。
- ⚠️ **重構 fetch 腳本的等價驗收：改前改後輸出 `cmp` 相同 ≠ 等價。** 多數腳本有「資料夠新就跳過」（如 breadth 的 `FRESHNESS_DAYS`）或快取 TTL（如 `tw_sector_map_cache.json` 7 天），兩次都走 skip 分支時 `cmp` 必然相同、什麼都沒證明（2026-09-25 B2 首輪驗收即如此）。做法：在 scratchpad 建隔離的 `OLD/`、`NEW/` 兩棵樹（`scripts/` + `data/`，腳本的 ROOT 都由 `__file__` 推導），把輸入資料切掉最後 N 列或刪掉快取，逼腳本真的走重算／cache-miss 路徑，從 stdout 確認走到了，再 `cmp`。另外檢查產出檔的 `updated` 是今天、內容與 HEAD 不同，確定兩次都真的有寫檔。別在真 repo 的 `data/` 裡做這件事。

## 外部 chart / trading UI reference：Vela

產品 repo 的 `references/vela/` 是 [LuxAlgo/Vela](https://github.com/LuxAlgo/Vela) 的獨立 upstream Git repository，父 repo 以 `.gitignore` 排除；不是 submodule 或 production source。研究入口與實際 source map 見 `docs/references/vela.md`。更新時在該目錄執行 `git pull --ff-only`；更新後重新核對文件記錄的版本、SHA、路徑及授權。

- 實作 chart、trading UI、workspace layout、indicators、drawing tools 或相關 UX 時，可以唯讀查閱；預設用途是 **READ / STUDY / COMPARE**。
- 未經明確要求，不修改 upstream、不直接 import Vela internals、不整棵複製 components，也不自行新增 Vela production dependency。
- 先理解 pattern，再適配本 repo 的 ES modules、ECharts、tab activation、data cache／abort、chart lifecycle 與既有共用 UI；研究沙盒與產品保持各自 runtime 邊界。
- 如需評估 Vela public API，另做範圍明確的評估；目前只以本 repo 的 ES modules／ECharts 落地 trend／stressdash 兩頁 pilot，未引入 upstream production import 或 dependency，不更換 renderer 或金融算法。
- 若要複製 source 而非概念，先核對該 snapshot 的 `LICENSE`、`NOTICE`、相關第三方授權，保留所需 license／attribution notices、修改標記；Vela `NOTICE` 記載每個顯示 Vela-rendered chart 的頁面／畫面須有可見歸屬。授權工程紀錄見 reference 文件。

## Ground truth 原則

本文件**不再維護** tab／資料檔的完整對照表 — 歷史證明必 drift（上一版只覆蓋 26 個 tab 中的 7 個）。要查現況，直接看程式碼：

- `ls js/tabs/` = 目前所有 tab 清單
- `js/navigation-catalog.mjs` 的 `CATEGORIES` = 導覽結構（8 分類、72 個畫面）；`js/navigation.js` 動態渲染分類、sub-nav 與「全部畫面」搜尋，**`index.html` 沒有靜態 tab 按鈕**
- `ls scripts/` = 所有抓取腳本
- `.github/workflows/fetch.yml` + `forward_pe.yml` = CI 實際跑的清單

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

1. `js/tabs/<id>.js` — export `activate({ signal, isCurrent })`（切入載入，成功前 await 首次 render）、`getCharts()`，選用 `onThemeChange(light)`、`resize()`；必要資料錯誤向外 throw，optional 資料標示 partial。**起手用 `js/scaffold/_template.js` 當範本**（已 import 四支 utils + echartsBase + ensureLoaded），別從舊 tab 複製起手。
2. `js/navigation-catalog.mjs` 的 `CATEGORIES` 選一個分類加入 `{ id, label }`，需要時補搜尋別名；模組預設 `js/tabs/<id>.js`，只有不一致的檔名才加 `MODULE_FILE` 對應。`boot.js` 由 catalogue 動態註冊，無需新增靜態 import。
3. `index.html` 加 `<section id="tab-<id>" class="tab-section" hidden>`（不用加 nav 按鈕，sub-nav 是動態渲染的）。
4. 主題色用 CSS 變數（`--bg/--panel/--border/--text/--muted`）；JS 內的色對/百分位/日期工具一律用 `js/utils/`（`PALETTE`/`math`/`dates`/`data`/`dom`，以及圖表狀態 `chartLifecycle`、可及性 `ui`／`tooltip`，速查表見下方），別內聯 `tc("#hex","#hex")` 或自寫 percentile。控制項一次性綁定用 `dom.bindOnce(el)`，chip 單選群組用 `dom.chipPicker(host, attr, onPick)`（host 內混有別組 chip 時加 `{ onlyMatching: true }`），別手寫 `dataset.built` 或 `closest(".chip[data-…]")` 委派（`check_reuse` 會抓）。多選切換、已選取短路、多個 closest 的分派器不適用 `chipPicker`。
5. ⚠️ **lint 對「還沒登錄 navigation-catalog 的新 tab 檔」完全不掃——含手動指定檔名也跳過**（刻意設計：避免掃到擱置死檔；2026-07-19 實測連塞違規進未接線檔、指名掃它都靜默 exit 0）。**唯一解法：先做第 2 步登錄、再寫 tab 內容**——接線後 hook 與 lint 自動納管。順序反過來（寫完才接線）的話，接線後要記得整檔重掃一次 `python3 ../Financial_work/check_reuse.py js/tabs/<id>.js`。

詳細程序與 ECharts 眉角（axisValue 毫秒、雙 grid 同步、itemStyle.color）見 `.agents/skills/add-tab/`；新增資料源用 `.agents/skills/fetch-script/`。

共用載入／abort／重試／圖表 zoom 與 legend 契約見 `docs/runtime-contracts.md`；選單與深連結／收藏見 `docs/navigation.md`；UI 元件與手機操作見 `docs/ui-components.md`。

### 前端測試與重構驗收

- 全庫離線檢查：`python3 scripts/run_checks.py`（manifest、Python、JavaScript；不更新市場資料）。
- JS 檢查：`npm test`（離線；JS syntax＋unit tests，範圍及局部命令見 TESTING.md）。
- **前端重構的行為等價驗收用 `js/__tests__/ui_harness.cjs`**（Playwright 無頭瀏覽器，操作基線見 TESTING.md；舊檔頭不能代替 WIP／固定時刻規則）：逐 tab 點遍所有可見 `.chip`，每步記錄 chip active 狀態、每張 ECharts 的完整 series／axis 資料 sha1、整個 tab 的 `innerText` sha1、console 錯誤。流程：先保存含既有 WIP 的改前來源快照（只有工作目錄無變動且 HEAD 確實是基準時才用 `git archive HEAD`）→ **對基準跑兩次**（兩次不同先查明原因；日期固定同一時刻，不能直接排除數值差異）→ 對工作目錄跑 → `cmp`。2026-09-25 C 包（`dom.js` 遷移 57 組 chip）即以此驗收。
- 盲點：點擊當下被隱藏的 chip 會跳過（例：flows 切到 sector 視圖後，其他選單被藏起來）；hover 才出現的 UI（tooltip）不在範圍，要另寫探針（例：`dispatchAction({type:'showTip'})` 後讀 tooltip DOM）。
- Playwright 已列在 `devDependencies`。使用 repo 安裝或以 `PLAYWRIGHT_MODULE` 指定本機模組；瀏覽器 runtime 須另外具備。瀏覽器故障注入測試不在離線單元測試入口內，需另執行。

<!-- JS_UTILS_CHEATSHEET_START -->
## js/utils 函式速查表(自動產生,勿手動編輯;來源:`../Financial_work/gen_cheatsheet.py`)

### theme.js(5)
- theme.isLight()
- theme.tc(dark, light)
- theme.mob()
- theme.PALETTE — Collapses the most common literal tc("#dark","#light") pairs repeated
- theme.echartsBase(overrides = {})

### dates.js(13)
- dates.tsToLocalDate(ts) — ECharts time-axis parses "YYYY-MM-DD" as local midnight, not UTC
- dates.presetStart(preset)
- dates.cutoffDate(key) — 「今天往回 N 年」的 range cutoff(key: 1Y/3Y/5Y/10Y/MAX,未命中回 3 年)。
- dates.currentWindow()
- dates.filterRange(rows)
- dates.dateAddDays(dateStr, n)
- dates.closestOnOrAfter(key, dateStr)
- dates.minBetween(key, t0, t1)
- dates.lookupLE(arr, date) — Binary search: last entry where arr[i][0] <= date
- dates.toWeekly(dailyData)
- dates.toWeeklyOHLC(daily) — Resample daily OHLCV rows into weekly OHLCV objects (週一=key；open=首日open、
- dates.toMonthlyLast(points, { minObs = 1, today = new Date() } = {}) — 把日頻 [[date, value|null], ...]（可未排序）重採樣成月頻，取每月最後一筆
- dates.toWeeklyHLC(dailyHLC)

### math.js(19)
- math.percentileRank(val, sortedAsc) — Binary-search rank of `val` within an ascending-sorted array
- math.percentile(sortedAsc, p) — Inverse of percentileRank: value at fraction `p` (0–1) of an
- math.mean(arr) — std uses ddof (delta degrees of freedom): divides by (n - ddof)
- math.std(arr, ddof = 0)
- math.zscore(arr, ddof = 0)
- math.SIGMA_KS — μ ± kσ 水平帶（σ 用母體標準差 ddof=0，與 numpy 預設相同）。values 至少 2 個有限數，否則回 null。
- math.sigmaBands(values, ks = SIGMA_KS)
- math.computeMA(data, period)
- math.toArithReturns(data)
- math.pearsonCorr(x, y)
- math.computeM2YoY(m2data)
- math.computeLinearRegression(data)
- math.computeRSI(data, period = 14)
- math.computeKD(hlcData, period = 9)
- math.computeTDSetup(closeData)
- math.computeDDZones(dailyData, lookbackDays = 60, threshold = 0.10)
- math.computeBounceSignals(qqqData, fgData, ma200Data) — Bounce signal: QQQ < MA200 & F&G < 15 → 2%+ bounce within 14 days
- math.computeMACD(closes, fast = 12, slow = 26, signal = 9) — MACD: DIF = EMA(fast) - EMA(slow); DEA = EMA(DIF, signal); HIST = DIF - DEA
- math.computeChannelBands(weeklyAll)

### data.js(10)
- data.clearRequestCacheForSignal(signal) — An activation may reject after a syntactically valid but unusable JSON body
- data.clearRequestCache(url)
- data.requestJSON(url, { signal, force = false, ttlMs = 300_000, timeoutMs = REQUEST_TIMEOUT_MS, label = url } = {})
- data.fetchJSON(url, { raw = false, ...options } = {}) — Generic fetch, not tied to the SERIES registry (unlike loadSeries below)
- data.isDataFresh(data)
- data.loadSeries(s, { signal, isCurrent, force = false, ttlMs } = {})
- data.ensureLoaded(key, options = {})
- data.loadEarnings()
- data.toPoints(rows, field) — {date, <field>} rows -> [[date, value], ...], skipping rows where the field is null/undefined
- data.latestOf(rows, field) — Last [date, value] point of toPoints(rows, field), or null when there is none

### dom.js(2)
- dom.bindOnce(el) — One-time-bind guard: true on first call (marks el.dataset.built), false if el is null or already bound
- dom.chipPicker(host, attr, onPick, { onlyMatching = false } = {}) — Single-select chip group: toggles .active (all .chip in host, or onlyMatching), then onPick(value, chip)

### chartLifecycle.js(3)
- chartLifecycle.captureChartState(chart)
- chartLifecycle.restoreChartState(chart, state)
- chartLifecycle.preserveChartState(getCharts, update)

### ui.js(1)
- ui.initSharedUI()

### tooltip.js(2)
- tooltip.tooltipPosition(anchor, size, viewport)
- tooltip.initTooltips()

<!-- JS_UTILS_CHEATSHEET_END -->

## 部署

Vercel（personal-fiance-nine.vercel.app）連 GitHub `main`，push 即自動部署。**所有 `data/*.json` 必須 commit 進 repo**，前端才 fetch 得到。

## 協作模式(主模型通用:Fable/Opus/Sonnet;Codex/ChatGPT 同一套)

標準迴圈:讀 memory 入口與本檔 → 用 write-spec skill 寫 spec(驗收條件要可機械核對)→ 實作交 executor subagent(sonnet, effort medium)→ 驗收交 verifier subagent(sonnet, effort high)→ 主模型 final review 全部驗收／diff／限制 → 新結論/眉角收錄 memory。
- **Claude Code 與 Codex/ChatGPT 共用本 repo**:Claude 讀 `CLAUDE.md` + `.claude/skills/` + `.claude/agents/`;Codex 讀 `AGENTS.md` + `.agents/skills/` + `.codex/agents/`。**`CLAUDE.md` 與 `.claude/skills/` 是唯一來源**,`AGENTS.md` 與 `.agents/skills/` 由 `python3 scripts/sync_agent_docs.py` 產生、勿手改;改完本檔或 skill 一定要重跑(`scripts/tests/test_agent_docs.py` 會在不同步時失敗)。`.claude/` 在 `.gitignore` 裡、只存在本機;`.codex/agents/*.toml` 手動維護,與 `.claude/agents/*.md` 保持同義。
- 主迴圈保持 context 乾淨:大量讀檔/盤點交 subagent,只收摘要。
- 同一判斷被糾正第二次 → 寫進本檔;同一套步驟重複第三次 → 做成 skill。目前 skills:add-tab、fetch-script。
- git:只有當次已授權 shipping 才 stage／commit;只 stage 該功能相關檔案,不要 git add -A。QA 先驗 task diff 與新檔交付完整性,不能為驗收 stage 他人 WIP；已授權 commit 時實作檔與 wiring 必須同 commit(教訓:twsectorflow 實作檔漏 add)。
