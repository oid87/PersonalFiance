# CLAUDE.md — PersonalFiance

個人總經儀表板（長期願景：個人版財經 M 平方）。純前端 SPA：`index.html` + ES module `js/tabs/*.js` + ECharts (CDN)，無建置步驟。資料是 `data/*.json`，由 `scripts/fetch_*.py`（Python + yfinance/requests）抓取。本地用 VS Code Live Server 或 `python -m http.server` 開 `index.html`。

## 資料更新管線（每天自動）

GitHub Actions `.github/workflows/fetch.yml` 每天自動跑、跑完 `git add data/` → commit → push：

- **06:00 台北（週二–週六）** — cron `0 22 * * 1-5`（美股收盤後）
- **18:00 台北（週一–週五）** — cron `0 10 * * 1-5`（台股收盤後）
- 也可手動 `workflow_dispatch`，或本地跑 `scripts/update_all.sh`（git pull → 所有 fetch → commit/push）。

每個 fetch 腳本：讀現有 `data/<x>.json` → 抓最新 → **idempotent 合併**（依日期，新蓋舊）→ 寫回。**新增資料來源時務必三處都加**：寫 `fetch_*.py` →加進 `fetch.yml`（用 `continue-on-error: true`）→加進 `update_all.sh`。

### 資料檔 → 來源腳本 → 是否自動更新

| 檔案 | 腳本 | 自動更新 |
|------|------|---------|
| `{TICKER}.json`（SPY/QQQ/VIX/0050.TW/**SP500**/GLD/sector ETF…） | `fetch_stocks.py` (yfinance) | ✅ 每日 |
| `fear_greed.json` | `fetch_fear_greed.py` | ✅ |
| `aaii.json`（AAII 散戶調查週資料） | `fetch_aaii.py` | ✅ |
| yields / cape / *_valuation / sp500_pe / earnings / taiwan_money/margin/investors/pmi | 各對應 `fetch_*.py` | ✅ |
| `taiwan_pcratio.json`（台指選擇權 P/C，TAIFEX 2005+） | `fetch_taiwan_pcratio.py` | ✅ |
| `taiwan_fut_inst.json`（台指期三大法人/散戶多空，FinMind 2018+） | `fetch_taiwan_fut_inst.py` †| ✅ |
| `taiwan_margin_total.json`（大盤融資餘額，FinMind 2008+） | `fetch_taiwan_margin_total.py` †| ✅ |
| `taiwan_sentiment.json`（台股恐懼貪婪複合指數） | `compute_taiwan_sentiment.py`（讀上面4檔算） | ✅ |
| `taiwan_sector_index.json`（台股 19 產業指數收盤，TWSE 2023+） | `fetch_taiwan_sector_index.py` | ✅ |
| **`VIX_early.json`** | （無腳本，**靜態**） | ❌ 1986–1999 歷史，永不變，**必須保留在 repo，別刪** |

† FinMind 來源的腳本需 token：CI 用 GitHub secret `FINMIND_TOKEN`（workflow step 已設 env），本地讀 repo 根 `.finmind_token` 或 `../Financial_work/.finmind_token`。沒設則匿名（低額度，單次每日呼叫通常仍可）。

> 部署：Vercel（personal-fiance-nine.vercel.app）連 GitHub `main`，push 即自動部署。**所有 `data/*.json` 必須 commit 進 repo**，前端才 fetch 得到（Action 會自動 commit 它產生的；但 `VIX_early.json` 沒人重建，要手動保留）。

## 慣例與眉角

- 股價皆**原始收盤價**（`auto_adjust=False`）。`0050.TW` 有 2014 真實 4:1 分割造成的 yfinance 斷崖，`fetch_stocks.py` 的 `SPLICE_FIXES` 做 idempotent ratio-splice 修復。
- `fetch_stocks.py` 預設 `GLOBAL_START=2000`；需要更長歷史的 ticker 放進 `FULL_HISTORY` set（目前 `^GSPC`，從 1987 起 → `SP500.json`）。
- **散戶情緒 tab（`js/tabs/aaii.js`）四格對照圖** S&P500 / F&G+VIX / AAII看多·中立·看空 / 看多−看空，資料起點各異：
  - S&P 500 用**指數 `^GSPC`**（`SP500.json`，1987 起）**而非 SPY ETF**（SPY 1993 才上市、又被 GLOBAL_START 卡在 2000）。指數最新值 ≈ MacroMicro「美國-S&P 500」。
  - VIX 在前端把 `VIX_early.json`（`^VXO` 1986-89 + `^VIX` 1990-99）接在共用 `VIX.json`(2000+) 前面 → 回溯 1987（看得到 1987 黑色星期一 VXO≈150）。**刻意不改共用 `VIX.json`**，以免動到情緒/相關係數 tab 的 VIX 計算。
  - **CNN 恐懼貪婪無法早於 2011**（CNN 2012 才推出此指標、只回填到 2011，硬限制；更早不存在，那格留白）。
- **AAII fetch 眉角**：官方 `sentiment.xls` 用 bare curl 會被 Incapsula 擋 403；Python `requests` 帶 `Referer: https://www.aaii.com/` + 完整瀏覽器 headers 才過得了。`fetch_aaii.py` 以官方 xls 為權威全歷史、live 表格只補最新週。

## 新增一個 tab

1. `js/tabs/<id>.js` — export `init`（首次切入載入）、選用 `onThemeChange(light)`、`resize()`。
2. `js/boot.js` — `import * as xTab` + 加進 `registerAll([...])`。
3. `index.html` — nav 加 `<button class="tab-btn" data-tab="<id>">`，內容加 `<section id="tab-<id>" class="tab-section" hidden>`。
4. 主題色用 CSS 變數（`--bg/--panel/--border/--text/--muted`）；圖表 `echarts.init(el, isLight()?null:"dark")`。
