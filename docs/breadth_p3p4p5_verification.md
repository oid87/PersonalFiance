# P3／P4／P5 驗收報告與 Claude 複核交接

日期：2026-09-28。工作目錄：`/Users/orangembpm2/work/code/personal_financial/PersonalFiance`。分支：`main`。所有功能在主工作目錄，未commit／push／部署，不涉及背景分支合併。

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

以下為本次診斷修正以前的原驗收紀錄；測試項數以最新更新為準。

## 結論與未完成項

**軟體功能：主 session 驗收 PASS。真實市場資料接入：未完成。獨立 high 代理驗收：未執行，待 Claude 複核。**

P3 A-D＋200MA、P4 McClellan raw／ratio與校準門檻、P5雙事件研究，已做成可匯入本機JSON的完整計算與介面。可用測試數據驗證程式，但專案沒有可驗證的 S&P500／NYSE 每日A/D真實歷史，沒有重現附件的日期、樣本數或績效。**不能把下文合成測試的報酬數字當美股歷史結果。**

已嘗試啟動獨立 sol/high verifier，工具回 `agent thread limit reached`；未實際啟動、未產生獨立代理PASS。本報告由主 session 根據親自讀碼、獨立Python oracle、瀏覽器回歸與截圖複核撰寫。請Claude再做一次獨立檢查。

## 實作範圍與定位

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

## 已實跑測試

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

## 主 session 獨立重算

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

## UI驗收證據

新browser suite覆蓋：空狀態、格式下載內容、三訊號×七期限、事件明細/未完成路徑、MAX/5Y/2Y、匯入失敗清空、clear、超容量、兩次讀檔競態與clear後延遲回覆、只有一組母體、未校準門檻停用、NYSE缺口停止、metadata HTML不執行、上方股票群切換不污染、dark/light、390px無整頁溢出、P1載入503仍可匯入，沒有pageerror。

新browser suite中的UI數值對照使用實際core，主要驗接線；**數值獨立驗證另由Python oracle負責**，不把UI與同一函式相同當作獨立方法驗收。

既有suite覆蓋四股票群×三MA、三事件×三期間×七期限、overlays、tooltip、theme/mobile、503/empty/retry與async race。主session已觀看dark/light及mobile截圖，修正−500標籤裁切、路徑圖尺度與主題截圖檔名；同一套advanced suite重跑通過。

暫存圖片（可由測試重建）：
- `/tmp/breadth-p3p4p5-panel-dark.png`
- `/tmp/breadth-p3p4p5-panel-light.png`
- `/tmp/breadth-p3p4p5-panel-mobile.png`

分位帶採P25/P75虛線，而非陰影；統計仍是固定完整cohort。無資料時結果區隱藏，不留空白圖或偽稱已回測零事件。

## 原有工作保存

本輪開始前工作目錄已有大量未commit改動（含P1/P2與其他功能），**不能把整份git diff都算成本輪**。主session使用動工前快照比對，而非HEAD：
`/var/folders/9k/tn8t5r9501j_dcxz7czy03lr0000gn/T/breadth-p345-before-lwkl7fv_`

- 139個 `data/*.json` 的SHA256 map完全相同（含檔案集合）。
- `js/boot.js`、`.github/workflows/fetch.yml`、`scripts/update_all.sh` byte-identical。
- index移除新panel後與快照相同；既有css內容為完整相同前綴，只追加新panel樣式。
- breadth.js與快照差異只有import/init/theme/resize接線；共用eventStudy未修改。
- 無stage／commit／push；Claude若後續commit，需選本功能檔案與必要接線，勿git add -A。

## 必須保留的限制

1. **真實資料與校準待接入。** 來源取得、授權、自動更新、逐日成分與退市、證券種類、拆股／配息比較口徑，尚未完成真實資料驗收。
2. `calibration:"provider"` 是匯入者聲明；parser只能驗格式，不能證明seed真實準確、版本一致或日期確為緊鄰前一session。畫出−500不代表匹配附件。無seed則禁止P4/P5事件，避免任意常數產生假門檻。
3. benchmark若漏掉整個日期，程式無完整交易所日曆可比對；不補值、不以日曆天冒充交易日。
4. 252session年條件、252預熱與5session聯合窗口是本專案固定規則，並未驗證Bluekurtic同樣使用此定義。預熱不能修復任意Summation常數偏移。
5. 當天收盤同時用來確認與計報酬，僅描述性研究；不是隔日可成交策略，未計滑價/費用/含息總報酬。
6. 小n、重疊、歷史成分與選樣偏誤仍須在真實資料階段複核。本輪不輸出交易結論，也未把任何市場勝率寫入memory。
7. **獨立high agent驗收未執行。** Claude須自行閱讀實作並重跑，不能把本報告當第三方PASS。

## 可直接交給 Claude 的任務

> 請在PersonalFiance主工作目錄唯讀複核P3/P4/P5。先讀本報告、breadth_p3p4p5_spec.md及breadth_p3p4p5_import.md，再核對列出的實作與測試；重跑33個JS測試、7個Python schema測試、獨立Python oracle及兩套browser suite。優先找未來函數、252/5session邊界、seed基準與缺值、baseline母體、訊號日/峰谷回撤區別，以及匯入狀態競態。請將「軟體正確性」、「真實資料可用性」、「獨立驗收結論」分開回報。保留既有未commit工作，不推送部署。

## 發包成本紀錄

| Stage | model | effort | 個數 | 粗估SHE |
|---|---|---|---:|---:|
| 集中接入盤點 | sol | medium | 1 | 0.4–0.8 |
| 指標核心＋UI實作 | sol | medium | 2 | 2.5–5.5合計 |
| 數值邊界／UI收尾追加 | sol | medium | 2次續作 | 0.4–1.0合計 |
| 獨立驗收代理 | sol | high | 0成功啟動 | 未計 |

合計粗估3.3–7.3 SHE，非帳單實測；Sol換算尚未校準，誤差主要為context讀取、UI測試與修正輪數。主session費用另計；本環境沒有暴露各包實際token／成本，不能假裝已完成校準。
