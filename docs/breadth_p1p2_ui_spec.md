# P1/P2 廣度頁整合實作

## 目標／派工
sol / medium，不再發包。沿用既有breadth頁，加現況對照及描述性事件研究；使用已驗收的純核心API，不自行另造統計。先讀AGENTS.md、本spec與`docs/breadth_p1p2_core_spec.md`。

## 可寫檔案（repo root=/Users/orangembpm2/work/code/personal_financial/PersonalFiance）
- `js/tabs/breadth.js`（修改）
- `index.html`（只改tab-breadth section，保留其他未提交內容）
- `css/main.css`（僅追加以#tab-breadth限定的新樣式）
- `scripts/test_breadth_browser.cjs`（新增）
檔案皆root下绝对路径簡寫。禁止改核心／data／boot／CI／其他頁，不commit/push，完成回報branch/commit/merge。遇核心API不符先回報，不另寫一套。

## 事實與證據
- [實測] 主session讀 `breadth.js`：cache目前包含data/overlay/maMaps/peakMaps；需保存完整price rows；每頁切換目前可能異步競爭。
- [實測] `index.html`breadth section有四universe、20/50/200MA、VIX/F&G及1Y/2Y/5Y/MAX。保留全部功能。
- [實測] 卡片與tooltip用同一total顯示不同MA分母；SP500 tooltip寫VOO但實際SPY；updated被當行情日期。
- [實測] `scripts/fetch_stocks.py` auto_adjust=False且有個別splice修正；前端現存close不能宣稱含息總報酬。
- [查證] core_spec固定三訊號與baseline/回撤API；使用`js/utils/eventStudy.mjs`、`js/tabs/breadthSignals.mjs`，這包在核心完成後才派出。

## P1 固定實作
1. 由buildBreadthContext取得MA、rolling peak、momentum、HB及日期。刪除breadth.js中已被取代的重複計算，保留既有HB圖釘與VIX/F&G。
2. 各universe cache保存原始data與prices及各MA context；同時檢查兩個HTTP回應、資料schema／核心校驗錯誤。初始化／切换失敗要可重試；使用request sequence防較早response覆蓋最新選擇。禁止載入失敗後把舊市場圖冒充新市場；提供狀態及重試按鈕。
3. 20/50/200卡片與hover使用getBreadthDenominator，舊20/200缺分母顯示「分母未記錄」或「—」，保留正確原pct；不得用50total冒填。卡片以最新breadth row，標明其日期。
4. 顯示廣度最後日期、ETF最後日期、共同可用日期，分開updated（可省updated）。不以價格尾日冒充廣度已更新；說明兩者可能不同步。若VIX/F&G開啟，另列各最後日期或載入失敗，不把缺值當0。
5. 增加現況對照`#breadth-regime`：在共同日期顯示選擇ETF在同窗MA上/下/持平、廣度pct及是否多數>=50%。四種狀態用中性文字「價格與廣度均強／價格強、廣度弱／價格弱、廣度較強／價格與廣度均弱」。資訊不足顯示資料不足，不給多空標籤。
6. 主圖改用context的ETF session軸、從breadth起日至共同日；缺breadth留null不壓縮。50%參考線；期間切換只控制主圖，不偷偷改研究樣本。圖上加所選研究事件的保留訊號點，tooltip正確處理scatter array，不對array呼叫toFixed。
7. 修正文案為所選股票群／ETF，SPY一致；XLG稱市值前50代理股票群。說明MA比例不是A-D。HB是簡化版，30sessions、完整90日峰值語意與core一致，移除未經本次驗證的「歷史常先於崩盤」「叢集才有意義」等斷言。

## P2 固定實作與UI契約
在主圖與status之後、解讀區之前加事件研究section（始終顯示，無須新tab）。桌機／手機可用，文字用繁中。
- `#breadth-study-signal` select：down「廣度跌破50%」、up「廣度站回50%」、divergence「ETF在均線上／廣度低於50%」。預設down，事件使用當前MA與universe。
- `#breadth-study-range` select：MAX（預設）、5Y、2Y；cutoff以latestBreadthDate回推曆年，僅限制事件錨点日。與上方圖表range獨立。
- `#breadth-study-horizon` select：5/10/21/42/63/126/252交易日；預設63。用於路徑與事件明細，不限制總表的7個horizon。
- `#breadth-study-status`：原始事件rawN／20交易日冷卻後keptN；所選horizon有效n與排除數、重疊對數/possiblePairs。資料軸為ETF有記錄的交易日，未聲稱完整交易所日曆。n<10顯示小樣本提示（只提醒，不隐藏統計）。
- 清楚可見方法文字：「訊號日收盤起算、收盤價格報酬、不含股利再投資與交易成本；描述性研究，非可成交策略。現有成分股回填／混合批次可能有倖存者與前視偏誤。」不能隱藏在tooltip。短方法列：今昨跨越50%、divergence首次成立、固定20session冷卻，baseline所有同條件資料有效日期、不去重，仍可能重疊。
- `#breadth-study-table`：每horizon一列，至少有效n、平均、中位、上漲率、baseline平均與中位／上漲率、平均報酬差pp、平均maxLoss、最差maxLoss、平均MDD、最差MDD。用明確中文列名，「訊號日起最大虧損」與「期間最大回撤」不可混。寬表放overflow-x:auto容器，不能把整頁撐寬；空值—、n0不變0%績效。
- `#breadth-study-chart` ECharts：完整horizon固定cohort的median、p25/p75帶，t0=100；標n。用API.paths統計，不能自行平均partial曲線。選中事件另畫個別路徑，未完成的路徑註明未完成，缺口後不補線。無完整事件也要有可理解的空狀態。
- `#breadth-study-events`：所有保留事件（最新在前）可選取；使用details或有上限高度scroll表，不靜默只顯示前20。列日期、當時pct、ETF close/MA、所選horizon報酬、maxLoss、MDD與完成狀態。click事件更新個別路徑及文字，日期／evidence可查核。
- `onThemeChange`、resize處理兩張圖；不要漏掉研究圖。新控制項用dom.bindOnce/chipPicker，既有切換可順勢用共用工具，避免重複綁定。

## 驗收
- 新browser test用既有Playwright慣例，從127.0.0.1:8766（主session已啟server）開liquidity→breadth；四universe×三MA能顯示，SPY/QQQ/XLG/0050對應正確；三訊號、三範圍、七horizon可切。
- 核對統計至少一組與直接import純核心相同；hover legacy200資料不錯用50分母；scatter tooltip沒有toFixed錯；選事件曲線；VIX/F&G；切dark/light、390px不整頁橫溢。
- 測冷啟動503/empty資料與重試恢復；快速universe切換延遲response不覆蓋新選擇。測試不要依賴當下事件一定非空，可用route fixture覆蓋需要狀況。
- 跑指定core node tests、新browser test、`python3 ../Financial_work/check_reuse.py js/tabs/breadth.js`；對修改行的新lint違規要修，既有違規回報並區分。
- Playwright路徑已實測：`/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`；node v25.4.0。截圖存系統暫存目錄，回報絕對路徑。

## 不做
不修改其他頁的既有回測、不做P3/P4/P5、不下載長期新資料、不加策略進出場引擎、不自動部署或推送。
