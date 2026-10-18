# 美股觀察頁需求與資料契約

定案日2026-10-18。定位：風險監控＋滯後確認＋歷史事件描述；不修改交易、加碼或槓桿策略。

## 頁面區塊

1. 每日概況：SPY/QQQ 120日回撤、VIX/VXN、同日VIX/VIX3M、QQQ/SPY與SOXX/QQQ 20日比值變動、NDX>50MA分母、明示HYG/LQD價格代理。
2. 可調研究：嚴格與非PIT重建分開；背景圖、N與覆蓋、三組基準、分布、最大虧損／收盤MDD／再破底、重疊與右設限。
3. 事件表：警報日、next-open、當時可得週月版本、首次事後取得（不可稱被迫平倉確認）。
4. 週月表／圖：CFTC多空及合計張數與到期／次週遮罩；NFCI三子項重估警語；FINRA月餘額與滯後。
5. 來源與品質：每項頻率、單位、最後有效日期、首次觀測、官方發布是否未知、延遲、來源URL、授權與unavailable原因。

## 控制項與ⓘ逐字文案

文案與頁面共用來源：`js/tabs/usrisk_controls.mjs`；下列內容由同一常數匯出。

### asset

選擇 SPY 或 QQQ。回撤、交易日軸與隔日開盤後結果皆以所選標的計算；價格報酬不含股息、費用或滑價。

### dataMode

嚴格模式只用決策日美東日終前已被本系統觀測且已公布的版本。首次匯入的舊資料不視為歷史已知。歷史收盤重建使用最新版日頻資料，並非完整 point-in-time 回測；週月確認仍遵守可得時間。

### mode

每次只研究一種日頻壓力指標，不自動尋找最佳組合。相對弱勢為 QQQ/SPY 比值的20交易日變動；半導體為 SOXX/QQQ。現有廣度含現今成分股回填偏誤，僅顯示背景，回測不可用。

### gate

警報日收盤相對最近120個標的交易日最高收盤價的回撤。0%表示不設閘門。回撤也是同時已發生的價格變化，不是底部預測。

### thresholdMode

明示門檻均為研究假設，沒有經過有效性認證。滾動分位數只用當日前252個標的交易日，至少126筆有效資料；不含當日與未來資料。

### threshold

高波動與 VIX/VIX3M 以大於等於門檻為壓力；相對強弱與廣度以小於等於門檻為壓力。更換門檻屬探索，不代表樣本外有效。

### cooldown

固定以第一個接受的警報為起點，至少相隔10個標的交易日才接受新事件。10日冷卻不等於60日結果彼此獨立；另列依研究視窗排除重疊後的樣本。

### horizon

收盤後警報最早於下一個標的交易日開盤處理。5日表示從該開盤日起含當日共5根交易日，於第5日收盤評估；不足完整視窗不計績效。

### background

週月圖按觀測期間排列並使用目前已見版本，包含後續修訂。它是背景圖；事件表的當時確認只列警報日實際已觀測的版本。

### loss

後續最大虧損＝視窗最低盤中低價/隔日開盤價−1（最高為0）。峰谷最大回撤另用收盤路徑與起始開盤價計算。兩者不同；不假設盤中最高與最低發生順序。

### misses

事後波段定義：120日高點回撤達8%開始，回復至不足3%結束。完整且指標全覆蓋的波段內沒有接受警報才算漏報。未結束、左設限或缺資料的波段不分類。誤報是完整結果事件落在這些事後波段以外；不是買點或低點預測準確率。

控制項：asset=SPY/QQQ；dataMode=strict/historical；mode=vix/vxn/term/relative/semis/breadth；gate=0/8/10/15%；thresholdMode=fixed/percentile；threshold依模式；cooldown=10交易日固定；horizon=5/10/20/60；background=CFTC_ES/NQ/RTY、NFCI三項、FINRA。

門檻下拉：

- vix：20/25/30/40點；≥；預設30。
- vxn：25/30/35/40點；≥；預設30。
- term：1/1.05/1.1/1.2倍；≥；預設1。
- relative：-3/-5/-8/-10%；≤；預設-5。
- semis：-3/-5/-8/-10%；≤；預設-5。
- breadth：20/30/40%；≤；預設30。

分位數：高壓80/90/95，低壓5/10/20；以前252個資產交易日、至少126筆有效歷史估計。所有門檻僅為假設，不是最佳化結果。研究從2020-01-01至快照美東日期；2018+保留暖機資料。UI沒有調整正式交易的接口。

## JSON schema／逐欄需求

正式schema：`docs/schemas/us-risk-observations.schema.json`；輸出`data/us_risk_observations.json`。

| 欄位 | 定義 |
|---|---|
| schema_version | 1 |
| generated_at | 此bundle產製UTC時間；不是每項觀測日或官方發布日 |
| series.ID.meta | label/frequency/unit/source_file/source_url/delay/quality/license/history_eligible/available/status/reason/input_sha256/input_updated/first_date/last_observation/source_rows；FINRA另mirror_url，CFTC另contract_code |
| records[].date | 真實觀測期間，日YYYY-MM-DD；月為月初標記，並非月初可得 |
| observed_at | 本系統首次看到該date+values版本的實際UTC時間，不回填 |
| published_at | 可核實的官方時間，未知為null。嚴格可得時間不得早於observed_at與published_at任一 |
| source_hash | 首次見此版本時整份輸入檔的SHA256，連同git版本保存provenance |
| values | SPY/QQQ/SOXX/HYG/LQD={open,high,low,close}；VIX/VXN/VIX3M/NDX_BREADTH/NFCI三項/FINRA={value}；breadth另total/above50_total；CFTC={long,short,oi} |

同date不同版本append-only保留；完全相同值不新增timestamp。不同source不可混單位。缺檔／來源失敗保留舊records與原observed_at並標stale；核心SPY/QQQ無資料或舊archive壞檔直接失敗，不覆蓋。HY_OAS/CNN_FG/RSP/SMH為空records及明確reason。沒有假flows或偽造融資維持率。

## 更新作業

producer=`scripts/compute_us_risk_observations.py`，只讀repo既有JSON，不打外部API或讀憑證。登錄source_manifest並接在US所有來源之後、data validator與commit之前；沿用既有週二至週六台北06:00排程。本地 update_all **不執行**此 producer（首次觀測時間只能來自排程；本機預設拒絕寫入共享檔，實驗請用 `--data-dir` 暫存目錄）；workflow 步驟為 continue-on-error，封存失敗不會阻擋主要資料發佈。新的受限來源不可因本頁而自動加入。上游來源URL／延遲／授權見產品設計來源表。

## 可再現與驗收案例

`node scripts/research/backtest_us_risk.mjs --input data/us_risk_observations.json --config <JSON> --out result.json` 保存完整參數、來源bundle SHA256與每筆結果；固定input+config輸出相同。不以每次執行時計算now。

- 發布與觀測時間邊界、夏冬令美東日終、首次匯入舊資料、同日修訂版本及過去lookback。
- 同日比值缺分母不可前填、OHLC內部矛盾／缺價不跳日、future rows、壞archive原子保留。
- 過去分位數不含當日／未來、126筆暖機、10日固定起點與horizon不重疊。
- CFTC第三週五到期週與次週、比較兩端乾淨且正好隔週才計變動。
- next-open、含entry日起5/10/20/60根、右設限、最大虧損與收盤MDD分開、警報low用訊號時版本。
- 三組基準共用eligible母體、空N與零覆蓋、未結束／部分覆蓋波段不算漏報、determinism。
- Browser：lazy load、desktop/390×844/844×390/短高度、下拉全部模式、ⓘ 點擊開關說明（再點／Esc 關閉）、嚴格模式 N=0 橫幅、主題、resize、切出重返、zoom/legend、503與畸形payload重試、缺optional來源明示、來源HTTP與磁碟hash、console零非預期訊息。

沒有build步驟。檢查入口：run_checks.py（Python/JS/manifest）、reuse lint、validate_data.py、新頁browser probe、獨立sanity oracle。實際執行結果另存validation文件。

日期品質：交易日軸採 SPY/QQQ 供給日期聯集；任一標的缺整列保留session為unavailable。雙方同缺交易日仍須外部交易所日曆核實。資料年齡以觀測期間計曆日；日>5、週>14、月>65為stale，非訊號門檻。
