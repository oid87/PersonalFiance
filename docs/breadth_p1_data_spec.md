# P1 廣度有效分母與metadata

## 目標與派工
sol / medium，不再發包。只補既有fetch共用核心與離線測試，不下載、不重寫實際data，不變更現有股票母體／MA比例公式／排程。

## 可寫檔案（絕對路徑）
- `/Users/orangembpm2/work/code/personal_financial/PersonalFiance/scripts/_breadth.py`
- `/Users/orangembpm2/work/code/personal_financial/PersonalFiance/scripts/tests/test_breadth_schema.py`（新增）
其他檔案唯讀，不commit/push。先讀repo AGENTS.md；閱讀只限本spec、_breadth.py、_common.py的load_rows、現有tests必要測試慣例。

## 已知證據
- [實測] `_breadth.py:82-92`已有n20/n50/n200；`:132-147`輸出total=n50但不輸出各MA分母。
- [實測] `run`以freshness先跳過；依舊欄位缺失full backfill；增量重算尾段30日。今回新增欄位不能觸發全史重算。
- [實測] fetch_prices使用auto_adjust=True；成分由外部get_tickers取得，既有歷史混合批次，不能標為PIT。

## 固定實作
1. compute_breadth每列新增above20_total/above50_total/above200_total，以實際valid counts整數（0亦保留），total保持等於above50_total，既有數值與其他欄位不變。
2. 成功下載／合併寫檔時頂層加schemaVersion:2及meta：`{label,priceBasis:'yfinance-auto-adjusted',constituentsBasis:'current-snapshot-backfill-mixed-vintages',lastDate:merged[-1].date或null,denominatorPolicy:'per-window-valid-count',legacyDenominators:'unknown-for-20-and-200'}`。updated仍是本次寫檔日，不是行情日。
3. freshness skip保留現有流程，不為新schema下載或重寫；舊資料缺新total也不清空歷史、不觸發full backfill。增量時舊row保留原樣，不用total或round pct反推20/200total。
4. 不重構重試／下載／freshness，不改呼叫端signature。不新增來源，故不動CI與update_all。空下載/失敗不得破壞原檔。

## 驗收
以合成DataFrame（不同IPO/缺值期間）確定n20/n50/n200不同且舊pct/count保持同公式；0分母為0且pct null。臨時目錄+mock fetch驗證freshness不下載；只有新欄位缺失不full-backfill；增量保留舊行缺分母；meta/lastDate正確；fetch失敗不覆寫。須真的走mock重算分支，不能僅比較skip前後檔案。
用現有可用Python環境跑新test；找不到pandas/yfinance可確認現有venv/conda，不全域安裝。完成≤12行：變更、測試、deviations、branch/commit/merge。不得讀憑證。
