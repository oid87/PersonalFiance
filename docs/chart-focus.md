# 圖表放大 pilot

借鑑 Vela maximize cell 的「暫時專注一張圖、還原原工作區」概念。本模組是 PersonalFiance 原生 ES module／ECharts 的獨立實作，沒有 upstream component、renderer 或依賴。

接線：`boot.js` import `initChartFocus` from `./utils/chartFocus.js`，於共用 UI 初始化後呼叫一次；`main.css` 頂部 import `./chart-focus.css`。沒有 build 步驟。

`initChartFocus()` 預設只增強 `#chart`（趨勢）與 `#stressdash-chart`（金融壓力）。回傳 `enter(chartId)`、`exit()`、`focusedChartId` getter、`destroy()`。同一 document 重複初始化不會新增按鈕或 listener。其他 host 須位於 `.tab-section` 的直接子層才能加入；巢狀版面需要明確 adapter。

放大使用既有 section 的 CSS viewport 版面，不使用瀏覽器 Fullscreen API，不移動 chart DOM，不 dispose／recreate instance，不寫 option、series、金融 state 或儲存資料。尺寸同步使用既有 `chartLifecycle.resizeVisibleCharts`，於 layout 的下一 animation frame 執行；目前沒有需要複製的 chart interaction store。zoom／legend 在同一 instance 上保留。

放大時 section 暫時取得 dialog 語意，背景及 section 的其他內容暫設 inert，原生還原按鈕保持可見。Tab 在還原按鈕與圖表內既有可聚焦元素間循環。Escape／還原按鈕會還原進入前 scroll 與 focus；切換 tab、host 移除或其他 dialog 開啟則自動退出且不搶回 focus。原有 role、ARIA、inert 與 body inline overflow 會還原。若其他 dialog 已開啟，不允許進入，也不攔截它的 Escape。

CSS 使用現有 theme tokens、safe-area 及動態 viewport。窄／矮視窗隱藏次要 Escape 提示，保留至少 44px 還原按鈕。沒有額外 overlay／背景捲動容器。

離線檢查：`node --test js/__tests__/chartFocus.test.mjs js/__tests__/chartLifecycle.test.mjs`。DOM stub 測試涵蓋進出、切頁、其他 dialog、resize 與實例／options 不變；不能取代真實瀏覽器對 viewport、觸控、畫布及螢幕閱讀器的驗證。pilot 的人工 UI regression 由整合 task 執行。
