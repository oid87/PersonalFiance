# Spec：自算 S&P 500 每日漲跌家數，接上 P3 A-D 線

日期：2026-09-28。交給 ChatGPT/Codex 實作；驗收另派 verifier（high）。

## 背景：資料源調查結論（2026-09-28）

| 項目 | 結論 | 證據級別 |
|---|---|---|
| NYSE 每日 A/D（P4／P5 所需） | **本次調查未找到免費、可程式下載、持續更新且符合本專案口徑的來源。** Unicorn 停在 2020-02-10；Nasdaq Data Link URC 被 Incapsula 擋 403；Barchart（AWS WAF）、StockCharts、Stooq、MarketWatch、ADVFN 擋 bot 或匯出要付費；Yahoo `C:ISSU` 代號在但 0 筆；WSJ Markets Diary 只有當日快照、無歷史 API。拼接舊史＋新來源有口徑問題（NYSE composite vs 普通股，StockCharts 自己就有兩版）。 | [實測，調查 agent] |
| 現成 S&P 500 A/D | 只有 DeanFinancials `https://raw.githubusercontent.com/DeanFinancials/deanfi-data/main/advance-decline/ad_line_historical.json`：500 列、2024-09-27 → 2026-09-25，欄位 `date/advances/declines/net_advances/ad_line`，**無 unchanged**。 | [實測，本 session curl] |
| 自算可行性 | 以現任成分股＋yfinance 收盤 vs 前一日收盤，2025 年抽 6 天與 DeanFinancials 比，每日只差 0–2 檔（例：2025-06-13 自算 69/431、Dean 70/430）。兩者都用現任成分，**一致只證明算法相同，不證明歷史成分正確**。 | [實測，調查 agent] |
| 回溯到 2000（point-in-time） | 成分表 `fja05680/sp500`（MIT，1996 起）可用，但 yfinance 抓 2005／2010 成分股分別 40%／32% 查無資料，且代號被回收（`POM`、`CAM` 在 Yahoo 是 2025 起別家公司）。**本 spec 不做。** | [實測，調查 agent] |

結論：**只做 P3 的 S&P 500 自算版；P4／P5 維持「只能匯入」**，不動。

## 為什麼

讓 P3（A-D 線跌破 200MA）有真實資料可看，同時不讓使用者誤以為這是 point-in-time 的正確廣度。現任成分回推含倖存者偏誤，可能改變 A-D 線與事件日期；偏誤方向未經驗證，不保證線偏高或事件偏少，這點必須在 UI 明示。

## 改哪些檔（清單外不得動）

| 檔案 | 動作 |
|---|---|
| `scripts/fetch_sp500_ad.py` | 新增：抓價、算漲跌家數、寫 `data/sp500_ad.json` |
| `scripts/tests/test_sp500_ad.py` | 新增：離線單元測試 |
| `js/utils/data.js` | 修改：`fetchJSON(url, {raw=false}={})` 可選保留完整 JSON，預設行為不變 |
| `js/utils/__tests__/data_loading.test.mjs` | 新增或修改：驗證預設解包及 raw 模式保留 metadata |
| `js/tabs/breadthAdvanced.mjs` | 修改：新增純函式 `projectSp500Bundle` |
| `js/tabs/breadthAdvanced.test.mjs` | 修改：新增該函式測試 |
| `js/tabs/breadthAdvancedPanel.js` | 修改：新增「載入專案自算」按鈕流程 |
| `index.html` | 修改：`#breadth-advanced-panel` 的 `.advanced-controls`（約 736 行）加一個按鈕 |
| `scripts/test_breadth_advanced_browser.cjs` | 修改：加按鈕流程的瀏覽器案例 |
| `.github/workflows/fetch.yml` | 修改：加一個 step |
| `scripts/update_all.sh` | 修改：加一行 |
| `docs/breadth_p3p4p5_import.md` | 修改：加「專案自算 S&P500 A/D」一節 |

⚠️ `fetch.yml` 與 `update_all.sh` 目前已有**未 commit 的 FINRA 改動**，原地加行，不可還原或覆蓋那些改動。

## 怎麼做

### 1. `scripts/fetch_sp500_ad.py`

- 成分股：`from fetch_breadth import get_sp500_tickers`（Wikipedia 現任清單；`fetch_breadth.py` 有 `__main__` guard，import 安全）[查證 `scripts/fetch_breadth.py:28-40`]。
- 抓價：`_breadth.fetch_prices(tickers, start)`，它是 `auto_adjust=True`、50 檔一批、含重試 [查證 `scripts/_breadth.py:37-73`]。**用調整後收盤是刻意的**：除息／拆股日若用原始收盤會被誤判成下跌；且調整因子對某日之前的價格同乘，不改變之前相鄰兩日的比較結果 [推論]。
- 純函式 `compute_ad(price_df) -> list[dict]`（測試對象）：
  - 以 `price_df` 的 index 順序為 session 軸；第一列沒有前一日，不輸出。
  - 某檔在第 t 列計入，當且僅當 t 與 t−1 列收盤都是有限正數；任一缺值就該檔當日不計（不往前找更早的價格）。
  - `abs(c_t − c_{t−1}) <= 1e-9 * c_{t−1}` → unchanged；否則大於為 advance、小於為 decline。
  - 每列 `{"date","advances","declines","unchanged","total"}`，`total` = 三者和（int）。`total == 0` 時四欄都寫 `null`，不可寫 0。
- 近期覆蓋門檻：與 breadth 相同，距今 `RECENT_WINDOW_DAYS`（14）天內且 `total < 480` 的列**不寫入**（yfinance 當日還沒補齊）；更早的列不套門檻（晚上市的成分股造成分母較低是正常的）[查證 `scripts/fetch_breadth.py:23`、`scripts/_breadth.py:25-27`]。
- 更新策略：
  - 檔案不存在 → 全量：`start="2015-12-01"`，輸出從第二個 session 起。
  - 檔案存在 → 增量：`start = 最後一列日期 − 45 個日曆天`，重算後以 `_common.idempotent_merge(OUT_PATH, rows)` 新蓋舊。
  - **不做 freshness skip**：每次都跑增量（成本約 10 批 × 45 天，並避開「兩次都 skip、cmp 相同什麼都沒證明」的陷阱）。
  - 下載失敗或 `compute_ad` 結果為空 → raise，原檔不動。
- 輸出格式（寫檔參數照 `fetch_breadth` 系列的慣例，別自創）：

```json
{
  "updated": "YYYY-MM-DD",
  "meta": {
    "source": "PersonalFiance 自算：yfinance 調整後收盤 vs 前一交易日",
    "constituentsBasis": "Wikipedia 現任 S&P 500 成分（每次執行當下抓取），非 point-in-time；含倖存者偏誤；舊列為過去各次執行時的成分快照",
    "priceBasis": "yfinance auto_adjust=True 收盤；|Δ|≤1e-9×前收視為平盤",
    "lastDate": "最後一列 date",
    "tickerCount": 本次抓取的成分股數
  },
  "data": [{"date": "YYYY-MM-DD", "advances": 0, "declines": 0, "unchanged": 0, "total": 0}]
}
```

### 2. 前端：`projectSp500Bundle(adFile, sp500File)`（放 `breadthAdvanced.mjs`，純函式）

- 輸入：`data/sp500_ad.json` 與 `data/SP500.json` 的原始 JSON。`SP500.json` 形狀 `{symbol, updated, data:[{date,open,high,low,close,volume}]}`，10009 列、1987-01-02 → 2026-09-25 [實測]；價格是原始收盤 [查證 CLAUDE.md「股價皆原始收盤價」]。
- benchmark：`SP500.json` 從 A/D 第一列日期起的列，`{date, close}`；`symbol:"SP500"`，`source:"yfinance ^GSPC（data/SP500.json）"`，`priceBasis:"原始收盤（auto_adjust=False）"`。
- sp500：`universe:"SP500"`，`source/constituentsBasis/priceBasis` 取自 `adFile.meta`，data 只留 `date/advances/declines/unchanged`（丟掉 `total`）。
- A/D 日期不在 benchmark 軸上（`^GSPC` 與成分股交易日不一致）→ 丟棄該列，回傳 `{bundle, droppedDates:[...]}`，由 UI 顯示丟棄數。**不補值、不新增 benchmark 日期。**
- 不含 `nyse` 鍵。回傳的 `bundle` 必須能通過現有 `parseBreadthImport`（它接受物件輸入）。

### 3. 前端：面板按鈕

- `index.html`：在 `breadth-advanced-template` 按鈕後加 `<button id="breadth-advanced-project" type="button">載入專案自算 S&P500 A/D</button>`。
- `breadthAdvancedPanel.js`：把 `importFile` 裡「parse → buildAdvancedContext → metadata → render」抽成共用的 `applyBundle(token, input, extraNotes)`，本機檔案與專案按鈕都走它，**沿用同一個 `request` token 防競態**，失敗一律 `clear('匯入失敗：…')`。
- 按鈕流程：`++request` → `clear('載入專案資料…')` → 用 `js/utils/data.js` 的 `fetchJSON(url, {raw:true})` 並行抓兩檔 → `projectSp500Bundle` → `applyBundle`。
- metadata 額外加兩行（`textContent`，不可用 innerHTML）：
  - `⚠ 自算：現任成分股、非 point-in-time，含倖存者偏誤，可能影響 A-D 線與事件日期；僅供描述性參考。`
  - `丟棄 N 個不在 ^GSPC 交易日軸上的 A/D 日期`（N=0 也顯示）。
- 不自動載入；使用者按了才抓。上方 P1 四市場切換不受影響。

### 4. 管線接線

- `fetch.yml`：在 `Compute S&P 500 market breadth` step（約 114–116 行）之後、同一個 job，加：

```yaml
      - name: Compute S&P 500 advance/decline (self-calculated)
        continue-on-error: true
        run: python scripts/fetch_sp500_ad.py
```

- `update_all.sh`：在 `"$PYTHON" fetch_breadth.py || true`（約 54 行）之後加 `"$PYTHON" fetch_sp500_ad.py || true`。
- `validate_data.py` 目前沒有任何 breadth 條目 [實測 grep]，本 spec 不加。

## 約束

- 共用模組照 CLAUDE.md「scripts 共用模組」：`import _common`、不加 `sys.path` hack、不用 3.12+ 語法（CI 是 3.11）。
- `data/` 只由 GitHub Action 寫入。**實跑請在 scratchpad 的隔離樹**（`scripts/` + `data/` 複製一份；ROOT 由 `__file__` 推導），不要寫 repo 的 `data/`。`data/sp500_ad.json` 在 commit 後由 CI 首次產出；在那之前按鈕會顯示載入失敗，這是預期行為。
- 前端工具一律用 `js/utils/`；`check_reuse` 對 `breadthAdvancedPanel.js` 可能不納管（未直接 register 進 boot），要自己照規則寫。
- 不改 `_breadth.py`、`breadth.json` 的 schema，也不改 P1／P2 行為。

## 驗收條件（可機械核對）

1. `python3 -m unittest discover -s scripts/tests` 全過；`test_sp500_ad.py` 至少覆蓋：手算的漲／跌／平、前一日或當日缺價不計、第一列不輸出、1e-9 平盤容差兩側、`total==0` 寫 null、近 14 天 `total<480` 不寫、下載失敗原檔 bytes 不變、增量 merge 保留 45 天窗口以前的舊列。
2. `node --test js/tabs/breadthSignals.test.mjs js/utils/eventStudy.test.mjs js/tabs/breadthAdvanced.test.mjs` 全過；新測試覆蓋：benchmark 從 A/D 首日起、不在軸上的日期被丟棄且列入 `droppedDates`、輸出通過 `parseBreadthImport`、`total` 被丟掉、沒有 `nyse` 鍵。
3. `python3 scripts/test_breadth_advanced_oracle.py` 仍 10 情境 PASS。
4. 兩套 browser suite（`test_breadth_browser.cjs`、`test_breadth_advanced_browser.cjs`）PASS；新增案例：route mock 兩檔成功 → status 顯示已匯入、metadata 含偏誤警語與丟棄數；mock 503 → 顯示匯入失敗且清空舊結果；按按鈕後立刻選本機檔案 → 最後結果只有本機檔案。
5. 隔離樹全量實跑一次：stdout 顯示走全量路徑；輸出首列在 2015-12 月初、末列為最近交易日；列數 ≥ 2600。
6. 與 DeanFinancials 比對僅為參考：回報重疊天數、漲跌家數絕對差中位數（應 ≤3）、淨額絕對差中位數（應 ≤5）；不設 90% 門檻。淨額 = advances − declines；比較各序列淨額的絕對差。
7. 用隔離樹產出的檔案＋`data/SP500.json` 過 `projectSp500Bundle` → `buildAdvancedContext` → `evaluateEventStudy`：回報 P3 原始與冷卻後事件數、事件日期、`missingSp500`、`droppedDates` 數。只做描述，不下交易結論。
8. `git diff --check` 通過；`git diff .github/workflows/fetch.yml scripts/update_all.sh` 裡除了新加的那幾行，FINRA 改動原樣保留；repo `data/` 沒有任何因本工作產生的變動（`git status data/` 與動工前相同）。
9. 完成回報要寫：分支名、是否已合回 main、未 commit。

## 不做

- P4／P5 真實資料（NYSE 無免費來源），也不做 WSJ 每日 scrape 自建歷史。
- point-in-time 成分回溯（fja05680 ＋ 下市股、代號回收檢查）。
- 付費來源、註冊帳號。
- 把 DeanFinancials 接進管線（只用來驗收比對）。
- commit、push、部署。

## 實作前補充（2026-09-28）

- [實測] `js/utils/data.js` 的 `fetchJSON` 原本回傳 `j.data || j`，會丟掉本方案所需 `meta`；增加可選 raw 參數保留完整物件，預設仍維持原行為。上述檔案清單已納入共用函式與回歸測試。
- [推論] 現任成分回推不能重現當時投資範圍，因此有偏誤；未驗證方向，警語不宣稱 A/D 一定偏高或事件一定偏少。

## 本次實作驗收紀錄（2026-09-28）

**依使用者提供的 Claude 獨立複核結果，第 6 條改為參考性比對；本次漲／跌家數絕對差中位數各 2、淨額絕對差中位數 4，符合修訂後參考值。原 90% 門檻取消，原第 6 條未通過結論撤銷，軟體實作不需修改。提交仍須使用者另行確認。**

- 已完成自算脚本、增量合併、P3 專案載入按鈕、共用完整 JSON 讀取及測試、CI 接線；P4/P5 不新增資料來源。
- Python 全套 123 項通過；JS 指定三套加共用資料工具測試 46 項通過（已移除一項重複測試）；獨立 oracle 10 情境與兩套瀏覽器測試通過。
- 隔離目錄全量實跑 2,719 列，2015-12-02 至 2026-09-25，503 個現任成分代號；增量實跑亦完成。
- Dean 此次回傳 598 列。依指定窗口 2024-09-27 至 2026-09-25 比較 500 天：漲家數絕對差中位數 2、最大 16；跌家數絕對差中位數 2、最大 13；兩者均不超過 3 的天數為 330/500（66.0%）。全重疊 598 天為 397/598（66.39%）。此占比保留為歷史紀錄，依修訂後第 6 條不再判定通過與否。未調整算法以迎合 Dean；差異的確切原因尚未證實。
- 真資料經 adapter → context → event study：P3 原始及 20-session 冷卻後各 3 次：2018-12-21、2022-02-23、2026-09-18。missingSp500=0，droppedDates=0。這是本自算樣本的描述，不能宣稱重現附件。
- 獨立 sol/high verifier 與主 session 各自確認 330/500；主 session 確認原有 643 個資料檔 SHA256 不變。FINRA 接線保留，git diff --check 通過。
- 驗收發現按鈕原先在 advanced-controls 外，已移回空白格式按鈕後、同一 controls 內。
- 證據暫存：`/tmp/sp500-ad-realrun/`，包含全量/增量 log、data/sp500_ad.json、dean.json、comparison-specified-window.json、event-study.json、compare.py、event-study.mjs。暫存證據不會隨 Git 發布。
- 工作位於主工作目錄 main；未 commit、未 push、未部署，沒有其他分支待合併。repo data/sp500_ad.json 尚未建立，故目前專案按鈕載入失敗仍是預期。
- 發包：sol/medium executor 1、sol/high verifier 1；原估計合計 1.5–3 SHE，非帳單。未取得實際 token 用量，無法校準，下載與測試輸出量會影響成本。

### 第 6 條改判依據與 commit 邊界

- [使用者轉述 Claude 獨立複核] 獨立下載重算：調整後收盤為 397/598（66.4%），原始收盤約 63%，平盤改歸下跌約 70%；差異不隨時間累積。Dean 檔案同日由 500 列變為 598 列，其完整方法不明，不適合作為標準答案。因此取消 90% 一致率門檻，改用中位數差異作參考；這不是靠修改實作提高一致率。
- [本次主 session 重算] 使用既存隔離資料 `/tmp/sp500-ad-realrun/data/sp500_ad.json` 與 `dean.json`，完整重疊 598 天的漲家數絕對差中位數 = 2、跌家數 = 2、淨額 = 4；2024-09-27 起 500 天的三個中位數亦為 2／2／4，符合第 6 條參考值。未重新下載或更動計算實作。
- 市場廣度 P1–P5、自算資料腳本、共用工具、測試、fixtures、文件及必要接線同一 commit。`index.html`、`fetch.yml`、`update_all.sh` 僅納入市場廣度的差異區塊。
- FINRA／資金雷達的接線、頁面、`js/boot.js`、flowradar 模組、抓取腳本、測試與資料另行提交，不混入市場廣度 commit；其他既存 data 更新亦不納入。commit 前須先詢問使用者，不 push／部署。
