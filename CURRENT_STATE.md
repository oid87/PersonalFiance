# 目前工程狀態

核對日期：**2026-10-04**。此為 dated snapshot；後續 agent 先核對 checkout，不把本頁當永久測試保證。
本頁驗證來源與 remaining status 是文件提交前的已提交 B3 checkpoint；本文件不填自己的未知 commit SHA／tree，也不宣稱此 checkpoint status 是文件提交後的最終 status。文件提交後的 fresh final HEAD 驗證另見本輪完整 report。

## 驗證來源

- 已提交 functional／B3 source HEAD：`1bbf2c084412b52257492338b72203c059bc6659`。
- branch／source tree：`原 repo main；驗證 clone detached HEAD`／`930da31d270b46f815db5df20fac3bd1618fcd6e`。
- 隔離 checkout 與資料基準：`/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-1bbf2c084412；committed Git data only，764 files；data hash map SHA256 6d175c6fa106986e7f67654adef002daab9c67b1ae3de24790a5067a72460f80；原 WT 的12資料刷新另列，不混入驗證`。
- 本輪完整 report／artifacts：`/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/REPORT.md；source checkpoint 證據 /Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/results.json；report 的後續更新與此 dated checkpoint 分開`。
- 本頁記錄上述驗證來源；文件 commit 不反向冒充 product/harness 的來源 commit。原工作樹保留 WIP，其驗收與乾淨來源樹驗收分開。

## 工程主幹與實際提交

| 群組 | 已提交 scope／commit 與驗證 |
| --- | --- |
| runner／npm／offline CI environment | e67fdc91 runner／4602050f npm entry；7fec8a93 offline CI 5paths，真實Python3.11＋Node22 clean install/npm ci/full runner PASS，lock/config一致；沒有宣稱遠端Actions實跑 |
| runtime／shared UI／navigation | 2bca977d runtime/request/activation 4paths、e8c62381 sharedUI/lazy navigation 13paths；503/timeout/retry/late completion等4runtime cases與7 UI/nav scenarios PASS；d7c08f07 原契約/研究9docs；eec74c29 新fetch guide事實修訂，完整externalcanonical生成證據另列 |
| 已確認完成的 page migrations／計算接線 | d1eae75b 六個等價pure precursors（trend/CPI/VIX-SKEW/leverage/NAAIM/marginglobal），21tests與38frozen legacy comparisons；80291d47 只接leverage與vixskew兩個wrapper；303ab1e0 39頁activation、2d04533d 13頁reentry/chartstate、8569204b 六個render/label/test paths、d2509665 CSS10行mobile修復。範圍及保留失敗見REPORT；54頁all-visible-chip supplement9runs/954snapshots/792clicks，equivalent financial/text/state differences0，AAII48 metadata leaves另列；R5 raw284UI/dateaxis leaves另列；MUI10viewport comparisons PASS。不宣稱全部金融admission/null/empty修復完成 |
| Vela 兩頁 pilot | 3c6bddd7 精確11paths，chartfocus/search shortcuts/stress layout兩頁pilot，保留已提交MUI tail；actual V1R source-tree proposal29/29 PASS，console/HTTP/cleanup PASS；另由已提交B3 clean checkout正常29/29確認。沒有calculator/extraMA金融行為變更 |
| portable browser smoke core | 1bbf2c08 精確3paths：package test:browser hunk、scripts/browser_smoke.cjs、3個infra unit tests；actualproposal normal29/29及controlledfailure29/30exit1後提交，再於realcommittedHEAD cleanclone獨立重跑PASS；不把proposalHEAD稱mainHEAD |

畫面清單是 catalogue 的 8 類／72 頁；不表示全部頁面已完成相同 lifecycle 遷移、計算抽離或 browser matrix。
純計算模組與 production wrapper 接線分開記錄；未提交的歷史 calculation／migration 報告不作為已完成證據。
介面與資料合約見 [navigation](docs/navigation.md)、[runtime](docs/runtime-contracts.md)、[UI](docs/ui-components.md)、[sources](docs/source-contracts.md)。

## 本次驗證

| 命令／範圍 | 實際結果與 runtime |
| --- | --- |
| Python 3.11 clean dependency install／check | PASS，新的Python3.11.17 clean venv /tmp/personalfiance-closure-clean311，依actual B3 requirements clean install exit0；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/closure-python-install.log；realclone pip check exit0與freeze見 /Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/results.json |
| Node 22 clean npm ci | PASS，plain npm ci exit0；v22.23.3；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/npm-ci.log |
| full runner：route／Python／JS syntax／JS tests | PASS，route；Python 148/148；JS syntax 137/137；JS 231/231；exit0；Python 3.11.17／v22.23.3；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/results.json |
| npm test | PASS，JS syntax 137/137；JS 231/231；exit0；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/npm-test.log |
| 正常 npm run test:browser | PASS 29/29，exit0；console error/warning/pageerror 0；HTTP hashes／cleanup PASS；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/browser-normal/report.json |
| browser failure self-test | 故意 FAIL 29/30，只有 controlled failure evidence self-test；exit1，失敗 screenshot/state/trace 保存；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-validation/browser-failure/report.json |
| 文件／agent sync／link review | 外部 actual B3 source＋9個新文件 proposal：根 canonical→generated sync、4/4 agent-doc tests及必要 project links PASS；clean export 略過 ignored skills，fetch 完整 canonical 相等性另見 current-doc-draft-v2 生成證據；actual staged／final HEAD 驗證另見本輪report；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/docs-review/current-nine-render-NO-B3-1bbf2c08 |

browser report 與同次 Git／source identity artifact 必須共同記錄實際 source HEAD／tree；runner 原生 report 的 Git 欄位是 head／branch／status。browser report 另記 HTTP／磁碟 hash、console error／warning／pageerror／request failures、viewport、engine／Playwright 與 cleanup。proposal commit、已提交 HEAD、original WT 結果不能互相代替。
既有含 WIP 的歷史驗收與此表分開；本輪實際執行結果只由上述新 report 決定。沒有執行的項目保持 not run／BLOCKED。
runner 不執行市場 fetch、data validator CLI、reuse lint 或 browser；正常兩頁 browser smoke 不等於全站 before／after 金融 oracle。

## 剩餘 WIP 身份

- product decision：金融公式、策略或計算行為差異，以及仍待決定的產品／規格草稿。
- policy decision：stock continue-on-error／其他資料發布 failure policy。
- data/provenance：market JSON、historical archive、來源或 provenance 尚未確認的資料；schema PASS 不能改寫此身份。
- experiment：costmap 與其他實驗性內容。
- genuinely incomplete：未完成的工程接線／驗證與尚未整合的 source；保留的歷史文件另標明未整合或已被當前文件取代，不因未提交就推定其程式尚未完成。來源未明的項目另列，不能猜測分類理由。

文件提交前 checkpoint 的 path groups／數量：`2026-10-04 B3 pre-doc snapshot 2026-10-04T11:33:28.419753+00:00：product decision51、policy decision1、data/provenance139、experiment3、genuinely incomplete/integration24；合計218paths。2個Vela reference/adoption paths是保留歷史研究文件，pilot/core已提交；未知來源paths0。逐path/理由見 /Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/pages-plan/wip-classification/remaining-wip.json。此數量含尚未提交的9doc工作，非文件提交後finalstatus`。同一 pre-doc checkpoint 的 Git status：`B3 pre-doc source checkpoint 1bbf2c084412b52257492338b72203c059bc6659：181 modified、37 untracked、0 staged；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-proof-checkpoint.status.txt；不代表文件提交後finalstatus`。
原工作樹 WIP bytes／recovery 保全：`YES（依continuation授權分開記錄）：351engineering／766otherdata／11recovery／1047JS evidence hashes無mismatch；12known refresh paths保留獨立original/continuation/append-only證據，不宣稱全部data與原fingerprint相同；provenance未核准；/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/B3-committed-proof-checkpoint.preservation.json。live舊fetchcanonical/generated bytes仍保留，與已提交新guide不同`。未 push／deploy。
fetch-script 指引的新事實修訂已於 `eec74c29250829adf022ade6ec5226b14122f975` 提交；完整 generated skill 由隔離 canonical source 經原 sync script 產生。canonical 路徑／hash 與生成證據列在文件驗證結果；未 force-add ignored `.claude/`。原 working tree 的舊 canonical／generated guide 保留為 WIP，重新 sync 前先核對兩者版本，避免把保留的舊 guide 覆蓋已驗證文件。
clean export 不含 ignored `.claude/skills/`，sync 會略過 skills；這只能驗根文件同步，不能代替另外保存的完整 canonical／generated skill 相等性證據。

使用者已確認的並行資料刷新限 12 paths：`data/BTC.json`、`data/GCF.json`、`data/SPY_valuation.json`、`data/cboe_putcall.json`、`data/cftc_positions.json`、`data/leverage.json`、`data/margin_costmap.json`、`data/margin_costmap_raw.json`、`data/tpex_margin.json`、`data/umich.json`、`data/us_macro_archive/manifest.json`、`data/us_macro_diagnostic.json`。此確認允許保留並記錄這些 working-tree 刷新，不是 provenance 核准或資料提交授權；本輪工程 commits 不納入 data。
原 fingerprint 與 historical anomaly 記錄維持原樣；continuation protection 分別核對工程、其他資料、recovery 與這 12 個刷新 paths，後續刷新另保存 append-only events。保全結果不得簡寫為「所有 data bytes 均與原 fingerprint 相同」。
最終隔離驗證使用已提交 source HEAD 的資料；上述 working-tree 刷新不會因 full runner／browser smoke 通過就得到相同驗收。

## 已知限制與停止狀態

- browser core 只涵蓋 trend／stressdash；native macOS IME、Safari、screen reader、真機 touch 與全 72 頁 matrix 未由 Chromium emulation 證明。
- chartFocus 目前只有兩個 pilot；nested host、不同圖表高度與多圖頁需明確 adapter／驗收才擴展。
- 各 tab 成功 cache、共用 request cache 與 state 有不同所有權；refresh／controller 統一不是低風險外觀整理。
- 0050 的既有規則稱「2014 真實分割」，fetch 原碼描述 vendor adjustment ratio-splice；目前保留實作並明確區分，尚未另做資料 provenance 裁定。
- 舊 ui_harness 檔頭不能代替 [TESTING](TESTING.md) 的 WIP／固定 clock／雙基準規則；目前不支援 tab filter 或固定 clock CLI。
- 資料 schema、工程測試與 UI smoke 都不能證明市場資料來源、金融公式決策或產品策略正確性。

BLOCKED items：工程主幹無剩餘 scope／dependency blocker；policy、data/provenance、金融行為、extra MA、experiments 與其餘未整合 WIP 保留原身份，未納入本輪提交。
Agent-ready baseline：`YES`。判斷依據是已提交 B3 source HEAD 的 clean install／full runner／npm／browser 證據，以及九個文件候選在隔離 staged tree `45d92e2b22ba313e9738b56eb4fb3d1cec8ef695` 的 sync、4/4 agent-doc tests、188 個必要 project links 與 full runner PASS（`/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/D9N-docs.json`、`/Users/orangembpm2/work/code/personal_financial/qa-artifacts/baseline-consolidation-2026-10-04/D9N-full.json`）。該 tree 是狀態欄及 Vela 文件事實更新前的已驗文件 proposal，不是本文件自己的 commit SHA。Vela 範圍已依實際兩頁 pilot 修正 canonical 並重新生成 AGENTS。這些文件更新亦須在實際最終 staged tree 驗證後提交。文件提交後的 fresh final HEAD 驗證不屬此 dated checkpoint；實際結果另見最終 report。
後續工作仍依使用者當次授權與 [AGENT_RULES](AGENT_RULES.md)；不沿用歷史輪次的停止／無 commit 授權文字作為目前授權。


## 2026-10-07 Cloud tools 歷史 coding checkpoint

Cloud checkout `/workspace/PersonalFiance`，origin `oid87/PersonalFiance`，branch
`work`，HEAD `7904738cc8fef78ae7b9dd64d3deed9e654fd9f1`，為接受基準
`63ecab26` 的 100 個 data 檔案直接後繼；本輪不改 data。
使用者後續授權先完成安全、可操作的 Cloud 工具。新增 [tools.html](tools.html)：
分組 ticker 清單與既有本地價格選取、既有槓桿回測／波動率診斷控制、已計算月報酬
JSON 熱圖（明示合成示範）、未接入總經未來事件來源狀態與官方人工參考連結。
波動率 production tab 與摘要共用同一 calculator，原 helper 固定 fixture 供獨立等價驗證。
主 dashboard 只有工具 section 的一行入口連結；catalogue 仍 72 頁。

完整 scope、共享 hunks、待決策與獨立 GPT-6.1 Sol low QA 指令見
[Cloud spec](docs/cloud-remaining-spec.md) 與 [Claude handoff](CLAUDE_HANDOFF.md)。
本 coding session 沒有執行 suites 或 browser；凍結後另交指定模型 QA，unit/static
不能聲稱 UI 已驗。舊 14 檔候選與 QA artifacts 保留，這輪另存證據。

待接收精確本地 8 檔 Taiwan overview＋9 檔公開 ETF patch＋5 檔私有 payload；
Cloud 尚未含該程式，不從 prose 重建、不請求原 excluded WIP repo。私有檔不進公開
repo／site。SEC 403、台灣 issuer 權利、每日價格月報酬口徑與總經 feed 仍各自
BLOCKED／待 owner 決策；local LLM 為方案與唯讀 API 契約，未安裝／實作。
未 stage／commit／push／deploy；本地 source 整合與同步尚待精確材料與後續驗證。

### 2026-10-07 後續授權：台灣觀察表

[研究工具](tools.html#taiwan) 新增既有加權指數、上市融資多頭維持率重建代理、上市
融資餘額與月頻期底 M1B／M2 年增率、已存 M1B−M2 百分點差值。各列觀測日／月份
與檔案更新分開；來源可個別失敗／重試，最新缺值不退回舊值、月資料不填入日序列。
[來源與方法](docs/references/taiwan-observations.md) 說明官方整戶及新版 MacroMicro
上市＋上櫃系列未接入。事件研究只留 handoff 摘要，沒有 −30 門檻、2× 推算、加速度
或清槓桿完成標籤。前輪 27 檔候選與 review package 保留為恢復 checkpoint；本輪
凍結後另交 GPT-6.1 Sol low 獨立 QA。未改 data、CI、環境或進行 shipping。

### 後續 feature 驗收與發布授權

以上兩段是提交前的歷史 checkpoint。後續已提交並推送
`agent/pf-cloud-browser-2026-10-07`，接受 checkpoint HEAD
`4b1d73fc9adc645957f55fc5108b35f4fd8878f9`、tree
`d938d10bbe1191e92f7c4345f3efeb4cf0381d76`。
[Actions run37582576074](https://github.com/oid87/PersonalFiance/actions/runs/37582576074)
由指定 GPT-6.1 Sol low 獨立抽查：Python151、JS345、pilot51/51、tools14/14，
console error/warning/pageerror及request failures為0，HTTP身份與cleanup通過。
CI使用Ubuntu22.04正常Chromium sandbox與明確bash pipefail；先前兩次失敗證據保留。

owner已明確授權本feature合併main，包含既有Vercel自動發布，並要求合併後驗證。
受限CI增加main的同SHA驗收，以及八項published-site probe；self-test只驗探針，
正式published run必須確認同SHA Vercel成功、served bytes一致及實際UI/console。
當前merge/deploy結果以GitHub實際refs及精確SHA報告為準，不從上述feature結果推定。
未改市場資料、來源、金融方法、資料刷新及stock failure policy。older22-file本地
overview/ETF候選仍未接入；44-WIP保留，本地同步與實跑成功須另有證據。
