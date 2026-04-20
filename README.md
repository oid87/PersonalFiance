# PersonalFiance

個人投資查詢工具 — 抓取 ETF / 指數 / 市場情緒的歷史資料，並以線圖呈現趨勢。

長期願景：類似 [財經 M 平方](https://www.macromicro.me/) 的個人版總經儀表板。

## 追蹤標的

| 類別 | 代號 | 起始日 | 備註 |
|------|------|--------|------|
| 台股 ETF | 0050.TW | 2003-06-30 | 元大台灣 50 |
| 美股 ETF | VOO | 2010-09-09 | Vanguard S&P 500 |
| 美股 ETF | QQQ | 2000-01-01 | Invesco QQQ (Nasdaq-100) |
| 美股 ETF | SPY | 2000-01-01 | SPDR S&P 500 |
| 波動率 | ^VIX | 2000-01-01 | CBOE VIX |
| 情緒指標 | CNN Fear & Greed | 2011-01-03 | 0 = 極度恐懼 / 100 = 極度貪婪 |

> 價格皆為**原始收盤價**（未做股息/分割調整）。
> Fear & Greed 歷史只到 2011（CNN 指標誕生年），這是資料源限制。

## 更新頻率

GitHub Actions cron：**台灣時間 週二 ~ 週六 05:00**（= UTC Mon–Fri 21:00）。
對應美股前一交易日收盤後、0050 前一交易日已完結。

## 本地執行

```bash
pip install -r scripts/requirements.txt
python scripts/fetch_stocks.py
python scripts/fetch_fear_greed.py
```

產物：`data/{0050.TW,VOO,QQQ,SPY,VIX,fear_greed}.json`

## 資料格式

### 股價 / 指數
```json
{
  "symbol": "VOO",
  "updated": "2026-04-20",
  "data": [
    { "date": "2010-09-09", "open": 103.4, "high": 104.1,
      "low": 103.0, "close": 103.8, "volume": 12345 }
  ]
}
```

### Fear & Greed
```json
{
  "source":  "CNN (via whit3rabbit/fear-greed-data + live CNN endpoint)",
  "updated": "2026-04-20",
  "data": [
    { "date": "2024-01-02", "value": 65.4, "rating": "greed" }
  ]
}
```

## 資料來源

- 股價 / 指數：[yfinance](https://github.com/ranaroussi/yfinance)
- Fear & Greed 歷史：[whit3rabbit/fear-greed-data](https://github.com/whit3rabbit/fear-greed-data)
- Fear & Greed 每日：CNN production endpoint

## Roadmap

- [x] 資料管線（daily fetch + commit）
- [x] 趨勢線圖（多指標疊加、時間區間切換）
- [ ] 5/20/50/100/200 MA 與 10 條自訂線（週期 + 顏色）
- [ ] 樂活五線譜（週均線 ±1σ / ±2σ）
- [ ] 殖利率 / 本益比 / 總經指標
