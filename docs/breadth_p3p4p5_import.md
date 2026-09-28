# P3／P4／P5 匯入與 Claude 複核說明

## 目前資料邊界
本功能是本機 JSON 匯入與事件研究工具。專案尚未接入可驗證的 S&P 500／NYSE 每日 A/D 真實歷史；不代表已驗證附件的事件、報酬或勝率。測試用合成資料不提供市場結論。

入口：流動性 → 市場廣度 → A-D／McClellan 聯合研究。此區固定使用匯入檔內的 **S&P 500 指數價格**，不跟隨上方 SPY／QQQ／XLG／0050 切換。

資料只留在瀏覽器記憶體，不上傳、不寫 localStorage、不送第三方。重新整理即清除。匯入錯誤會清除這一區的舊結果。上方 P1／P2 不受影響。

## JSON 格式
只接受 JSON（不是供應商原生格式）。最大10 MiB、最多20000個 benchmark 日期。以下只是欄位格式範例，**不是可用市場資料**；實際 data 必須加入真實資料列。

```json
{
  "schemaVersion": 1,
  "benchmark": {
    "symbol": "SP500",
    "source": "請填價格來源",
    "priceBasis": "請填原始/拆股調整/含息等價格口徑",
    "data": []
  },
  "sp500": {
    "universe": "SP500",
    "source": "請填S&P500 A/D來源",
    "constituentsBasis": "請填逐日歷史成分或其他明確口徑",
    "priceBasis": "請填上漲/下跌判定的價格調整方式",
    "data": []
  },
  "nyse": {
    "universe": "NYSE",
    "source": "請填NYSE A/D來源",
    "constituentsBasis": "請填包含哪些證券種類",
    "priceBasis": "請填漲跌比較口徑",
    "variant": "ratio",
    "seed": null,
    "data": []
  }
}
```

benchmark.data 每列為 `{ "date": "YYYY-MM-DD", "close": 正數或null }`。sp500.data 與 nyse.data 每列為 `{ "date": "YYYY-MM-DD", "advances": 非負整數, "declines": 非負整數, "unchanged": 非負整數 }`。整列缺資料使用三個 counts 全為 null，不可把缺資料寫成0。計數總和必須大於0。

至少提供 sp500／nyse 其中一組；兩組齊備才能做聯合研究。所有列日期必須嚴格遞增、不重複，A/D 日期必須包含在 benchmark 日期軸。原始交易所的完整交易日曆沒有內建：若匯入者漏掉整個 benchmark 日期，系統無法自行發現。提供者名稱、母體與校準狀態均是匯入者的聲明，並非本程式完成外部查證。 各A/D序列第一列以前的benchmark日期不計為缺值；第一列即使是全null仍算序列已開始。開始日起到benchmark末日的真正缺列／null照常計數；NYSE ratio全平盤造成分母0也算缺值。未提供或空序列缺值數為0，不代表已有可用資料。

## 校準與缺資料
`nyse.variant` 只能是 `raw` 或 `ratio`。raw 使用 A−D；ratio 使用 1000×(A−D)/(A+D)，不把平盤家數放進分母。兩版數值尺度不同，不能混用历史。

可選 seed：
```json
{
  "date": "匯入NYSE首日前一有效交易日，格式YYYY-MM-DD",
  "ema19": 供應者當日10%Trend,
  "ema39": 供應者當日5%Trend,
  "summation": 同版本且已校準的當日Summation,
  "source": "該seed的來源與校準依據",
  "calibration": "provider"
}
```
上方是欄位說明，數值欄位需填真正JSON number。seed日期必須早於NYSE第一列；匯入者須確保中間沒有漏掉NYSE交易日。系統無法單憑seed聲明確認數值準確或與供應者一致。

沒有seed仍可看本機初始化的震盪及累加圖，但 **P4門檻事件與P5聯合研究停用**。原因是任意把Summation從0起算，會改變−500穿越日期；多跑幾天EMA不能消除Summation的任意常數差。

有seed也要求252筆連續NYSE觀測預熱，且P4事件前再有252個有效session的門檻檢查。NYSE已開始後遇到缺列、全null或ratio的A+D=0，從該日停止後續McClellan計算；補齊後重新匯入。A/D累積線則在缺口後另開segment，重新累积，200MA及一年條件重新等候完整資料。圖表不跨缺口連線。

## 本專案固定規則
- **P3**：S&P500 A/D線＝逐日累加A−D；200MA取完整200個同段觀測。今天線低於200MA，且前252個連續benchmark sessions每天嚴格高於200MA，才觸發。相等不算高於。
- **P4**：EMA19 alpha=.1、EMA39 alpha=.05；Oscillator＝EMA19−EMA39；Summation逐日加Oscillator。今天低於−500，之前252個已校準且預熱完成sessions都≥−500，才觸發。raw／ratio各自研究，不宣稱與附件版本一致。
- **P5**：上述兩個原始事件相隔至多5個benchmark sessions，於較晚事件當日觸發；同日可觸發，不能回填較早日期。這是本專案自訂的聯合條件，不是Bluekurtic已驗證條件，也不要求較晚日兩個指標仍同時在門檻下。
- 每類事件各自先全史20-session冷卻，再套事件日期範圍；7期為5／10／21／42／63／126／252 sessions。研究日期範圍不截斷已觀察到的後續價格。
- 基準使用同種訊號所需資料皆可判定的日期，未用門檻條件篩選基準。P5基準要求當日及前5sessions均可判定兩種單訊號。
- 報酬由訊號日收盤起算，屬描述性價格研究，不含股利再投資、成本或可成交進場假設。訊號日起最大虧損與期間峰谷最大回撤分開計算。
- 每個期限獨立列有效n；未完成與中間缺價格分別排除；基準也套相同完整窗口规则。重疊事件並不獨立。路徑分位帶固定使用該期限完整樣本，個別路徑遇缺價即停止。

## 一手方法來源
- [McClellan 計算說明](https://www.mcoscillator.com/learning_center/kb/market_data/Calculating_the_McClellan_Oscillator/)：EMA差與逐日加總。
- [比例調整版本](https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/)：A+D分母與1000倍尺度。
- [中性基準差異](https://www.mcoscillator.com/learning_center/kb/market_data/summation_index_and_zero/)：傳統NYSE中性+1000，ratio中性0。
- [EMA遞迴](https://www.mcoscillator.com/learning_center/kb/market_data/exponential_moving_averages_calculation/)：.1/.05係數與歷史影響衰減。

## 交給Claude的複核重點
1. 檢查 `docs/breadth_p3p4p5_spec.md` 與實際API/實作，不只讀PASS字樣。
2. 重跑驗收報告中的可重現命令；Python oracle與JS使用同一測試輸入、独立計算。
3. 特別核對一年252session邊界、−500相等、joint 5/6邊界、較晚確認日期與全史冷卻。
4. 確認無seed/缺NYSE/全平盤ratio不會產生虛構事件；metadata不被當作已驗證真實來源。
5. 查匯入失敗與快速連續操作後不殘留舊結果，P1/P2仍過回歸。
6. 真實資料來源／校準／逐日成分與交易日完整性須另行驗收；目前軟體PASS不等於投資結論PASS。

## 專案自算 S&P500 A/D

按「載入專案自算 S&P500 A/D」讀取 `data/sp500_ad.json` 與 `data/SP500.json`；首次 CI 產出前會顯示載入失敗。只支援 P3，P4／P5 仍需匯入 NYSE 資料。

⚠ 自算：現任成分股、非 point-in-time，含倖存者偏誤，可能影響 A-D 線與事件日期；僅供描述性參考。

自算使用 Wikipedia 執行當下的成分股與 yfinance 調整後收盤，比較相鄰交易日；缺任一天有效正價格便不計，平盤容差為前收的 1e-9。近 14 天不足 480 家不寫入，早期分母可能較低。首次從 2015-12-01 全量下載；之後每次重算末列日期前 45 天，新列覆蓋舊列，歷史列可能混合不同執行時的成分快照。指數 benchmark 使用原始收盤；A/D 不在指數交易日軸上的日期丟棄並顯示數量，不補值。

資料每日由 GitHub Actions 更新；下載或計算失敗保留原檔。面板按下按鈕才抓資料，載入結果只保留在記憶體。
