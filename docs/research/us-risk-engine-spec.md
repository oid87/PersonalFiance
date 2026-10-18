# 美股風險觀察實作規格與派工台帳

## 決策與證據
- [實測] repo origin=oid87/PersonalFiance，base=8008803b。獨立 worktree `research/us-risk-observer`，保留主 checkout 台股 marginalert WIP。
- [查證] README/CLAUDE/AGENTS/TESTING：原生 ES modules、ECharts、無 build，從 scaffold 起手，共用 requestJSON/theme/dom/lifecycle。正式交易模組不變。
- [實測] SPY 2026-10-16 open>high；VXN 10/15；vix_term 10/16 ratio=null；credit 2023-06-27 起。缺值與 OHLC 異常不能修補／補零。
- [查證] 現存 CFTC 為 consolidated series，long+short 不含 spreading，不是美元 gross 曝險。
- [查證] 廣度 meta=current-snapshot-backfill-mixed-vintages，歷史模式禁止廣度回測。NFCI／FINRA 沒有逐期 historical release/vintage。
- [決策] 嚴格模式預設：只用 append-only observation archive 中在決策 cutoff 前已觀測的版本。首次匯入整段歷史只證明匯入日可得。歷史收盤模式另標非 PIT，日頻重建不得偽稱領先性；週月確認仍嚴格 as-of。

## JSON 契約（Main 負責 producer/schema）
`data/us_risk_observations.json`：`schema_version:1, generated_at:ISO UTC, series:{ID:{meta,records}}`。
`meta` 含 label,frequency(daily/weekly/monthly),unit,source_url,source_file,delay,license,quality,history_eligible,available,reason,input_sha256,input_updated,last_observation。
每筆 `records`：`{date:YYYY-MM-DD, observed_at:ISO UTC, published_at:null|ISO, source_hash:sha256, values:{...}}`；同 date 不同 observed_at 保留各版本，完全相同不追加；published_at 未知永不估計。
ID／values：SPY/QQQ/SOXX: `{open,high,low,close}`；VIX/VXN/VIX3M/HY_OAS/NDX_BREADTH/NFCI_RISK/NFCI_CREDIT/NFCI_LEVERAGE/FINRA/CNN_FG: `{value}`（breadth 另有 total/above50_total）；CFTC_ES/CFTC_NQ/CFTC_RTY: `{long,short,oi}`。RSP/SMH 缺資料：records=[],available=false。
所有 seed rows 日期>=2018-01-01，first observed 都為本次實際執行時間。舊 producer input 檔原封不動。失敗保留舊檔與原 observed_at，不重新標示新鮮。

## Worker spec: 純計算引擎與必要單元測試
**難度** high；**ownership** 僅新增 `js/tabs/usrisk_calc.mjs`、`js/tabs/usrisk_calc.test.mjs`。不得改其他檔案，不得再發包。
**Main ownership**：所有 UI／接線、producer／schema／pipeline、文件與 browser probe。並行時不得還原別人的 WIP。

公開 API：
- `validateBundle(bundle)`：必要 schema/series SPY QQQ records 及有效日期時間，不接受畸形／空核心來源。回傳 bundle 或 throw。
- `runStudy(bundle, config={})`：回傳 `{config,days,events,stats,baselines,coverage,diagnostics,episodes,latest}`，實際結構可擴但須附簡短說明供 Main 接 UI。
- `latestOverview(bundle, asOf=bundle.generated_at)`：各 ID 最新可用記錄、有效日期、observed_at、age 與 stale 狀態；不能把檔案 updated 當有效日期。
- `rollContaminated(date)`：季度第三週五所在週及其後一週 true（週一至週日）。
- `confirmationAt(bundle, date)`：只取 published_at（如有）與 observed_at 均<= date 的美東日終 cutoff 的週／月版本；不可得=null，不可用最新值補過去。CFTC 顯示 roll flag；只對連續一週且比較兩端乾淨報告計算 `(long+short)` 週變動；污染週不可前填乾淨變動。

config：asset SPY/QQQ；dataMode strict(預設)/historical；mode vix/vxn/relative/semis/term/breadth；gate 0/8/10/15 %；thresholdMode fixed/percentile；threshold 預設依 mode 30/30/-5/-5/1/30；percentile 90(高壓)或10(低壓)；cooldown 10；horizon 5/10/20/60；from 2020-01-01；to 截至 bundle.generated_at 的美東日期。

方法：
1. 信號日在美東日終才可知；最早下一個資產交易日 open；美東 cutoff 要處理 DST，不可直接用 UTC 日期比較。published_at 與 observed_at 至少晚者，未知 publish 不得估計。
2. 股價 axis 保留每個供給交易日；OHLC 必須正、finite、low<=open/close<=high。異常 bar 不跳過以縮短 horizon，outcome unavailable。
3. drawdown=(1-close/max(近120個資產交易日close))*100，資料不足120日 unavailable。嚴格模式每個訊號日的 lookback 亦只能用當時已觀測版本。
4. VIX/VXN value>=threshold；term=VIX/VIX3M 同觀測日，不前填；relative=(QQQ/SPY)/(20資產交易日前的同日QQQ/SPY)-1；semis 同理 SOXX/QQQ（%），低於 threshold；breadth 為 NDX >50MA%，歷史模式 unavailable；嚴格模式亦要求 meta.history_eligible 且可信 PIT 成員，現存 false。
5. percentile 只使用當日之前252個資產交易日，至少126個有效值，不可用當日或未來，全樣本不允許。使用既有 math.percentile。
6. 僅當價格／指標都有效且可得才納入 eligible。flag=condition&&dd>=gate。固定首事件冷卻：距上個接受事件 >=cooldown 交易日；stats 分別列 raw flag days、冷卻事件數及 horizon 不重疊事件數（間隔 >=max(cooldown,horizon)）。不得把全部冷卻事件稱統計獨立。
7. next open anchor，horizon=5 指 entry 日起5根，exit=entry+4 收盤；所有 horizon完整且全部OHLC合法才回報。回報 return、maxLoss=min(low/entry-1,0)、close-path peak-to-trough MDD（含entry anchor）、再破警報日low比例；均百分比，不含股息/成本。
8. stats 包含 N、完整/右設限/壞價數、中位、p10/p25/p75/p90、min/max、逐事件分布。基準 all、drawdownMatched、singleIndicator 均用相同 indicator eligibility／日期／price quality，套相同冷卻/不重疊規則，保留母體 eligible N，禁止 coverage 差異冒充增益。
9. episodes 用當時120日高點回撤>=8進入、<3離開，未離開=open，漏報/誤報只對完整且 eligible 全覆蓋波段；無覆蓋/部分覆蓋/open 標 censored，不可算漏報。誤報為完整已覆蓋波段外且未來視窗完整的 accepted events（定義另明示，非預測低點）。
10. 每個 event 回報警報日、next-open日、當時週月 confirmation 與 first later confirmation（事後）；不把估計發布日期或最新版 NFCI 回填進歷史。reproducibility=固定bundle內容+config同結果。

驗收：Node unit tests（發布前/後/DST、兩版本、strict無歷史、同日ratio、過去分位、冷卻10/11、horizon右設限、OHLC異常、roll兩端、空分母、基準共eligibility、不可把open wave當漏報、determinism）。所有測試加入 js 下由 npm test收集。Main 會實際重跑及抽算數字，不只接受PASS摘要。

## 台帳
| phase_id | agent_id | role | status | assigned_phase_ids |
|---|---|---|---|---|
| delivery | architect | workflow-architect gpt-6-astra/high | completed plan; final review by Main | delivery |
| delivery | engine_worker | workflow-worker gpt-6.1-sol/medium | completed | delivery |

每階段 distinct=2，子代理不得再發包。Main模型/effort沒有可確認／切換工具；不宣稱已達使用者偏好設定。

使用者後續指定：往後所有可選模型／推理工作只用 gpt-6.1-sol/high，不再用 Astra。此輪前段既有角色呼叫已結束，之後由 Main 完成整合與最後 review，不再呼叫 Astra。
