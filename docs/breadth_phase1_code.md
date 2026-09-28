# 市場廣度第一輪 B：程式與事件研究盤點

證據分級：[實測]本次本地資料運算；[查證]本次精讀實際程式與caller；[推論]由已核對程式推導或待下一輪實作。未下載、未跑全套測試。

## 能力與重用表

| 現有能力／候選 | 證據 | 判斷與邊界 |
|---|---|---|
| 四市場廣度＋ETF自身20/50/200MA | [查證] `js/tabs/breadth.js:16,124,136,139` | 沿用頁面與載入配置；個股廣度與ETF MA是不同數列，不能混稱。 |
| 個股aboveMA、52週高低、距高點20%熊市比例 | [查證] `scripts/_breadth.py:78,94,104,132` | 計算核心可沿用；分母契約要補全。 |
| Hindenburg-style單日及叢集 | [查證] `js/tabs/breadth.js:73,89,98` | 需抽成純函式、明定缺日与叢集邊界；不是原版NYSE指標。 |
| NAAIM去重／forward return／基率 | [查證] `js/tabs/naaim.js:140,187,206,228,261,344` | 首選設計參考；純計算與DOM分離已成立。日期去重及索引horizon可抽用；週頻母體、+2曆日嚴格後移、90日參數不直接套breadth。 |
| ROC4事件首日／統計表 | [查證] `js/tabs/roc4.js:43,57,167` | 可借首日事件和per-horizon n呈現；需去除全域raw/firstOnly依賴，無baseline。 |
| wkrev週訊號／基率 | [查證] `js/tabs/wkrev.js:114,120,140,274,287` | 借每個horizon排除末端的做法；不宜原封當可成交回測，caller未後移進場。 |
| marginpeak事件後分布 | [查證] `js/tabs/marginpeak.js:182,199,378` | 借rebase路徑＋分位數彙整；不得移用峰值訊號和硬碼baseline，需補nByOffset。 |
| 日期／統計工具 | [查證] `js/utils/dates.js:77`、`js/utils/math.js:49,69,73` | lookupLE、percentile、mean/std可重用；需以可得時點調用lookupLE。dates的loaded耦合函式不當純核心。 |
| 靜態JSON與既有更新管線 | [查證] `.github/workflows/fetch.yml:114,118,122,328`、`scripts/update_all.sh:54` | 四支均已接線；若只補既有schema不需新增來源或新增tab。 |

## 本地資料摘要

[實測]本次以Python讀JSON只印schema、起訖、首次有效、尾列；不整檔輸出。數據行號以來源程式錨定：`scripts/_breadth.py:132`；價格讀取`js/tabs/breadth.js:135`；overlay`js/tabs/breadth.js:289`。
四檔共同schema：date、above20/50/200_count/pct、total、new_hi/lo_count、hl_total、bear_count/pct/total；頂層updated/data。沒有above20_total／above200_total、逐檔報酬、daily advances/declines、發布時間或歷史成員快照。

| JSON（data/） | 列數／起訖 | 200MA首次有效 | bear首次有效／high-low首次有效 | 尾列above20/50/200%，total／hl_total |
|---|---|---|---|---|
| breadth.json | 1715；2019-11-26～2026-09-24 | 2020-07-02 | 2020-09-16／2020-09-17 | 26.8／26.2／47.7；503／499 |
| breadth_ndx.json | 1707；2019-12-09～2026-09-24 | 2020-07-15 | 2020-09-28／2020-09-29 | 49.5／42.6／56.6；101／99 |
| breadth_xlg.json | 1715；2019-11-26～2026-09-24 | 2020-07-02 | 2020-09-16／2020-09-17 | 52／46／74；50／50 |
| breadth_tw50.json | 1658；2019-11-29～2026-09-24 | 2020-07-16 | 2020-09-28／2020-09-29 | 56／82／94；50／50 |

[實測]20/50、total首次有效均為各檔首日；200_count與pct同日首次有效，bear_count/pct/total同日，new_hi/lo_count與hl_total同日。date欄全程有效。
[實測]SPY、QQQ各6723列（2000-01-03～2026-09-25）；XLG 5379列（2005-05-10～2026-09-25）；0050.TW 4341列（2009-01-02～2026-09-24），均date/OHLC/volume且每欄從首日有效。VIX 6727列（2000-01-03～2026-09-25），同schema；F&G 3937列（2011-01-03～2026-09-25），date/value/rating且从首日有效。美股價格最新日比breadth多一交易日。

## 方法問題

1. **分母有明確語意差異。** [查證] `scripts/_breadth.py:82,90,135,139,146`各MA各自計有效分母，但只輸出v50為total。UI卡片及tooltip都用total（`js/tabs/breadth.js:207,395`）。[實測]SP500尾列239/503=47.5%，存檔47.7%；NDX 56/101=55.4%，存檔56.6%。按差值>0.11pp抓200MA不符列數依序900/1105/300/150，這是UI分母不符，不能說存檔pct算錯；count與一位小數pct不足以唯一反推有效分母。P1補above20_total/above200_total，舊列無證據時顯示分母未知。
2. **日期窗口不是同一種單位。** [查證] `naaim.js:115,140,187`進場buffer及cooldown為曆日、報酬為交易日；`roc4.js:43,57`為連續同向區段首日＋交易日horizon；`wkrev.js:114`按週K數。`compute_sentiment.py:88,118`以21/63/126/252「曆日」位移並取第一個>=日期，卻命名1m/3m/6m/1y；不宜移用為交易日事件核心。
3. **收盤描述與執行分離。** [查證] `wkrev.js:125,142,152,292`caller直接傳訊號週i，`forwardReturn:117`實際分母weeks[i].close，與`:113`註解「i+1週收盤起算」不符；本次未修。`roc4.js:29,57`同日收盤決定ROC並作報酬起點；`breadth.js:73`同日股價/高低/趨勢才能確認。這些可作收盤事件描述；下一輪可成交策略須獨立confirmedAt及下一可執行交易日open/close與成本。
4. **事後峰值不是當時可知訊號。** [查證] `marginpeak.js:84,91,98,182`峰值比較到i+6月，事件/報酬卻錨定原峰值月底；現有JSON/程式沒有發布時點。只能借分布畫法，不拿事後峰值當即時預測。A訊號cooldown >365曆日（`:73`），亦非跨越門檻必然首日。
5. **缺失日改變「交易日」語意。** [查證] `breadth.js:91,101,110`趨勢50、叢集30、動能90都以breadth列數當日；`_breadth.py:118`可丟最近低覆蓋日。[推論]缺一列會讓50列跨度大於ETF的50交易日；需用目標市場session軸與coverage旗標，不能先drop null再計窗口。rollingPeak目前是最近90個非null值（`breadth.js:112`），未滿窗仍輸出，null跨期可拖入過舊高點；computeMomentum比較rows[-91]（`:60`）。叢集cutoff latestIdx-30（`:102`）含當日為31列，P1須明定「30日」是30筆或30日差。
6. **未完成horizon與樣本數。** [查證] `naaim.js:189,253`、`roc4.js:59,179,209`按horizon排末端且回有效n；NAAIM警告卻按nPost而非horizon n（`:232`）。wkrev算n1/4/12（`:128`）但表只顯count（`:166`）；`dates.js:131`末週不是週五即partial，不懂交易所週五假日，可能排掉已完成假日週。marginpeak逐offset丟null（`:199`）但只回paths.length（`:205`），需另回每offset n，避免同一條平均曲線被誤認固定事件母體。
7. **調整價格與總報酬。** [查證] `_breadth.py:49`成分股auto_adjust=True；前端直接讀overlay close（`breadth.js:135`），未重建股利，NAAIM檔頭明示未還原息（`naaim.js:11`），repo AGENTS.md「不可變事實」聲明股價auto_adjust=False。此範圍未讀fetch_stocks以獨立核實其每ticker例外；JSON亦無adjustment metadata。[推論]目前ETF事件數字應標close price return，不能宣稱含再投資總報酬；逐檔調整价aboveMA与ETF原始close MA口徑需明示，拆股修補不得等同完整總報酬。
8. **兩種下跌指標不能混。** [查證] `dates.js:65`minBetween只找最低收盤，並無running peak；`_breadth.py:104`bear_pct是橫截面個股距252日高点比例，非ETF事件回撤。四候選事件模組（NAAIM`:187`、ROC4`:57`、wkrev`:114`、marginpeak`:182`）均未提供事件區間peak-to-trough MDD。[推論]新增signed maximum loss=min(0,min(P/P0-1))，signed MDD=min(Pt/max(P0..Pt)-1)，close-only須標示不含盤中低點。
9. **baseline與重疊。** [查證] `naaim.js:270`基率限定有效週rank且有t0，與訊號同horizon；基率沒90日去重（`:211`），訊號有（`:230`），而130TD horizon仍可能與90曆日下一事件重疊。ROC4只去連續同向，明示非独立（`:209`）；wkrev每個非partial週都算（`:142`），沒有冷卻。marginpeak baseline硬碼（`:16`），不隨breadth市場/範圍重算。下一輪baseline須同市場、訊號所需欄位有效期、執行規則與horizon；同時報raw/episode/eligible n及重疊比例，平均勝率不作獨立樣本顯著性宣稱。
10. **歷史成分與A-D缺口。** [查證] SP500/NDX抓當前名單（`fetch_breadth.py:27`、`fetch_breadth_ndx.py:27`），XLG現時市值排序＋30日cache（`fetch_breadth_xlg.py:65,77`），TW50當前/90日cache/fallback（`fetch_breadth_tw50.py:59`）。`_breadth.py:183,198`增量尾段覆蓋、舊段保留，故歷史還可能混合不同抓取批次成員；不能簡化為整檔固定今日名單。`index.html:752`已警告偏誤。[推論]aboveMA彙總不能反推daily A/D或McClellan；缺point-in-time constituents與逐檔日報酬，P2/P5只能做有偏環境事件描述。
11. **P1文案與freshness。** [查證] `index.html:693`稱VOO，實際SPY（`breadth.js:17`）；20MA已可切換（`index.html:699`），spec舊行號686/739須改699/752。`_breadth.py:169`4曆日內先skip，CI每日執行不代表breadth每日新；前端cache在`breadth.js:125`無freshness判定。顯示每個來源lastDate及共同可用日期，不能用updated或價格尾日冒充breadth尾日。

## 建議模組與資料契約

[推論]以下是下一輪候選規格，不是已實作功能；依據純核心先例`naaim.js:261`、靜態載入`breadth.js:124`及分布彙整`marginpeak.js:182`。
- `js/utils/eventStudy.js`：純陣列核心，alignSession、dedupeEpisodes、evaluateHorizons、buildPaths、summarize；無fetch/DOM/state。參考NAAIM的索引計算，不直接import整個tab；共用math已有mean/std/percentile（`:49,69,73`）。預設full-precision結果，最後UI才round，若復用舊round行為須明示。
- `js/tabs/breadthSignals.js`：breadth專屬detectSignals(rows, sessionDates, config)；產raw events與確認紀錄，不包含未來報酬。連續首日、冷卻、Hindenburg叢集、共同訊號為可配置政策，閾值／時間窗／同日或窗口內共同成立由主session裁定，不搜尋最佳化。
- 既有`breadth.js`：取資料、universe切換、事件標記／表／路徑圖；維持原頁ES module架構。圖表range與研究樣本range分開參數；baseline隨研究range，暖身始終取完整過去數列（現有MA先算全史的做法`:136`）。

| 契約 | 必填／行為 |
|---|---|
| SourceMeta | universe、exchange、timezone、lastDate、updated、priceBasis(raw/split-adjusted/adjusted/unknown)、returnBasis(price/total)、constituentsBasis(current/backfilled/mixed/PIT/unknown)、schemaVersion；未核實不得填PIT/total。 |
| BreadthRow | date、above20/50/200_count/pct、above20/50/200_total、hl_total、bear_total及既有count/pct；允許null，total兼容別名=above50_total；缺舊分母不可從rounded pct造回精確n。 |
| PriceRow／sessions | date、finite positive close、open可選；sessions指定市場交易日序；排序唯一，不默默把缺價日壓縮；缺/重複/非finite必須reject或附明確missingPrice狀態，不能轉0。 |
| Event | id、universe、signalType、observedDate、confirmedAt（時間與時區或明示session-close）、executionDate、executionField、dedupePolicy、evidence（原值及有效分母）；研究anchorDate可與策略executionDate分開。 |
| StudyConfig | mode(descriptive/tradable)、horizonsTD、cooldown(unit calendar/session)、episodePolicy、researchFrom/To、entryPolicy、closeOnly、成本假設；模式/資料不符拒絕輸出可成交績效。 |
| EventOutcome | 每horizon {eligible,status,anchorDate,exitDate,forwardReturnPct,maxLossPct,mddPct}；status区分unconfirmed/noEntry/missingPrice/incomplete/complete；不完整不補尾價。 |
| Aggregate／baseline | rawN、episodeN、nByHorizon、mean/median/winRate、baseline同欄及差值、overlapCount/ratio、excludedReasons、sampleStart/End；空樣本統計=null。 |
| Paths | offsetTD、mean、p25/p75、nByOffset；區分variable cohort與完整horizon cohort，不把兩種曲線混稱；n=0→null。 |

## 下一輪檔案範圍

- P1候選：[推論] `js/tabs/breadth.js`、`index.html`（SPY文案、分母、來源日期、窗口契約）；`scripts/_breadth.py`（有效分母落盤與版本metadata）、四支fetch（只在市場metadata需傳参時）、對應breadth JSON。證據`_breadth.py:132`與`breadth.js:207`；改schema需保留舊讀法，是否重算由主session裁定，不能假定老缺值可恢復。
- P2/P5候選：[推論] 新`js/utils/eventStudy.js`、`js/tabs/breadthSignals.js`、既有`breadth.js`／breadth section、離線`.test.mjs`；沿用boot接線（`js/boot.js:15,89,178`），不建新tab或框架。測試檔在實作輪才建立。
- [推論] 若只有現有來源/schema補強，CI與update_all已接線，不必修改；若之後決定新增來源，才依repo規則補兩管線。NAAIM/wkrev/ROC4/marginpeak/compute_sentiment在本輪及下一breadth最小實作範圍均不順手修。

## 驗收案例

[推論]以下供下一輪離線驗收；本輪只定fixture與expected，不寫測試檔。金額無成本、報酬單位%。

| # | Fixture條件 | Expected |
|---|---|---|
| 1 尾端 | close=[100,110,121]，anchor=0，h=2/3；另事件anchor=1、h=2 | 第一事件h2=21%，h3=incomplete/null；第二h2排除。rawN=2、n(h2)=1、n(h3)=0且mean=null，不能以尾價補足。 |
| 2 兩種下跌 | 路徑100→120→90→110（含anchor） | maxLoss=-10%；MDD=-25%；h3報酬+10%，不能拿min/anchor代MDD。100→120→110則maxLoss=0、MDD=-8.3333%。 |
| 3 去重政策 | 候選2026-01-02、01-03、01-31、02-01；cooldown=30曆日，與前一保留比 | 保留01-02及02-01（差30）；01-31差29排除。另方向序列+,+,0,+,-,-之episode首日為index0/3/4，不等同30日cooldown。 |
| 4 確認/執行 | 週五收盤100確認訊號，週一open110、close120，週二close121 | descriptive週五→週一=20%；tradable次session open→週二close=10%，event.confirmedAt與executionDate不同；不允許以週五close宣稱實際成交。 |
| 5 交易日/曆日 | sessions=[2026-09-24,09-25,09-28,09-29]、close=[100,101,110,120]；09-25 anchor，h2 | 交易日h2 exit=09-29，return=18.811881%；曆日+2落09-27、往後對齊則exit=09-28，return=8.910891%。兩種規則必須產生不同expected，不能以曆日替代交易日。 |
| 6 分母/暖身 | 同日a20=1,n20=3；a50=1,n50=2；a200=null,n200=0 | pct20=33.3、pct50=50、pct200=null；UI分母各為3/2/未知或0；歷史無n20/200不可用total=2冒填。 |
| 7 缺日與窗口 | sessions=A,B,C,D；breadth B缺失；lookback=2 sessions；另峰值窗3筆含一null | D比較B應missing/不可判，不改比A；固定3-session窗遇null按明定有效率政策返回不足，不能往前再抓一個非null當第三天。 |
| 8 基率母體 | 4個session價格100,110,121,133.1；訊號所需欄位僅後2日有效，h1；尾日無未来 | baseline只能anchor index2，n=1、ret=10%；index0/1不得混入，尾日排除；研究顯示窗縮短不能改暖身計算。 |
| 9 路徑n/round | 路徑一[100,110,120]、路徑二[100,90,null] | nByOffset=[2,2,1]，mean=[100,100,120]；offset1 p25=95、p75=105。完整h2 cohort只有第一條，曲線[100,110,120]須明標；統計前不逐筆round。 |
| 10 事後資訊/非法價格 | 峰值須未來6月確認；或price含duplicate date/null/0；F&G早於2011缺 | 峰值confirmedAt不得早於+6月可得日，事後原峰值anchor只能descriptive；非法價格拒絕或missingPrice，overlay缺時共同訊號unknown而非0或false數值，不得偷用未來最近值。 |

## deviations

- 沒有額外程式閱讀範圍、沒有網路研究、沒有下載、沒有原檔文件解析、沒有實作／測試檔／commit。只讀指定來源及指定JSON摘要。
- spec提供的index.html 686/739行號已重定位：MA切換699～701；成分偏誤752。舊標籤未直接信任，以caller精讀重驗。
- 價格auto_adjust=False僅依repo明示與候選程式文案查證，未超出集中清單追fetch_stocks；其每ticker拆股處理及實際資料供應發布時間留待下一輪授權核實。
- 工作分支main；本包僅新增本報告，未commit、未合回（不適用）。

## 主 session 複核（2026-09-28）

- 已抽查NAAIM的dedupeSignals/fwdRet/baseline、wkrev caller、marginpeak前後6月峰值、compute_sentiment曆日位移，以及breadth卡片共用total。確認可借設計，不應整包複製為可交易回測。
- 驗收案例5原fixture的交易日與曆日對齊恰巧同日，無法抓出窗口錯用；已改用週五anchor，使兩者exitDate與報酬不同。
- 本輪沒有執行實作或全套測試；驗收案例為下一輪規格輸入，並非已通過測試。
