# Forward P/E 時間序列自建（VOO / QQQ）

指數層級的 forward P/E 歷史走勢（FactSet Earnings Insight 那種圖）。分母（未來 12 個月
共識 EPS）沒有免費的歷史資料，所以策略是**從今天開始每日自建快照**：一年後就有一年的
真實序列，而且結構上不可能有 look-ahead bias。

- 腳本：`scripts/fetch_forward_pe.py`
- 序列：`data/forward_pe_voo.jsonl`、`data/forward_pe_qqq.jsonl`（append-only）
- 圖：`data/chart_voo.json`、`data/chart_qqq.json`（Chart.js 直接可用）
- 排程：`.github/workflows/forward_pe.yml`，每日 05:00 UTC（13:00 台北 / 01:00 ET）

> 這條線跟既有的 `fetch_spy_valuation.py` / `fetch_qqq_valuation.py` **平行**跑，不互相
> 覆蓋。比對一段時間確認無誤後才把 `js/tabs/valuation.js` 切過來，屆時這支併回
> `fetch.yml`、舊腳本退役。

## 方法論

```
Index Forward P/E = Σ(sharesᵢ × priceᵢ) / Σ(sharesᵢ × forward_epsᵢ)
```

即「總市值 ÷ 總預估盈餘」，等價於以市值為權重取個股 P/E 的**調和平均**。

只有權重、沒有股數的來源（QQQ）走等價式，代數上是同一個東西：

```
Σ(mvᵢ) / Σ(mvᵢ × epsᵢ/priceᵢ)      mvᵢ = sharesᵢ×priceᵢ 或 wᵢ，比值不變
```

所以兩個標的算的是同一個定義。`scripts/` 內以單一 `compute()` 實作，兩條路已用相同輸入
驗證過會得到同一個數字。

### 四條硬規則

1. **不用各成分股 P/E 的算術平均。** 會被高本益比個股嚴重扭曲。
2. **不剔除 forward EPS 為負的公司。** 負值在分母自然扣減就是正確處理；剔除會系統性
   低估 P/E。半導體與景氣循環股這點特別重要。
3. **不回填任何歷史日期。** 序列只能 append，起始日就是第一次成功執行的日期。假造的
   歷史比沒有歷史更糟。
4. **資料點不足時不畫 5y / 10y 均線。** 需要約 1260 / 2520 個交易日，不足時該欄位輸出
   `null`，不用短樣本假裝。

### 資料品質門檻

`coverage` = 成功取得 forward EPS 的成分股權重總和。

- `coverage >= 0.95` → 正常寫入，`valid: true`
- `coverage < 0.95` → 仍然寫入，但 `valid: false`，前端不畫這個點

缺漏的成分股在**分子分母同時排除**（只排除分母會讓 P/E 被高估）。

同一天重跑是 idempotent 的：覆蓋當日該筆，不重複 append。

## 日期語意（`date` vs `price_asof`）

每筆記錄的 `date` 是**腳本執行日**（`.github/workflows/forward_pe.yml` 排程 05:00
UTC，即台北 13:00 / 美東 01:00），**不是**報價本身的交易日。真正決定 forward P/E
分子（股價）與分母（forward EPS）的資料，其實際 as-of 交易日另外記在 `price_asof`：
取法是 `yf.Ticker(<標的自己，即 VOO 或 QQQ 本身，不是成分股>).history(period="5d")`
最後一列的 index 日期，轉成 `YYYY-MM-DD`；抓不到就是 `None`。

`date` 與 `price_asof` 通常差一天——收盤後才有當天資料，隔天執行才抓得到——但遇連假
或週末會差更多天，兩者**不假設固定的天數關係**，各自照實記錄，不用其中一個去推算
另一個。同理，iShares CSV 本身附的持股名冊公佈日（`Fund Holdings as of`）獨立記在
`holdings_asof`；slickcharts（QQQ holdings 來源）不提供這個資訊，`holdings_asof`
固定是 `None`。

選這個「兩個都留」的組合，而不是只留一個「代表性日期」，是因為三者語意不同（腳本跑了
哪天 / 股價與 EPS 反映哪個交易日 / 持股名冊公佈於哪天），事後要重建某一天的實際情境
（例如回頭比對某天的 WSJ 官方數字時，需要知道當時用的到底是哪個交易日的股價）三者
缺一不可，任何一個都不能由另一個推導出來，所以都寫進記錄，不做取捨。

## Holdings 來源

| 標的 | 實際來源 | 為什麼 |
|---|---|---|
| VOO | **IVV**（iShares Core S&P 500）`latest-holdings.csv` | Vanguard 沒有公開 holdings feed，`investor.vanguard.com` 的 API 回 HTML。IVV 同追 S&P 500，plain `requests` 就過。 |
| QQQ | **slickcharts.com/nasdaq100** 的 NDX 指數權重 | Invesco 的下載端點連 ticker 參數都不吃（QQQ / QQQM 回同一份 422KB HTML shell，裸 curl 是 406）；iShares 的 Nasdaq-100 只有 UCITS 線（CNDX，UK 站）且卡 investor-type gate。QQQ 完全複製 NDX，所以指數權重就是持股權重。 |

### 兩個踩過的坑

- iShares 產品頁 JS 注入的 `…/1467271812596.ajax?fileType=csv&fileName=X_holdings&dataType=fund`
  **是死的** —— 回 HTTP 200、`Content-Type: text/csv`，body 卻是產品頁 HTML。換 UA、cookie
  jar、`blackrock.com` 網域、`asOfDate`、`curl_cffi` TLS 指紋偽裝全部無效。**正確的是
  `…/latest-holdings.csv`**，裸 curl 就過。
- iShares CSV 的 ticker 寫法跟 yfinance 不同（`BRKB` vs `BRK-B`），見 `TICKER_FIX`。

### slickcharts 的交叉檢查

slickcharts 是第三方 scrape，版面一改就可能靜默餵髒資料。所以 QQQ 每天另外用 Nasdaq
官方 API（`api.nasdaq.com/api/quote/list-type/nasdaq100`）的**原始市值權重**獨立算一次，
兩者相對差超過 5% 就把當天標 `valid: false`。

注意兩者定義本來就不同：NDX 是 modified cap-weighted 且有 float 調整，Nasdaq API 給的是
全公司市值。所以這是「有沒有壞掉」的哨兵，不是「哪個才對」的仲裁。

## 已知的近似誤差

**yfinance 的 `forwardEps` 是 FY2，不是 FY1，更不是滾動 NTM。** 這點跟原始規格的假設
不同，是實測出來的：

```
MU    forwardEps=155.03   0y(FY1)=73.40    +1y(FY2)=155.03  -> FY2
NVDA  forwardEps= 15.46   0y(FY1)= 9.31    +1y(FY2)= 15.46  -> FY2
AMD   forwardEps= 15.45   0y(FY1)= 7.57    +1y(FY2)= 15.45  -> FY2
LRCX  forwardEps= 11.57   0y(FY1)= 9.46    +1y(FY2)= 11.57  -> FY2
QCOM  forwardEps= 10.22   0y(FY1)=10.52    +1y(FY2)= 10.20  -> FY2
```

真正的 NTM 應該是 `w × FY1 + (1−w) × FY2`，w = 當前會計年度剩餘月數 ÷ 12。用純 FY2 表示
盈餘估得比 NTM 更遠、更高，因此我們的 forward P/E 會**系統性偏低**（不是偏高），且在
會計年度交界附近有跳階。

> **2026-09-05 更新：上面這個問題已經解決。** 舊版曾把 `eps_basis` 欄位依規格填
> `"FY1_only"`（但實測值其實是 FY2，標籤與事實不符）。現在改成同一筆記錄雙 basis
> 並存（FY2 + blended NTM，見下面「EPS basis」一節），`eps_basis` 如實反映主序列用的
> 是哪一個，不再有標籤與事實不符的問題。

FY1/FY2 其實 yfinance 就給得到（`Ticker.earnings_estimate` 的 `0y` / `+1y`），既有的
`fetch_soxx_valuation.py` 早就在用 blended NTM，所以「要換 FMP / Finnhub 才做得到
blended」的前提並不成立。

## EPS basis（2026-09-05 定案：雙 basis 並存）

`fetch_forward_pe.py` 每個成分股同時取得兩種 forward EPS，算出兩條 forward P/E，寫進
同一筆記錄，兩條都有完整歷史：

- **FY2**：`yfinance.info['forwardEps']` 實測就是**下一個完整會計年度**（`+1y`）的共識
  EPS，不是 FY1、更不是滾動 NTM。純用 FY2 表示盈餘，估得比真正的 NTM 更遠、更高，因此
  forward P/E 會**系統性偏低**，且在每檔公司自己的會計年度交界附近會有**跳階**（因為
  FY1/FY2 的定義瞬間互換）。取不到才 fallback 到「換算成報價幣別後」的
  `earnings_estimate['+1y']`（見下面「幣別陷阱」）。
- **blended NTM**：真正的「未來 12 個月」共識 EPS，公式：

  ```
  ntm_eps = w × FY1_est_fx + (1 − w) × FY2_est_fx
  w = clamp((fy1_end − today).days / 365, 0, 1)
  ```

  `fy1_end` 取自 `info['nextFiscalYearEnd']`（當前會計年度的結束日）。`w` 是「今天距離
  當前會計年度結束還有多少比例的一年」——會計年度剛開始時 `w≈1`（幾乎全部是 FY1），
  快結束時 `w≈0`（幾乎全部是 FY2），符合直覺：越接近年底，未來 12 個月裡 FY2 的占比
  越高。

  `FY1_est_fx`、`FY2_est_fx` 分別取自 `Ticker.earnings_estimate` 的 `0y`、`+1y`，
  **兩者都換算成報價幣別**（見下面「幣別陷阱」），**完全不混用 `info['forwardEps']`**
  （理由見「為什麼 blend 不混用 forwardEps」）。FY1_est_fx、FY2_est_fx、`fy1_end`
  三者任一缺，`ntm_eps` 就是 `None`——不用單邊數值硬湊一個假的 blended 值。

### 幣別陷阱：`earnings_estimate` 是財報幣別，`forwardEps`／股價是報價幣別

`yf.Ticker(x).earnings_estimate` 回傳的 EPS 是用公司「財報幣別」
（`info['financialCurrency']`）計價，但 `info['regularMarketPrice']`、
`info['forwardEps']` 都是「報價幣別」（`info['currency']`，美股掛牌皆 USD）。ADR
（財報用母國幣別、掛牌報價用 USD）兩者不同，若拿 `earnings_estimate` 未換算的值直接
除以 USD 股價，分母會被灌爆或縮水。實測證據（2026-09-05）：

```
PDD   currency=USD financialCurrency=CNY  forwardEps=12.391  est[+1y]=83.260  ratio=0.1488  (CNYUSD=0.14901)
ASML  currency=USD financialCurrency=EUR  forwardEps=60.128  est[+1y]=51.710  ratio=1.1628  (EURUSD=1.16212)
CCEP  currency=USD financialCurrency=EUR  forwardEps= 5.704  est[+1y]= 4.906  ratio=1.1628
FER   currency=USD financialCurrency=EUR  forwardEps= 1.377  est[+1y]= 1.184  ratio=1.1628
NVDA  currency=USD financialCurrency=USD  forwardEps=15.458  est[+1y]=15.458  ratio=1.0000
```

即 `info.forwardEps == est['+1y'] × FX(financialCurrency→currency)`。舊版一度優先用
未換算的 `earnings_estimate` 當 FY2（且 blend 也吃到同一份未換算值），ADR 的 EPS 被
系統性放大或縮小，指數 P/E 因此被拉低（QQQ 上光 PDD 一檔權重 0.28% 就吃掉大約
21.38→20.61 的落差）。修法：新增模組級 `fx_rate(frm, to)`（同幣別直接回 `1.0` 不打
網路；不同幣別用 `f"{frm}{to}=X"` 抓 `regularMarketPrice`，整個執行期每組幣別只抓一次
並快取），`earnings_estimate` 的 `0y`/`+1y` 一律先乘上
`fx_rate(financialCurrency, currency)` 才使用；換算不到（FX 為 `None` 或幣別欄位缺）
就把該檔的換算後 EPS 視為缺值，不用未換算的數值硬上。抓失敗時的重試與快取行為見下面
「FX 失敗與 retry」一節。

### FX 失敗與 retry（2026-09-06 加）

`fx_rate` 一開始的版本抓失敗就直接把 `None` 寫進 `_FX_CACHE` 並整輪沿用——匯率來源
（`f"{frm}{to}=X"` 這個 yfinance 準標的）瞬斷一次，就會讓**該幣別當天所有成分股**的
換算後 EPS 一起變 `None`，被 `compute()` 排除。QQQ 只有 4 檔非 USD 財報幣別
（ASML/PDD/CCEP/FER，權重合計約 2.07%），低於 `COVERAGE_MIN`＝0.95，所以即使真的整個
幣別失敗，那天仍會**靜默通過**（`valid: true`），只是少算了 2% 左右的權重，沒有任何
訊號會被看到。

現在的處理：

1. **`fx_rate` 內建 retry**：抓失敗（例外或 `regularMarketPrice` 缺）就重試，沿用
   `fetch_quote` 的退避風格——`FETCH_RETRIES`（3）次、失敗間隔 `15 * (第幾次嘗試 + 1)`
   秒遞增。**只有 `FETCH_RETRIES` 次全部失敗才快取 `None`**；只要有一次成功就快取那個
   成功值、立刻回傳，不會因為前面失敗過就永遠悲觀。相同幣別（`frm == to`）仍直接回
   `1.0`、完全不打網路，不受這個改動影響。
2. **coverage 如實反映換算失敗**：`compute()` 本來就是「缺該 basis 的 eps 就整檔排除，
   分子分母一起扣、`used_w`／`coverage` 不計入這檔權重」——FX 換算失敗會讓
   `ntm_eps`（連帶 `fwd_eps_fy2` 的 fallback 路徑）變 `None`，走的是同一條既有的
   「缺值排除」邏輯，不需要另外加特判。也就是說換算失敗的成分股，其權重**確實不會**
   被算進 `coverage_ntm`。
3. **顯性訊號 `fx_failed_weight`**：`main()` 額外統計「幣別非 USD（`fin_ccy != ccy`）
   但 `fx_rate` 重試後仍回 `None`」的成分股，把權重合計寫進 entry 的
   `fx_failed_weight` 欄位（`float`，正常情況下是 `0.0`）。這個統計刻意只算「真的需要
   換算但換算失敗」的檔，不含「本來就沒有 earnings_estimate 資料」等其他缺值原因，
   避免跟既有的 `dropped`／`coverage_ntm` 診斷混在一起看不出成因。`fx_failed_weight > 0`
   時，dry-run／正式跑的 stdout 都會印一行 `⚠️ FX 換算失敗（重試 N 次仍失敗）` 警告，
   列出受影響的 ticker 與權重合計。

驗證（2026-09-06，monkeypatch `fx_rate` 讓 `frm == "EUR"` 一律回 `None`，模擬 EUR 這個
匯率來源整段失敗，QQQ `--dry-run`）：`coverage_ntm` 從 1.0001 掉到 **0.9822**、
`fx_failed_weight` = **0.0179**（ASML 1.58% + CCEP 0.11% + FER 0.10%，三檔皆 EUR 財報
幣別），且 stdout 印出警告行，`forward_pe_fy2`／其 coverage 不受影響（FY2 優先用
`info['forwardEps']`，不需要 FX 換算）。另外用假的 `yf.Ticker` 直接驗證 retry 迴圈：
連續失敗 3 次才快取 `None`（`time.sleep` 依序被叫 `15`、`30` 秒），第 3 次才成功則正常
回傳並快取該成功值，不會被前兩次失敗污染。

### 為什麼 blend 不混用 `forwardEps`

`ntm_eps` 的兩端（FY1、FY2）都只用**換算後的 `earnings_estimate`**，不拿
`info['forwardEps']` 當 FY2 的另一種來源，因為兩個來源在部分公司差異極大，且不是
匯率造成的（皆 USD/USD）：

```
PANW  forwardEps=4.894   est[+1y]_fx=2.279   ratio=2.15x
TTWO  forwardEps=10.301  est[+1y]_fx=5.292   ratio=1.95x
MSTR  forwardEps=49.490  est[+1y]_fx=13.825  ratio=3.58x
```

混用會讓 blend 內部不自洽（FY1 與 FY2 出自不同分析師樣本/GAAP 口徑），且在 `w`
變動時（跨會計年度交界）產生假跳動。所以 `fwd_eps_fy2`（FY2 那條獨立線）與
`ntm_eps`（blend 用的 FY2 端）刻意用不同來源：前者優先 `forwardEps`，後者只認換算後
的 `earnings_estimate`。

### 為什麼兩個都存

單一 basis 一旦寫進 jsonl 就是 append-only、不可回填（見規則 #3），選錯了會後悔莫及。
兩條線並存不用預先決定「哪個對」，跑一段時間比對 WSJ 之後再拍板，兩邊都不會遺失資料。
每筆記錄同時有：

```json
{"forward_pe": <primary>, "forward_pe_fy2": ..., "forward_pe_ntm": ...,
 "coverage_fy2": ..., "coverage_ntm": ..., "eps_basis": "<primary 標籤>", "valid": <primary>}
```

`forward_pe` / `eps_basis` / `valid` 三個欄位是 **primary basis 的鏡射**，保留是為了
相容舊 jsonl 形狀（單一序列）。`eps_basis` 值如實反映：`"blended_ntm"` 或 `"fy2_only"`。

### 切換 primary basis

模組常數 `PRIMARY_BASIS`（`scripts/fetch_forward_pe.py` 檔案上方「規格常數」區）目前設
`"ntm"`。改這一個常數就切換 `forward_pe`/`eps_basis`/`valid` 三個鏡射欄位改指向哪條線
（連帶影響 `chart_<t>.json` 的 5y/10y 均線算哪一條），`forward_pe_fy2`/`forward_pe_ntm`
兩條完整序列**不受影響、永遠都寫**，所以切換不會遺失資料。

## 驗證結果

**主基準改為 FactSet Earnings Insight**（2026-09-06 定案）——FactSet 每週五公布一手
的 S&P 500 forward 12-month P/E（NTM 口徑，跟本專案的 `forward_pe_ntm` 定義相同），
比 WSJ 更適合當基準，理由見下面「FactSet 外部驗證」與「WSJ 21.22 是日曆年口徑」兩節。
QQQ（NASDAQ-100）目前沒有可用的同口徑第三方 NTM 基準，見下面「已知限制」。

舊的比對基準 WSJ 官方指數級 forward P/E（`data/WSJ_PE.json`，由既有的
`fetch_wsj_pe.py` 每週抓，`INX` = S&P 500、`RIXF` = NASDAQ-100）**保留在下面當歷史
紀錄**，但已查明是日曆年口徑、不是 NTM，降為次要參考，不再是主基準。這也比 iShares
基金頁好，理由見下面「為什麼不拿 iShares 官網的 P/E 比」。

### FactSet 外部驗證（主基準，2026-09-06）

FactSet Earnings Insight 2026-09-04 期一手公布：「the forward 12-month P/E ratio
for the S&P 500 is 19.5」，as-of 價格是 **2026-09-03 收盤**（FactSet 慣例用前一交易日
收盤價）。本專案的 VOO blended NTM 序列跑在 **2026-09-04 收盤**（`price_asof` =
2026-09-04，VOO 收盤價 7718.60），算出 `forward_pe_ntm` = **19.51**。兩者 as-of 日期
差一天，直接比會混進一天的價格變動，所以先把我們的數字校正到 FactSet 用的同一個
價格基準：

```
09-03 收盤價 = 7747.71，09-04 收盤價 = 7718.60（VOO 一天內漲跌，EPS 估計值視為不變）
校正後 forward_pe_ntm(09-03 基準) = 19.51 × (7747.71 / 7718.60) ≈ 19.58
```

19.58 對 FactSet 19.5 的差距：**+0.43%**。落在誤差範圍內（不同 EPS 估計來源、
holdings as-of 時點的微小差異），確認 blended NTM 方法論正確——這是本專案第一次
拿到真正同口徑（forward 12-month NTM）的第三方外部驗證，取代先前只能跟 WSJ
（後來查出是不同口徑）比對的狀態。

### WSJ 21.22 是日曆年 CY2026 口徑，不是 NTM（次要參考，2026-09-06 查明）

WSJ 的 21.22（as-of 2026-09-04）腳注雖寫 "Forward 12 months"，但反推隱含 EPS 對不上
NTM：`VOO 09-04 收盤價 7718.60 ÷ WSJ PE 21.22 ≈ 363.7`，這個隱含 EPS 363.7 貼近
**FactSet CY2026（日曆年 2026，非滾動 12 個月）bottom-up EPS 共識 $361.38**（差
0.65%），而不是任何 NTM 估計。也就是說 WSJ 的 "forward 12 months" 腳注跟其實際數字
的口徑不符，**不可拿來當 NTM 基準**。WSJ 數字保留在下表當歷史紀錄與次要參考，但
不再是主基準；`scripts/fetch_forward_pe.py` 內對應常數已從 `WSJ_REF` 改名為
`WSJ_REF_CY2026` 並加註口徑警語，主基準改用新常數 `BENCHMARK_REF`（QQQ 設 `None`）。

2026-09-05 首次執行（WSJ as-of 2026-09-04，次要參考、日曆年口徑）：

| 標的 | 本專案 | WSJ 官方（CY2026 口徑，非 NTM） | 差距 | 門檻內？ |
|---|---:|---:|---:|:--:|
| VOO（S&P 500） | 18.59 | 21.22 | **−12.4%** | ✅ |
| QQQ（NASDAQ-100） | 21.38 | 25.25 | **−15.3%** | ❌ 超過 15% |

同日 repo 內舊腳本（前 20 大、加權算術平均、blended NTM）的數字：`SPY_valuation.json`
= 22.68、`QQQ_valuation.json` = 22.49。

### 雙 basis dry-run 驗證（2026-09-05/06，`--dry-run`，未寫入 data/，幣別 bug 修正後重跑）

上一輪雙 basis dry-run 曾把 `fwd_eps_fy2` 誤改成優先用未換算的 `earnings_estimate`，
混進了「幣別陷阱」一節說的 ADR 單位錯誤（QQQ 因 PDD 一檔就把 FY2 從 21.38 拉低到
20.61）。修掉換算與 FY2/NTM 來源定義後，用 `--dry-run --rows 15` 重跑 QQQ（102 檔、
耗時 124s）與 VOO（504 檔、耗時 605s）驗證：**`forward_pe_fy2` 回到原始已驗證的定義
（QQQ 21.38、VOO 18.59，即最上面「2026-09-05 首次執行」那張表的數字），且兩個標的的
`forward_pe_ntm` 仍都高於 `forward_pe_fy2`**（NTM 摻入較低的 FY1 EPS，P/E 應該上升，
方向正確）：

| 標的 | FY2 | blended NTM | WSJ 官方 | FY2 對 WSJ | NTM 對 WSJ |
|---|---:|---:|---:|---:|---:|
| VOO（S&P 500） | **18.59** | **19.51** | 21.22 | −12.4% | −8.1% |
| QQQ（NASDAQ-100） | **21.38** | **23.07** | 25.25 | −15.3% | −8.6% |

- VOO：`coverage_fy2` = 0.9979（used 502/504，缺 `FISV`、`HOLX`）；`coverage_ntm` =
  0.9974（used 499/504，缺 `FISV`、`L`、`FOX`、`ERIE`、`HOLX`，五檔合計權重
  0.09%）。兩者都遠高於 0.95 門檻。幣別非 USD 的成分股：0 檔（S&P 500 成分股皆美股
  掛牌報價、財報幣別亦皆 USD）。
- QQQ：`coverage_fy2` = `coverage_ntm` = 1.0001（102/102 全數命中，slickcharts 權重合計
  略超 100% 是資料源本身的四捨五入）。另有交叉檢查（Nasdaq 市值權重，basis=NTM）=
  22.81，相對差 1.13%，遠在 5% 容許內。幣別非 USD 的成分股 4 檔（ASML/PDD/CCEP/FER，
  合計權重約 2.07%）——換算後的 est FY2 貼近 `info.forwardEps`（如 PDD 12.41 ≈
  forwardEps 12.39、ASML 60.09 ≈ forwardEps 60.13），確認換算方向正確。
- 修正後 QQQ NTM 對 WSJ 的差距從（未修正時的）−13.0% 進一步縮小到 −8.6%，因為
  `fwd_eps_fy2` 不再被未換算的 ADR EPS 拉低，且 blend 兩端統一用換算後的
  `earnings_estimate`。NTM 比 FY2 更接近 WSJ，但仍系統性偏低——次因（WSJ 週更 vs
  我們即時、holdings as-of 落後、QQQ 用指數權重而非實際持股）跟下面「差距來源的判斷」
  一節列的一樣，這裡沒有再調任何參數去湊。
- `forwardEps` 與換算後 `est['+1y']` 相對差 > 20% 的成分股（GAAP/non-GAAP 或估計
  vintage 的真實分歧，不是 bug）：QQQ 8 檔、權重合計 1.65%；VOO 8 檔、權重合計
  0.80%。其中 PANW（2.15x）、TTWO（1.95x）、MSTR（3.58x）三檔皆 USD/USD、非匯率
  因素，是 blend 刻意不混用 `forwardEps` 的理由（見上面「為什麼 blend 不混用
  forwardEps」）。

### 差距來源的判斷

**主因是 EPS basis，不是加權法。** 方向與量級都指向同一件事：

- 我們用的 `forwardEps` 實測是 **FY2**（見上節），盈餘估得比 NTM 遠且高 → P/E 系統性偏低。
- 旁證：舊腳本用 blended NTM，兩個標的都比我們更靠近 WSJ（QQQ 22.49 vs 我們 21.38，
  WSJ 25.25）。同一天、同一批成分股，差別只在 basis。
- 若加權法才是主因，舊腳本的算術平均應該讓它**高於**我們且高於 WSJ（算術平均會被
  Tesla 164x 這種拉高），但實際上兩個標的都還是低於 WSJ。所以加權法解釋不了缺口方向。

次因：
- WSJ 的 as-of 是 2026-09-04（週更），我們是 09-05 即時報價，差一天。
- 我們的 holdings as-of 是 09-03（iShares CSV 的公佈時點），股數落後兩天。
- QQQ 用的是 NDX 指數權重而非 QQQ 實際持股，float 調整的細微差異。

**沒有為了縮小差距調任何參數。** 規格明訂差距超過 15% 要先停下來，QQQ 已觸線。修正
方向很明確（把 basis 換成 `w×FY1 + (1−w)×FY2`），但那是規則變更，要另外決定。

### 三 basis 診斷（2026-09-06）：主假說是否成立

上面的 blended NTM 換成正確換算後，QQQ／VOO 對 WSJ 仍分別殘留 −8.7%／−8.1% 的缺口。
主假說：**WSJ 的 forward P/E 用的其實是「當年度 FY1」口徑，不是滾動 12 個月的
NTM**——若成立，改算純 FY1 加總的 forward P/E 應該落在 WSJ ±3% 附近。這一輪只做
診斷（`compute(holdings, "fwd_eps_fy1")`，只印出來，**不寫進 jsonl、不改
`PRIMARY_BASIS`、不為了讓數字更靠近 WSJ 調任何參數**）。

三 basis 對照（`--dry-run --rows 0`，WSJ as-of 2026-09-04，`WSJ_REF` 僅供比對不參與
計算）：

| 標的 | FY1 only | blended NTM | FY2 only | WSJ | FY1 vs WSJ | NTM vs WSJ | FY2 vs WSJ |
|---|---:|---:|---:|---:|---:|---:|---:|
| QQQ（NASDAQ-100） | 26.95 | 23.06 | 21.38 | 25.25 | **+6.7%** | −8.7% | −15.3% |
| VOO（S&P 500）   | 21.60 | 19.51 | 18.59 | 21.22 | **+1.8%** | −8.1% | −12.4% |

`w`（NTM blend 的權重，`w≈1` 幾乎全 FY1、`w≈0` 幾乎全 FY2）分布，用來直接量化「NTM
有多少比重壓在 FY2 上」：

| 標的 | n | 中位數 | 平均 | `[0,0.25)` | `[0.25,0.5)` | `[0.5,0.75)` | `[0.75,1]` |
|---|---:|---:|---:|---:|---:|---:|---:|
| QQQ | 102/102 | 0.3178 | 0.3627 | 12 檔／21.55% | 75 檔／63.23% | 4 檔／1.03% | 11 檔／14.20% |
| VOO | 502/504 | 0.3178 | 0.3417 | 48 檔／17.05% | 405 檔／71.12% | 20 檔／1.51% | 29 檔／10.11% |

兩個標的的 `w` 中位數都落在 `[0.25,0.5)` 這格，超過六成權重集中在這一格——多數成分股
的下一個會計年度都已經走過 1/4~1/2，所以 NTM 確實近七成權重壓在 FY2 上，這部分跟
主假說的前提（w≈0.32、七成權重在 FY2）一致。

**判讀：主假說只在 VOO 成立，在 QQQ 不成立，不能一概而論。**

- **VOO 支持假說**：FY1 only = 21.60，對 WSJ **+1.8%**，落在 ±3% 內。S&P 500 的
  WSJ forward P/E 缺口，換成當年度 FY1 口徑後幾乎完全消失。
- **QQQ 不支持假說**：FY1 only = 26.95，對 WSJ **+6.7%**，沒有落在 ±3% 內，換成 FY1
  口徑後 QQQ 從「低於 WSJ」（NTM −8.7%）變成「高於 WSJ」（+6.7%），缺口沒有縮小、
  只是換了方向。「WSJ 用 FY1 口徑」這個假說**沒有解釋 QQQ 的缺口**。

**如實結論（不是湊出來的）**：主假說證實了一半——EPS horizon 是 VOO 缺口的主因，但
不是 QQQ 缺口的（唯一）主因。QQQ 還有 EPS horizon 之外的因素在起作用，方向指向
QQQ 特有的方法論差異：本專案用 slickcharts 的 NDX **指數權重**代替 QQQ 實際持股、
WSJ 的 RIXF 基準本身跟 NASDAQ-100 的成分股/口徑未必完全一致、holdings as-of 落後
等（見上面「差距來源的判斷」列出的次因）。這些目前都只是候選解釋，這一輪沒有進一步
驗證，也沒有為了讓 QQQ 數字更靠近 WSJ 去調任何參數或改權重來源。

### 為什麼不拿 iShares 官網的 P/E 比

iShares 產品頁自己的說明寫得很清楚：

> Each holding's P/E is the latest closing price divided by the latest fiscal year's
> earnings per share. Negative P/E ratios are excluded from this calculation.

兩點都跟我們不同 —— 那是 **trailing**（最近一個完整會計年度）而非 forward，而且**排除
負 P/E**，正是本專案規則 #2 明令不做的事。拿來比會混進兩層定義差異，判讀不出真正的
缺口來源，所以改用 WSJ 的 forward 值當基準。

### 逐條規則的驗證

四條硬規則各寫了測試檢查（`compute()` / `write_chart()`）：

1. 有股數的路徑（VOO）與只有權重的路徑（QQQ）餵相同輸入得到同一個數字，且與手算
   `Σ(s·p)/Σ(s·eps)` 相符 → 調和平均實作正確。
2. 負 forward EPS 的成分股留在分母自然扣減，不被剔除。
3. 缺 price 或缺 EPS 的成分股在分子分母同時排除，`coverage` 隨之下降。
4. 序列點數不足 1260 / 2520 時，5y / 10y 兩條線整條輸出 `null`；`valid: false` 的點
   在 chart 裡也是 `null`。

### 逐檔抓取的缺漏

VOO 首跑 504 檔中 2 檔沒有 forward EPS：`FISV`（Fiserv，yfinance 有報價但
`forwardEps` 為 `None`）、`HOLX`。兩檔合計權重 0.21%，`coverage` = 0.9979，仍在
0.95 門檻之上。這不是 ticker 對照問題 —— `FISV` 在 yfinance 查得到，只是缺 EPS 欄位。

執行時間：VOO 504 檔 460 秒、QQQ 102 檔 93 秒。

## 已知限制

**QQQ 序列尚未開始**（2026-09-06）——這輪只寫入 VOO 的第一個資料點
（`data/forward_pe_voo.jsonl`），`data/forward_pe_qqq.jsonl`／`data/chart_qqq.json`
都還不存在，`.github/workflows/forward_pe.yml` 的 QQQ step 已註解掉（VOO step 仍在
跑）。

原因：找不到同一天的第三方 forward-NTM 基準可驗證 QQQ。試過的免費來源都不合用：

- WSJ 的 RIXF（NASDAQ-100）已查明是日曆年口徑（見上面「WSJ 21.22 是日曆年 CY2026
  口徑」一節對 VOO 的驗證方式同樣適用於推論 QQQ），非 NTM。
- FactSet Earnings Insight 免費公開的一手數字只涵蓋 S&P 500，沒有 NASDAQ-100 版本。
- 其餘 NASDAQ-100 / QQQ forward P/E 來源，不是 trailing 口徑、就是口徑未標明，或
  端點被 403/406 擋（見上面「Holdings 來源」與模組 docstring 記錄的踩坑）。

目前僅有的間接證據：QQQ 序列跟 VOO 用**同一支程式、同一套 EPS 來源與公式**
（`fetch_forward_pe.py` 的 `compute()`），且有 QQQ 專屬的內部交叉檢查（slickcharts
NDX 指數權重 vs Nasdaq 官方市值權重，2026-09-06 dry-run 相對差 1.13%，遠在 5% 容許
內，見上面「雙 basis dry-run 驗證」）。但**這不是外部驗證**——交叉檢查只證明「兩個
權重來源算出來的數字彼此一致」，不證明「數字本身對不對」。QQQ 要等到找到可信的同日
第三方 NTM 基準才會恢復寫入；恢復時只需取消 `.github/workflows/forward_pe.yml` 裡
那個 step 的註解，`git add` 路徑不用改。

## price_asof 防護（2026-09-06 加）

`write_series()`（`scripts/fetch_forward_pe.py`）在原本「同一天重跑覆蓋當日該筆」
的 idempotent 行為之外，另外加了一道以 `price_asof` 為鍵的防護，兩道防護並存：

- 生產排程是週一–週五 05:00 UTC。週一那次執行時，指數自己（VOO/QQQ）最後一筆收盤
  仍是上週五，`price_asof` 會跟週末手動跑（或補跑）的那一筆撞同一個值，但 `date`
  （腳本執行日）不同——若只以 `date` 為鍵，這會產生兩筆不同 `date` 但反映同一個
  交易日股價/EPS 的紀錄，圖上會出現「同一天收盤價畫出兩個不同 P/E 值」的假象。
- 防護做法：寫入前先檢查既有序列中是否已有相同 `price_asof`（非 `None`）的紀錄。
  有的話**不新增**，而是**覆蓋該筆**——沿用原本的 `date`，其餘欄位（`forward_pe_*`、
  `coverage_*`、`valid_*` 等）更新為這次抓到的值。
- `price_asof` 為 `None`（指數自己的報價抓不到）時，這道防護不適用，退回原本純以
  `date` 為鍵的行為。
- `--dry-run` 與正式跑的 stdout 都會印出這次判定是「新增」還是「覆蓋既有
  `price_asof=X` 的那筆」，方便從 log 直接確認防護有沒有生效，不用另外去 diff
  jsonl 檔。
