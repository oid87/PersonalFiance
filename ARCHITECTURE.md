# 架構與改動入口

基準日期：2026-10-04。本文以 [CURRENT_STATE](CURRENT_STATE.md) 指定的驗證來源為準；原工作樹另有保留 WIP，不能把其內容當成已提交工程主幹。
本文路徑以 `PersonalFiance` 根目錄為起點；`../Financial_work` 是研究 repo，`../personal_financial_work` 是 legacy 報告工具。
72 頁／8 分類來自目前 catalogue；它是畫面清單，不是 72 個獨立應用或服務。[navigation-catalog.mjs](js/navigation-catalog.mjs)

## 先理解執行邊界

```text
Python fetch/prep/compute ── source manifest／workflow ──> 已提交的 data/*.json
                                                               │ HTTP
index.html + ECharts CDN ── boot ── navigation/catalog ── switcher ── lazy tab
                                                               │
                                          data/state + utils + 頁面專用 *_calc
趨勢自訂 ticker ── 本地 HTTP 非成功狀態才回退 ──> /api/stock ── yahoo-finance2
```

主產品是靜態 SPA，沒有 bundler、前端 framework 或通用後端資料服務；HTML 載入 ECharts 5.5.0 CDN 與 CSS，boot 使用原生 ES module。[index.html](index.html)、[boot.js](js/boot.js)
Python 產製市場資料，瀏覽器讀 JSON 並做互動計算；Node API 只支援自訂 ticker 回退，不能把 Python fetcher 當成 request-time API。[trend.js](js/tabs/trend.js)、[api/stock.js](api/stock.js)
研究 repo 的 `lab.py`、Python 回測與 `web/backtest.js` 不在主產品 import graph；產品共用 Python 不應依賴相鄰 sandbox。[shared-python.md:16](docs/shared-python.md)

## 改 X，先讀哪些模組

| 要改的行為 | 先讀的入口與責任 | 延伸邊界／驗收入口 |
| --- | --- | --- |
| 頁面分類、命名、搜尋別名、新頁接線 | [catalog](js/navigation-catalog.mjs)：aliases、唯一檔名例外、modulePath；[boot](js/boot.js)：lazy registry | [navigation.test](js/__tests__/navigation.test.mjs)、[add-tab skill](.agents/skills/add-tab/SKILL.md)；HTML 仍須有對應 section |
| 搜尋、收藏、分享、hash、上一頁／下一頁 | [navigation](js/navigation.js)：native dialog 與 UI；[selectTab](js/navigation.js)：同步分類與啟用 | [navigation.md](docs/navigation.md)、[navigation_shortcuts.test](js/__tests__/navigation_shortcuts.test.mjs)；純搜尋比對在 catalog，收藏在 localStorage |
| 載入中、錯誤、重試、重返頁面 | [switcher](js/switcher.js)：activation generation、timeout、首圖完成、錯誤 UI；[data](js/utils/data.js)：共享請求 | [runtime-contracts.md](docs/runtime-contracts.md)、[switcher.test](js/__tests__/switcher.test.mjs)、[data.test](js/__tests__/data.test.mjs) |
| 圖表 zoom／legend、theme、resize | [chartLifecycle](js/utils/chartLifecycle.js)：四個公開 helper：captureChartState、restoreChartState、preserveChartState、resizeVisibleCharts；互動狀態與可見尺寸；[switcher](js/switcher.js)：跨頁調度；各 tab 的 `getCharts/onThemeChange/resize` | [chartLifecycle.test](js/__tests__/chartLifecycle.test.mjs)；不要由共用層覆寫 series／axis |
| 圖表放大、焦點與 modal 衝突 | [chartFocus](js/utils/chartFocus.js)、[chart-focus.css](css/chart-focus.css)：呈現、inert、focus、還原；boot 初始化 | [chart-focus.md](docs/chart-focus.md)、[chartFocus.test](js/__tests__/chartFocus.test.mjs)；目前只接趨勢與金融壓力 |
| 手機、短高度、寬表格、摘要卡 | [main.css](css/main.css)：tokens；[main.css](css/main.css)：RWD；[navigation.css](css/navigation.css)、[dashboard-layout.css](css/dashboard-layout.css) | [ui-components.md](docs/ui-components.md)、[dashboard-layout.md](docs/dashboard-layout.md)；同時看 HTML host 層級與 tab 的圖表高度計算 |
| tooltip、chip、一次性事件綁定 | [ui.js](js/utils/ui.js)、[tooltip.js](js/utils/tooltip.js)、[dom.js](js/utils/dom.js)；[boot](js/boot.js) | [ui.test](js/__tests__/ui.test.mjs)、[dom.test](js/utils/__tests__/dom.test.mjs)；單選 chipPicker 不等於多選控制器 |
| 趨勢、共用 ticker、期間、MA、訊號 | [trend](js/tabs/trend.js)、[state](js/state.js)、[trend_calc.mjs](js/tabs/trend_calc.mjs) | [trend_calc.test](js/__tests__/trend_calc.test.mjs) 驗純計算；wrapper 接線看 import。boot 還有 trend-specific status 裝飾 |
| 策略展示與槓桿模擬 | [catalog](js/navigation-catalog.mjs)、[leverage](js/tabs/leverage.js)、[leverage_calc](js/tabs/leverage_calc.mjs)、[fetch_leverage](scripts/fetch_leverage.py) | [leverage_calc.test](js/__tests__/leverage_calc.test.mjs)；cashking／kelly／wkrev 等各自持有策略設定，不存在通用 strategy service |
| 事件研究／歷史結果 | [wkrev](js/tabs/wkrev.js)、[qqqmacd](js/tabs/qqqmacd.js)、[roc4](js/tabs/roc4.js)、[eventStudy](js/utils/eventStudy.mjs) | [eventStudy.test](js/utils/eventStudy.test.mjs)；sentiment 的統計由 [compute_sentiment](scripts/compute_sentiment.py) 預先產製 |
| Portfolio／持倉報告 | 主產品 catalogue／state／API 未接持倉、交易帳本或 P&L 服務；legacy 的 [PortfolioGate](../personal_financial_work/src/portfolio_gate.py) 是報告模式門控 | [legacy main](../personal_financial_work/src/main.py) 是 demo；不能由函式名稱推論它已整合儀表板或具備部位估值 |
| 市場資料、新來源、schema／更新順序 | [source_manifest.json](scripts/source_manifest.json)、[check_pipeline](scripts/check_pipeline.py)、[source_contracts](scripts/source_contracts.py)、[validate_data](scripts/validate_data.py) | [source-contracts.md](docs/source-contracts.md)、[fetch-script skill](.agents/skills/fetch-script/SKILL.md)；workflow 與本地入口分別接線 |
| 共用 Python、breadth、valuation | [_common](scripts/_common.py)：I/O／日期／重試；[_breadth](scripts/_breadth.py)、[_valuation](scripts/_valuation.py)：領域核心 | [shared-python.md](docs/shared-python.md)、[test_common](scripts/tests/test_common.py)、[test_shared_io_dates](scripts/tests/test_shared_io_dates.py)、[test_valuation_common](scripts/tests/test_valuation_common.py) |
| 離線檢查與行為等價 | [run_checks](scripts/run_checks.py)、[checks.yml](.github/workflows/checks.yml)、[ui_harness](js/__tests__/ui_harness.cjs) | [development.md](docs/development.md)、[AGENTS 前端驗收](AGENTS.md)；browser probe 不在離線 test 入口 |

## 核心、擴充點與 state 所有權

核心是 catalogue → navigation → switcher；新增頁只擴充 catalogue、HTML section 與 tab module，不替 boot 增加靜態 import。
起手範本 [scaffold](js/scaffold/_template.js) 示範共用工具與 lifecycle；新增 tab 先登錄，再做 reuse lint，未登錄的檔案不受該 lint 納管。[AGENTS 新頁 lint](AGENTS.md)
tab 擁有來源驗證、局部計算、控制項、ECharts options 與頁面 state；相鄰 `*_calc.mjs` 是純計算邊界，utils 只收可明確命名且語意相同的 primitive。
已提交的純計算模組包括 trend／CPI／VIX-SKEW 與 leverage／naaim／marginglobal；純模組存在不表示相鄰 tab 已改用它。實際接線逐頁看 import，測試 fixtures 只證明其涵蓋的計算；不宣稱 marginpeak extraction 或所有金融函式均已遷移。

資料快取分三層，改 refresh 必須分別處理：

1. `requestJSON` 以 URL 去重、每位 consumer 深複製，成功 TTL 預設五分鐘；abort consumer 不會取消其他 consumer 的共享 fetch。[data.js](js/utils/data.js)
2. `state.js` 的 `loaded/loadedHLC/loadedVol` 與 `active` 是跨趨勢等頁共用容器；`loadSeries` freshness 判斷、提交資料並清 `sigMaps`。[state.js](js/state.js)、[data.js](js/utils/data.js)
3. tab 自有成功快取，如 `qqqmacd.cache`、`wkrev.cache`、`leverage.BUNDLE`；request TTL 到期不會自動重算這些快取。[qqqmacd.js](js/tabs/qqqmacd.js)、[wkrev.js](js/tabs/wkrev.js)、[leverage.js](js/tabs/leverage.js)

navigation 的 hash／收藏與 boot 的 theme 分別持有瀏覽器狀態；沒有統一 application store。[navigation.js](js/navigation.js)、[boot.js](js/boot.js)
activation 必須 await 首圖、把必要錯誤向外 throw；signal／isCurrent 是提交 state 的守門條件，optional 來源缺失須明示 partial。[runtime-contracts.md:9](docs/runtime-contracts.md)
switcher 的 generation／20 秒 timeout 防止舊嘗試覆寫調度狀態；它不會替忽略 context 的 tab 阻止 late write，也不因切到另一頁自動 abort 前頁請求。[switcher.js](js/switcher.js)、[switcher.js](js/switcher.js)
chartLifecycle 保存 zoom／legend，按 DOM host 再 index 對回重建實例；theme 只處理已啟用或已 render 的 tab，resize 跳過隱藏 section。[chartLifecycle.js](js/utils/chartLifecycle.js)、[switcher.js](js/switcher.js)
chartFocus 保留同一 DOM／ECharts instance；巢狀 host 被跳過，擴展須有 explicit adapter，不能只擴 PILOTS 清單。[chartFocus.js](js/utils/chartFocus.js)

## 金融與來源邊界不能由外觀推定

stock fetch 的原始價格 `auto_adjust=False`，leverage bundle 刻意用含息資料；breadth 的 adjusted prices 又服務不同分析目的。[fetch_stocks.py](scripts/fetch_stocks.py)、[fetch_leverage.py](scripts/fetch_leverage.py)、[_breadth.py](scripts/_breadth.py)
`roc4` 用觀測序列 horizon，sentiment 用日曆天後第一筆交易資料；`wkrev` 使用週資料。合併「forward return」前須固定時間軸、錨點、右設限與缺值政策。[roc4.js](js/tabs/roc4.js)、[compute_sentiment.py](scripts/compute_sentiment.py)、[wkrev.js](js/tabs/wkrev.js)
共用 eventStudy 是 ETF session 軸的描述性 close-price outcomes，不能自動替代週事件、NAV 回測或成交時序。[eventStudy.mjs](js/utils/eventStudy.mjs)
研究 Python／browser 回測在費用、缺價、CAGR 與 Sharpe 定義上不同；研究 QQQ/QLD MA125 假設當日收盤訊號同價成交。[研究 backtest-contract:5](../Financial_work/docs/backtest-contract.md)、[backtest.py](../Financial_work/backtest.py)
Python helpers 的「壞檔回空」與「保留已讀部分」政策各異；JSON serialization、source headers／retry 分流、單位與財務定義留在來源端。[shared-python.md:5](docs/shared-python.md)、[_common.py](scripts/_common.py)

## 72 頁重複：何時才值得抽象

這是代表性 code 抽查後的分層判斷，未宣稱完成逐頁 clone detection。頁數多不等於需要一個大型 tab factory。

| 分類 | 具體重複／module 例子 | 值得抽象的條件 |
| --- | --- | --- |
| High value–Low risk | navigation 已用單一 catalogue；chip／tooltip／theme／chart state 已有 utils | 先復用現有 API；新增同語意第三個 caller、可固定 fixtures，才增加小 helper |
| High value–Low risk | CSS 卡片／期間群組／局部表格捲動；stressdash 獨立 grid、`.ui-card`、`.period-control` | 同 DOM 責任與 responsive 行為反覆出現，且 selector 可限定；以小批頁面驗證，避免全站選取器擴張 |
| High value–High risk | wkrev／qqqmacd／roc4 的 load→cache→render→theme 流程 | lifecycle 的首圖、重試、chart 重建差異可寫成合約並證明等價後，才考慮 controller；不把 signal commit 隱藏在 factory |
| High value–High risk | 事件 return／sample filters、CPI 與 VIX-SKEW percentile、跨頁 dates／data transforms | 必須先寫明 calendar/session、tie／null／rounding 與不足樣本政策；先頁面專用純函式，再評估共享 |
| Low value | 把 72 頁所有 ECharts option、strategy/backtest、JSON writer 或 fetch retry 統一 | 相似語法但金融或來源契約不同，維護成本與回歸風險大；沒有可驗證的共同語意就保留差異 |

chart interaction 先用 chartLifecycle／chartFocus；navigation 已收斂，不再建立平行 registry／keymap store。
CSS-layout 可以抽呈現 tokens／局部模式，data transform 只能抽同算法的 primitive；shared 不應變成跨 repo 的隱式依賴中心。

後續候選、優先順序與目前是否值得執行統一見 [CURRENT_STATE.md](CURRENT_STATE.md)；本文維持結構入口，候選不在這裡另列。

## 依賴、權威與驗收限制

runtime／版本以 [.nvmrc](.nvmrc)、[.python-version](.python-version)、[package.json](package.json)、[package-lock.json](package-lock.json)、[scripts/requirements.txt](scripts/requirements.txt) 為準；Python requirements 多為最低版本，不能視為鎖定全部傳遞依賴。
靜態 `http.server` 預覽不會執行 `api/stock.js`；自訂 ticker 的 serverless 回退需另有 Node hosting/runtime。API 自設一小時 HTTP cache，也沒有替代 scheduled JSON 的來源合約。[api/stock.js](api/stock.js)
離線入口會檢查 manifest、Python unittest、JS syntax 與 `*.test.mjs`；它不包含市場 fetch、browser UI、API live smoke 或最新資料保證。[run_checks.py](scripts/run_checks.py)
manifest／workflow／validator 是來源接線與 schema 權威；tab／calc 是畫面金融語意權威；測試 fixtures／before oracle 只證明它們覆蓋的情境。[source-contracts.md](docs/source-contracts.md)；資料通過 schema 驗證不代表 provenance 已確認。
前端等價驗收須包含 WIP 的 before 快照、固定 clock、基準兩次及 after 對照；harness 跳過當下隱藏 chip／hover UI，style snapshot 也不替代圖表、觸控與 modal 驗收。[AGENTS 前端驗收](AGENTS.md)、[ui_harness.cjs](js/__tests__/ui_harness.cjs)、[style_snapshot.cjs](js/__tests__/style_snapshot.cjs)
共用 fetch 重構的 `cmp` 在 freshness／cache skip 分支不能證明等價，須在隔離 fixture 逼出重算、cache miss 與 retry。[AGENTS fetch 等價驗收](AGENTS.md)。實際執行的命令、來源、結果與未驗項見 [CURRENT_STATE](CURRENT_STATE.md)，不能從工程 tests 推定市場資料已更新或 provenance 已確認。
操作程序以 [AGENTS.md](AGENTS.md)、[add-tab](.agents/skills/add-tab/SKILL.md)、[fetch-script](.agents/skills/fetch-script/SKILL.md) 為準；既有長合約保留在 [runtime](docs/runtime-contracts.md)、[sources](docs/source-contracts.md)、[navigation](docs/navigation.md)、[UI](docs/ui-components.md)，本文只提供改動入口。
