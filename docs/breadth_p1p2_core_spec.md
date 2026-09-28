# P1/P2 純計算核心與訊號規格

## 目標／派工
sol / medium executor；不再發包。實作描述性事件研究與廣度對照的純函式，供既有breadth頁使用。請先讀repo AGENTS.md。本輪沒有交易策略、下單、參數最佳化、P3/P4/P5。

## 唯一寫入範圍（repo root=/Users/orangembpm2/work/code/personal_financial/PersonalFiance）
- `js/utils/eventStudy.mjs`（新增）
- `js/utils/eventStudy.test.mjs`（新增）
- `js/tabs/breadthSignals.mjs`（新增）
- `js/tabs/breadthSignals.test.mjs`（新增）
以上均為root下絕對路徑的簡寫；不要修改其他檔案，不commit/push。完成附分支名／未合併狀態。只精讀本spec、`js/utils/math.js`、`scripts/_breadth.py`、`js/tabs/breadth.js`、`docs/breadth_phase1_code.md`，不重掃workspace。

## 證據
- [實測] `scripts/_breadth.py:78-147`：20/50/200MA比例的分母各不相同，舊total=n50；資料沒有日A/D。
- [實測] `breadth.js:16,124,136`：四股票群各配SPY/QQQ/XLG/0050及ETF自身均線；JSON有date/close。
- [查證] `docs/breadth_phase1_code.md`：今日成分／批次混合歷史存在偏誤，不能稱無偏回測。NAAIM是設計參考，不直接import整個tab。
- [實測] 本輪重新讀 `scripts/_breadth.py`，full_backfill與增量資料不能提供精確舊20/200有效分母，UI不可由rounded pct反推。

## 固定API：eventStudy.mjs
匯出 `HORIZONS = [5,10,21,42,63,126,252]`。
匯出 `evaluateEventStudy({prices, events, eligibleDates, horizons=HORIZONS, from=null, to=null, cooldownSessions=20, pathHorizon=63})`。
- prices為按date嚴格遞增、不重複的`{date,close}`列；date有效YYYY-MM-DD。它是可用ETF交易日軸（非交易所完整日曆），不可按日曆天位移。null close保留位置，非null非正有限價拒絕，重複／亂序日期拒絕。
- events為`{date,...evidence}`陣列；只接受在prices且在eligibleDates的事件，排序去重；eligibleDates也是合法價格軸上的日期。其他非法日期或不在軸上的事件須明確throw，不能悄悄配最近日。事件及eligibleDates的null價可存在，但outcome記missingPrice。
- 先在全史事件做20 sessions冷卻：當前index-前一保留index >=20保留。再依from/to（包含端點，均為事件錨點範圍）過濾事件與baseline；研究範圍變動不能改冷卻結果。0表示不冷卻。to不截斷後續已觀察到的價格。
- 每事件每h：退出idx+h；不夠長為incomplete；窗口任一close缺失為missingPrice（不跳過/補值）；complete則forwardReturnPct=100*(exit/anchor-1)、maxLossPct=100*min(0,min(path/anchor-1))、mddPct=100*min(path/runningPeak-1)。包含anchor，全精度運算，只是收盤價格報酬，不含息/成本、不聲稱可交易。
- 統計complete樣本：n、mean、median、winRate（嚴格>0）、meanMaxLoss、medianMaxLoss、worstMaxLoss、meanMdd、medianMdd、worstMdd；空樣本n=0其餘null；重用math.mean/percentile。
- baseline同from/to、eligibleDates、horizon與完整窗口規則，無條件不去重。stats每h有`horizon,n,mean,median,winRate,meanMaxLoss,medianMaxLoss,worstMaxLoss,meanMdd,medianMdd,worstMdd,baseline:{同統計},overlapPairs,possiblePairs,excluded:{incomplete,missingPrice}}`。重疊是complete事件按index相鄰、後錨點<前錨點+h的對數，possiblePairs=max(n-1,0)。冷卻不代表獨立樣本。
- 回傳`{rawN,keptN,events:[{date,...evidence,outcomes:{[h]:{status,exitDate,forwardReturnPct,maxLossPct,mddPct}}}],stats:[...],paths:{horizon:pathHorizon,n,points:[{offset,n,median,p25,p75}],individual:[{date,complete,values:[number|null]}]}}`。
- paths從t0=100重設。bands只取完整pathHorizon的固定cohort，每offset同n；individual可含未完成事件，但從首個缺價起後续全null，不能跨缺口拼接。無complete cohort時points統計null；長度h+1。

## 固定API：breadthSignals.mjs
匯出`getBreadthDenominator(row, window)`：優先正整數above{window}_total；50可退回total；20/200缺就null，禁止反推。
匯出`buildBreadthContext(rows, prices, maWindow=50)`（window只接受20/50/200）；rows/prices date排序唯一，同上嚴格校验。prices的null保持交易日位置；breadth pct只接受finite[0,100]否則當unknown。
- 用完整prices軸算ETF MA（有任一null則該窗null，需完整w天）。sessions逐日回傳`{date,close,ma,pct,denominator,row,aboveMA,divergent,eligible}`；row缺則null，aboveMA以close>ma（相等為false），資訊不足則null。
- `eligible`需今與前一個ETF session的pct、close、ma全有效；資料缺口兩側不判斷跨越。baseline用相同eligibleDates（保守共同母體）。
- signals `down`：昨pct>=50且今<50；`up`：昨<50且今>=50；`divergence`：今close>ma且pct<50，昨該條件為false才觸發。皆需eligible；divergence標示「ETF在均線上／廣度低於50%」，不稱價格創高背離。
- 每個事件帶`{date,pct,previousPct,close,ma,denominator}`。
- 回傳`{sessions,signals:{down,up,divergence},eligibleDates,maByDate,peakByDate,current,latestBreadthDate,latestPriceDate,commonDate,momentum,hindenburgDates,hindenburgRecentCount}`。current為最後同日breadth與有效close所在session（pct/ma可能null）；commonDate為其date；latest日期指行情列日期非updated。
- peakByDate：在ETF軸完整90 session的pct最大值，任一缺pct則null；momentum在current date以該90峰值減前90sessions那天的完整90峰值，無180日完整資料則null。`{peakNow,peakPrior,diff}`。
- Hindenburg沿用新高與新低各/hl_total >.022、max<=2min、當日close>50sessions前close；無hl_total不猜total，無數字不判。輸出dates；recent count是current在內最後30sessions（index-29），不是31筆。不取未來列。保留圖表既有標記用途，不放入本輪事件研究選項。

## 驗收
離線node tests至少覆蓋：100→120→90→110報酬+10/maxloss-10/MDD-25；單調上漲maxloss0；perhorizon尾端與null；空樣本；精度未先round；20session邊界；研究from不重置冷卻；baseline母體；overlap；固定cohort與partial path；週五+2session不同於+2曆日；非法日期/duplicate/price；50/20/200分母；MA完整warmup；缺pct不橋接訊號；divergence初次；90/180momentum完整窗；HB最近30界線。
跑`node --test js/utils/eventStudy.test.mjs js/tabs/breadthSignals.test.mjs`。不跑全套、不下載。完成≤15行回覆：API差異（應無）、測試命令/結果、deviations、branch/commit/merge。
