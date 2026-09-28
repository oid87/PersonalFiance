# 市場廣度第一輪 A：資料可行性調查

調查日：2026-09-28（Asia/Taipei）。範圍：P0／P3／P4 的資料來源；不驗證投資訊號。

## 候選來源表

證據：[實測]＝本次直接請求／主 session 已盤點；[查證]＝提供者文件；[推論]＝由證據導出的建議；[未確認]＝本輪未取得證據。提供者文件不等於成功下載資料。

| 候選／路線 | 母體與版本 | 可證實範圍／粒度 | 取得方式、費用、授權、CI | 證據 |
|---|---|---|---|---|
| McClellan／直接 NYSE | [查證] 當日頁標 NYSE，使用 WSJ/Barron's 最終廣度；[未確認] 普通股／基金／優先股納入細則。文件同時區分原始版、RAMO/RASI；[未確認] 歷史商品欄位屬哪版 | [查證] 商品標 NYSE McClellan A-D & Volume Oscillator Data「1960 -」；[未確認] 精確首末日、原始 A/D 欄位、全期缺漏。公開表有 2026-09-25 單日 | [查證] 網頁表、xls 連結、付費歷史下載 US$40／30日內下載；需帳號／付款。商品頁條款限制重製與轉傳；[未確認] 公開網站 JSON 再發布權與 API。[實測] 本機 GET 403，未驗證 CI | [當日頁](https://www.mcoscillator.com/market_breadth_data/)、[商品頁](https://www.mcoscillator.com/subscriptions/signup/historical-data/) |
| StockCharts／直接指數 AD% | [查證] `$SPXADP` 標 S&P500 net advances percent；AD%＝(A-D)/Total Issues，不是 McClellan 的 1000×(A-D)/(A+D)。[查證] 文件稱歷史採當時持股；[未確認] 個別 `$SPXADP` 官方指數／ETF持股一致性及臨時成分細則 | [查證] 文件僅說數年、收盤後計算；[未確認] 精確首末日、每日可下載值 | [查證] SharpCharts 圖表；[未確認] CSV/API、登入費用、額度、重製授權與 CI。只可列人工觀察候選，不稱 API 可用 | [圖表說明](https://help.stockcharts.com/charts-and-tools/sharpcharts/sharpcharts-workbench/editing-sharpcharts/charting-market-breadth-indicators)、[AD%定義](https://chartschool.stockcharts.com/table-of-contents/market-indicators/advance-decline-percent) |
| Norgate／直接廣度 | [查證] US Extras 列 NYSE/Nasdaq/NYSE American 及 S&P500 等指數的 advances、declines、unchanged、累積 A-D；指數組另列 McClellan Oscillator/Summation。[查證／主session補核] 指數廣度採PIT成分，價格調整為Capital reconstructions and special distributions；[未確認] NYSE證券種類、McClellan原始／比例調整、每條代碼與算法 | [查證] 有日頻 price_timeseries；[未確認] 個別廣度序列起訖，不能把股票套餐起點當廣度起點 | [查證] Gold以上含 Extras；Python API＋Windows NDU＋有效訂閱。[查證] EULA 允許個人私有雲處理，限制對外發布；[推論] 公開 data/*.json 架構須先取得另行授權。CI實測未做 | [內容表](https://norgatedata.com/data-content-tables.php)、[Python](https://pypi.org/project/norgatedata/)、[EULA](https://norgatedata.com/subscribe/eula.php) |
| Norgate／PIT 重建 S&P500 | [查證] `$SPX` 每日成員布林序列與目前／退市股價；有效日前開盤生效，排除短暫納入。[未確認] 逐日與指數商完整一致性，不能稱完全官方母體 | [查證] 成分股內容表從 1957-03；Platinum股價／退市1990起，Diamond1950起；[推論] 重建最早時點取成分及股價共同可用區間，仍需實測。末日／完整率未確認 | [查證] `index_constituent_timeseries`＋`price_timeseries`；Platinum US$630/年、Diamond US$787.50/年；非公開 REST／成員清單下載。Windows NDU；同上授權。沒有購買／取樣 | [內容表](https://norgatedata.com/data-content-tables.php)、[FAQ](https://norgatedata.com/data-package-faq.php)、[套餐](https://norgatedata.com/stockmarketpackages.php)、[Python](https://pypi.org/project/norgatedata/) |
| Barchart／交換所 A/D 候選 | [查證] 官方搜尋摘要：NYSE／NYSE Arca／Nasdaq 排除 UIT、封閉基金、權證、優先證券與無SIC分類股；不等於NYSE全部證券，也不是S&P500。[未確認] 完整方法與比例版 | [查證] getMomentum 官方摘要稱 daily advancing/declining/unchanged summary；[未確認] 起訖／歷史功能／完整schema | [查證] 搜尋摘要有 CSV GET/POST 文件；[實測] web工具兩個官方頁都只回3行，沒有可用正文，停止。[未確認] 費用／API額度／授權／CI，不把歷史個別股價下載視為A/D歷史下載 | [getMomentum](https://www.barchart.com/ondemand/api/getMomentum)、[Momentum頁](https://www.barchart.com/stocks/momentum)；本次官方搜尋摘要 |

[查證] Norgate EULA（頁面版本 20260927）允許訂閱期間個人用途的匯出、私有第三方處理，但禁止讓他人存取 Content；訂閱終止後須刪除 Content，符合定義的 Derived Data 可保留。廣度序列是否構成可公開 Derived Data **未確認**，不能逕自認定。憑據：[EULA第2、8、21節](https://norgatedata.com/subscribe/eula.php)。

## 原始取樣證據

### McClellan：文件表格可讀，本機請求未成功

[實測] 2026-09-28，Python 3.14 標準 `urllib.request.urlopen(url, timeout=30)`，無帳號、cookie或額外headers：

```text
GET https://www.mcoscillator.com/market_breadth_data/
HTTP Error 403: Forbidden
```

[實測] 本機沒有成功取得response body；response header未記錄，不補猜。只嘗試一次；未改UA、未繞過封鎖。[未確認] 能否在CI合法穩定取得。

[查證] 同日 web 工具讀到提供者HTML的文字表格，以下是**同一交易日三個指標列**，不是三天歷史，也不是API實測；工具未提供HTTP狀態／response headers：

```text
NYSE: 09/25/2026
          Issues       Volume(000s)
Advances  | 1526 |     | 2472815
Declines  | 1212 |     | 1887337
Difference| 314  |     | 585478
```

憑據：[公開表格](https://www.mcoscillator.com/market_breadth_data/)，web文字行38–42。[推論] 當日1526−1212＝314一致，但不證明歷史完整率或證券納入規則。

### 文件schema與原句（未下載產品資料）

- [查證] StockCharts 定義原句：`AD Percent = (Advances Less Declines) / Total Issues`；文件圖表與範例數字不作市場原始取樣。[AD%文件](https://chartschool.stockcharts.com/table-of-contents/market-indicators/advance-decline-percent)。
- [查證] Norgate API文件：`Date, Open, High, Low, and Close`；成分查詢 `index_constituent_timeseries(symbol, indexname, ...)`。未安裝NDU、未登入，沒有實際資料列。[Python文件](https://pypi.org/project/norgatedata/)。
- [查證] Norgate FAQ關鍵原句：`Temporary inclusions (aka temporary lines) are not included in historical index constituents.` 憑據：[FAQ](https://norgatedata.com/data-package-faq.php)「temporary inclusions」。這個缺口必須列入官方母體差異，不能隱藏。
- [查證] Norgate 免費trial需申請，只給兩年歷史；本輪未申請。[FAQ](https://norgatedata.com/data-package-faq.php)「trial」。
- [實測] Barchart兩次web打開正文失敗，只能使用標為[查證]的官方搜尋摘要；未請求需要key的端點。

## 建議與阻礙

| 方案 | 目前能觀察 | 能回測 | 不能宣稱／先決條件 |
|---|---|---|---|
| 最低可行：保留現有MA廣度；人工核對McClellan／StockCharts直接圖表 | [實測／既有盤點] 現有20/50/200MA比例；[查證] NYSE當日A/D及提供者圖表 | [推論] 既有今日成分股回算只能作明示偏誤的探索；本輪沒有取得足够直接歷史序列供新回測 | [推論] 不能稱官方歷史S&P500 A-D，也不能重現附件訊號；抓取與公開權限尚未成立 |
| 升級A：取得授權的直接歷史A/D | [推論] 優先用McClellan歷史商品核對NYSE；S&P500可先問Norgate直接序列 | [推論] 若A/D原始欄位、母體、缺漏、版本與授權驗收通過，可回測該提供者定義的廣度／McClellan | [未確認] Mc商品是否含原始A/D、Norgate序列起訖與算法；NYSE是大盤proxy，不可改名S&P500 |
| 升級B：PIT成分＋退市股價重建 | [推論] 對S&P500母體、平盤與價格調整能自行固定 | [推論] Norgate是文件最完整的付費重建候選，需抽查加入／移除日、退市與分割事件後再批准回測 | [查證] 短暫納入缺口、Windows依賴與公開授權限制；[推論] 只能称已定義且經驗證的重建序列，不稱指數商原始官方數值 |

[推論] 首選順序：**先確定母體與版本，再驗收直接來源；只有需要可控S&P500口徑時才重建。** 直接來源適合當日觀察及供應商版本的歷史比較；PIT重建適合研究成員變更／不同調整口徑。當前沒有證實免費、可CI下載、可公開再發布且足夠長期的完整方案。憑據：上列候選與實測；不是宣稱所有免費資料皆不存在。

[實測／既有盤點] 現有MA廣度定義與今日名單偏誤依本spec提供的 `scripts/_breadth.py:78`、`scripts/fetch_breadth.py:27`、`index.html:739`，本輪遵守唯讀限制，未重新掃碼。

### 重建前必須固定的口徑

| 決策項 | 已有證據／建議與未決事項 |
|---|---|
| 成分生效日／母體 | [查證] Norgate成員為當日有效、開盤前生效；臨時成分省略。[推論] 每日用當天成員，不用今日清單；記錄公司／證券股類計數與臨時成員差異。[FAQ](https://norgatedata.com/data-package-faq.php) |
| IPO／退市／缺值 | [推論] 無可比較前收盤的新股、停牌缺值須另列，不當成跌或平盤；明示coverage分母／最低coverage，退市股票不得消失。尚未定coverage門檻。[查證] Norgate供退市但早期庫不保證完整。[內容表](https://norgatedata.com/data-content-tables.php) |
| 平盤 | [推論] A、D、U分列，固定價格精度與平盤容差；[查證] RASI分母A+D排除U，StockCharts AD%採Total Issues，兩者不可直接換用。[RASI](https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/)、[AD%](https://chartschool.stockcharts.com/table-of-contents/market-indicators/advance-decline-percent) |
| 拆股／配息 | [查證] Norgate提供raw／capital／capital+special／total return；API預設total return。[推論] 至少固定拆股一致性；配息是否調整須按目標供應商口徑驗收，現有raw close不可直接默認可用。[FAQ](https://norgatedata.com/data-package-faq.php)、[Python](https://pypi.org/project/norgatedata/) |
| EMA／加總初始化 | [查證] 10%／5% Trend對應alpha=0.1／0.05（19／39EMA）。[推論] 固定EMA種子、遞迴精度、A-D line起點與Summation基準；不能靠改常數硬對供應商。[EMA文件](https://www.mcoscillator.com/learning_center/kb/market_data/exponential_moving_averages_calculation/) |
| warmup | [查證] EMA舊值影響逐漸衰減、不在19日硬消失。[推論] 回測期前載入預熱並做種子敏感度驗收；本輪不發明固定warmup天數。[EMA文件](https://www.mcoscillator.com/learning_center/kb/market_data/exponential_moving_averages_calculation/) |
| 中性點／門檻版本 | [查證] McClellan傳統NYSE/Nasdaq Summation中性+1000；RASI中性0，官網RASI另述−500／+500。[推論] −500不能搬到原始、平移、不同母體或不同初始化版本。[中性點](https://www.mcoscillator.com/learning_center/kb/market_data/summation_index_and_zero/)、[RASI](https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/) |

## 尚未確認

- [未確認] 各直接序列的完整首末日、缺值／修訂歷史、NYSE完整證券種類、S&P500臨時股類與生效日一致性。
- [未確認] McClellan US$40檔案實際schema／原始A/D／更新權益；商品起始1960不等於已實測1960全期資料。
- [未確認] StockCharts `$SPXADP` 可合法下載的完整序列、API額度、Total Issues對U與缺值的詳細處理；不可用AD%重建原始A/D而不先取得逐日分母。
- [查證／主session補核] Norgate FAQ「How is market breadth data calculated?」明示指數廣度採PIT成分及Capital reconstructions and special distributions價格調整。[未確認] McClellan原始／調整版本、每條起訖，以及短暫納入對結果的影響。來源：https://norgatedata.com/data-package-faq.php
- [未確認] 公開Vercel前端／GitHub data/*.json的再發布許可；私有雲處理權不等於公開資料權。
- [未確認] 附件／Bluekurtic完整原始算法、母體與條件；本輪不能驗證或聲稱重現。
- [未確認] spec未定義P0／P3／P4各自精確功能邊界，本報告只提供共同資料決策，不另發明需求。

## deviations

- [實測] 無越權檔案修改、購買、安裝、全量回填、commit、push、子代理或產品實作。
- [實測] 候選4個提供者（Norgate分兩路）；web search 1次工具呼叫；URL打開／click 14次＋本機GET 1次＝15次；find只定位已讀頁面，無新增URL；未下載任何office／PDF檔。
- [實測] 成功端點資料取樣0個；McClellan本機GET 403，留下文件中的單日三列，明示非API；Barchart兩次正文失败後停止。故沒有2–3個歷史日期的成功API原始列，本輪可行性結論保留此阻礙。
- [實測] 分支 `main`；未commit；合回不適用。

## 主 session 複核（2026-09-28）

- 已重開Norgate內容表、FAQ、Python文件與EULA。FAQ原有「指數廣度是否PIT」未確認項已更正為文件查證；仍未實際下載序列。
- EULA第8節限制向其他人提供Content；公開JSON再發布權仍不可假定，Derived Data適用性未定。Python依賴Windows NDU已核對。
- McClellan歷史商品頁在主session重開時回工具Internal Error；價格／商品欄位維持子代理文件查證，未提升為主session實測。
