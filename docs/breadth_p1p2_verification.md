# P1/P2 獨立驗收（2026-09-28）

結論：**PASS（帶資料未改之證據限制）**。本輪範圍未發現 P1／P2 blocker；沒有修改實作、下載資料、commit 或 push。
驗收分支：`main`；本輪未 commit，不涉及隔離分支合併。原有未提交工作不能歸因本輪。

## 執行與證據

| 檢查 | 結果 |
|---|---|
| `node --test js/utils/eventStudy.test.mjs js/tabs/breadthSignals.test.mjs` | 18／18 PASS |
| `.venv/bin/python -m unittest scripts.tests.test_breadth_schema -v` | 7／7 PASS |
| `PLAYWRIGHT_MODULE=/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright node scripts/test_breadth_browser.cjs` | PASS |
| `node /tmp/breadth-verifier-core.mjs` | SP500 oracle、NDX200空段、三MA prefix invariance PASS |
| 獨立 Python 標準庫重算 NDX200（臨時探針） | 事件／eligible 日期、七horizon所有統計 PASS，容差1e-8 |
| 獨立舊 `_breadth.py` snapshot vs 現版合成DataFrame重算 | 271行所有既有欄位完全相同，僅新增三分母 |
| `node /tmp/breadth-verifier-ui.cjs` | 獨立oracle對UI、實際scatter hover、schema與overlay故障 PASS |
| `python3 ../Financial_work/check_reuse.py js/tabs/breadth.js` | PASS，無新違規 |
| `git diff --check` | PASS |
| index範圍與管線逐byte比對起始snapshot | breadth以外相同；boot／fetch.yml／update_all相同 |

離線測試包含有辨識力的固定expected：100→120→90→110為報酬+10%、anchor loss−10%、MDD−25%；null位置、20session邊界、from不重置冷卻、Friday+2sessions、固定cohort、180日暖身與HB30邊界。Python mock實際走重算／merge，非只驗freshness skip。
Node僅有既有package未宣告module type警告，沒有測試失敗；未修改package。

## 核心與資料核對

- `eventStudy.mjs:87-106` 全史冷卻先於研究範圍；baseline取相同eligible母體及horizon完整窗口，未再冷卻。
- `eventStudy.mjs:46-61` 保留ETF日期軸，尾端與缺價分開排除；沒有補尾價、壓縮null或提前round。
- `eventStudy.mjs:108-124` paths僅完整horizon固定cohort，各offset同n；individual首缺口後永久null。
- `breadthSignals.mjs:38-68` MA完整暖身；前一ETF session缺值不橋接；divergence只首次成立；所有信號只用當下與過去。三MA prefix invariance實測通過。
- `breadthSignals.mjs:62-74` 90／180峰值按ETF軸；HB最近30包含當天，不是31；未知hl_total不猜測。
- `_breadth.py:132-149` 新三分母為真實valid count，零分母保留0；total仍等於50分母，原百分比公式相同。
- `_breadth.py:167-218` 新欄位缺失不觸發full backfill；freshness不下載／重寫；舊行保留；metadata行情lastDate與updated分開；空下載／失敗原檔不變。
- 舊20／200分母未知；`getBreadthDenominator:23-27` 僅50可退回total，未反推rounded pct。

SP500／50MA／down／MAX／20session：raw **59**、kept **31**，事件日期與主session Python oracle完全相同；oracle所存七horizon統計容差1e-8。

| horizon | signal n | baseline n | signal mean % | baseline mean % |
|---|---:|---:|---:|---:|
| 5 | 31 | 1710 | -0.017015834352238 | 0.297402274833042 |
| 10 | 31 | 1705 | 0.696845163249060 | 0.589524376474147 |
| 21 | 30 | 1694 | 0.630966850793054 | 1.235537482036910 |
| 42 | 30 | 1673 | 2.850715976605303 | 2.437614466139926 |
| 63 | 30 | 1652 | 4.435480846370290 | 3.611919528124188 |
| 126 | 28 | 1589 | 8.035964526174650 | 7.926712721784904 |
| 252 | 25 | 1463 | 12.947683041989212 | 16.083904445384420 |

63日：signal median 5.507551326480609%、winRate 73.33333333333333%；mean anchor loss −5.083822473845191%、mean MDD −7.615675028220362%。重疊21／29，非獨立樣本。
另一市場NDX／200MA／down：raw16、kept8；独立Python重算七horizon所有11個統計欄位及baseline、所有日期相同。首次有效200MA廣度2020-07-15；此前pct unknown不入eligible。

## UI、故障與目視

- 四市場×三MA、三訊號×三研究範圍×七horizon實際切換；ETF對應SPY／QQQ／XLG／0050正確。HB pin、VIX、F&G仍可用。
- UI七horizon n、mean、median、winRate、baseline及worst損失／MDD逐格比對獨立Python oracle；全部31個保留事件列出。
- 主圖range不影響研究；研究range也不影響主圖日期軸。主圖使用ETF session軸至共同日期，缺值留null。
- 實際mouse hover研究scatter，ECharts tooltip包含SPY與當日訊號，舊200MA顯示「分母未記錄」，無array.toFixed錯誤。
- 選單次事件路徑、固定cohort中位線、尾端未完成／缺價後不補線、空樣本提示與—績效均通過。
- 冷啟動breadth503／price503／empty→retry恢復；額外invalid-date schema測試失敗時清空卡片、圖及研究，沒有把舊市場冒充新市場。
- 延遲NDX response後切TW50，舊response不能覆蓋0050；VIX503明示載入失敗、沒有冒0，明確toggle後可重試。
- 深色／淺色兩圖與390px實測；沒有整頁橫向溢出，寬表在容器捲動。截圖已逐張目視：選單、方法文字、卡片、分位帶、個別路徑、事件表均可讀。
- 產品顯示收盤價格報酬、不含息／成本、描述性／非可成交策略與成分偏誤；小n提示、不把n0說成高勝率。未混入P3／P4／P5。

截圖（已目視）：
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-dark.png`
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-light.png`
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-mobile.png`
- `/tmp/breadth-verifier-hover.png`（實際scatter hover；拍攝當下chart仍在切range動畫，不用此圖判完整歷史線）

## 限制與deviations

- 起始沒有data雜湊，無法以cryptographic證據證明本輪全部data byte未改。四breadth列數／起訖／尾比例及total／hl_total與phase1_code報告完全吻合，mtime早於本輪data spec；mtime只作旁證。
- 四breadth尾日均2026-09-24；SPY／QQQ／XLG價格尾日2026-09-25，0050為2026-09-24。此日期不同步已在UI明示。
- 原repo有大量data與其他未提交diff；沒有把HEAD diff全部歸因本輪。`index.html`採tab-breadth到下一tab區塊比對，避開新增內層section造成的誤判。
- CSS新規則限定於#tab-breadth；管線／boot對起始snapshot逐byte相同；未引入新來源。
- 驗收僅覆蓋本輪P1／P2，沒有可成交策略、完整交易所calendar或point-in-time成分驗證。實作API無deviation。

## 主 session 收件複核

- 已親自核對SP500七期Python oracle及事件日期，並讀取核心公式、分母資料diff與本報告。
- 已親自比對主工作目錄index範圍外內容及boot／fetch／update_all快照，確認既有工作保留；四市場200MA實際運算正常。
- 已目視深色與手機截圖，另於Codex內建瀏覽器開啟市場廣度頁，確認日期、分母未知提示、59／31事件與七期表格可見。
- 畫面解讀中的內部欄位名已改為「可計算52週高低點的有效家數」；僅文案，不影響公式。
- 主工作目錄main可用；尚未commit／push／部署，沒有待合併的背景分支。
