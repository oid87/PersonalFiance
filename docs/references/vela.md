# Vela 外部 UI／chart 實作參考

查閱日期：2026-10-03（Asia/Taipei）。用途固定為 **READ / STUDY / COMPARE**；從模式學習後，在 PersonalFiance 既有架構內重新實作。這份文件沒有授權安裝、接入生產依賴、移植交易平台、更新資料或恢復已暫停的重構工作。

## 參考快照與定位

- 上游：[LuxAlgo/vela](https://github.com/luxalgo/vela)。本機位置：[`references/vela/`](../../references/vela/)，是獨立 Git checkout 的外部參考資料。
- 查閱 SHA：`d5199cb8908fd1a18c3f83c02981874c0682cc55`；[`package.json`](../../references/vela/package.json) 宣告 `@luxalgo/vela` **0.8.1**。SHA 是本次內容識別；版本不是「最新版本」承諾。
- 固定來源：[README](https://github.com/luxalgo/vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/README.md)、[package.json](https://github.com/luxalgo/vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/package.json)、[LICENSE](https://github.com/luxalgo/vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/LICENSE)、[NOTICE](https://github.com/luxalgo/vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/NOTICE)。其餘本機來源表也以這個 SHA 為準。

Vela 是瀏覽器金融圖表函式庫，包含 headless core、原生 renderer、繪圖工具、原生技術指標、可插拔 provider／scripting engine、UI 元件與多圖 workspace。它提供交易圖表互動，不能據此推定具有 Personal Finance 的資產帳本、貸款、現金流或研究方法。

保留本機來源是為了追查實際責任分界、事件、設定及互動；閱讀 README 截圖不足以判斷能否適合本專案。版本更新時先記錄新 SHA，再重新核對這份表，不能把外部 checkout 當產品來源目錄。

## 真實來源導覽

下列路徑均相對本文件，可直接閱讀；沒有假定 `src/renderer` 或 `src/indicators` 這類不存在的目錄。

| 要研究的部分 | 真實來源 | 責任／觀察重點 |
| --- | --- | --- |
| 組合入口／headless chart | [`src/Vela.ts`](../../references/vela/src/Vela.ts)、[`src/index.ts`](../../references/vela/src/index.ts) | 接線 core、renderer、feed；公共 API 與預設值以程式為準。 |
| 工具列／控制項 | [`widget/topbar.ts`](../../references/vela/src/widget/topbar.ts)、[`topbar-composition.ts`](../../references/vela/src/widget/topbar-composition.ts)、[`mobile-bar.ts`](../../references/vela/src/widget/mobile-bar.ts)、[`bottombar.ts`](../../references/vela/src/widget/bottombar.ts) | 商品、bar resolution、style、指標入口，桌機與手機呈現。 |
| 商品／時間週期 | [`symbol-picker.ts`](../../references/vela/src/widget/symbol-picker.ts)、[`timeframe-drawer.ts`](../../references/vela/src/widget/timeframe-drawer.ts)、[`data/timeframe.ts`](../../references/vela/src/data/timeframe.ts) | 商品選擇與 provider 身分；時間週期解析。 |
| 指標選擇／設定 | [`indicator-picker.ts`](../../references/vela/src/widget/indicator-picker.ts)、[`IndicatorInputsDialog.ts`](../../references/vela/src/renderers/shared/IndicatorInputsDialog.ts)、[`SettingsDialog.ts`](../../references/vela/src/renderers/native/chrome/SettingsDialog.ts) | 指標清單、輸入 schema、圖表外觀設定分離。 |
| 原生指標／MA | [`native-indicators/index.ts`](../../references/vela/src/core/native-indicators/index.ts)、[`classics/averages.ts`](../../references/vela/src/core/native-indicators/classics/averages.ts)、[`volume/VolumeIndicator.ts`](../../references/vela/src/core/native-indicators/volume/VolumeIndicator.ts) | core 直接計算；MA 類型與 period／source 設定，無須 Pine engine。 |
| workspace／layout | [`VelaWorkspace.ts`](../../references/vela/src/workspace/VelaWorkspace.ts)、[`ChartCell.ts`](../../references/vela/src/workspace/ChartCell.ts)、[`layouts.ts`](../../references/vela/src/workspace/layouts.ts)、[`sync.ts`](../../references/vela/src/workspace/sync.ts)、[`layout-picker.ts`](../../references/vela/src/widget/layout-picker.ts) | 多圖組合、active cell、layout、同步群組；單圖 core 不管理整頁。 |
| 最大化／全螢幕呈現 | [`cell-controls.ts`](../../references/vela/src/widget/cell-controls.ts)、[`workspace guide`](../../references/vela/docs/user/workspace.md)、[`dialog/view.ts`](../../references/vela/src/ui/components/dialog/view.ts) | `maximizeCell` 讓 cell 占滿 workspace grid；手機 dialog 全螢幕呈現。這些不等同瀏覽器 Fullscreen API，本次未找到 `requestFullscreen` 呼叫。 |
| 狀態／持久化 | [`state/document.ts`](../../references/vela/src/state/document.ts)、[`workspace/persist.ts`](../../references/vela/src/workspace/persist.ts)、[`widget/persist.ts`](../../references/vela/src/widget/persist.ts) | versioned document、欄位驗證、storage adapter；顯示偏好與金融資料分離。 |
| provider／資料存取 | [`DataProvider.ts`](../../references/vela/src/core/ports/DataProvider.ts)、[`MarketDataFeed.ts`](../../references/vela/src/core/ports/MarketDataFeed.ts)、[`MultiProviderFeed.ts`](../../references/vela/src/data/MultiProviderFeed.ts)、[`CachingDataFeed.ts`](../../references/vela/src/data/CachingDataFeed.ts)、[`ProviderRegistry.ts`](../../references/vela/src/data/ProviderRegistry.ts) | 來源能力、symbol routing、history／streaming、快取；內建 provider 是 Binance、Coinbase、Hyperliquid。 |
| plugin／extension | [`plugin.ts`](../../references/vela/src/plugin.ts)、[`chart-types/registry.ts`](../../references/vela/src/chart-types/registry.ts)、[`widget/contributions.ts`](../../references/vela/src/widget/contributions.ts) | chart type、renderer layer、原生指標、UI descriptor 與 namespaced state extension。 |
| 使用者 drawing | [`DrawingStore.ts`](../../references/vela/src/core/drawings/DrawingStore.ts)、[`DrawingHistory.ts`](../../references/vela/src/core/drawings/DrawingHistory.ts)、[`DrawingToolbar.ts`](../../references/vela/src/renderers/native/drawings/DrawingToolbar.ts)、[`DrawingPainter.ts`](../../references/vela/src/renderers/native/drawings/DrawingPainter.ts) | core model、undo／redo 與 JSON；renderer 負責投影、命中與呈現。 |
| renderer／互動 | [`NativeRenderer.ts`](../../references/vela/src/renderers/native/NativeRenderer.ts)、[`SceneGraph.ts`](../../references/vela/src/renderers/native/core/SceneGraph.ts)、[`InputController.ts`](../../references/vela/src/renderers/native/core/InputController.ts)、[`CoordinateSystem.ts`](../../references/vela/src/renderers/native/core/CoordinateSystem.ts) | pane、scene、座標、pan／zoom／touch／scale 互動。 |
| geometry backend／crosshair | [`WebGL2Backend.ts`](../../references/vela/src/renderers/native/backend/WebGL2Backend.ts)、[`Canvas2dBackend.ts`](../../references/vela/src/renderers/native/backend/Canvas2dBackend.ts)、[`CrosshairRenderer.ts`](../../references/vela/src/renderers/native/chrome/CrosshairRenderer.ts) | WebGL2 資料 geometry 與 Canvas2D fallback；crosshair 屬獨立呈現層。 |
| UI 基礎 | [`ui/index.ts`](../../references/vela/src/ui/index.ts)、[`ui/tokens.ts`](../../references/vela/src/ui/tokens.ts)、[`ui/keymap.ts`](../../references/vela/src/ui/keymap.ts) | 元件、design tokens、鍵盤控制；部分 overlay 使用 Zag.js。 |

## 架構、事件與 chart 能力

依據 [`architecture/overview.md`](../../references/vela/docs/architecture/overview.md)、[`data-flow.md`](../../references/vela/docs/architecture/data-flow.md)、[`boundaries.md`](../../references/vela/docs/architecture/boundaries.md) 與上述程式：core 擁有 canonical bars 與 orchestration；provider／feed、scripting engine、renderer 經窄介面交換 neutral model。模型時間使用 epoch milliseconds。primary bars 由 core 載入、傳給計算和 renderer，不讓每個指標各自抓同一份價格。

預設組合有 renderer 與 cache-wrapped feed，但沒有預先註冊交易所 provider，也沒有預設 scripting engine。可直接傳 offline OHLCV；原生 studies 不需要 scripting engine，volume 預設啟用。架構文件的「candles-only」簡寫不能用來否定程式中的原生指標能力。

[`core/events/types.ts`](../../references/vela/src/core/events/types.ts) 定義 `market:changed`、`load:start/end`、`indicator:added/removed/inputs`、`pane:changed`、drawing 等事件；[`EventBus.ts`](../../references/vela/src/core/events/EventBus.ts) 提供 typed bus。workspace 再提供 `cell:active`、`layout:changed`、`cell:maximized`、`state:changed` 等 shell 事件。學習重點是讓資料載入、金融計算、選擇狀態和 UI 更新各有 owner，而不是在本專案新增第二套全域事件系統。

持久化的 `version: 1` document 包含 layout、active cell、timezone、同步偏好、各 cell 的 symbol／timeframe／style、renderer config、drawings、指標及 extension state。decoder 驗欄位；renderer config／drawing 的深層驗證由其 consumer 負責。預設 localStorage adapter 可替換 sync／async storage，指標設定儲存相對 declaration defaults 的差異。這是顯示與工作區狀態，不是本專案資料來源契約或 portfolio 帳本。

| 能力 | 來源證據／本次判讀 |
| --- | --- |
| candlestick、OHLC bars、line、area、baseline | [`core/options.ts`](../../references/vela/src/core/options.ts) 的 `PriceStyle` 和 native renderer；Heikin Ashi 由 [`chart-types/builtins.ts`](../../references/vela/src/chart-types/builtins.ts) 註冊。 |
| volume、overlay、MA | 原生 volume／averages 模組；`IndicatorModel` 與 renderer scene 分配主圖 overlay 或 study。不能假設與本專案的金融計算口徑相同。 |
| multi-pane、價格尺度 | [`SceneGraph.ts`](../../references/vela/src/renderers/native/core/SceneGraph.ts)、[`autoscale.ts`](../../references/vela/src/renderers/native/core/autoscale.ts)、[`manualScale.ts`](../../references/vela/src/renderers/native/core/manualScale.ts)；pane 及 own-scale 的分界可作設計參考。 |
| crosshair、pan、zoom | CrosshairRenderer、InputController、[`ViewportState.ts`](../../references/vela/src/renderers/native/core/ViewportState.ts)；時間位置與資料 readout 的互動分離。 |
| renderer fallback | `nativeBackend: 'auto'` 使用可用 WebGL2，否則 Canvas2D；geometry backend 可指定。WebGL2 不代表整頁全用 GPU：axis、grid／session backdrop、crosshair、drawing 仍有 Canvas2D／DOM 層。workspace 超過預設 8 cells 時可按 context budget 改採 Canvas2D；glow 是 WebGL2 功能，fallback 不具相同效果。 |

以上為靜態來源分析；沒有測量效能、執行上游 UI、驗證瀏覽器相容性或宣稱每種 renderer 行為等價。

## 可參考與不可直接移植

**A．UX 模式：** 商品／日期窗口／bar resolution／指標分組；明確 active 狀態；不遮住主圖的設定 dialog／drawer；手機控制收斂；crosshair readout；多 pane 保留單位；圖表最大化與恢復。應以本專案 CSS 變數、chip／tooltip／可及性契約重做，避免帶入完整交易平台操作密度。

**B．架構模式：** 顯示狀態可序列化、資料 adapter 與金融計算隔離、core 擁有資料、renderer 僅呈現、capability 誠實宣告、設定 schema、生命週期 cleanup。採用概念時仍遵循本專案現有 module、快取與 abort 契約。

**C．公共 API 的條件式未來評估：** 只有另有明確需求、決策與驗收後，才評估直接使用依賴。這不是此次行動。[`package.json`](../../references/vela/package.json) 真正 exports 為 `@luxalgo/vela`、`/ui`、`/widget`、`/workspace`、`/plugin`、`/providers/binance`、`/providers/coinbase`、`/providers/hyperliquid`。例如 root 的 `Vela`／`NativeRenderer`／`MultiProviderFeed`、workspace 的 `VelaWorkspace`、plugin 的 `registerChartType`／`registerRendererLayer`／`registerNativeIndicator` 有實際 export。評估應限定公開入口，不引用 upstream private 深層路徑，並另驗 build／bundle、來源 adapter、單位、日期、手機互動及授權；目前沒有新增 production import 或 dependency。

**D．不移植：** 上游整個 workspace、交易所連線、drawing runtime、renderer、內建指標公式、Pine engine、state store 或主題品牌。不把 WebGL 宣稱轉成效能結論；不以 crypto provider 取代 ETF／台股／VIX 管線；不將上游 script strategy 直接當可用 backtest。

## 對應 PersonalFiance 與研究子專案

[`README`](../../README.md)、[`CLAUDE.md`](../../CLAUDE.md)、[`runtime-contracts`](../runtime-contracts.md)、[`ui-components`](../ui-components.md) 與 [`Financial_work 架構`](../../../Financial_work/docs/refactor-architecture.md) 是內部依據。

| 本專案責任 | 對應方式 |
| --- | --- |
| PersonalFiance 靜態 SPA／ECharts | `index.html`、[`boot.js`](../../js/boot.js)、[`navigation-catalog.mjs`](../../js/navigation-catalog.mjs)、[`switcher.js`](../../js/switcher.js)、各 tab ES module，CDN ECharts、無建置步驟。Vela 僅在參考目錄，不成為 runtime。 |
| activation／abort／cache | tab 的 `activate({ signal, isCurrent })`；[`data.js`](../../js/utils/data.js) 管請求去重、consumer clone、abort 與 TTL；`switcher.js` 提供失敗重試，各 tab 驗必要 payload 後才提交 module cache。不能用外部 provider cache 蓋掉此契約。 |
| 金融計算與呈現 | tab 持有 adapter／DOM／option；`*_calc.mjs` 純計算。[`trend.js`](../../js/tabs/trend.js) 和 [`trend_calc.mjs`](../../js/tabs/trend_calc.mjs) 保留既有金融語意。Vela settings UX 不決定研究公式。 |
| theme／zoom／legend／resize | [`chartLifecycle.js`](../../js/utils/chartLifecycle.js) 捕捉及恢復 zoom／legend，dispatcher 管再進入／主題；[`state.js`](../../js/state.js) 是現有 series／選擇狀態，不能另外建立平行 store。 |
| 市場資料 | Python `scripts/fetch_*.py` → `data/*.json`；manifest／source contracts 管來源。trend 自訂 ticker 先查 local JSON，僅 HTTP404 才 fallback [`api/stock.js`](../../api/stock.js)，API 取約十年 `1d` historical 並傳 close／OHLCV，不能據此宣稱 intraday 或已驗 adjusted。 |
| Financial_work 研究 | `study_runtime.py` 管 manifest／provenance，`study_report.py` 提供 Plotly 報告；`web/chart.js` 是 Canvas backtest app。TW dashboards 是各自獨立 repo／app；不跨 repo 引入前端 runtime。Vela UI 參考不改 compute 或 baseline。 |

[`2026-10-03 重構驗收`](../../../Financial_work/docs/refactor-acceptance-2026-10-03.md) 明列第二輪 **FAIL、13 項待修，依指示停止**。其中 trend FPE 缺值與手機直接旋轉問題仍存在。這份參考文件不能當成全部架構通過的證據，也不恢復那些工作。

### 金融語意與需求邊界

- **Bar resolution 與日期窗口不同。** Vela `60` 是 60 分鐘，`D/W/M` 是日／週／月 bar；`timeframeToMs` 的月以 30 日估算僅供 bucketing。PF 的 1Y／5Y／自選起迄是顯示窗口；目前不能把切日期範圍解釋成切 intraday resolution。
- **Raw 與 adjusted 分開。** PF 固定資料以 raw close（`auto_adjust=False`）為契約，0050 有既定 ratio-splice 修補；不可為了線條連續而改成 adjusted。研究若需要 adjusted／total return，必須明示來源、口徑、as-of 與缺值；API／provider 名稱本身不證明口徑。
- **VIX 不共用價格單位。** 目前 trend 有獨立 VIX y-axis，並跳過 VIX／F&G 的 MA overlay。未來若做多 pane，VIX 指數點數用獨立 pane／scale／標籤；USD、TWD、報酬率和成交量亦需明確區分，不混畫成一個「價格」。
- SPY／QQQ／VOO／0050／VIX 已在 trend series 清單；VT 及 MA100／125／150／300 等擴展是未來需求。portfolio、allocation、cashflow、loans、SPYI、watchlist、regime、signals、backtest、AI summaries 的完整產品流程不能一概稱為已實作；個別既有圖表／訊號或研究工具不等於完整模組。

## 建議下一個限縮功能（本次不實作）

**Trend 可選 MA 週期擴展：保留 MA20／50／200，增加 MA100／125／150／300。** 借鏡 Vela 指標設定的選擇／狀態 UX，以既有 ECharts 和 `maActive` 完成。

來源現況：[`trend.js`](../../js/tabs/trend.js) 的 render 明列 `[20, 50, 200]`，HTML `#ma-picker` 對應三個 `data-ma` chip；[`math.js`](../../js/utils/math.js) 的 `computeMA` 是最近 N 筆價格算術平均，滿 N 筆後才出值、四位小數，先在完整 series 計算再 `filterRange`。這是交易資料筆數窗口，不是 N 個日曆天。MA200 在 signal 計算另有固定用途。

未來定案 spec 可限定 `index.html`、`js/tabs/trend.js` 及必要控制項樣式；保留原共用計算，沿用 data-ma 多選與 shared chip 可及性。不得把顯示 MA 選擇改成 signal MA200 參數；不得改價格口徑、資料檔、缺值、日期窗口或 rounding。驗收需比對舊三條 MA 數值完全不變、新週期首點與短 history、範圍切換、theme／zoom／legend／手機控制換行；若涉及現有旋轉或 FPE 問題，應明確列限制並另行授權修正。這項建議沒有包含 VT 新來源、signals 或 backtest。

## 授權工程筆記

本機 [`LICENSE`](../../references/vela/LICENSE) 為 Apache-2.0；[`NOTICE`](../../references/vela/NOTICE) 實際寫有每個使用 Vela renderer 的頁面／畫面顯示 visible attribution 要求。內建 mark 預設啟用；NOTICE 表示只有同畫面其他可見位置提供 Vela 名稱與專案連結時，才可停用內建 attribution；不能隱藏或遮蔽且沒有等效標示。

若未來複製／修改／散布程式碼，工程追蹤至少覆蓋 LICENSE §4：

- (a) 向接收者提供 license 副本。
- (b) 修改的檔案帶明顯修改聲明。
- (c) 散布 derivative source 時保留相關 copyright、patent、trademark、attribution notices。
- (d) 保留可讀 NOTICE attribution；LICENSE 同時說明 NOTICE 內容屬資訊且不修改 license。NOTICE 的實際聲明與 LICENSE 應一起留存，後續使用情境另行評估。

本次只讀來源及獨立撰寫參考文件，沒有將 Vela renderer 接入產品。以上是文件內容與工程注意事項，沒有作出授權有效性、衍生作品範圍或法律合規結論。

查閱 checkout 的額外 license／notice 名稱檔案只有 root `LICENSE`／`NOTICE`；未在 `src` 掃描結果發現 SPDX／copyright／AGPL header。這不代表完整授權稽核已完成。[`package-lock.json`](../../references/vela/package-lock.json) 的第三方 metadata 包含 MIT、Apache-2.0、MPL-2.0、ISC、BSD 等不同 license，不能把 dependencies 一律稱為 Apache。README 將 `@luxalgo/vela-pinets`／PineTS 說明為另行 AGPL-3.0 addon；本次 core package dependencies 沒有該 addon，沒有查閱或安裝 addon，不將其授權自動套到 core，也不對未取得的 addon 檔案作結論。

## 驗證範圍

本文件依據 checkout、package、docs 與實際程式靜態查閱撰寫；提交交接前檢查本文件相對來源連結存在。未安裝 upstream dependencies、未跑 Vela tests／build／browser，也未測實體裝置、遠端 CI 或效能。Main 負責 reference 隔離／ignore 與內部指引更新驗證；結果以 Main 的實際驗證為準。

## 工作區與更新方式

外層 `personal_financial/` 是多專案工作區，沒有 `.git`；真正產品 root 是 `PersonalFiance/`。本次只在這個產品 repo 放 reference，不在外層建立新 Git repo，也不在研究子專案建立重複 clone。Vela 的 package 設定是一個 TypeScript library 的多個 public entrypoints，由 `tsup.config.ts` 打包；`package.json` 沒有 npm `workspaces` 宣告。「workspace」在此主要指 chart workspace 功能。

相鄰 [`personal_financial_work/`](../../../personal_financial_work/) 是另一個市場報告專案，其 [`src/portfolio_gate.py`](../../../personal_financial_work/src/portfolio_gate.py) 有持倉輸入及報告模式，不能據此宣稱 PersonalFiance SPA 已有完整 portfolio 模組。Vela 參考不接管該專案的報告、帳務或 AI 摘要流程。

從產品 root 更新獨立 upstream：

```bash
cd references/vela
git pull --ff-only
```

上游更新後重新記錄 SHA／版本並核對 source map、public exports、LICENSE／NOTICE；本次未建立 submodule、未安裝 package 或 dependencies。

## Main 本輪 setup 驗收

2026-10-03，在實際產品工作目錄執行：

| 檢查 | 實際結果 |
| --- | --- |
| checkout 與 Git 隔離 | `references/vela/.git` 是獨立目錄；`git rev-parse --show-toplevel` 分別指向產品與 Vela；Vela `git fsck --no-reflogs` 通過。 |
| upstream origin／工作目錄 | `origin` 是 `https://github.com/LuxAlgo/Vela.git`；Vela `git status --porcelain` 為空。 |
| 父 repo 不追蹤 Vela | `git ls-files references/vela` 為空；`git check-ignore -v` 確認 `/references/vela/` 同時排除 source 與 upstream `.git`。 |
| 文件與來源路徑 | 本文件存在；Main 獨立解析本文件所有相對 Markdown 連結並核對目標存在，另抽查 API、MA 窗口／四位小數、renderer、provider、state 及授權聲明。 |
| agent 指引 | 只修改唯一來源 `CLAUDE.md`，執行 `scripts/sync_agent_docs.py` 生成 `AGENTS.md`；`--check` 通過；既有 `test_agent_docs.py` 四項測試通過。 |
| WIP／產品隔離 | 對照開工前檔案 SHA 與 status，既有檔案僅產品 `.gitignore`／`CLAUDE.md`／`AGENTS.md` 改變，新增本文件；沒有 application／market-data／dependency 變動、刪檔或丟失既有 WIP。Financial_work 與 personal_financial_work 原有檔案及 status 均保持。 |
| 變更衛生 | `git diff --check` 通過；未 stage、commit、push、deploy 或修改 upstream source。父 repo 原有大量 dirty／untracked，驗收的是本輪 delta，不能把原有修改算成本輪。 |

本輪只驗 reference setup／文件；不宣稱先前產品重構的 13 項待修已解決，也未執行上游 runtime／效能驗收。
