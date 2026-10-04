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
