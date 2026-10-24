# 共用 UI 元件

頁面無建置步驟。`js/boot.js` 呼叫一次 `initSharedUI()`；它負責 tooltip 與 chip 的鍵盤可及性，不讀取或改寫金融資料。

## Tooltip

在元素上設定 `data-tooltip="說明"`。`js/utils/tooltip.js` 在 body 建立唯一的 `role="tooltip"` 浮層，以純文字顯示，依視窗邊界定位與換行。滑鼠移入、鍵盤聚焦或觸控點按時顯示；離開、失焦、Escape 或觸控點按別處時隱藏。觸控開啟的 tooltip 沒有離開事件：顯示 2.5 秒後自動隱藏；捲動時隱藏；觸控點按別處（包含點選導覽切換畫面）時隱藏；瀏覽器上一頁／下一頁造成 hashchange 時也隱藏。滑鼠 hover、鍵盤聚焦與 Escape 的行為不變。非觸控的 tooltip 捲動與縮放時重新定位，來源離開視窗時隱藏。浮層顯示期間會把自身 ID 加入 `aria-describedby`，隱藏時只移除該 ID，保留原有描述。

純說明文字可以聚焦閱讀 tooltip，但不會被標成按鈕。不要把說明放進 CSS 偽元素；即使透明，偽元素仍可能撐寬頁面。

## Chip 與期間控制

互動 chip 使用 `.chip`；原生 `<button>` 優先。既有非原生 chip 會取得 `role="button"`、`tabindex="0"`，Enter／Space 會產生一次原有 click，讓各 tab 既有的單選、多選及自訂處理照常執行。`.active` 或現有 `*-on` 狀態會同步至 `aria-pressed`；趨勢與五線譜動態 ticker chip 以原有 inline 選取色同步；純動作按鈕（例如上月、下月）不設定 pressed。

`chipPicker(host, attr, onPick, { onlyMatching })` 的 click 與分組契約維持原樣。期間群組可加 `.period-control`，靠右加 `.period-control--end`；這兩個 class 只處理呈現及換行，日期範圍計算仍由原 tab 負責。

## 版面

- `.ui-card`：共用摘要卡片；`.section-title`、`.section-subtitle`、`.status`：標題與狀態文字。
- `.table-scroll`：讓寬表格在自身區域水平捲動；需有可辨識的 `aria-label` 和 `tabindex="0"` 供鍵盤操作。
- `.ui-details`：次要表格或方法說明，使用原生 `<details><summary>`。主要圖表與判讀保持可見；初始化時需量測寬度的圖表可以先保持 `open`。
- 間距使用 `--space-1/2/3/4/6`，文字大小使用 `--text-sm/base`。`--fg` 保留為 `--text` 的相容別名，明暗主題同步更新。

手機橫式（高 ≤500px）時標題列收起、深淺色按鈕併入分類列；主圖最高一屏（`100dvh - 16px`），多面板圖保留原高度、改用放大圖表（見 chart-focus.md）。手機版以局部捲動或換行處理寬內容，不在 body 設定全站水平裁切。觸控環境的導覽、chip、日期欄位及折疊標題至少高 44px；趨勢控制列與寬表格可橫向滑動。圖表上的垂直單指滑動交給頁面捲動，水平滑動仍交給圖表；雙指圖表手勢不攔截。`viewport-fit=cover` 搭配 body 的 safe-area padding，讓橫向瀏海側仍可操作。

## 圖表軸版面（趨勢／全球融資）

- 趨勢圖的多條 y 軸不寫死 `offset`：`render()` 依「目前有序列的軸」由內而外計算（每條軸佔刻度＋標籤間距＋最寬刻度標籤＋間隔，相鄰軸名也留間隔），`grid.left/right` 由最外側軸推導；軸名若會和圖例同列就整排移到圖例下方並加大 `grid.top`（圖例換行也計入）。寬度改變（放大圖表、旋轉、視窗縮放）時 `relayoutAxes()` 只合併 grid／offset／nameGap，不重畫序列、不動縮放。軸 id／position／min／max／序列綁定、刻度格式與單位字樣都不改。
- 全球融資圖與錨點％圖用 `containLabel` 加固定 8px 的 `grid.bottom`（不用百分比，避免短橫向圖下方留白）。圖上方有一排市場 chips（`#mg-market-picker`，`.chip` 單選，鍵盤與 `aria-pressed` 由共用 chip 機制處理）；chips 與表格列都呼叫同一個 `selectMarket()`，狀態只有 `activeMarket`。觸控環境選市場後，若 chips＋圖不在畫面內才捲到 chips 列；短橫向（高度 ≤500）時圖高扣掉 52px 的 chips 列，使 chips 與整張圖同屏。桌面（非觸控且寬螢幕）不自動捲動。
