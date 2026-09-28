# P1/P2 獨立驗收

## 任務
sol / high verifier，不再發包。各包實作完成後獨立檢查，不以executor的PASS代替驗證。可先驗已完成的純核心與Python包；UI仍在實作時不得把暫時缺檔當FAIL，等主session明確發送「UI ready」才讀／測UI，最後一次交整合結果。等待用collaboration.wait_agent接事件，不poll檔案或問進度。難度high：時點、樣本範圍、缺值與回撤會直接影響財經研究結論。

## 範圍
repo `/Users/orangembpm2/work/code/personal_financial/PersonalFiance`。
唯讀實作：`scripts/_breadth.py`、`scripts/tests/test_breadth_schema.py`、`js/utils/eventStudy{.mjs,.test.mjs}`、`js/tabs/breadthSignals{.mjs,.test.mjs}`、`js/tabs/breadth.js`、`index.html`的tab-breadth、`css/main.css`新增breadth樣式、`scripts/test_breadth_browser.cjs`。
讀三份spec：`docs/breadth_p1_data_spec.md`、`docs/breadth_p1p2_core_spec.md`、`docs/breadth_p1p2_ui_spec.md`及AGENTS.md。
唯一可寫repo檔：`docs/breadth_p1p2_verification.md`（≤140行）。臨時探針與截圖寫系統暫存目錄。不得修改程式、不commit/push、不動資料、不修其他問題。所有新發現附檔行號及重現／預期／實際，回報root修正。

## 證據
- [實測] 本輪前原檔快照在 `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-before-kv5iqa_0`，含index、breadth.js、_breadth.py、boot、fetch.yml、update_all。repo原本已有大量未提交工作，不把全部git diff歸因這輪。
- [實測] 主session已用獨立Python標準庫對SP500/50MA/down/MAX/20session冷卻重算，基準在 `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-oracle.json`；包括事件日期、raw59/kept31、各horizon報酬/回撤與baseline。若資料被外部刷新導致不同，先核對日期，不覆寫基準迎合實作。
- [實測] 本機Python測試環境 `.venv/bin/python`；Playwright在 `/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`；server 127.0.0.1:8766已啟動。

## 驗收清單
1. 執行新增node tests、新Python tests、新browser test；檢查它們是否具有辨識力，不只是照實作重述。新增獨立adversarial probe可在暫存目錄。失敗保留原始資訊，不標PASS。
2. 冷卻是全史先做再研究範圍，baseline是同eligible母體，同horizon排未完成；最大虧損與peak-to-trough MDD不同；缺价不壓縮sessions、不補尾價；paths固定cohort而非每offset混樣本；回報overlap不說獨立樣本。
3. 確認signal只用當下與過去；divergence首次且缺日不橋接；MA完整warmup；HB30包含當天只取30而非31；90/180峰值按ETF日期軸。
4. 核對core全精度結果與oracle（允許浮點1e-8）；保留n/日期完全一致。至少抽查另一个市場／200MA空段。
5. 舊20/200有效分母未知，新schema計數真實；新增欄位不full-backfill；data檔本輪未改；updated不能冒充日期。資料失敗及async race不能顯示錯市场。
6. browser實際切四市場三均線、研究選單、單次事件路徑、兩主題及390px；hover包含scatter、舊分母顯示正確；冷啟動故障和retry。看截圖，不能只有DOM assertion。
7. 產品明示描述性close價格報酬與成分偏誤；空樣本與不足樣本不說高勝率。P3/P4/P5不混入本輪。
8. `python3 ../Financial_work/check_reuse.py js/tabs/breadth.js`；比較快照index的breadth以外區塊完全相同；boot/fetch.yml/update_all不被本輪改。CSS新增只影響breadth。

## 輸出
報告寫PASS／FAIL／帶限制，列已跑命令、關鍵數字、問題與deviations。最終訊息≤15行，列P1/P2 blocker優先級與重現，不貼全部日誌。附branch與commit/merge狀態；本輪預期main未commit、不涉及合併。
