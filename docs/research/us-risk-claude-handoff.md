# 給 Claude：美股風險／去槓桿觀察頁驗收交接

請驗收這個已實作的研究分支，先核對資料與金融語意，再看UI與工程。使用者要求留檔供Claude驗收；本輪未呼叫Claude CLI。若由使用者選擇CLI驗收，其偏好為Sonnet5.5/high；請勿自行換成Astra或付費探測模型可用性。

## 身分與邊界

- repo：https://github.com/oid87/PersonalFiance
- PR：https://github.com/oid87/PersonalFiance/pull/4 （draft，未合併）。
- branch：`research/us-risk-observer`；base：`8008803b`。初次完整實作commit=`f1c9a408`，後續補強與本交接以PR最新HEAD為準。
- 研究工作目錄：本聊天工作目錄下 `work/pf`。主 checkout 另有其他Claude/session的台股WIP，請不要reset、stash或直接覆寫。
- 本PR無main merge、production deploy、正式交易／加碼條件修改。請先read-only review；重大問題請列檔案／行號／證據，不直接改別人的WIP。
- 先讀repo README／CLAUDE／AGENTS／TESTING，以及 [產品設計與六題](us-risk-product-design.md)、[需求與逐字ⓘ](us-risk-requirements.md)、[驗證紀錄](us-risk-validation.md)、[定案規格與台帳](us-risk-engine-spec.md)。

## 變更入口與ownership

| 檔案 | 責任 |
|---|---|
| `js/tabs/usrisk.js` | 風險頁呈現／控制項／ECharts／lifecycle，Main整合 |
| `js/tabs/usrisk_controls.mjs` | 控制項門檻與ⓘ逐字文案 |
| `js/tabs/usrisk_calc.mjs`、同名test | strict as-of、日頻重建、事件／基準／波段；Worker第一版，Main複核並補缺列／左設限修正 |
| `scripts/compute_us_risk_observations.py`、`scripts/tests/test_us_risk_observations.py` | append-only首次觀測／修訂版本，失敗保留舊時間與原子輸出；無網路／憑證讀寫 |
| `data/us_risk_observations.json`、`docs/schemas/us-risk-observations.schema.json` | 真實既有資料的首次觀測封存與schema；不造發布日期 |
| `scripts/research/backtest_us_risk.mjs`、`verify_us_risk.py` | 固定輸入SHA256＋config重現；獨立數值oracle |
| `scripts/test_usrisk_browser.cjs` | 新頁39案例／四viewport／HTTP身分／失敗重試 |
| catalogue、index、scoped CSS、navigation/lazy tests | 新頁lazy接線，保留舊畫面標籤 |
| source_manifest、US fetch workflow、update_all | 在上游後封存（continue-on-error，失敗不阻擋主資料），驗證後才由既有workflow發佈；本機 update_all 不執行此 producer，本機預設拒絕寫入共享封存檔 |

既有美股研究分支 `research/us-delever-weekly` 的commit `595e6b47` 已唯讀查閱；它有推估發布時間與修訂後資料，沒有被直接當成嚴格回測引擎。未修改或重發舊研究結論。

## 請逐條驗收

1. 嚴格模式不能把首次匯入的舊資料回填成歷史已知；日頻也必須遵守observed_at／published_at。非PIT重建與嚴格結果不能混算。
2. 嚴格lookback與滾動分位數不含未來版本；分位數不含當日，至少126筆過去資料。
3. CFTC正確標示consolidated market與張數、long+short未含spreading，污染到期週與次週；週變動只比較兩端乾淨且相隔一週。禁止稱斷頭或全市場美元曝險。
4. NFCI不是融資維持率；歷史修訂與缺ALFRED版本揭露。FINRA無官方逐月公布日，用首次實際觀測保守門檻，不能估計月底+25天。
5. next-open、含entry日起5/10/20/60根，缺價／壞OHLC不得跳日；警報low用當時版本。最大虧損與收盤峰谷MDD必須分清。
6. N／條件日／冷卻事件／不重疊事件分開；三組基準同eligible母體。小樣本、右設限與壞價不靜默剔除。
7. 漏報波段要完整且全覆蓋，首次看見已在下跌中的波段需左設限；誤報只是波段外事件，不是低點預測準確率。
8. 來源日期與首次取得分開；NDX廣度分母與現今成分股回填限制明示。RSP/SMH/HY_OAS/CNN缺值／授權限制可見，不能造數或偷偷接續OAS代理。
9. 四viewport、各下拉、ⓘ、主題、zoom/legend、切出重返、503／畸形payload重試、optional缺值，正常流程console全部0。
10. user提供的SPY8波段／QQQ10波段研究數字沒有獨立驗證，不能在新頁包裝成已重現。歷史重建結果不得直接升格正式ETF加碼。

## 重跑指令（repo根目錄）

```sh
python3 scripts/run_checks.py
python3 scripts/check_pipeline.py
python3 scripts/validate_data.py --no-shrink
node --test js/tabs/usrisk_calc.test.mjs
python3 -m unittest discover -s scripts/tests -p test_us_risk_observations.py
python3 scripts/research/verify_us_risk.py
node scripts/research/backtest_us_risk.mjs --config '{"asset":"QQQ","dataMode":"historical","mode":"vix","gate":8,"horizon":20}' --out /tmp/us-risk-reproduction.json
node scripts/test_usrisk_browser.cjs
```

Python需repo既有依賴（pandas/numpy供獨立oracle）；CI為Python3.11／Node22，本地已測Python3.13.2／Node25.4.0。browser使用已安裝Playwright1.58.0與Chromium；需要時以`PLAYWRIGHT_MODULE`指定既有套件、`USRISK_BROWSER_OUTPUT`指定**新的**輸出目錄。不要為驗收自動升級／安裝／重啟live sessions；不要關sandbox。reuse lint依TESTING指向相鄰Financial_work已有工具。

請不要在review時重新跑全量市場fetch；快照已提供，更新會改變輸入與結果。若要測producer，使用既有離線fixtures或隔離data目錄，不改共享原始資料。

## 必須保留的限制

初始嚴格覆蓋0/1707、N=0是正確降級；非PIT重建只是描述。Yahoo／Cboe公開再散布權利未解；OAS公開使用受限，CNN許可未確認。現有SPY最後一日OHLC異常，本頁未修共享價。雙標的同缺交易日尚需外部官方日曆。沒有native Safari／IME／真實交易或正式部署證據。

建議驗收回報欄位：P0/P1/P2 findings（file:line＋可重現證據）、逐條PASS/FAIL/not run、實際命令／runtime／退出碼、資料與HTTP指紋、未驗證限制、分支／commit與是否合回main。不要只給一句PASS。
