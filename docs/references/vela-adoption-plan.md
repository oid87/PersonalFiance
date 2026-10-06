# Vela reference：比較、採用範圍與實作驗收

檢查日期：2026-10-04（使用者 Mac）。本輪先完成唯讀 baseline，之後依使用者新指示研究 Vela、拆分 tasks、實作小型 UI 改善並整合 review。沒有執行 baseline 裡所有改善建議。

## Checkout 與比較基準

- 產品：`/Users/orangembpm2/work/code/personal_financial/PersonalFiance`，branch `main`，HEAD `5fcea8c43ebd472c27b9909f66bff6313f8dee7b`。
- 開始時已有 309 筆預設 porcelain status：233 modified、76 untracked、沒有 staged。這是既有 WIP，不是本輪修改數。
- 基準為原工作目錄內容的副本，沒有使用 HEAD 覆蓋 WIP：`/Users/orangembpm2/Documents/Codex/2026-10-04/task/vela-review/before/PersonalFiance`。
- 實作與檢查副本：同目錄 `after/PersonalFiance`。原 checkout 的套用狀態與保留證據另見工作區 `apply-result.json`，不能僅憑本文件推定已套用。
- 保存原始 status 與 2,305 個檔案 SHA256 的 `baseline.json`；套用前逐一核對本輪擁有的檔案，衝突時停止。
- Vela 本機 checkout：產品目錄下 `references/vela`；研究版本 `d5199cb8908fd1a18c3f83c02981874c0682cc55`，package `0.8.1`。研究起迄 clean；沒有執行上游 provider 或 build，沒有複製原始碼。
- `Financial_work` 與舊 `personal_financial_work` 為研究／歷史 repository，本輪不修改它們。

## 1. 資訊架構

Vela 是 headless chart → widget → workspace 的圖表工作區。商品、bar interval、指標、繪圖、樣式以 chart 為中心；Personal Finance 是 8 類、72 個領域分析頁，依總經、流動性、情緒、風險、籌碼與策略組織。保留產品分類、搜尋、收藏與 URL 路由，無須改成交易平台工具架構。

證據：[Vela ADR 0006](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/docs/architecture/adr/0006-workspace-composes-charts.md)；PF `js/navigation-catalog.mjs`、`js/navigation.js`、`js/switcher.js`。

## 2. Dashboard layout

Vela 的 1／2／4／8 格及最多 4×4 grid，使用穩定 cell identity、splitter 與 active cell。它的共享工具列操作 active chart。PF 的頁面則由摘要、控制列、主圖與歷史表格組成；合適借鑑的是主圖優先與暫時 focus／restore。

本輪只改善壓力總覽的三張既有卡片。原 markup 有三卡，但共用摘要容器 selector 沒有涵蓋 `#stressdash-top`，造成桌機逐卡佔滿寬度。新增 scoped grid，寬螢幕並排、窄螢幕單欄，保留來源順序與卡片內容。

證據：[Vela layouts.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/workspace/layouts.ts)；PF `index.html` 的 `#stressdash-top`、`js/tabs/stressdash.js`、新 `css/dashboard-layout.css`。

## 3. Navigation

Vela 工具列將主要市場／interval／style／indicator 與輔助操作分開。PF 已有 category、sub-nav、搜尋、收藏、hash；這些不是 placeholder，也不需要第二套 catalogue。

本輪新增 ⌘K／Ctrl+K，開啟既有全部畫面搜尋。輸入欄、contenteditable、role=textbox、IME、已消耗事件及另一個 modal 均有 guard。重複按快捷鍵保留搜尋文字；Escape 回到開啟搜尋前的焦點。沒有加入裸字母快捷鍵，也沒有攔截 ticker、日期或數字編輯。

證據：[Vela keymap.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/ui/keymap.ts)；PF `js/navigation.js`、新 `js/__tests__/navigation_shortcuts.test.mjs`。

## 4. Chart

Vela 同一 chart 的 panes 共享時間軸，crosshair 與 readout 分離，也可跨 cell 同步游標。PF ECharts 已有多單位軸、crosshair、legend 與 zoom。USD／TWD／VIX／F&G 單位分界及 backward lookup 等金融語意優先；不能任意同步不同單位的價格座標。

本輪在趨勢與壓力總覽加入放大 pilot。它保持原 chart DOM、ECharts instance 與 options，僅改 CSS 呈現，再沿用 `resizeVisibleCharts`。還原後保留使用者的 legend 與日期縮放；沒有 dispose、重建或重載市場資料。

證據：[Vela data-window.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/widget/data-window.ts)、[sync.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/workspace/sync.ts)、[VelaWorkspace.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/workspace/VelaWorkspace.ts)；PF 新 `js/utils/chartFocus.js`、既有 `js/utils/chartLifecycle.js`。

## 5. Component 與 interaction

值得保留的工程概念是 controller／view 分工、既有 tokens、明確 cleanup 與可獨立測試的行為。PF 已有 `ui.js`、tooltip、chip 可及性與原生 dialog，本輪沒有加入 Vela UI kit、Zag、另一套 store 或 event bus。

放大模式具有 dialog 語意，背景暫時 inert，Tab 保留在可見控制中，Escape 還原；切頁、host 移除或另一 dialog 開啟時退出。原 ARIA、inert、scroll、focus、overflow、transition 會恢復。模組 `destroy()` 會清除 observer、listeners 與 animation frames。

證據：[Vela UI component guide](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/docs/contributing/adding-a-ui-component.md)；PF 新 `css/chart-focus.css`、`js/utils/chartFocus.js`。

## 6. Mobile 與顯示狀態

Vela 的手機 toolbar 使用 44px target 與 safe area。PF 是長頁分析，適合保留垂直捲動與局部控制換行；本輪放大控制使用現有 tokens、44px 按鈕與動態 viewport。沒有移植接管整頁捲動的交易圖表手勢。

Vela versioned document 主要保存顯示偏好。PF 已有 state、收藏與 URL 範圍；將來若需要可建立顯示偏好 codec，但不能用它取代產品資料契約或投資模型。

證據：[Vela mobile-bar.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/widget/mobile-bar.ts)、[document.ts](https://github.com/LuxAlgo/Vela/blob/d5199cb8908fd1a18c3f83c02981874c0682cc55/src/state/document.ts)。

## 採用分類

| 分類 | 結論 |
|---|---|
| 可以直接借鑑概念 | 主圖優先；控制依任務分組；清楚 active 狀態；快捷鍵尊重編輯與 modal；呈現改變保留 chart state；tokens、責任分離與 cleanup。 |
| 需要在 PF 重新實作 | 本輪搜尋快捷鍵、兩頁圖表放大、壓力摘要 responsive grid；後續可限縮評估 trend 控制分組、readout／單位資訊、日期同步或顯示偏好 codec。 |
| 不適合目前系統 | 整套 workspace／renderer／framework／provider；交易所 streaming、intraday、Pine、drawing、orderflow；4×4 圖表與整頁手勢；以 Vela document 取代投資資料模型。 |

Vela 的 D／W／M／60 是 bar interval，不能混同 PF 的 1Y／5Y 顯示窗口。上游 WebGL 敘述也不能當作 PF 效能改善證據。

既有 `docs/references/vela.md` 是歷史設計文件；其中「新增 MA100／125／150／300」已落後 checkout：`index.html` 與 `js/tabs/trend.js` 已有這些項目。本輪沒有重做它們。沒有宣稱 Local LLM 已部署。

## Implementation plan 與 Codex task ownership

| Task／角色 | Scope 與價值 | 擁有檔案 | 依賴／驗收／結果 |
|---|---|---|---|
| Reference researcher | 原始碼比較與採用邊界 | 唯讀 upstream／產品；不修改檔案 | 完成；未執行 Vela UI／build，結論屬原始碼分析。 |
| A：frontend navigation | 快速進入既有 72 頁搜尋 | `js/navigation.js`、新 navigation_shortcuts test、`docs/navigation.md` | 不改 catalogue／switcher；快捷鍵、IME、editor、modal、焦點還原測試完成。 |
| B：frontend chart interaction | 主圖 focus／restore、避免失去探索狀態 | 新 chartFocus module、chart-focus CSS、chartFocus test、chart-focus doc | 使用既有 chartLifecycle；不改金融 options；單元與兩頁瀏覽器驗收完成。 |
| C：frontend CSS | 讓壓力摘要在桌機可快速比較、手機可讀 | 新 dashboard-layout CSS／doc | selector 只限 stressdash；1280px 三欄與 390px 單欄實際驗證。 |
| Root integrator | 接線與保留既有 WIP | 僅 root 修改 `js/boot.js`、`css/main.css`；研究整合文件 | snapshot → 平行 A/B/C → 順序接線 → 全庫檢查 → UI → diff／安全套用。 |
| Independent reviewer | 抽查所有 agent 的 code／test 證據 | 唯讀 before／after | 找到 hidden ancestor modal guard 問題，owner 修正後獨立驗證；16 targeted tests passed，無未解決 blocking finding。 |

Trend 控制列重排、readout／跨圖同步、偏好儲存與全站放大均留待後續限縮 task，沒有隨本輪擴張。若需更換 framework、資料模型或大規模重構，仍須使用者決定。

## Commands 與結果

全部先檢查 scripts／CI 副作用；使用既有依賴，沒有安裝、migration、資料更新、遠端寫入、部署或金融帳戶操作。

| 檢查 | 結果 | 證據／限制 |
|---|---|---|
| before：`PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/Caskroom/miniconda/base/bin/python scripts/run_checks.py --js-only` | passed | 230 JS tests、0 failed／skipped；含原 WIP 的快照。 |
| after：同 runtime 執行 `scripts/run_checks.py` | passed | manifest／pipeline contract、151 Python tests、JS syntax 與 244 JS tests；0 failed／skipped。 |
| reviewer：`node --test js/__tests__/navigation_shortcuts.test.mjs js/__tests__/chartFocus.test.mjs js/__tests__/chartLifecycle.test.mjs` | passed | 16 tests、0 failed／skipped。 |
| production build | not run／無此腳本 | 原生 ES modules 靜態站；`package.json` 沒有 build script。不能將不存在的 build 說成通過。 |
| TypeScript typecheck／獨立 lint | not run／無此腳本 | PF 不是 TS app；全庫檢查包含 Node syntax check。 |
| Vela build／tests | not run | 只做 reference 原始碼研究；不安裝上游依賴。 |
| 全 72 tab、每個可見 chip 的完整 UI harness | incomplete | 以 CUA 改編現有 harness：已發現全部 72 頁，但在基準 chip 批次 `uiBatch('base1', reviewTab, 20)` 60 秒逾時，工具重設；沒有完成第二次基準與 after 全矩陣，不能宣稱全站行為等價。原 `ui_harness.cjs` 沒有另從 shell 執行。 |

已有 Node ES module package warning 仍存在。Python negative-path fixture 內的 IntegrityError 是預期測試場景；最終完整檢查 exit 0，不能把 fixture 輸出誤報為整體失敗。

## 使用者 Mac 的實際瀏覽器證據

使用 Codex 內建瀏覽器與 localhost fixture。fixture 在 HTTP 回應中注入固定 Date `2026-10-03T12:00:00Z` 與只讀圖表探針；沒有修改產品 index／金融資料，也沒有測試探針进入交付原始碼。一般預覽不含探針。

| 情境 | 實際結果 |
|---|---|
| trend／stressdash baseline 重新載入兩次 | 完整 series／axes／zoom／legend 比較穩定。 |
| before → after 預設資料 | 兩頁圖表資料一致；預期 UI 差異為新 toolbar 與壓力 grid。 |
| 壓力圖放大／Escape 還原 | 同 ECharts instance；資料與 legend 保留；正常 1280×580、放大 1280×659。 |
| 壓力圖實際點擊 SPY legend 再還原 | 使用者選擇保留，沒有被重置。 |
| 趨勢圖放大／拖曳日期 slider／還原 | slider start 約 33.0348%；同 instance、兩組 dataZoom 保留；還原尺寸 1280×526。 |
| ⌘K／Ctrl+K 搜尋 | 既有搜尋開啟、可查 72 頁；重複快捷鍵保留「趨勢」文字；Escape 還原 opener focus。 |
| 在 ticker input／chart modal 使用搜尋快捷鍵 | 不開搜尋，保持編輯／放大情境。 |
| 放大時 browser history 換頁 | 聚焦 class、背景 inert 與 body overflow 清除；沒有遺留遮罩。 |
| 桌機 1280px 壓力摘要 | 三張卡片等寬並排、每張約 400px。 |
| 手機 390×844 | 三張卡片單欄、寬 366px／左右 12px；document width 390px；放大圖表 390×791；無新 page errors。 |

工作區保存 `evidence/stress-data-regression.json`、`trend-data-regression.json` 與桌機／手機 JPEG。Safari、真正觸控裝置、螢幕閱讀器、768px／1440px、200% 字級縮放與實際暗色主題未完成視覺驗證；沒有把 CSS 靜態推論當成這些情境通過。

## Review 結果與殘留限制

Root 抽查所有 before／after 差異、圖表生命週期、導覽接線與 tests。原 `data/`、financial calc、state、package／lockfile、fetch／CI 與 index 均不在修改範圍。外部 repository 保持唯讀。

已處理：搜尋與圖表 focus 的 ARIA modal 互斥；IME Escape guard；hidden ancestor modal 誤判；還原時趨勢 height transition 導致第一 frame 尺寸量測不正確。沒有未解決 code review blocking finding。reviewer 曾指出 snapshot 缺少 `docs/references/vela.md`，原因是快照排除所有 `references` 目錄；root 已將同一原檔加入 before 與 after，沒有修改歷史文件內容。

剩餘驗證缺口為完整 72-tab chip matrix 與上述跨裝置情境；現有 targeted regression 支持本輪 pilot，但不支持全站／所有瀏覽器無 regression 的廣泛結論。

## 使用者需求對照

| 要求 | 交付 |
|---|---|
| 分析 IA／layout／navigation／chart／component／interaction | 本文件 1–6 與 upstream pinned source 證據。 |
| 對照目前 PF、判斷值得導入 | 每節 PF 現況、現有功能與採用分類。 |
| 三類分類 | 概念／重新實作／不適合表。 |
| Implementation plan | 小型 pilot 順序、延後範圍及 architecture decision 邊界。 |
| 拆成獨立 Codex tasks | A／B／C、researcher、integrator、reviewer ownership 表。 |
| 避免改同一核心檔 | boot／main.css 只有 root 接線；其餘檔案分離。 |
| build／test／regression | commands 結果與實際 UI 表，明確標示未執行／未完成。 |
| Review 所有 agents 並統整 | 獨立 review + root 原始碼、diff、測試與畫面抽查。 |
| 原本資料模型／投資邏輯優先 | 不更換 framework／資料模型；只改顯示與 navigation；套用前後 SHA256 保存檢查。 |
