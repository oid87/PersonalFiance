# CNN 恐懼貪婪七分項（`#tab=fgparts`）

## 頁面
情緒與曝險 → 情緒總分 → 「恐懼貪婪七分項」。上格價格（S&P 500 指數／SPY／VOO 切換，均線 50／125／200 或自訂 5–400 日；均線只影響顯示，動能分數固定 125 日），下格 0–100：CNN 實際總分（實線）、本頁估算總分（虛線）、七分項各一顆開關。下方表格是 CNN 今天公布的七項分數與等權平均。

## 資料
`scripts/fetch_fear_greed.py` 除了原本的 `data/fear_greed.json`，同一次呼叫 CNN 免費端點
`production.dataviz.cnn.io/index/fearandgreed/graphdata/<start>` 另寫 `data/fear_greed_components.json`：

| 欄位 | CNN key | 內容 |
|---|---|---|
| sp500 / sp125 | market_momentum_sp500 / _sp125 | S&P 500 與其 125 日均線 |
| strength | stock_price_strength | NYSE 52 週新高減新低 |
| breadth | stock_price_breadth | McClellan 成交量總和指標 |
| put_call | put_call_options | 5 日平均 Put/Call |
| vix / vix50 | market_volatility_vix / _vix_50 | VIX 與其 50 日均線 |
| junk | junk_bond_demand | 垃圾債與投資級殖利率差 |
| safe_haven | safe_haven_demand | 股票與公債 20 日報酬差 |

- 原始讀數歷史：端點最早只接受約 2020-08 起的 start（更早回 500），所以分項歷史從 2020-08-03 開始。七項都抓得到，沒有缺項。
- 分項 0–100 分數：CNN **只給今天**（`score`）。每次抓取把當天快照 append 到 `scores`，之後逐日累積。
- 端點陣列裡每點的 `rating` 跟該分項自己的分數對不上（例：S&P 點標 extreme greed、動能分數卻是 8），所以不存。
- 沒用付費來源。

## 2009–2020-07 回補（`scripts/compute_fear_greed_proxy.py` → `data/fear_greed_proxy.json`）
手動一次性腳本（manifest `manual_research`，不進 fetch.yml）。各讀數用免費資料重建，再對 CNN 重疊期（2020-08 起）做線性校準到 CNN 刻度；前端在 CNN 首日之前用代理、之後用 CNN。圖上灰底標出代理期間。

| 分項 | 代理 | 原值相關 | 126 日 z 相關 |
|---|---|---|---|
| 動能 | ^GSPC 與 125MA（同定義） | 1.000 | — |
| 波動度 | VIX 與 50MA（同定義） | 1.000 | — |
| Put/Call | Cboe 股票 P/C 5 日平均（putcall.json） | 0.999 | — |
| 避險需求 | SPY 減 IEF 20 日總報酬 | 0.959 | 0.96 |
| 垃圾債 | HYG 減 LQD 近 12 月配息殖利率 | 0.985 | 0.80 |
| 股價強度 | 現有 S&P 500 成分股（52 週新高−新低）/n，20 日平均 | 0.898 | 0.85 |
| 股價廣度 | 現有成分股漲跌量 McClellan Summation | 0.823 | 0.70 |

驗證：重建總分對 CNN 實際總分，2011-01～2020-07（全為代理）2389 日相關 0.93、平均差 7.1 分；2020-08 起相關 0.95、平均差 5.6 分。
不可得：FRED 的 ICE BofA 利差只開放近 3 年、本機連不上 FRED，所以垃圾債改用 ETF 配息殖利率；NYSE 全市場新高新低與上漲／下跌量沒有免費長歷史，強度與廣度改用現有 S&P 500 成分股（有存活者偏差，越早越大）。CNN 總分本身仍只有 2011 起。

## 合成方式
CNN 公開說明：七項各自依「目前讀數偏離平均多少、相對平常波動」換成 0–100，再**等權平均**。驗證：2026-11-06 七項分數平均 22.1、CNN 公布 22.0（另一次快照 23.7 vs 24.1），差距在取值時間與捨入範圍內。

CNN 未公開精確視窗，本頁重建（`js/tabs/fgparts_calc.mjs`）：
1. 方向對齊：動能用 S&P/125MA−1，VIX 用 1−VIX/50MA，Put/Call 與垃圾債利差取負號，其他照原值（越大越貪婪）。
2. 近 126 交易日 z 分數（少於 63 筆不算）→ 標準常態累積機率 ×100。
3. 七項等權平均；任一項缺值該日不算。

選 126 日的依據（2020-09 起對 CNN 實際總分，1512 交易日）：

| 視窗 | z→CDF 相關 / 平均差 | 百分位 相關 / 平均差 |
|---|---|---|
| 63 | 0.876 / 8.2 | 0.864 / 8.6 |
| **126** | **0.953 / 5.7** | 0.951 / 5.8 |
| 252 | 0.905 / 7.6 | 0.921 / 6.9 |
| 504 | 0.834 / 10.2 | 0.853 / 9.4 |

## 限制
- 分項曲線是近似值；單項與 CNN 今天的分數可差 10–25 分（例：垃圾債需求估 61、CNN 36），總分較準。
- 2020-08 前的分項是代理讀數（見上），廣度最不準。
- 測試：`node --test js/tabs/fgparts_calc.test.mjs`（含「估算總分與 CNN 相關 > 0.9」及「七項平均≈公布總分」兩項資料檢查）。
