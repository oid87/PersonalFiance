# 美股高檔風險研究頁（#tab=uspeakrisk）：公開資料白名單與來源對照

研究：`研究_美股高檔預警_2026-11-15`（P1 最終版，2026-11-15 結案，資料截止 2026-11-13）。本頁只展示研究彙總，不重算模型。

## 前端讀取的檔案

| 檔案 | 性質 | 新增？ |
|---|---|---|
| `data/uspeakrisk.json` | 研究彙總（分類、統計量、覆蓋率），無任何價格序列 | 本頁新增 |
| `data/SOX.json`、`data/SP500.json`、`data/QQQ.json`、`data/SPY.json` | 網站既有每日收盤檔（全站共用，由既有 fetch 管線產生） | 既有，本頁未新增、未修改 |

RSP 沒有既有公開檔，探索器的 RSP vs SPY 顯示「資料不可用」。

## `data/uspeakrisk.json` 白名單（`scripts/build_uspeakrisk_data.py` 的 `SOURCES`）

| 欄位 | 研究來源 | 內容 |
|---|---|---|
| lead_events | out/p1v2/sox_lead_events_v2.csv | 每次 SOX 訊號的日期、分類、領先天數、布林結果（不含價格） |
| lag_dist | out/p1v2/sox_lag_distribution.csv | 領先天數分位數 |
| fair | out/p1v2/fair_compare.csv | 公平比較命中率與 Wilson 區間 |
| models | out/p1v2/short.csv、long.csv（AUC、Brier）＋ out/p1v3/event_level_EA.csv（EA 事件層級、危機區塊 CI） | 模型比較 |
| loco | out/p1v2/loco_strict.csv | 嚴格 LOCO 摘要 |
| coverage | out/coverage_yearly.csv | P0 歷史成分股覆蓋率 |
| provenance | 上述各檔 | 相對路徑與 SHA256 |

明確排除：研究的 `data/index/*`、`data/prices/*`（Yahoo 原始行情）、`data/raw/*`、任何本機路徑。腳本 `check_public()` 會擋本機路徑與憑證字樣；`js/tabs/uspeakrisk_calc.test.mjs` 檢查欄位白名單與關鍵數字。

## 未解決的授權事項（需使用者決定）

既有的 `SOX/SP500/QQQ/SPY.json` 來自 Yahoo Finance，Yahoo 條款未授權再散布。這些檔案早已由網站公開；本頁沿用它們做描述性圖表，沒有增加新的行情檔。若決定不再公開 Yahoo 衍生行情，探索器會自動顯示「資料不可用」，其餘區塊不受影響。
