# 市場預警與策略回測：方法與限制

頁面：`#tab=marketrisklab`（策略與工具 → 市場預警與策略回測）。模型版本 `mrl-1.0.0`（`scripts/_market_risk_lab.py` 的 `MODEL_VERSION`）。

## 檔案

| 角色 | 檔案 |
|---|---|
| 額外行情 | `scripts/fetch_market_risk_lab_prices.py` → `data/market_risk_lab_prices.json`（QLD、SSO、USD、RSP、^NDX、NQ=F） |
| 計算核心 | `scripts/_market_risk_lab.py`（純函式，無 I/O） |
| 每日訊號 | `scripts/compute_market_risk_lab.py` → `data/market_risk_lab.json` |
| 回測 | `scripts/backtest_market_risk_lab.py` → `data/market_risk_lab_backtest.json`（`--mode daily`／`--mode full`） |
| 頁面 | `js/tabs/marketrisklab.js`、`js/tabs/marketrisklab_calc.mjs` |
| 測試 | `scripts/tests/test_market_risk_lab.py`、`js/tabs/marketrisklab_calc.test.mjs` |
| 排程 | `.github/workflows/fetch.yml`（us、tw job 各一次）、`.github/workflows/market_risk_lab_weekly.yml`（週六 10:00 台北） |

## 使用者規則（照原定義實作，未修改）

| 規則 | 訊號基準 | 交易標的 | 實作 |
|---|---|---|---|
| 深度修正 Reset | QQQ 盤中低點，或 Nasdaq 期貨 NQ=F 日 K 低點（含夜盤） | — | `low_t ≤ MA300_{t-1}`，不要求收盤跌破 |
| SSO 啟動 | S&P 500 指數（^GSPC） | SSO | 收盤 < 200MA 之後，第一次收盤 > 125MA（或 150MA，兩版都算） |
| QLD 啟動 | QQQ | QLD | Reset 之後，先收盤 < 150MA，再第一次收盤 > 150MA |
| USD 啟動 | 費城半導體指數（^SOX） | USD | 費半自己的 Reset → 站回 150MA |
| 00631L 啟動 | 台灣加權指數（^TWII） | 00631L | 加權自己的 Reset → 站回 150MA；**不使用 QQQ 訊號** |

工程上補的定義（不是使用者規則，頁面上有標示）：

- **盤中觸及的參考線**：盤中無法知道當天收盤，所以用前一日收盤算出的 MA300。
- **盤中資料缺失**：該日記為「無法判定」，不以收盤冒充觸及。
- **Reset 去群聚**：觸及之後，收盤要連續 60 日（可切 20 日）站上 300MA，才記下一次 Reset。
- **SSO 跌破事件去群聚**：觸發後收盤連續 20 日在 200MA 之上，才接受下一次跌破。
- **訊號與成交**：收盤條件在 t 日收盤後成立，最早 t+1 開盤成交。
- **出場**：使用者沒有定義。回測提供三種研究假設：一次投入持有 252 日、三批（間隔 21 日）各 1/3 持有 252 日、基準收盤跌破 200MA 出場（最長 756 日）。

## 訊號回測（事件研究）

- 錨點：訊號日收盤；前瞻 20／60／120／252 個交易日；價格指數（不含息）。
- 指標：觸發次數、平均、中位數、上漲比例、再破底（前瞻期間最低價 < 訊號前 60 日最低價）、MAE／MFE、期間最大回撤、平均數 bootstrap 90% 區間（事件層級重抽 2000 次，seed 固定）。
- 無訊號基準：從第一個事件起，所有交易日的同天期報酬分布。
- 群聚：與前一事件相距 < 60 日標記 `clustered`，另給去群聚版統計。
- 樣本內外：2013-01-01 前後切開（固定切點，未調參）。
- 右設限：視窗未滿 → `pending`，不給報酬、不進統計（`validate_data.py` 會擋帶報酬的 pending）。

## 策略回測（組合 NAV）

- 初始 1,000,000；未投入現金利率 0。
- 價格：交易標的的真實成交價，`adj_close/close` 換算含息。槓桿 ETF 的每日重設、費用與追蹤誤差都已包含在實價裡；**不以指數報酬 ×2／×3 推算**。ETF 成立前的訊號列出但不回測。
- 成本（單邊）：美股手續費 0.05%＋滑價 0.05%；台股手續費 0.1425%（賣出加證交稅 0.1%）＋滑價 0.1%。
- 持有中出現新訊號不加碼。
- 統計：CAGR、最大回撤、Sharpe（rf=0）、持有比例，並列同期間買進持有。

## Walk-forward

只針對 SSO 的四種變體（125／150 × SMA／EMA）。每年 1/1 重選，訓練只用 120 日視窗在年初前已結束的事件，至少 5 筆才選；把當年事件的 120 日報酬併入樣本外。

## 排程與防呆

- 每日（fetch.yml）：us job 抓額外行情 → compute → backtest daily；tw job 收盤後 compute → backtest daily。
- 每週（market_risk_lab_weekly.yml）：工程測試 → compute → backtest full → validate_data → 只 commit 這兩個檔。
- 輸入雜湊（11 個輸入檔）與模型版本都沒變 → backtest 不寫檔。
- 任何腳本例外 → 不寫檔、保留上次成功結果；額外行情某檔失敗 → 保留該檔舊資料並記在 `failed`，前端顯示「部分來源抓取失敗」。
- 前端：更新日超過 5 天顯示「過期」；回測檔缺失時顯示 partial，只有當前訊號。
- 公開頁面沒有 GitHub Actions 啟動按鈕，也不含任何憑證。

## 代理資料與已知限制

- 美股廣度（`breadth.json`、`sp500_ad.json`）用現任成分股回填，非 point-in-time，含倖存者偏誤；分別只到 2019-11、2015-12。不是完整歷史成分股廣度。
- RSP/SPY 是等權 vs 市值加權的代理。
- 領漲股破線／突破失敗：未自動化（沒有可追溯的領漲股清單）。
- NQ=F 是未換月調整的近月連續合約，長均線受換月跳空影響；只有日 K 高低點，不是逐筆。
- 台股只有現貨日 K，不含台指期夜盤。
- 歷史案例日期是人工挑的急跌開始日，N=5，不是統計證據。
- 2026-10-15 Mark Minervini 建立 SPY 空單：查無可核實的一手來源。頁面只列出當天收盤前已公開的指標，不重建其模型。

## 台股訊號分級

| 分級 | 指標 | 依據 |
|---|---|---|
| 已驗證核心 | 加權盤中回撤 ≤ −20%（00631L 分批） | 恐慌進場回測 V2；微觀流動性 V3 結案維持 |
| 使用者規則 | 加權 300MA Reset → 150MA 站回 | 使用者規則，本專案未驗證增量價值 |
| 輔助觀察 | TWVIX ≥ 40、廣度／跌停／融資、國安基金 | 都沒有勝過只看回撤 |
| 研究中／未通過 | V3 微觀流動性（價差修復、可轉債、當沖） | V3.0.2 結案：樣本外沒有穩定勝過 M0，不納入交易觸發 |
