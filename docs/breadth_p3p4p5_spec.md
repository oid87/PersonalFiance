# P3/P4/P5 實作合約（2026-09-28）

## 目標與分類
使用者確認 P3=A-D Line＋200MA、P4=McClellan Oscillator/Summation、P5=雙訊號聯合事件研究。executor sol/medium（有輸入驗證、缺值與UI判断）；verifier sol/high。禁止再派子代理、commit、push、部署、修改 data/* 或其他工作。
[實測] 主session讀過 `js/tabs/breadthSignals.mjs`、`js/utils/eventStudy.mjs`、`js/tabs/breadth.js`；既有P1/P2可維持原樣，eventStudy可接任意事件證據並提供7期統計。
[查證] 集中Explore確認 index.html 原732行研究section後可插入獨立panel；breadth.js的init/theme/resize可轉接。僅沿用該tab，不新增tab/boot接線。
[實測] `docs/breadth_phase1_sources.md`及 data 現況未含每日A/D歷史；沒有已實測可自動下載、可公開發布的歷史來源。
[決策] 做完整本機JSON匯入→計算→圖表→單訊號/聯合研究；不使用假歷史冒充真實，不增加空fetch或自動抓取。合成資料只放tests，不放data、不提供產品示範按鈕。無資料時顯示等待匯入。
[未知/不做] 附件Bluekurtic原始算法、實際source與McClellan版本，不能聲稱重現。真實來源串接與實盤訊號結論未完成，驗收必須明列。

## 已查證方法（主session web 2026-09-28）
- 官方 https://www.mcoscillator.com/learning_center/kb/market_data/Calculating_the_McClellan_Oscillator/ ：EMA alpha .1/.05，oscillator=fast−slow，summation累加oscillator；raw NYSE中性+1000。
- 官方 https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/ ：ratio net=1000*(A−D)/(A+D)，排除unchanged，ratio版本RASI。
- 官方 https://www.mcoscillator.com/learning_center/kb/market_data/summation_index_and_zero/ ：raw中性+1000，ratio中性0。不能用任意summation起點宣稱官方−500事件。
- 官方 https://www.mcoscillator.com/learning_center/kb/market_data/exponential_moving_averages_calculation/ ：EMA種子影響遞減但不會在19/39日硬消失。
[決策] 本功能支持raw與ratio，版本由匯入檔固定；明示初始化。P4門檻−500僅在檔案附供應者校準seed的情況啟用，始終標示「校準由匯入者提供，未經外部核實」。不聲稱本機判斷能驗證校準真假。

## 檔案責任（絕對路徑前綴）
ROOT=/Users/orangembpm2/work/code/personal_financial/PersonalFiance
核心包唯一可寫：ROOT/js/tabs/breadthAdvanced.mjs、ROOT/js/tabs/breadthAdvanced.test.mjs、ROOT/scripts/fixtures/breadth_advanced_fixture.mjs（新增）。
UI包唯一可寫：ROOT/js/tabs/breadthAdvancedPanel.js（新增）、ROOT/js/tabs/breadth.js（最小接線）、ROOT/index.html（breadth section內新增）、ROOT/css/main.css（新panel限定樣式）、ROOT/scripts/test_breadth_advanced_browser.cjs（新增）。
主session寫docs規格、匯入說明、Python獨立oracle。UI包等核心落地再跑整合；可依本合約先寫，不改核心API。
只讀本spec/AGENTS.md/上述關聯檔與js/utils/{math,theme,dom}.js；不重新掃整workspace。

## 匯入JSON合約（我們自訂格式，不宣稱供應商API格式）
檔案最大10 MiB；最多20000筆benchmark，至少1筆。必須為：
```
{
 "schemaVersion":1,
 "benchmark":{"symbol":"SP500","source":"nonempty","priceBasis":"nonempty", "data":[{"date":"YYYY-MM-DD","close":positiveNumberOrNull}]},
 "sp500":{"universe":"SP500","source":"nonempty","constituentsBasis":"nonempty","priceBasis":"nonempty","data":[{"date":"YYYY-MM-DD","advances":integerOrNull,"declines":integerOrNull,"unchanged":integerOrNull}]},
 "nyse":{"universe":"NYSE","source":"nonempty","constituentsBasis":"nonempty","priceBasis":"nonempty","variant":"ratio", "seed":null,"data":[sameCountsRows]}
}
```
sp500/nyse至少存在一個，缺另一個仍可看該項單訊號；P5需兩者。benchmark為S&P500指數收盤，不靜默用SPY。panel獨立於上方4股票群，標明固定S&P500指數研究，切換上方不改此panel。
每序列日期有效嚴格遞增且唯一；counts每列三欄皆為非負safe integer，或三欄皆null表示缺資料，不准混用；counts和需safe且>0。所有breadth日期必須存在benchmark軸（benchmark可含null close保留session），多餘日期拒絕避免偷偷刪掉EMA日。文字metadata要非空trim、最多500 chars。benchmark symbol與universes exact enum，variant僅raw/ratio；未知版本或不合法數值拒絕，禁止coerce字串數字，NaN、Infinity拒絕。
nyse.seed可null或為：`{date:"YYYY-MM-DD",ema19:number,ema39:number,summation:number,source:"nonempty",calibration:"provider"}`，date須小於nyse第一筆日期，有限數值。seed表示匯入資料第一筆前一有效session的狀態（使用者須保證完整連續；檔案無法單獨證明）。seed缺時：首筆有效net同時初始化兩EMA、oscillator0、summation0；標示未校準，P4/P5事件停用，不把任意0當官方基準。
日期軸是匯入benchmark有記錄的session，非完整交易所日曆；必須顯示此限制。不讀localStorage、不上傳、不外網查使用者匯入資料。只在記憶體保留，到reload清除。匯入錯誤清空新panel所有舊結果，避免新檔失敗仍展示舊結果。
匯入metadata不可innerHTML插值；textContent或安全escape。數值也必須parser成功後才render。

## 核心匯出固定API
`parseBreadthImport(input)` input可JSON字串或object，回傳經驗證的bundle（純複製/不得改input）；字串size limit，row limit。明確throw可讀訊息。
`buildAdvancedContext(bundle)` 內部也validate，回傳：
```
{ prices:bundle.benchmark.data, sessions:[{date,close,ad,adMA200,oscillator,summation,mcReady,mcCalibrated}],
 signals:{ad:[],mc:[],joint:[]}, eligibleDates:{ad:[],mc:[],joint:[]},
 meta:{variant:bundle.nyse?.variant??null,calibrated:Boolean(seed),jointWindow:5,warmup:252,yearSessions:252},
 diagnostics:{missingSp500:number,missingNyse:number,mcInvalidated:boolean},
 latest:{benchmark:date|null,sp500:date|null,nyse:date|null}}
```
每個事件至少`{date,adDate:date|null,mcDate:date|null,lagSessions:number|null,ad:number|null,adMA200:number|null,summation:number|null}`。單訊號adDate/mcDate各為自身日期，joint帶兩個原始日期與絕對session差。ad/mc數值是event date當天狀態；不預告未來事件。

### P3
在benchmark全史axis對齊sp500。SP500序列開始日為data第一列日期（即使該列全null）；開始前日期只輸出null，不累加diagnostics.missingSp500。未提供或空序列沒有開始日，缺值數為0。從開始日（含）到benchmark末日，missing row或全null才計為缺資料；A−D有效則累加（第一日即A−D，隱含前日0）。缺口當天ad=null；之後從新segment重設ad基準0，前段不連線。AD200=同segment完整200筆AD算術平均、不round。
訊號：t日ad<ma200，且之前252個連續benchmark session每一天ad>ma200（严格>，相等不合格），所有所需值均有效，t close有效。t為至少連續451日之後；不得往前多抓非null填滿。
EligibleDates.ad：t close有效、t及前252session ad/ma有效，不要求前252都在上方（否則baseline被條件篩選）；看跌條件只有signals判。

### P4
net raw=A−D；ratio=1000*(A−D)/(A+D)，A+D=0（全平盤）ratio無值，raw仍可0。
EMA全精度遞迴；有seed第一有效nyse列就更新seed，sum=seed.summation+osc；無seed按前述初始化。
NYSE開始之前的benchmark日期只輸出null，不消耗warmup、不算invalidated，也不累加diagnostics.missingNyse。NYSE開始日為data第一列日期（即使該列全null）；未提供或空序列缺值數為0。開始日起至benchmark末日的缺列、全null或ratio分母0才累加missingNyse；計數的是原始資料缺口，不是缺口後所有停止計算的日期。開始之後任一缺NYSE、null counts或ratio分母0：當天及其後oscillator/summation全部null，本bundle不可接續；diagnostics.mcInvalidated=true，提示補齊歷史再匯入，禁止跳過缺口。末尾benchmark晚於NYSE也視此規則，但保留此前可用結果。
至少252個连续已處理NYSE observations後mcReady=true，前251輸出數值但mcReady=false。mcCalibrated=Boolean(seed)&&mcReady且未invalidated。
訊號：t sum<−500，前252benchmark sessions全部sum>=−500，前252及當天均mcCalibrated=true且t close有效。若無seed，P4圖可看，但signals.mc和eligibleDates.mc均空。
EligibleDates.mc：t close有效且t/前252session全mcCalibrated，不篩門檻。raw/ratio都獨立以檔案variant計算，明示不同版本的−500不是同一意義，未驗證附件版本。

### P5
聯合規則固定：P3與P4原始觸發在5個benchmark sessions內（包含同日與差5），兩者都已可觀察的較晚日期才觸發。對每個當日的原始ad/mc事件，找最近的對側且<=今日事件；若差<=5加入，當日只一列。這是本專案自訂，非附件已證實的雙重策略。不得回填到較早事件日。
EligibleDates.joint：t close有效，t及前5sessions每天同時屬eligibleDates.ad與eligibleDates.mc（保守共同可判定窗口）。若不eligible不發joint。不要求目前兩指標仍在門檻下；它是近期兩事件而非當日雙狀態。
之後呼叫既有evaluateEventStudy，各signal配自身eligibleDates，固定20session cooldown先全史後事件範圍。7 horizons、baseline、overlap、incomplete/missingPrice、maxLoss/MDD、固定cohort paths全部沿用。

## 核心驗收
node單元測試覆蓋raw/ratio手算、seed遞迴、未校準禁止門檻、252warmup邊界、AD200/252條件邊界、相等、ratio零分母、gap停止MC且AD重啟、首尾缺資料、非法schema/date/duplicate/unsorted/count/seed/universe/variant/size、拒絕超出benchmark日期、prefix invariance。P5測試同日、差5與6、反順序、不得在早日触發、eligible缺口。fixture產生器輸出deterministic >=1100 weekday rows、具AD及MC事件與完整/尾端樣本，metadata明示SYNTHETIC TEST ONLY。fixture只export `makeAdvancedFixture()`，方便browser import/oracle共用input；不要在data落地。

## UI驗收與行為
新panel本地JSON input、清除、空白格式下載（只metadata占位，無假市場值）、狀態、source/method/seed/calibration、三圖：S&P500價格+AD/AD200（可雙grid）、oscillator、summation與−500虛線（未校準時不畫門檻）。P3/P4訊號標記與joint標記日期可讀；需清楚識別版本和不同母體。
單訊號AD/MC與joint下拉、研究range MAX/5Y/2Y、path horizon7項、統計表7列、事件日期表和兩原始日期/lag/數值證據、固定樣本路徑圖/逐事件點選、零樣本/小樣本/未完成/缺價與baseline n。日期from相對benchmark尾日calendar-year截取；圖表crop和研究crop不要重算指標。
匯入大小在File.size先檢查、pending request id防止兩次讀檔先後覆蓋/clear後回填。所有失敗清圖表/表格與下載結果（若有），state不殘留。切換theme保留結果、resize手機390px無viewport溢出，表格容器可橫捲。新panel init不依賴P1資料成功；P1失敗仍能匯入。獨立panel明文「固定S&P500指數；不跟隨上方股票群切換」。只在init/theme/resize接入breadth.js，不改P1邏輯或eventStudy。
no data→等待匯入，不顯示0次觸發讓人誤讀為實測無事件。校準seed資訊與metadata由匯入者聲明、未外部核實。頁面提示缺乏PIT成分或未知母體會有偏誤，非交易策略、非Bluekurtic重現。
Browser tests：空狀態；fixture import含3signal/7horizon；invalid替換清空；clear；兩次race；只有sp500/只有nyse；未校準；gap；錯誤metadata HTML無注入；上下股票群獨立；theme/mobile；console無錯。既有P1/P2 browser regression仍過。

## 完成回報
每包≤15行：實際API/檔案、測試命令結果、deviations、分支、commit/合回狀態；有問題回報不要自行擴scope。

## 收尾補充決策
- [實測] 主session獨立Python oracle四種情境PASS；整數counts累積可能超safe range，補AD與rolling sum安全整數檢查，不讓精度悄悄流失。
- [決策] 空狀態/讀取/失敗隱藏結果區；路徑分位使用P25/P75虛線，固定cohort不變。
- [實測] 原截圖檔名沒有先確認主題，主session修正browser test逐一指定並assert dark/light，避免證據命名錯誤；手機−500標籤改insideEndTop、tooltip confine、路徑yAxis scale。
- [實測] high verifier代理啟動因本對話agent thread limit被拒絕；未降級冒充high驗收，改由主session完成程式複核與獨立oracle、雙browser回歸，報告列待Claude獨立複核。
