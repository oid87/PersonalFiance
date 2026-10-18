# 美股風險／去槓桿觀察：產品結論與六題分析

審查日：2026-10-18。研究分支 `research/us-risk-observer`；base `8008803b`。本文件先定產品與方法，再接線頁面；完整需求與逐字文案見 [requirements](us-risk-requirements.md)。

## 結論（五點）

1. **有證據支持**：定位為日頻風險監控、週月背景／滯後確認與描述性事件研究。使用者提供的小樣本未證實領先低點，不能升格為買入／加槓桿流程。本次沒有獨立重現舊研究的命中率、相關係數或2026/7個案數字。
2. **有證據支持**：CFTC 是特定市場與交易者分類的持倉；NFCI 是金融條件；FINRA 是月頻帳戶借款總額。三者不能換算全市場融資維持率，也無法直接辨認被迫平倉。
3. **僅是假設**：VXN、QQQ/SPY、SOXX/QQQ 可補充 Nasdaq／半導體集中壓力的觀察範圍。這不等於已證明預警或超額績效；門檻全是研究假設。
4. **需要先補資料**：逐期公開時間、日頻／週月 vintage、當時成分股，以及公開再散布許可。首次匯入只證明匯入時可得，不填造歷史時間。
5. **有證據支持**：本 repo 已有多數資料，應沿用 ECharts、ES modules 與每日 JSON。雙口徑必須分開：預設嚴格已觀測版本；另提供標示非 PIT 的日頻歷史重建。缺資料顯示 unavailable。

## 1. 頁面定位

**有證據支持**：不用「美股融資維持率」或「底部清洗完成」作標題。使用者研究的反例與官方指標定義均不支持此語意。首頁各卡並列已發生回撤、波動、相對價格與資料日期，不合成未驗證的紅綠燈分數。

**有證據支持**：警報只代表所選條件出現；事件結果以隔日開盤後5/10/20/60個資產交易日觀察，沒有下單、部位或槓桿加碼接口。

**需要先補資料**：不直接以舊研究「近底命中」比例驅動 UI。舊報告的 FINRA 估計發布日、最新版 NFCI、當前成分股廣度均未達嚴格歷史可得標準。

## 2. 指標放哪裡

| 指標 | 產品位置／理由 | 結論層級 |
|---|---|---|
| SPY/QQQ回撤、VIX/VXN、VIX/VIX3M | 主畫面；價格與隱含波動的不同面向。比值為兩個指數的同日配對，不是 VIX 期貨期限結構 | 有證據支持 |
| QQQ/SPY、SOXX/QQQ 20日比值變動 | 主畫面觀察；受產業權重／估值／個股權重等影響。QQQ 不等於純科技指數 | 僅是假設（效用） |
| NDX >50MA | 背景卡，列每窗口有效分母；現有資料為現今成分股回填與混合版本，歷史回測停用 | 有證據支持（限制） |
| CFTC | 週背景與多／空／合計張數圖、轉倉標記；S&P/Nasdaq 是 consolidated code，不是單一 ES/NQ 規格。long+short 未含 spreading，不跨商品加總成美元 | 有證據支持 |
| NFCI risk/credit/leverage | 週背景與修訂警語；沒有 vintage 時不能拿最新版回填過去確認 | 有證據支持 |
| FINRA | 月背景與借款餘額確認；第三方鏡站不是官方 feed，無逐月發布時間，不假設月底+25日 | 有證據支持 |
| HY OAS、CNN F&G | 來源表明示 unavailable；前者公開再散布明確受限，後者未確認授權。信用背景只用明示 HYG/LQD 價格代理，不把它接成 OAS | 需要先補資料／授權 |
| RSP/SPY、SOXX/SMH、槓桿ETF flows | 研究備選；現有 repo 缺RSP/SMH，flows缺經核實的免費歷史與再散布權利，不建立假序列 | 需要先補資料 |

## 3. 科技集中回撤的替代觀察：來源、授權、延遲、歷史

下表把「可免費讀取」與「可公開再散布」分開。檢查只讀取公開頁面／既有檔；未付費、未繞過保護、未新增資料抓取依賴。既有 Yahoo 個人用途資料的公開再散布權利仍未確認，本 PR 沿用既有資料架構，不宣稱已取得開放授權；發布者須處理此限制。新檔不複製明確受限的 ICE OAS 或未確認的 CNN 資料。

| 候選 | 真實來源／本次可得性 | 延遲與歷史 | 授權／本次決定 | 層級 |
|---|---|---|---|---|
| VXN | [Cboe VXN](https://www.cboe.com/us/indices/dashboard/VXN/)、[CSV](https://cdn.cboe.com/api/global/us_indices/daily_prices/VXN_History.csv)；本次HTTP200，DATE/OHLC，首列2009-09-14。repo既有Yahoo VXN首列2001-01-23、末列2026-10-15 | 日收盤；不能保證當日特定時刻上架。兩來源歷史起點不同 | Cboe保留版權，免費下載不是公開轉授權。沿用既有VXN，不另切資料源 | 有證據支持（可得性）；僅是假設（預警效果） |
| VIX/VIX3M | [Cboe歷史頁](https://www.cboe.com/tradable-products/vix/vix-historical-data)、[VIX3M CSV](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX3M_History.csv)；CSV HTTP200，首列2009-09-18 | 日收盤；VIX官方1990起。repo VIX3M配對缺日則unavailable，不前填 | [Cboe內容條款](https://www.cboe.com/terms)；來源保留權利，非開放授權聲明 | 有證據支持（定義）；僅是假設（門檻） |
| NDX成分股廣度 | repo `fetch_breadth_ndx.py`／`_breadth.py`；[Nasdaq GIW](https://www.nasdaqtrader.com/Trader.aspx?id=realtimeindexes)、[治理來源](https://indexes.nasdaq.com/Governance) | 既有2019-12-09起；日收盤後批次計算，有缺價與分母差異。尚無免費可靠PIT歷史成分股接入 | 官方GIW有授權產品；沒有查證可免費取得／再散布完整歷史成員。現有回填僅背景，回測停用 | 需要先補資料 |
| QQQ/SPY | repo既有 `QQQ.json`／`SPY.json`；[yfinance文件](https://ranaroussi.github.io/yfinance/)、[Yahoo條款入口（本次直連未成功，以yfinance所連官方條款再確認）](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html) | 既有兩者2000起、每日批次；20交易日比值變動，同日配對。原始價格非總報酬 | yfinance聲明Yahoo資料供個人用途；套件開源不代表資料可自由再散布。沿用既有個人研究檔 | 有證據支持（可計算）；僅是假設（辨識力） |
| SOXX/QQQ、SOXX/SMH | repo既有SOXX；[iShares SOXX](https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf)、[VanEck SMH](https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/) | repo SOXX 2001起；SMH缺檔。需檢查分割、配息、指數成員與權重。SOXX/SMH是兩個半導體組合差異，不能直接當科技整體壓力 | 發行商頁可查基金資訊，不代表免費完整OHLC歷史API與再散布許可；本次只啟用已有SOXX/QQQ | 僅是假設；SMH需要先補資料 |
| RSP/SPY | [Invesco RSP](https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=RSP)；RSP本repo無檔 | 等權／市值權比值可反映領導集中，但受產業再平衡影響；未實抓並驗證完整日價歷史 | 免費網頁不保證歷史API與授權；顯示unavailable，不推測資料覆蓋 | 需要先補資料 |
| HY OAS | [FRED BAMLH0A0HYM2](https://fred.stlouisfed.org/series/BAMLH0A0HYM2) | 日收盤，官方頁2026-10-15觀測於10/16更新；2026-04起只供最近3年。repo目前2023-06-27起，不能說完整1996起可用 | ICE明示internal use only，公開分送須事先書面同意；本次不複製／發佈OAS。HYG/LQD另標價格代理，無單位接續 | 有證據支持（限制）；需要先補授權 |
| 槓桿ETF flows | [ProShares TQQQ](https://www.proshares.com/our-etfs/leveraged-and-inverse/tqqq)，本次公開頁HTTP200 | 有基金資訊，但未驗證免費穩定、完整逐日發行股數／申贖歷史。不能以成交量代替flows，也不能把AUM變動直接當淨流入 | flows估計需NAV與分割調整的shares outstanding，且許可仍待確認。僅列研究備選 | 需要先補資料 |

**僅是假設**：2026/7類型可以用相對壓力、VXN與廣度擴大「看見風險」的範圍；沒有獨立驗證它們能更早辨識低點。不能把使用者提供的單一反例當作選參數的樣本外證據。

## 4. 可調參數與防止誤讀

**有證據支持**：原生下拉選單、各控制項ⓘ、變更即重算，預設QQQ／嚴格版本／VIX≥30／回撤8%／10日冷卻／20日視窗。數字30與8%只是明示研究假設，不宣稱已最適化。逐字文案由 `usrisk_controls.mjs` 匯出。

**有證據支持**：固定顯示可評估日、條件日、冷卻事件、完整N、右設限與壞價、三種共同可得性基準、報酬中位與分布、最大虧損、收盤峰谷回撤、再破警報日低點比例。10日冷卻與60日outcomes會重疊，因此另列視窗不重疊子樣本及逐筆報酬。

**有證據支持**：事件表並列警報日、最早隔日開盤、當時實際取得的週月版本與首次事後資料。首次匯入的舊週月值不回填到歷史警報。圖表使用最新背景版本時必須標明，不能和嚴格統計混為一談。

**僅是假設**：事後8%→3%波段及「波段外事件」作漏報／誤報描述。它不是低點預測的ground truth；需對波段規則做敏感度研究。缺覆蓋／未結束波段不放進漏報分母。

## 5. 納入正式原型ETF加碼流程前的優先工作

1. **需要先補資料（P0）**：積累不可變實際觀測版本；可核實發布時間；NFCI ALFRED／原始版本與FINRA逐月已知上界。先取得合法使用與發布範圍；目前模式不能作正式策略驗證。
2. **需要先補資料（P0）**：OHLC內部一致性、交易日完整性、分割／股息口徑、全期間缺值表、版本修訂敏感度。repo SPY 2026-10-16有open>high，本頁排除相關outcome，沒有改共享價格。交易日軸採SPY與QQQ供給日期聯集，任一標的缺整列仍保留該session為不可用；若兩者同缺一個交易日，目前仍須外部交易所日曆才能識別。
3. **需要先補資料（P1）**：歷史當時成分股與分母，不能用今日存活者回填；CFTC合約規模與spreading、正確發布中斷紀錄。官方週五排程不是永不例外的公式。
4. **僅是假設（P1方法）**：預先固定一小組假設、訓練／樣本外時間切分，測相對簡單VIX與回撤匹配基準的增量；以波段或時間區塊評估，不把每日數量當獨立N；登錄所有試過參數，控制多重測試。
5. **需要先補資料（P2）**：較長年份／其他危機、成本、滑價、開盤跳空、可交易ETF價格與個人風險容量；前瞻觀察與失效條件達標後，另案審查正式流程。本次不自動升格。

## 6. 方法盲點與過度推論

- **有證據支持**：使用者提供的個位數波段與相關事件不足以做穩健因果判斷。「尚未證實有效」也不等於證明永遠無效。
- **有證據支持**：公布日推估、修訂後NFCI、現今成分股、試到好看為止、同源VIX/F&G、換倉機械收縮會扭曲評估；本頁排除／揭露，沒有用缺失值補零。
- **有證據支持**：較晚警報的後續回撤較小，可能純為起算點移動。比較必須固定可得性、期間與基準；不能宣稱多層確認更安全或更準。
- **有證據支持**：持倉張數收縮不等於名目曝險下降；多空持倉、hedge/basis trade與分類都會影響解讀。單一方向合計不代表整個金融體系。
- **僅是假設**：120日高點與8/3%波段規則、門檻、20日相對強弱窗口可能影響所有結論；需預先指定並做敏感度。研究UI讓參數透明，不替代驗證。

官方頻率參考：[CFTC排程](https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm)、[Chicago Fed NFCI](https://www.chicagofed.org/research/data/nfci/current-data)、[FINRA](https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics)。CFTC通常週二→週五美東15:30；NFCI通常週三；FINRA通常次月第三週。實際個別發布時間仍不可用公式代替，本頁只用已觀測時間作保守可得門檻。

公開發布限制：Cboe網站條款亦限制個人非商業用途外的複製、展示與分發；既有Yahoo／Cboe相關資料的公開使用權利並未因本PR而解決。本PR供研究審查，不等於完成正式對外資料授權；主分支與部署保持不變。
