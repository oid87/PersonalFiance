# 台灣觀察表：來源與方法

[研究工具](../../tools.html#taiwan) 並列各來源自己的最新觀察。每日資料與月頻貨幣
資料可以有不同日期；不做同步日對齊、插值或月資料向前填補。
畫面「原值」保留檔案数值；檔案更新是儲存／收集標記，不是發布日、資料月份或即時性保證。

| 指標 | 既有快照／producer | 頻率、單位與範圍 |
| --- | --- | --- |
| 加權指數 | [TWII.json](../../data/TWII.json)／[fetch_stocks.py](../../scripts/fetch_stocks.py) | Yahoo/yfinance `^TWII` 原始收盤，日觀察、指數點；非直接交易所認證序列 |
| 融資維持率代理 | [taiwan_margin_ratio.json](../../data/taiwan_margin_ratio.json)／[fetch_taiwan_margin_ratio.py](../../scripts/fetch_taiwan_margin_ratio.py) | 日觀察、%；TWSE 上市融資多頭，含配對 ETF，Σ(融資張×收盤×1000)／上市融資金額×100 |
| 上市融資餘額 | [taiwan_margin_total.json](../../data/taiwan_margin_total.json)／[fetch_taiwan_margin_total.py](../../scripts/fetch_taiwan_margin_total.py) | FinMind `TaiwanStockTotalMarginPurchaseShortSale`，日觀察、新臺幣億元；不含上櫃融資金額 |
| M1B 年增率、M2 年增率 | [taiwan_money_supply.json](../../data/taiwan_money_supply.json)／[fetch_taiwan_money_supply.py](../../scripts/fetch_taiwan_money_supply.py) | CBC 月頻**期底**、%；不是日平均。檔案月份以當月第一日標記，畫面只顯示 YYYY-MM，非第一日發布 |
| M1B − M2 年增率差 | 同一貨幣快照 `spread` | 百分點；直接讀取已存值並核對同月兩年增率，容許 producer 的三位小數儲存精度。缺值不自行重算 |

M1B／M2 年增率及 **M1B − M2** 差值方向已由使用者確認。它不同於 M2−M1B
貨幣金額差，也不以 M1A 替換 M1B。官方 M1A／M1B／M2 定義、期底／日平均與月頻
發布契約見[官方統計資料說明](https://www.stat.gov.tw/News_NoticeCalendar_Content_temp.aspx?MetaI_D=211&n=3717)。

## 官方／代理與未接入來源

這個維持率是**上市融資多頭重建代理**，沒有上櫃融資金額、融券或整戶追加擔保品，
不能稱為官方整戶維持率或精確 MacroMicro 複製。MacroMicro chart 53117 的
87821（官方整戶）和 91339（新版上市＋上櫃融資多頭擔保品／融資金額）是不同口徑；
此區分來自 owner 本次來源核對，兩者目前均未接入本工具。
既有 manual `taiwan_margin_ratio_mm.json` 不拿來替代或補值；本表只讀 daily proxy。
上櫃 `tpex_margin.json` 的融資金額／維持率為 null，也不以張數推算缺失金額。

## 缺值與重試

- 一個來源失敗只影響其列；其餘可用觀察繼續顯示。所有四個請求均為同站既有 JSON，沒有即時供應商查詢。
- 最新觀察的 null、未提供及非有限數值分別明示；不默默退回舊的有效數值。
- 日期無效、重複或貨幣月頻標記不合約時，來源不可用。空 monthly 不以 annual 或 latest 摘要替代。
- 已存差值與兩個同月年增率不一致時，差值不可用；有效的 M1B／M2 仍顯示。
- 「重新讀取台灣觀察快照」重新讀本地檔；取消、較晚完成的舊請求與頁面離開不能覆盖目前結果。

本表沒有分數、−30 門檻、2× 指數壓力推算、加速度或清槓桿完成判定。
MA125／150仍是使用者另外的交易框架。比率下降可能來自擔保品價格與組成變動；
融資金額收縮也不能辨識強制平倉或證明已完成去槓桿。
來源／驗證深契約見 [source contracts](../source-contracts.md)。
