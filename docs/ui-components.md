# 共用 UI 元件

頁面無建置步驟。`js/boot.js` 呼叫一次 `initSharedUI()`；它負責 tooltip 與 chip 的鍵盤可及性，不讀取或改寫金融資料。

## Tooltip

在元素上設定 `data-tooltip="說明"`。`js/utils/tooltip.js` 在 body 建立唯一的 `role="tooltip"` 浮層，以純文字顯示，依視窗邊界定位與換行。滑鼠移入、鍵盤聚焦或觸控點按時顯示；離開、失焦、Escape 或觸控點按別處時隱藏；捲動與縮放時重新定位，來源離開視窗時隱藏。浮層顯示期間會把自身 ID 加入 `aria-describedby`，隱藏時只移除該 ID，保留原有描述。

純說明文字可以聚焦閱讀 tooltip，但不會被標成按鈕。不要把說明放進 CSS 偽元素；即使透明，偽元素仍可能撐寬頁面。

## Chip 與期間控制

互動 chip 使用 `.chip`；原生 `<button>` 優先。既有非原生 chip 會取得 `role="button"`、`tabindex="0"`，Enter／Space 會產生一次原有 click，讓各 tab 既有的單選、多選及自訂處理照常執行。`.active` 或現有 `*-on` 狀態會同步至 `aria-pressed`；趨勢與五線譜動態 ticker chip 以原有 inline 選取色同步；純動作按鈕（例如上月、下月）不設定 pressed。

`chipPicker(host, attr, onPick, { onlyMatching })` 的 click 與分組契約維持原樣。期間群組可加 `.period-control`，靠右加 `.period-control--end`；這兩個 class 只處理呈現及換行，日期範圍計算仍由原 tab 負責。

## 版面

- `.ui-card`：共用摘要卡片；`.section-title`、`.section-subtitle`、`.status`：標題與狀態文字。
- `.table-scroll`：讓寬表格在自身區域水平捲動；需有可辨識的 `aria-label` 和 `tabindex="0"` 供鍵盤操作。
- `.ui-details`：次要表格或方法說明，使用原生 `<details><summary>`。主要圖表與判讀保持可見；初始化時需量測寬度的圖表可以先保持 `open`。
- 間距使用 `--space-1/2/3/4/6`，文字大小使用 `--text-sm/base`。`--fg` 保留為 `--text` 的相容別名，明暗主題同步更新。

手機版以局部捲動或換行處理寬內容，不在 body 設定全站水平裁切。觸控環境的導覽、chip、日期欄位及折疊標題至少高 44px；趨勢控制列與寬表格可橫向滑動。圖表上的垂直單指滑動交給頁面捲動，水平滑動仍交給圖表；雙指圖表手勢不攔截。`viewport-fit=cover` 搭配 body 的 safe-area padding，讓橫向瀏海側仍可操作。
