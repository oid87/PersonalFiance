# 壓力總覽摘要卡片佈局

本次採用 dashboard 的「摘要 panel 先於主要圖表」及等寬分組概念，使用 PersonalFiance 既有 CSS tokens 與 `.breadth-card` 呈現。沒有複製 Vela source、加入 framework 或改變 renderer、資料、金融指標、freshness 判斷。

## 範圍與接線

- 新增 `css/dashboard-layout.css`，只選取 `#stressdash-top` 與其直接 `.breadth-card`。
- 主整合 task 在 `css/main.css` 開頭加入 `@import url("./dashboard-layout.css");`。此獨立 task 不修改該核心檔案。
- 沿用現有 markup、三個指標的順序、字級、色彩與卡片內距；不調整控制列、圖表高度或其他頁面。

## 佈局理由

原 markup 有三張卡片，但 `main.css` 的共用摘要容器 selector 沒有 `#stressdash-top`，因此這些 block 原先逐張佔滿寬度。

新的 grid 使用 `repeat(auto-fit, minmax(min(100%, 18rem), 1fr))`。最小欄寬 18rem 留出現值、觀測日期及判讀文字的閱讀空間；寬度不足時自動減少欄數。`min(100%, …)` 讓狹窄容器不因最小欄寬溢出；`min-width: 0` 與換行讓卡片內容參與縮放，不以裁切隱藏資訊。三張卡片維持來源順序，中間寬度可以形成兩欄與一張第二列，不假造四張或新增合成 KPI。

外距採既有 `--space-4/6`，768px 以下改用 `--space-3`，與原站手機版 12px 邊距一致；邊線採 `--border`。沒有固定卡片高度，長文字可自然增加高度；同一 grid 列內卡片預設等高。

## 真實瀏覽器驗收

由主整合 task 對接線後的 snapshot 執行，以下尚未於此 task 視覺驗證：

| 情境 | 驗收條件 |
|---|---|
| 桌機 1440px、預設字級 | 三張卡片同列、等寬、間距一致；內容與原 snapshot 相同，圖表緊接摘要區下方 |
| 中間寬度 768px | 卡片可形成兩欄；第三張自然落到下一列，來源順序不變，沒有整頁水平溢出 |
| 手機 390px | 三張卡片單欄，左右 12px 間距；現值、日期、signal 完整可讀且沒有裁切 |
| 明／暗主題 | 卡片仍沿用原站 panel、border、text tokens；沒有硬編碼主題色 |
| 縮放至 200%／長內容 | 欄數可減少，文字可換行；卡片不裁切、不重疊控制列與圖表 |
| Tab／ticker／range 切換 | 圖表與卡片仍載入、數值及判讀一致；切換出去再返回可 resize，沒有新的 console error |
| 相鄰頁面 regression | breadth、nfci、twstress 等既有卡片排列不變；新增 selector 沒有套用到其他 tab |

這是 CSS layout 改動，沒有新增鏡像 stylesheet 的單元測試；既有離線檢查與上述真實畫面驗收由主 task 執行並分別記錄結果。
