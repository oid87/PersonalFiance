# 美股風險觀察頁：驗證紀錄

日期：2026-10-18。branch=`research/us-risk-observer`，base=`8008803b`。所有產品測試在獨立 worktree 執行；主 checkout 的台股 WIP 與正式交易模組不在交付 diff。

| 檢查 | 實際結果 |
|---|---|
| `python scripts/run_checks.py` | PASS：manifest、187 Python tests、全部 JS syntax、459 JS tests（補強前完整入口） |
| `node --test js/tabs/usrisk_calc.test.mjs` | PASS：20個方法與as-of邊界案例（含最後發布時間補強） |
| observation producer tests | PASS：7個首次匯入／冪等／修訂／失敗保留／壞檔／缺來源案例，已包含於187 |
| 最終 `npm test` | PASS：全部JS syntax與460 JS tests；新增非PIT也不得超過凍結快照發布時間的防線 |
| CLI獨立程序重現 | PASS：固定輸入與config兩次輸出byte-for-byte相同 |
| 初版GitHub CI | PASS：`f1c9a408`，Python3.11／Node22設定，[run 39094204949](https://github.com/oid87/PersonalFiance/actions/runs/39094204949)；後續版本看PR最新checks |
| 指定新tab reuse lint | PASS；未修改check強度或既有測試期望之外的金融語意 |
| `scripts/check_pipeline.py` | PASS：manifest、US workflow與local路由一致 |
| `scripts/validate_data.py --no-shrink` | PASS：141 root JSON，JSONL與macro archive |
| producer `validate_archive` | PASS：UTC、版本唯一性、核心來源、數字、SHA256與時間邊界 |
| `scripts/research/verify_us_risk.py` | PASS：獨立pandas rolling／numpy path複核SPY/QQQ×5/10/20/60；逐事件日期、報酬、最大虧損、收盤MDD、再破low與中位一致 |
| 新頁Chromium browser | PASS：39案例，正常流程console warning/error/pageerror/requestfailed全0；503、畸形payload可重試、optional缺值明示 |
| Browser viewports | 1280×900、390×844、844×390、1024×450；頁面不橫向溢出，select高≥44 |
| Browser interactions | lazy load、控制項、ⓘ鍵盤、主題、zoom/legend保存、切出重返；HTTP六檔與磁碟SHA256一致 |
| `git diff --check` | PASS |
| build | 不適用：原生ES modules，repo沒有build步驟 |

本機runtime：Python3.13.2（miniconda）、Node25.4.0、Playwright1.58.0、Chromium145.0.7632.6、macOS。CI指定Python3.11／Node22，與本機不同；遠端結果須另外查看，不能把本機通過稱CI通過。既有Node module-type warning保留；它不是browser warning。

第一次browser測試發現固定負門檻被誤傳為分位數；已修正，保留首輪失敗report。新增缺整列案例亦促使eligible顯式回傳boolean；最後全部通過。browser報告記錄base HEAD，測試在未提交研究工作樹上執行；六個HTTP／磁碟hash可與提交內容逐一核對。

## 結果解讀與限制

- 初始快照的嚴格模式覆蓋0/1707、事件0、N=0是預期結果：舊資料首次於本次匯入被觀測，不能回填成2020已知。
- 非PIT的VIX≥30＋回撤≥8%＋10日冷卻：SPY21件、QQQ19件；這些只是本頁新定義的描述性事件，不能冒充使用者舊研究的獨立重現或投資訊號。
- 不重疊窗口仍不保證統計獨立。未知官方發布日保持null；NFCI歷史重估、FINRA鏡站、CFTC合約口徑與張數限制皆保留。
- HY OAS／CNN未啟用、RSP／SMH缺來源、現今成分股廣度不回測。既有Yahoo／Cboe資料公開使用權利未確認；研究PR不代表正式公開部署授權完成。
- SPY 2026-10-16原始OHLC矛盾，相關窗口unavailable；未改共享價格。聯集session軸可識別單一標的缺整列，但雙方同缺一日仍須交易所日曆。
- 未驗真機Safari、native IME、真實交易與production deploy；未合併main。JSON Schema文件已提供，這次以producer與前端語意validator執行，沒有宣稱未安裝的jsonschema套件已跑過。

快照 SHA256：`95008626d294ac8bcf251063c4151bc018b7975b758630e93267663c4b5b678b`。
