# 導覽與按需載入

js/navigation-catalog.mjs 是 72 頁的 id、顯示名稱、八分類與模組路徑的唯一清單。registryEntries() 在 boot.js 註冊 load()，匯入 catalog 不會下載頁籤模組。預設只啟動趨勢；直接開 #tab=fsi 只下載金融壓力頁及其依賴。切換主題不預載未開啟頁。

選頁一律走 navigation.js 的 selectTab：同步更新分類、子選單及 section，再由 dispatcher 按需啟用。網址用 #tab=<id>；支援瀏覽器上一頁／下一頁，同頁重選不新增歷史。不存在或損壞的 id 回趨勢。支援的期間 chip 以既有 data-*-range 的鍵和值記入 rangeKey／range；回復前先確認該頁真的存在唯一相符 chip。其他自訂參數不包含在分享連結。

「全部畫面」保留 72 頁單一清單及分類搜尋。每列星號可收藏，儲存在 pf:favorites:v1；「只看收藏」是清單篩選，空集合顯示提示。分享目前頁先嘗試複製完整網址，Clipboard 不可用時顯示可選取的連結。壞掉的收藏資料會安全忽略。

可用 macOS 的 ⌘K 或其他平台的 Ctrl+K 開啟同一個「全部畫面」搜尋；按鈕 title 與 aria-keyshortcuts 提供提示，原按鈕名稱與點按入口保持不變。已開啟時只聚焦搜尋，不清空查詢或重複 showModal。輸入框（搜尋框本身除外）、textarea、select、contenteditable／textbox、IME composition、已處理的 event、其他開啟中的 dialog、Alt／Shift 組合與按鍵長按不攔截；沒有新增裸字母或數字快捷鍵。Escape 或關閉按鈕回到開啟來源（按鈕或原焦點元素）；若來源已移除則回「全部畫面」按鈕。選搜尋結果則回新頁的 sub-nav 按鈕。這是適配現有 native dialog 的互動概念，沒有引入 Vela 元件、keymap store 或依賴。

其他 modal 的判斷涵蓋 native `dialog[open]` 與可見的 `[role="dialog"][aria-modal="true"]`，因此圖表聚焦時不會再打開搜尋。具有 `hidden` 或位於 `hidden` 祖先中的 modal 不阻擋；搜尋自己的 dialog 不列為衝突。

首次動態匯入失敗可按 dispatcher 的「重試」。模組根 URL 用一次 lazyRetry=1 新網址繞過瀏覽器 ESM 失敗快取；依賴 URL 若已被快取為失敗，新根 URL 仍無效，第二次失敗後顯示「重新載入頁面」並保留 hash。正常匯入不附 cache buster。金融資料載入失敗仍走 dispatcher 原本的重試與 signal cache 清理。

搜尋 dialog 隨 visualViewport 的高度與位移更新；短視窗縮小間距、保留 44px 搜尋與關閉按鈕，僅結果區捲動。沒有 VisualViewport 時沿用 CSS viewport。這是瀏覽器模擬與漸進增強，不能代替實機 iOS Safari 鍵盤驗證。
