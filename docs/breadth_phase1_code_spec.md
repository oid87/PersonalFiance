# 市場廣度第一輪 B：程式與事件研究盤點

## 目標與難度
給下一輪P1／P2／P5提供具體檔案與方法規格依據，避免重新發明事件回測。唯讀研究，難度 medium：必須從實際程式判斷時間對齊、樣本依赖與可重用程度。executor gpt-6-sol / medium，不再派子代理。

## 唯一可新增檔案
- `/Users/orangembpm2/work/code/personal_financial/PersonalFiance/docs/breadth_phase1_code.md`
其他檔案唯讀；不修改程式、data、設定、memory；不commit、不push。repo有其他未提交工作，必須保留。

## 集中盤點已完成的輸入
- [實測] 主session核對 `js/tabs/breadth.js:16`：SP500→SPY、NDX→QQQ、XLG→XLG、TW50→0050；`:136`計算ETF本身20/50/200MA。
- [實測] `scripts/_breadth.py:78`計算站上MA比例；`:47`下載auto_adjust=True。`:169`起的流程有4日freshness skip。資料只保留彙總，沒有逐檔日報酬或每日A/D家數。
- [實測] `index.html:686`提供20/50/200切換；`:739`明示當前成分股套用歷史之偏誤。
- [查證] 前次集中Explore子代理確認 `js/tabs/naaim.js:140,187,230`有事件去重/forward return/baseline候選；請精讀驗證，不直接信標籤。
- [實測] `js/tabs/wkrev.js:114`有forwardReturn及統計；註解與函數參數是否相符須追查caller，不能只看註解。
- [查證] `js/tabs/roc4.js:209`提示事件重疊；`js/tabs/marginpeak.js:378`起有事件後路徑與分布圖。
- [查證] 前次Explore發現 `scripts/compute_sentiment.py:88`附近以日曆天位移，可能與期數標示不符。只確認是否影響重用，不修正相鄰功能。
- [查證] 先前Explore回報UI的SP500 tooltip稱VOO，但實際SPY；200MA比例的有效分母與UI total可能不同。請重驗並列入P1候選修正，不自行改碼。

## 怎麼做（定案流程）
1. 讀repo AGENTS.md及本spec，只在下列檔案做精讀／定位，不再掃整個sandbox。
2. 已定位讀取清單：`js/tabs/breadth.js`、`scripts/_breadth.py`、`scripts/fetch_breadth{,_ndx,_xlg,_tw50}.py`、`js/tabs/naaim.js`、`js/tabs/wkrev.js`、`js/tabs/roc4.js`、`js/tabs/marginpeak.js`、`scripts/compute_sentiment.py`、`js/utils/{dates,math,data}.js`、`js/boot.js`市場廣度導覽區、`index.html`breadth section、`.github/workflows/fetch.yml`breadth steps、`scripts/update_all.sh`breadth呼叫。
3. `data/breadth*.json`只用腳本印schema、起訖、各欄首次有效與最後一列，不cat整檔；overlay JSON亦只摘要。可追已讀模組的直接import相依，但報告列出新增閱讀範圍。不讀密鑰或其他工作目錄。
4. 產出能力／缺口表：現有功能、證據檔案行號、可直接重用／需重構／不宜重用。區分event study（收盤後描述統計）與可交易策略回測（確認後才執行），不要把same-close計算自動稱為可成交策略。
5. 對可重用邏輯檢查：交易日與日曆日、事件去重/冷卻窗、可交易時間、未完成horizon、價格/總報酬、maximum loss vs peak-to-trough drawdown、baseline、重疊樣本與樣本數。以具體程式證據說明，不僅列一般風險。
6. 建議下一輪最小模組邊界、輸入/輸出資料契約與檔案清單。方案以現有純前端ES module／靜態JSON架構為準，不加框架、不拆新tab（預期沿用breadth頁）。共同訊號的時間窗/閾值先列待主session裁定，不擅自最佳化。
7. 提供6-10項有辨識力的離線合成資料驗收案例，每項含fixture條件與expected結果；至少包括資料尾端不完整、兩種回撤不同、重複訊號去重、同日確認與次日執行分離。不寫測試檔、不跑全套repo測試。

## 交付與驗收
- 繁中報告≤180行，含「能力與重用表」「方法問題」「建議模組與資料契約」「下一輪檔案範圍」「驗收案例」「deviations」。
- 所有程式判斷附repo相對路徑與行號、證據分級[實測]/[查證]/[推論]；不要把尚未查證的問題宣稱成bug。
- 至少列出3個候選事件研究模組的重用判斷；日期窗口、分母、price adjustment三項均有結論。
- 不把当前成分股回填序列當作無偏歷史，A-D不能從aboveMA比例反推。
- 完成回覆≤12行：報告路徑、首選模組邊界、主要限制、deviations、分支名、是否commit/合回（本包应为未commit、不適用）。不貼整份報告。

## 不做
不實作、不新增產品功能、不修相鄰bug、不重構其他tab、不新增資料來源、不重跑全量下載、不另派代理、不進行網路研究（由A包負責）。
