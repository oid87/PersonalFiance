# P1–P5 市場廣度總驗收與 Claude 複核交接

本文件是 **P1、P2、P3、P4、P5 全部工作的統一交接入口**。前次只交出P3–P5報告，未把P1／P2一併列入，現補齊。本文合併兩輪既有驗收證據；其後Claude複核提出的診斷修正與重跑結果，記錄於下方最新更新。

工作目錄：`/Users/orangembpm2/work/code/personal_financial/PersonalFiance`。以下實作與驗收紀錄日期為2026-09-28；最後收件狀態為main工作目錄、未commit／push／部署，無待合併的實作分支。Claude複核時應重新檢查當下Git狀態。

## Claude複核後修正：起始日前缺值誤計（本次更新）

使用者轉述Claude複核：P1–P5計算與測試通過，指出診斷顯示把序列開始前的benchmark日期計入缺值。已修正：各序列從自身第一列（含）起才計missing；第一列為null仍算開始。未提供或空序列missing=0。真正缺列／null／NYSE ratio零分母照常計數，指標與訊號算法未改。

- `breadthAdvanced.test.mjs`新增benchmark300／SP500200／NYSE50個session的錯開測試；兩missing均0，mcInvalidated=false。另檢查各序列首筆null、中途缺列、尾端缺列及ratio零分母。
- `test_breadth_advanced_oracle.py`現在獨立重算並逐一比較missingSp500、missingNyse、mcInvalidated。修正前已實際抓到`staggered-starts/diagnostics/missingSp500: actual100 / expected0`，修正後10情境全部PASS；同時保留逐日指標、事件及七期績效比對。
- 本次主session重跑 **34／34 JS測試、10情境Python oracle、git diff --check**：PASS。Python schema與browser程式未變，本次未重跑；其上一輪7項schema及两套browser的PASS仍列在歷史紀錄。
- 規格P3／P4及匯入說明已明確排除起始日前日期，且不把缺口後停止計算的所有日期誤算為原始缺值。
- 本次未commit／push，未修改FINRA的fetch.yml或update_all.sh。Claude對此修正本身尚未再次複核；前面的外部複核結果係使用者提供。

### 後續commit邊界

市場廣度接線与依賴必須同一commit：`js/tabs/breadth.js`、`js/tabs/breadthAdvancedPanel.js`、`js/tabs/breadthAdvanced.mjs`，以及該功能的測試與`scripts/fixtures/breadth_advanced_fixture.mjs`。目前`js/tabs/breadthSignals.mjs`、`js/utils/eventStudy.mjs`也是未追蹤依賴，P1–P5提交時一併納入，並包含相應HTML／CSS／_breadth.py及測試與文件。勿只提交載入端，漏掉新clone需要的檔案。

`.github/workflows/fetch.yml`與`scripts/update_all.sh`現有改動屬FINRA資金雷達，排除於市場廣度commit。勿使用git add -A；這裡記錄提交範圍，未執行stage或commit。

## 全範圍狀態

| 優先度 | 交付功能 | 資料狀態 | 驗收狀態 |
|---|---|---|---|
| P1 | 20／50／200MA市場廣度與對應ETF自身均線；各窗有效分母；廣度／價格／共同日期；缺值與載入狀態修正 | 使用專案既有四股票群資料；新分母隨後續成功更新產生，舊20／200分母不反推 | 首輪獨立verifier＋主session複核PASS；第二輪回歸PASS |
| P2 | MA廣度跌破50%、站回50%、ETF高於自身均線但廣度低於50%首次成立；七期事件統計與個別路徑 | 使用既有廣度與ETF價格；成分股回填／混合批次偏誤仍存在 | 首輪獨立verifier＋主session複核PASS；第二輪回歸PASS |
| P3 | S&P500 A-D累積線＋完整200MA；前252個session嚴格在均線上後跌破 | 本機JSON匯入功能完成；尚無已接入的真實A/D歷史 | 主session驗收、單元／Python獨立重算／UI測試PASS；獨立high代理未執行 |
| P4 | NYSE McClellan raw／ratio、EMA19／39差、Summation、已校準的−500事件 | 同上；需要匯入者提供且外部尚待核實的校準seed，缺seed停用門檻事件 | 同P3；未驗證與附件資料供應者一致 |
| P5 | P3與P4原始事件差至多5sessions，較晚日確認；共用七期回測與事件證據 | 需P3／P4兩組資料完整可判定；尚無真實聯合事件結果 | 合成資料驗證雙順序、同日／5／6邊界、無提前確認；待Claude獨立複核 |

**P1／P2已包含在本次整體交付。P1–P5軟體都有實作；P3–P5真實歷史資料接入尚未完成，因此不能稱P1–P5全都已完成真實市場驗證。**

P1的對應為SP500→SPY、NDX→QQQ、市值前50代理股票群→XLG、TW50→0050。P3–P5使用匯入的S&P500指數價格，與NYSE廣度保持不同母體標籤；該panel不跟隨上方四股票群切換。

## 統一複核範圍

| 層 | 需閱讀的檔案（相對repo根） |
|---|---|
| P1資料與分母 | `scripts/_breadth.py`、`scripts/tests/test_breadth_schema.py` |
| P1／P2訊號及展示 | `js/tabs/breadthSignals.mjs`、`js/tabs/breadthSignals.test.mjs`、`js/tabs/breadth.js` |
| P2／P5共用事件引擎 | `js/utils/eventStudy.mjs`、`js/utils/eventStudy.test.mjs` |
| P3／P4／P5核心 | `js/tabs/breadthAdvanced.mjs`、`js/tabs/breadthAdvanced.test.mjs` |
| P3／P4／P5介面 | `js/tabs/breadthAdvancedPanel.js` |
| 共用頁面接線與樣式 | `index.html`的tab-breadth區塊、`css/main.css`相關規則 |
| 瀏覽器回歸 | `scripts/test_breadth_browser.cjs`、`scripts/test_breadth_advanced_browser.cjs` |
| 獨立重算／合成輸入 | `scripts/test_breadth_advanced_oracle.py`、`scripts/fixtures/breadth_advanced_fixture.mjs` |

規格入口：
- [P1資料規格](breadth_p1_data_spec.md)
- [P1／P2核心規格](breadth_p1p2_core_spec.md)
- [P1／P2介面規格](breadth_p1p2_ui_spec.md)
- [P3／P4／P5規格](breadth_p3p4p5_spec.md)
- [A/D資料匯入與方法說明](breadth_p3p4p5_import.md)
- [資料來源調查與仍待確認項](breadth_phase1_sources.md)

## 合併後的測試帳

以下是最近一輪已實跑、涵蓋P1–P5的結果，不把前後輪重跑重複計數：

| 檢查 | 覆蓋 | 最近結果 |
|---|---|---|
| 三個JS單元測試檔 | P1／P2既有18項＋P3–P5新增16項 | 34／34 PASS |
| Python schema測試 | P1分母、增量寫檔、缺值、失敗保留 | 7／7 PASS |
| Python獨立oracle | P3–P5的ratio／raw／無seed／缺session，逐日指標、事件、七期事件及基準統計 | 10情境PASS（含三個diagnostics欄位） |
| 舊browser suite | P1／P2四市場×三MA、三訊號×三範圍×七期限、錯誤與競態 | PASS |
| 新browser suite | P3–P5匯入、三訊號、七期限、校準／缺值、清除／競態、主題／手機 | PASS |
| reuse與diff檢查 | breadth接線與空白錯誤 | PASS |

**共41項單元測試＝34個JS＋7個Python**，另有10情境oracle與2套browser suite；不是P3–P5單獨新增40項。

在repo根重跑：
```sh
node --test js/tabs/breadthSignals.test.mjs js/utils/eventStudy.test.mjs js/tabs/breadthAdvanced.test.mjs
.venv/bin/python -m unittest scripts.tests.test_breadth_schema -v
python3 scripts/test_breadth_advanced_oracle.py
python3 ../Financial_work/check_reuse.py js/tabs/breadth.js
git diff --check
```
瀏覽器測試需另開本機server（若8766已有server則沿用）：
```sh
python3 -m http.server 8766 --bind 127.0.0.1
```
在另一terminal執行：
```sh
node scripts/test_breadth_browser.cjs
node scripts/test_breadth_advanced_browser.cjs
```
Playwright使用現有npx快取，可透過`PLAYWRIGHT_MODULE`覆蓋；server URL可透過`BREADTH_TEST_URL`覆蓋。P1／P2首輪另有獨立臨時探針與重算，完整紀錄見附錄A；臨時檔可能不適合作為長期唯一證據，Claude可自行重建抽查。

## Claude應優先查的問題

1. **P1分母及資料日期**：不同MA有效家數不可共用；舊20／200分母未知不得由rounded比例反推；行情日期與更新日期分開。增量更新不得因缺新欄位觸發全史重算。
2. **P2與P5共用引擎**：全史冷卻在日期範圍之前；七期限各自完整n；baseline母體一致；缺價不壓縮session；最大訊號日起虧損與峰谷MDD不可混用；分位路徑固定cohort。
3. **P3／P4**：完整200MA、252前日條件與預熱邊界；raw／ratio的分母與中性基準；seed僅聲明而非已驗證來源；NYSE缺口後禁止延續。
4. **P5**：雙訊號使用已發生事件，在較晚日確認，不能回填較早日；差5可接受、差6拒絕；共同可判定日期不可偷換成成功訊號樣本。
5. **整合**：新panel獨立於上方四市場；匯入失敗／快速切換無舊狀態殘留；P1資料載入失敗不阻擋P3–P5；深淺主題、390px、tooltip与寬表正常。
6. **證據與限制**：P1／P2是既有真實資料上的有偏描述性研究；P3–P5目前只有合成測試。小樣本、重疊、無完整交易所日曆、非可成交策略不能省略。

## 驗收獨立性與既有工作

P1／P2首輪已有獨立verifier PASS及主session複核。P3–P5獨立sol/high verifier啟動遭`agent thread limit reached`拒絕，只有主session驗收與獨立實作的Python計算；**不能把P1／P2的獨立PASS延伸為P3–P5也通過獨立代理驗收**。

P1／P2起始沒有data雜湊，該輪資料完全未改只能提供有限證據。P3–P5動工前有快照與139份data雜湊，第二輪核對完全相同；這不追溯消除第一輪的證據限制。repo已有其他未提交改動，不能把所有HEAD diff歸因本功能。

## 可直接交給Claude的完整要求

> 請複核P1–P5全部市場廣度工作，勿只看P3–P5。以這份總報告、兩輪規格與實際程式為依據，重跑41項單元測試、10情境Python oracle及兩套browser suite。逐項檢查P1分母／MA對應、P2事件引擎、P3 AD200、P4 McClellan版本／校準、P5聯合事件時間與基準。將軟體正確性、資料可用性、方法論偏誤分開給結論；P3–P5沒有真實A/D歷史，不能宣稱重現附件績效。先唯讀驗收，列出可重現問題、嚴重度、檔案位置與修復建議；保留其他未commit工作，不commit、push或部署。

---

## 附錄A：P1／P2首輪完整驗收紀錄

以下保留當輪範圍與證據。「本輪只含P1／P2」指首輪當時，不表示此次交接排除P3–P5。

### P1/P2 獨立驗收（2026-09-28）

結論：**PASS（帶資料未改之證據限制）**。本輪範圍未發現 P1／P2 blocker；沒有修改實作、下載資料、commit 或 push。
驗收分支：`main`；本輪未 commit，不涉及隔離分支合併。原有未提交工作不能歸因本輪。

#### 執行與證據

| 檢查 | 結果 |
|---|---|
| `node --test js/utils/eventStudy.test.mjs js/tabs/breadthSignals.test.mjs` | 18／18 PASS |
| `.venv/bin/python -m unittest scripts.tests.test_breadth_schema -v` | 7／7 PASS |
| `PLAYWRIGHT_MODULE=/Users/orangembpm2/.npm/_npx/e41f203b7505f1fb/node_modules/playwright node scripts/test_breadth_browser.cjs` | PASS |
| `node /tmp/breadth-verifier-core.mjs` | SP500 oracle、NDX200空段、三MA prefix invariance PASS |
| 獨立 Python 標準庫重算 NDX200（臨時探針） | 事件／eligible 日期、七horizon所有統計 PASS，容差1e-8 |
| 獨立舊 `_breadth.py` snapshot vs 現版合成DataFrame重算 | 271行所有既有欄位完全相同，僅新增三分母 |
| `node /tmp/breadth-verifier-ui.cjs` | 獨立oracle對UI、實際scatter hover、schema與overlay故障 PASS |
| `python3 ../Financial_work/check_reuse.py js/tabs/breadth.js` | PASS，無新違規 |
| `git diff --check` | PASS |
| index範圍與管線逐byte比對起始snapshot | breadth以外相同；boot／fetch.yml／update_all相同 |

離線測試包含有辨識力的固定expected：100→120→90→110為報酬+10%、anchor loss−10%、MDD−25%；null位置、20session邊界、from不重置冷卻、Friday+2sessions、固定cohort、180日暖身與HB30邊界。Python mock實際走重算／merge，非只驗freshness skip。
Node僅有既有package未宣告module type警告，沒有測試失敗；未修改package。

#### 核心與資料核對

- `eventStudy.mjs:87-106` 全史冷卻先於研究範圍；baseline取相同eligible母體及horizon完整窗口，未再冷卻。
- `eventStudy.mjs:46-61` 保留ETF日期軸，尾端與缺價分開排除；沒有補尾價、壓縮null或提前round。
- `eventStudy.mjs:108-124` paths僅完整horizon固定cohort，各offset同n；individual首缺口後永久null。
- `breadthSignals.mjs:38-68` MA完整暖身；前一ETF session缺值不橋接；divergence只首次成立；所有信號只用當下與過去。三MA prefix invariance實測通過。
- `breadthSignals.mjs:62-74` 90／180峰值按ETF軸；HB最近30包含當天，不是31；未知hl_total不猜測。
- `_breadth.py:132-149` 新三分母為真實valid count，零分母保留0；total仍等於50分母，原百分比公式相同。
- `_breadth.py:167-218` 新欄位缺失不觸發full backfill；freshness不下載／重寫；舊行保留；metadata行情lastDate與updated分開；空下載／失敗原檔不變。
- 舊20／200分母未知；`getBreadthDenominator:23-27` 僅50可退回total，未反推rounded pct。

SP500／50MA／down／MAX／20session：raw **59**、kept **31**，事件日期與主session Python oracle完全相同；oracle所存七horizon統計容差1e-8。

| horizon | signal n | baseline n | signal mean % | baseline mean % |
|---|---:|---:|---:|---:|
| 5 | 31 | 1710 | -0.017015834352238 | 0.297402274833042 |
| 10 | 31 | 1705 | 0.696845163249060 | 0.589524376474147 |
| 21 | 30 | 1694 | 0.630966850793054 | 1.235537482036910 |
| 42 | 30 | 1673 | 2.850715976605303 | 2.437614466139926 |
| 63 | 30 | 1652 | 4.435480846370290 | 3.611919528124188 |
| 126 | 28 | 1589 | 8.035964526174650 | 7.926712721784904 |
| 252 | 25 | 1463 | 12.947683041989212 | 16.083904445384420 |

63日：signal median 5.507551326480609%、winRate 73.33333333333333%；mean anchor loss −5.083822473845191%、mean MDD −7.615675028220362%。重疊21／29，非獨立樣本。
另一市場NDX／200MA／down：raw16、kept8；独立Python重算七horizon所有11個統計欄位及baseline、所有日期相同。首次有效200MA廣度2020-07-15；此前pct unknown不入eligible。

#### UI、故障與目視

- 四市場×三MA、三訊號×三研究範圍×七horizon實際切換；ETF對應SPY／QQQ／XLG／0050正確。HB pin、VIX、F&G仍可用。
- UI七horizon n、mean、median、winRate、baseline及worst損失／MDD逐格比對獨立Python oracle；全部31個保留事件列出。
- 主圖range不影響研究；研究range也不影響主圖日期軸。主圖使用ETF session軸至共同日期，缺值留null。
- 實際mouse hover研究scatter，ECharts tooltip包含SPY與當日訊號，舊200MA顯示「分母未記錄」，無array.toFixed錯誤。
- 選單次事件路徑、固定cohort中位線、尾端未完成／缺價後不補線、空樣本提示與—績效均通過。
- 冷啟動breadth503／price503／empty→retry恢復；額外invalid-date schema測試失敗時清空卡片、圖及研究，沒有把舊市場冒充新市場。
- 延遲NDX response後切TW50，舊response不能覆蓋0050；VIX503明示載入失敗、沒有冒0，明確toggle後可重試。
- 深色／淺色兩圖與390px實測；沒有整頁橫向溢出，寬表在容器捲動。截圖已逐張目視：選單、方法文字、卡片、分位帶、個別路徑、事件表均可讀。
- 產品顯示收盤價格報酬、不含息／成本、描述性／非可成交策略與成分偏誤；小n提示、不把n0說成高勝率。未混入P3／P4／P5。

截圖（已目視）：
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-dark.png`
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-light.png`
- `/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p1p2-mobile.png`
- `/tmp/breadth-verifier-hover.png`（實際scatter hover；拍攝當下chart仍在切range動畫，不用此圖判完整歷史線）

#### 限制與deviations

- 起始沒有data雜湊，無法以cryptographic證據證明本輪全部data byte未改。四breadth列數／起訖／尾比例及total／hl_total與phase1_code報告完全吻合，mtime早於本輪data spec；mtime只作旁證。
- 四breadth尾日均2026-09-24；SPY／QQQ／XLG價格尾日2026-09-25，0050為2026-09-24。此日期不同步已在UI明示。
- 原repo有大量data與其他未提交diff；沒有把HEAD diff全部歸因本輪。`index.html`採tab-breadth到下一tab區塊比對，避開新增內層section造成的誤判。
- CSS新規則限定於#tab-breadth；管線／boot對起始snapshot逐byte相同；未引入新來源。
- 驗收僅覆蓋本輪P1／P2，沒有可成交策略、完整交易所calendar或point-in-time成分驗證。實作API無deviation。

#### 主 session 收件複核

- 已親自核對SP500七期Python oracle及事件日期，並讀取核心公式、分母資料diff與本報告。
- 已親自比對主工作目錄index範圍外內容及boot／fetch／update_all快照，確認既有工作保留；四市場200MA實際運算正常。
- 已目視深色與手機截圖，另於Codex內建瀏覽器開啟市場廣度頁，確認日期、分母未知提示、59／31事件與七期表格可見。
- 畫面解讀中的內部欄位名已改為「可計算52週高低點的有效家數」；僅文案，不影響公式。
- 主工作目錄main可用；尚未commit／push／部署，沒有待合併的背景分支。

---

## 附錄B：P3／P4／P5完整驗收紀錄

以下為第二輪紀錄；其中對P1／P2的測試為整合回歸，不能取代附錄A的首次獨立驗收。

### P3／P4／P5 驗收報告與 Claude 複核交接

日期：2026-09-28。工作目錄：`/Users/orangembpm2/work/code/personal_financial/PersonalFiance`。分支：`main`。所有功能在主工作目錄，未commit／push／部署，不涉及背景分支合併。

#### 結論與未完成項

**軟體功能：主 session 驗收 PASS。真實市場資料接入：未完成。獨立 high 代理驗收：未執行，待 Claude 複核。**

P3 A-D＋200MA、P4 McClellan raw／ratio與校準門檻、P5雙事件研究，已做成可匯入本機JSON的完整計算與介面。可用測試數據驗證程式，但專案沒有可驗證的 S&P500／NYSE 每日A/D真實歷史，沒有重現附件的日期、樣本數或績效。**不能把下文合成測試的報酬數字當美股歷史結果。**

已嘗試啟動獨立 sol/high verifier，工具回 `agent thread limit reached`；未實際啟動、未產生獨立代理PASS。本報告由主 session 根據親自讀碼、獨立Python oracle、瀏覽器回歸與截圖複核撰寫。請Claude再做一次獨立檢查。

#### 實作範圍與定位

| 項目 | 狀態與證據 |
|---|---|
| 本機JSON驗證 | PASS；`js/tabs/breadthAdvanced.mjs:43`。10MiB／20000 sessions、metadata、日期唯一有序、價格、safe counts、null、母體、variant、seed校驗 |
| P3 | PASS；`js/tabs/breadthAdvanced.mjs:98` 算AD／完整200MA；`:145`、`:151` 查前252sessions與當日跌破 |
| P4 | PASS；`js/tabs/breadthAdvanced.mjs:117` raw/ratio、兩EMA與加總；`:131` 預熱；`:146`、`:152` 校準與門檻 |
| P5 | PASS；`js/tabs/breadthAdvanced.mjs:147` 共同可判定窗；`:153`–`:157` 只用已發生的兩事件，在較晚日期確認 |
| 事件績效 | 沿用既有 `js/utils/eventStudy.mjs`，未改檔；7期、各期n、同母體baseline、冷卻、缺價／未完成排除、max loss與MDD分開 |
| 介面 | `js/tabs/breadthAdvancedPanel.js`、`index.html:733`；獨立固定S&P500 panel，匯入／清除／空白格式／圖表／單訊號與聯合表格／事件路徑 |
| 接線 | `js/tabs/breadth.js` 僅加import、init、theme、resize四處；未改上方四股票群的行為 |
| 真實來源 | 尚缺；不新增空fetch、不購買資料、不把NYSE改名SP500、不由MA比例反推A/D |

完整定義見 [實作規格](breadth_p3p4p5_spec.md)、[匯入與方法說明](breadth_p3p4p5_import.md)。獨立驗收原計畫見 [verifier規格](breadth_p3p4p5_verifier_spec.md)，該檔是計畫，不是已完成獨立驗收的證據。

#### 已實跑測試

主session在主工作目錄親自執行以下命令。無下載市場資料；Python schema測試使用mock與臨時輸出。

| 命令 | 結果 |
|---|---|
| `node --test js/tabs/breadthAdvanced.test.mjs js/tabs/breadthSignals.test.mjs js/utils/eventStudy.test.mjs` | **33/33 PASS**，新core15＋既有18 |
| `.venv/bin/python -m unittest scripts.tests.test_breadth_schema -v` | **7/7 PASS** |
| `python3 scripts/test_breadth_advanced_oracle.py` | **4情境 PASS**：ratio、raw、未校準、缺session |
| `node scripts/test_breadth_advanced_browser.cjs` | PASS；UI最後修正後重跑 |
| `node scripts/test_breadth_browser.cjs` | PASS；P1／P2回歸 |
| `python3 ../Financial_work/check_reuse.py js/tabs/breadth.js` | PASS |
| `git diff --check` | PASS |

Node會顯示既有 `MODULE_TYPELESS_PACKAGE_JSON` 提示，不影響測試；未為此修改全專案module設定。helper panel未直接register boot，check_reuse可能不納管，主session另讀過其utils引用及事件處理，沒有把lint靜默略過稱為helper的完整lint。

重現瀏覽器測試先在repo根執行：
```sh
python3 -m http.server 8766 --bind 127.0.0.1
```
再於另一terminal跑測試。Playwright不在repo依賴，測試支援 `PLAYWRIGHT_MODULE` 指到本機已安裝的playwright目錄；預設目前機器的npx快取。改port可設定 `BREADTH_TEST_URL`。本輪沒有新增安裝依賴。

#### 主 session 獨立重算

可重現入口：`scripts/test_breadth_advanced_oracle.py`。它只使用JS的fixture作共同輸入，**不呼叫JS計算來產生預期值**；Python標準庫自行算所有sessions的AD、MA、EMA、Summation、warmup、eligible日期、三訊號日期、joint證據、20session冷卻，以及每類事件／baseline七期的n、均值、中位數、上漲率、虧損與MDD。容差abs1e-8／rel1e-10。

fixture：`scripts/fixtures/breadth_advanced_fixture.mjs`，1250個工作日，所有source明示 `SYNTHETIC TEST ONLY`；不排除交易所假日，所以不是市場交易日曆，也不放進data目錄。

| 合成情境 | AD原始事件 | MC原始事件 | 聯合事件 |
|---|---:|---:|---:|
| ratio、有seed | 2 | 2 | 2 |
| raw、有seed | 2 | 2 | 1 |
| 無seed | 2 | 0 | 0 |
| index600插入AD及NYSE缺值 | 2 | 1 | 1 |

ratio兩個聯合事件（僅測試證據）：
- 2020-01-03確認：AD 2020-01-02、MC 2020-01-03，差1 session。
- 2022-04-29確認：MC 2022-04-22、AD 2022-04-29，差5 sessions。
- 合成63-session：n=2、平均/中位3.640672142160528%、上漲率100%、最差訊號日起虧損−0.5282197863616611%、最差MDD−1.1781040711520308%。數字只用來偵測程式回歸，不提供投資解讀。

另外單元測試驗證同日/5/6邊界、反順序、不能回填較早事件、prefix invariance、相等門檻、252預熱與一年窗口、AD分段、ratio全平盤分母0、首筆/中途/尾部缺失、無seed、非法輸入及數值累積超safe integer。

#### UI驗收證據

新browser suite覆蓋：空狀態、格式下載內容、三訊號×七期限、事件明細/未完成路徑、MAX/5Y/2Y、匯入失敗清空、clear、超容量、兩次讀檔競態與clear後延遲回覆、只有一組母體、未校準門檻停用、NYSE缺口停止、metadata HTML不執行、上方股票群切換不污染、dark/light、390px無整頁溢出、P1載入503仍可匯入，沒有pageerror。

新browser suite中的UI數值對照使用實際core，主要驗接線；**數值獨立驗證另由Python oracle負責**，不把UI與同一函式相同當作獨立方法驗收。

既有suite覆蓋四股票群×三MA、三事件×三期間×七期限、overlays、tooltip、theme/mobile、503/empty/retry與async race。主session已觀看dark/light及mobile截圖，修正−500標籤裁切、路徑圖尺度與主題截圖檔名；同一套advanced suite重跑通過。

暫存圖片（可由測試重建）：
- `/tmp/breadth-p3p4p5-panel-dark.png`
- `/tmp/breadth-p3p4p5-panel-light.png`
- `/tmp/breadth-p3p4p5-panel-mobile.png`

分位帶採P25/P75虛線，而非陰影；統計仍是固定完整cohort。無資料時結果區隱藏，不留空白圖或偽稱已回測零事件。

#### 原有工作保存

本輪開始前工作目錄已有大量未commit改動（含P1/P2與其他功能），**不能把整份git diff都算成本輪**。主session使用動工前快照比對，而非HEAD：
`/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p345-before-lwkl7fv_`

- 139個 `data/*.json` 的SHA256 map完全相同（含檔案集合）。
- `js/boot.js`、`.github/workflows/fetch.yml`、`scripts/update_all.sh` byte-identical。
- index移除新panel後與快照相同；既有css內容為完整相同前綴，只追加新panel樣式。
- breadth.js與快照差異只有import/init/theme/resize接線；共用eventStudy未修改。
- 無stage／commit／push；Claude若後續commit，需選本功能檔案與必要接線，勿git add -A。

#### 必須保留的限制

1. **真實資料與校準待接入。** 來源取得、授權、自動更新、逐日成分與退市、證券種類、拆股／配息比較口徑，尚未完成真實資料驗收。
2. `calibration:"provider"` 是匯入者聲明；parser只能驗格式，不能證明seed真實準確、版本一致或日期確為緊鄰前一session。畫出−500不代表匹配附件。無seed則禁止P4/P5事件，避免任意常數產生假門檻。
3. benchmark若漏掉整個日期，程式無完整交易所日曆可比對；不補值、不以日曆天冒充交易日。
4. 252session年條件、252預熱與5session聯合窗口是本專案固定規則，並未驗證Bluekurtic同樣使用此定義。預熱不能修復任意Summation常數偏移。
5. 當天收盤同時用來確認與計報酬，僅描述性研究；不是隔日可成交策略，未計滑價/費用/含息總報酬。
6. 小n、重疊、歷史成分與選樣偏誤仍須在真實資料階段複核。本輪不輸出交易結論，也未把任何市場勝率寫入memory。
7. **獨立high agent驗收未執行。** Claude須自行閱讀實作並重跑，不能把本報告當第三方PASS。

#### 可直接交給 Claude 的任務

> 請在PersonalFiance主工作目錄唯讀複核P3/P4/P5。先讀本報告、breadth_p3p4p5_spec.md及breadth_p3p4p5_import.md，再核對列出的實作與測試；重跑33個JS測試、7個Python schema測試、獨立Python oracle及兩套browser suite。優先找未來函數、252/5session邊界、seed基準與缺值、baseline母體、訊號日/峰谷回撤區別，以及匯入狀態競態。請將「軟體正確性」、「真實資料可用性」、「獨立驗收結論」分開回報。保留既有未commit工作，不推送部署。

#### 發包成本紀錄

| Stage | model | effort | 個數 | 粗估SHE |
|---|---|---|---:|---:|
| 集中接入盤點 | sol | medium | 1 | 0.4–0.8 |
| 指標核心＋UI實作 | sol | medium | 2 | 2.5–5.5合計 |
| 數值邊界／UI收尾追加 | sol | medium | 2次續作 | 0.4–1.0合計 |
| 獨立驗收代理 | sol | high | 0成功啟動 | 未計 |

合計粗估3.3–7.3 SHE，非帳單實測；Sol換算尚未校準，誤差主要為context讀取、UI測試與修正輪數。主session費用另計；本環境沒有暴露各包實際token／成本，不能假裝已完成校準。
