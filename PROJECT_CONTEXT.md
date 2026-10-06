# PersonalFiance 專案脈絡

核對日期：2026-10-04。本文件提供接手工程工作的產品與金融語意背景；現況以原始碼、實際資料契約與入口為準。
連結以本文件位於 PersonalFiance repo root 為基準；歷史驗收或研究報告不能替代目前程式的證據。

## 用途與使用情境

PersonalFiance 是個人總經與市場儀表板，長期願景為個人版財經 M 平方；目前核心是觀察市場、比較指標與閱讀描述性研究。
使用者可從走勢切入，再對照總經、流動性、情緒、風險、籌碼、估值；策略頁提供既有模擬、訊號與工具。
搜尋、收藏與 `#tab=<id>` 深連結協助回到常用畫面；期間控制服務各頁既有分析與呈現，不代表統一的研究時間窗。
產品是 ES module SPA，以 ECharts 呈現，無前端建置步驟；自訂 ticker 另有 [`api/stock.js`](api/stock.js) 的 Vercel serverless 路徑。

## 導覽結構

以下數量直接由 [`CATEGORIES`／`NAV_ITEMS`](js/navigation-catalog.mjs) 計數，共 **8 類、72 頁**，不是 `js/tabs/` 檔案總數。
同目錄還含純計算與面板模組，不能將每個檔案都解讀成獨立產品頁；新增或改名以 catalogue 接線為準。

| 分類 | 頁數 | 主要觀察面向 |
| --- | ---: | --- |
| 走勢與技術 | 10 | 價格、趨勢、技術指標與市場比較 |
| 總經與景氣 | 9 | 宏觀、通膨、景氣與成長 |
| 利率與流動性 | 7 | 流動性、利率、央行與市場廣度 |
| 情緒與曝險 | 7 | 投資人情緒與部位曝險指標 |
| 波動與風險 | 10 | 金融壓力、信用與波動結構 |
| 籌碼與融資 | 11 | 資金流、台股籌碼、融資與成本 |
| 估值與產業 | 7 | 本益比、產業輪動、財報與相關性 |
| 策略與工具 | 11 | 槓桿模擬、既有訊號、季節性與工具 |

[`boot.js`](js/boot.js) 由 catalogue 註冊頁面；[`navigation.js`](js/navigation.js) 管選頁，`index.html` 提供對應 section。
畫面與模組路徑的權威清單在產品 repo 內；catalogue 首行提及研究端來源，不代表 runtime 讀取相鄰研究 repo。

## 核心資料 → 分析 → 呈現

1. Python 來源腳本取得市場或總經資料，部分 `prep_`／`compute_` 腳本生成衍生資料，輸出供前端使用的 `data/` 檔案。
2. 已提交資料由共用 [`data.js`](js/utils/data.js) 或各頁 adapter 讀取；檔案與欄位形狀依來源，不能假定全部 JSON 都是同一 schema。
3. 各 tab 對齊日期、選擇樣本與計算指標；共用數學／日期工具及部分頁面專用 `*_calc.mjs` 負責純計算。
4. tab 把計算結果轉為 ECharts series、卡片、表格、訊號與方法說明；dispatcher 與共用 UI 管畫面互動。

[`trend.js`](js/tabs/trend.js) 持有 adapter 與呈現，鄰接的 [`trend_calc.mjs`](js/tabs/trend_calc.mjs) 是純計算模組。模組存在與 production wrapper 已接線分開判讀；是否使用以該驗證來源的 tab import 為準，不能由檔案存在推定完成遷移。
自訂 ticker 先讀本地 JSON；目前 local response 非成功 HTTP 狀態時才嘗試 `/api/stock`，不是僅限 HTTP 404。API 取約十年日頻 OHLCV，不代表已有 intraday 或已驗證 adjusted 資料。
資料來源、排程與驗證細節見 [source contracts](docs/source-contracts.md)；載入、取消、重試與圖表狀態見 [runtime contracts](docs/runtime-contracts.md)。

## Domain 概念與不可任改的語意

- **價格口徑**：[`fetch_stocks.py`](scripts/fetch_stocks.py) 使用 `auto_adjust=False`；價格報酬不能直接稱為含息總報酬。0050 另有 2014 邊界的 idempotent ratio-splice 修補，不能為線條連續就更換整體口徑。
- **標的與單位**：S&P 500 指數與 SPY ETF 有不同歷史；AAII 頁讀 `SP500.json`。USD、TWD、VIX 指數點數、百分比、成交量及融資單位各自有意義，不應混成單一價格尺度。
- **日期與頻率**：顯示日期窗口、日／週／月資料頻率、發布日期、可用交易日與價格 as-of 是不同概念；曆日加法不能任意替換交易日對齊。
- **百分位與門檻**：共用 `percentileRank`、NAAIM 含同值平均名次的 rolling rank、VIX/SKEW 特定排名方法不等價；更換公式可能改變事件入選。
- **研究樣本**：先定義母體、資料有效性、冷卻及 horizon，再解讀勝率／報酬。未完成期間、缺價、重疊事件與固定 cohort 不可靜默改成其他樣本。
- **風險量測**：訊號日起最大虧損與期間峰谷最大回撤是不同指標；`eventStudy.mjs` 分別計算，不能因欄位近似就合併。
- **估值**：自建 forward P/E 以總市值／總預估盈餘計算；NTM／FY2 basis、負 EPS、來源權重 coverage、執行日與 `price_asof` 均須保留。不可用個股 P/E 算術平均或臆造歷史替代。
- **缺值與歷史限制**：`null`、無資料、過期與樣本不足各有含義；靜態 `VIX_early.json` 必須保留，共用 `VIX.json` 影響多頁。不能以補零、延伸尾價或短樣本冒充完整歷史。

市場廣度 P3–P5 已有匯入／計算／呈現流程；[匯入說明](docs/breadth_p3p4p5_import.md) 明示尚無可驗證的 S&P 500／NYSE 每日 A/D 真實歷史接入。
既有描述性事件研究、合成 fixture 與已可成交策略是不同層次；市場結論須回查資料 provenance、價格口徑與方法，不能從舊 report 的績效數字反推目前結果。

## 設計原則與產品邊界

- 延續 ES modules、ECharts、現有 state 與共用 UI；以清楚的資料、純計算、adapter／呈現責任邊界降低重複，不為形式統一犧牲金融語意。
- 共用主題、日期、數學與控制項工具；必要資料失敗與 optional 部分資料需可辨識。手機、鍵盤及圖表狀態是既有產品契約的一部分。
- 新頁依 [.agents add-tab 指引](.agents/skills/add-tab/SKILL.md) 從 scaffold 起手與接線；來源 schema、模型與 dependency 的改動須有明確任務依據。
- `Financial_work/` 是相鄰研究 repo，`study_runtime.py`／`study_report.py` 管研究輸入 provenance 與報告；其 runtime、歷史 baseline 與產品 SPA 各有邊界。
- `personal_financial_work/` 是相鄰市場報告專案；其 `src/portfolio_gate.py` 有持倉輸入及個人／公開報告模式，**不代表本 SPA 已整合完整 portfolio／資產帳本**。
- [`references/vela/`](docs/references/vela.md) 是獨立上游研究 checkout，受 gitignore 排除；參考其互動概念不等於採用其 renderer、金融公式或 production dependency。

當輪 scope 與 dated 驗證狀態見 [CURRENT_STATE](CURRENT_STATE.md)；架構改動入口見 [ARCHITECTURE](ARCHITECTURE.md)。

## 權威入口

[README](README.md) 提供產品入口；[CLAUDE.md](CLAUDE.md) 是 repo 規則來源，[AGENTS.md](AGENTS.md) 與 `.agents/skills/` 為同步產物。
[navigation](docs/navigation.md)、[UI components](docs/ui-components.md)、[development](docs/development.md) 分別說明導覽、介面與開發入口。
[forward P/E](docs/forward_pe.md) 提供方法背景；計算模組與 tab 的接線直接核對該驗證來源的 import、fixtures 與 payload。未提交的 calculation／migration 報告不是目前 production 接線的證據。
本文件是脈絡索引，不宣稱金融資料正確性、全套測試或瀏覽器驗收已通過；最新工程驗證需另查當輪證據。
