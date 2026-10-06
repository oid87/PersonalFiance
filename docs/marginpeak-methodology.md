# 融資峰值：歷史中位報酬與樣本數

本頁是描述性、事後事件研究；「基準中位報酬」是價格報酬的中位數，**不是上漲機率**，亦不是可成交策略績效。

## 固定參考版本

`marginpeak-monthly-raw-v1` 的 anchor window 固定為 **1999-04～2025-06**，含首尾315個候選月份，不自動滾動。沿用既有標稱研究範圍以建立可重現 reference；沒有宣稱該期間經過最佳化。2025-06是 anchor月份截止，**不是價格資料截止**：12m結果可以使用後續價格。

資料為現有 `data/SP500.json`（^GSPC，UI標SPX）、`data/QQQ.json` 的原始 `close`，及 `data/liquidity.json.margin`。價格報酬不包含股息，未改成 adjusted／total return。價格檔更新或修訂可能改變重算結果；固定的是 anchor window和方法，不是永久鎖死的數值。UI另顯示實際價格最後日期。

各候選月份取**月底以前最後一筆可用價格**為 anchor，包括月底當日；休市使用 prior observation。1m／3m／6m／12m分別為 anchor index **+21／+63／+126／+252 個價格觀測**，不是 calendar-month return。不補交易日、不去重、不新增最大anchor距離。

報酬為 `(P_future/P_anchor−1)×100`；沿用JS `toFixed(2)`轉回數字後聚合中位數。偶數樣本取兩個中心值平均，中位数本身不另round2，UI显示1位。零報酬顯示+0.0%，不代表胜率定義。

## 分開解讀 n

**基準 n**：每個資產／horizon分別計算，無anchor或future index超尾的null結果不纳入该栏。不要求共同月份、不補值或推估。目前2026-09-30資料可重現SPX各315、QQQ各306；QQQ從2000-01開始，1999-04～12九個候選月缺anchor。這不是把315個候選月當成每欄分母。

**事件 n**：A／B每欄獨立計算非nullish報酬數。事件使用可用融資歷史，**不限制在基準窗口**。事件和基準分母不同，且事件或forward periods可能重疊，n不代表獨立實驗數。

**事件研究每個t的 n**：在hover顯示當個相對價格觀測的貢獻路徑數，並以連續區間文字揭露所有t（含ECharts可能不顯示tooltip的全缺值尾段）。路徑只需可建立t=0，未要求完整252筆；右尾不足保留短路徑並減少後續n，n=0的統計是N/A。曲線為rebase100後的Mean、p25、p75，不是中位報酬；統計算法與人口未變。

## 事件定義與可見資訊

YoY沿用 `(debit[i]/debit[i−12]−1)×100`，略過nullish debit。資料按月份有序是既有假設，沒有改成日期join。

- A：YoY嚴格>50%，首個符合者入選，其後與上個已選事件嚴格相隔>365曆日才入選。這不是前月≤50、本月>50的crossing；連續高位仍可能再入選。
- B：YoY嚴格>30%，且等於前後各6筆YoY觀測的最高值。左邊界clip到序列開頭，右側需有6筆後續觀測。同值峰值均可入選，沒有另做冷卻／去重。

B是 **retrospective／ex-post**：需要未來6個YoY observations才能辨識。連續月資料約6個月；缺月後的有效觀測窗口可能更長。實際當時可用時間取決於資料發布，來源没有逐筆發布日或歷史vintage，不能偽造可交易確認日。anchor維持**峰值月月底**，不移到confirmation month，不能描述成峰值月當時可交易訊號。A亦未建立發布時序／成交回測。

## 邊界與驗證

本次不新增price validity／positive filters，不改既有null／zero／negative算術、不改事件偵測與其他金融公式。n沿用原本排除null／undefined的規則；不是新增finite檢查。原始close欄的NaN、零anchor或malformed等異常政策尚未另定，若需改其金融處理，必須先產品決策。

固定測試入口：`node --test js/__tests__/marginpeak_transparency.test.mjs`；fixture在 `js/__tests__/fixtures/marginpeak-transparency.json`。獨立linear-search oracle檢查anchor、每欄分母、觀測offset與不足horizon；browser入口 `node scripts/test_marginpeak_browser.cjs --output <新的目錄>`，使用既有Playwright／Chromium、loopback及ECharts CDN，不下載市場資料。完整回歸仍用 `python3 scripts/run_checks.py`、`npm test`、`npm run test:browser`。
