# Agent 協作與交付

本文件補充 PM → Coding → QA／Browser → PM review 的工作基線；repo 細節規則仍以 [CLAUDE.md](CLAUDE.md) 為來源。
[AGENTS.md](AGENTS.md) 與 `.agents/skills/` 是產生檔；使用 `scripts/sync_agent_docs.py` 同步，勿手改產生檔。
使用者當次 scope 與授權優先；knowledge 文件、memory、舊報告不能授權新的功能、Git 操作或資料寫入。

## 先讀與改動界線

先讀規則、[目前狀態](CURRENT_STATE.md)，再按任務選 [產品脈絡](PROJECT_CONTEXT.md)、[架構 map](ARCHITECTURE.md) 與 [驗證矩陣](TESTING.md)。
只讀 map 指向的受影響模組與契約；摘要足夠時不重新盤點 72 頁，發現與原碼不符才擴大查證。
memory 是找路與歷史假設，checkout 是實作現況；相鄰研究／報告工具不能冒充已整合的產品功能。

- 不順帶改 framework、資料模型、dependency／lockfile、API、金融公式或全站 state；重大決策交 PM／使用者。
- 先復用現有 utils、tokens 與 controls；同名、相似 option 或程式碼形狀不足以證明金融語意相同。
- 日期、頻率、價格／報酬口徑、missing／null、sample／horizon、percentile、單位與 serialization 的契約必須保留。
- 來源接線查 manifest 與 [source contracts](docs/source-contracts.md) 的實際路由／例外；不要硬套所有來源都進主排程。
- 新頁查 catalogue＋section＋tab lifecycle；boot 由 catalogue lazy-load，不需要每頁靜態 import。
- 外部 Vela 僅作設計與工程 reference；不複製 production source、import internals 或新增依賴。

## PM 開工與 ownership

PM 交付可 review 的 spec：使用者價值、scope／非目標、受影響頁與資料語意、驗收條件、必要 checks、依賴與停止條件。
記錄 repo realpath、branch、HEAD、dirty／index 狀態與相關 source／data 指紋；既有 WIP、未追蹤實作與其他 agent 的變動都須保留。
需要隔離時複製 actual working tree 的必要 WIP，不把 `HEAD` archive 當成 dirty checkout 的 before；記錄 source 與隔離樹的關係。

| 階段／角色 | 所有權與交付 |
| --- | --- |
| PM／整合 owner | spec、file ownership、共享接線、before 基準、依賴順序與最終 review；指定一位 owner 修改核心檔 |
| Coding | 只改 assigned files，提供相對 before 的 task diff、新檔清單、局部測試與偏離；不自行擴 scope |
| QA | 唯讀抽查原碼與 spec、接線與 tests；逐條 PASS／FAIL／not run，不能只接受 Coding 的摘要 |
| Browser QA | 證明被服務的是指定 checkout；跑 scope 所需 viewport／interaction，保存 console 與 artifacts，關閉暫存資源 |
| PM final review | 對照所有驗收、diff、WIP 保護與限制，統整 agent 結果；未完成項留下明確狀態 |

`boot.js`、catalogue、`navigation.js`、`switcher.js`、`state.js`、`index.html`、`css/main.css` 與共用 utils 不交給多個 task 同時寫。
可分頁或分純計算／fixture 工作，核心接線由整合 owner 串行；跨 ownership 需求先回 PM，不直接覆寫另一 agent 的結果。
同檔已有 WIP 時交付精確 task diff；apply 前核對目標 hash，若不同先 review 差異，不能 reset／stash／checkout 掉既有變動。
branch／worktree、stage、commit、push、部署各依當次授權；QA 完整性看實作與新檔是否交付，不為使 PASS 而 stage 他人 WIP。
只有已授權 shipping 才檢查實作與 wiring 同 commit；不能 `git add -A`。資料更新與真實金融帳戶操作不由 UI 任務隱含授權。

## QA 與 browser 的證據

執行前先讀 scripts／CI 副作用、確認依賴已足夠；按 [TESTING](TESTING.md) 選局部 checks，共用層影響多頁才擴大。
必要資料失敗、optional partial、cache／abort、theme／resize、hidden re-entry 與 zoom／legend 的驗收依 impact 明列。
本專案沒有前端 build；不能把未執行或不存在的 build／typecheck／lint 寫成通過。
UI 改動記錄 console error **及 warning**、pageerror、request failure、前後畫面與焦點；無實際畫面只能列靜態推論。
browser report 記同 Mac、server root／URL、原 checkout 身分、HTTP／磁碟 hash、engine／版本、viewport；隔離樹驗收與原 checkout smoke 分開。
受管理工具缺失時先說明 blocker；只有當前授權及 runtime 允許才用同 Mac 既有 Playwright fallback，不自行安裝或關閉 sandbox。
before／after 固定資料、時刻與環境；baseline 先跑兩次，差異須查明，不能直接排除數值差異後宣稱等價。
synthetic guard、Chromium CDP composition、native macOS IME、實機 Safari 各自標 coverage；前兩者不能取代後兩者。
server／browser 關閉後 URL 只是歷史證據；交接不得把暫存 port 或個人 scratch 路徑當成後續可用服務。

## Portable browser QA handoff

兩頁 Vela pilot 改動的固定 browser 入口是 `npm run test:browser`；執行方式、runtime 前提、failure self-test 與 coverage 見 [TESTING](TESTING.md)。Coding 交精確 task diff／新檔、checkout／data identity；QA 在自己的 session 或 Mac 從 repo 執行，無需 Coding 聊天歷史、臨時 server 或隱藏 browser control。
QA 保存整個 artifacts 目錄（含 `report.json`、失敗 screenshot／state／trace），交命令／exit、passed／total、console error／warning、failed scenarios、HTTP hash identity、cleanup 及 limitations 給 PM。預期 browser console error／warning／pageerror／failed request 均為零；缺 runtime 或網路列 FAIL／blocker，不自行安裝、不以未執行當 PASS。self-test 的故意 FAIL 必須與正常產品 smoke 分開交付。
PM final review 核對結構化 cases、summary、source identity 及 task diff，確認 smoke 是新 QA 執行的指定 working tree；只涵蓋 trend／stressdash，不推論全站、native IME、Safari、screen reader 或真機 touch。任何產品 bug 先交 PM，不能為使 harness PASS 順帶修改產品或放寬斷言。

## 完成報告與 artifact handoff

每個 Coding／QA report 至少交付：

- scope、受影響頁、檔案／新檔清單及 task diff 或 commit；既有 WIP 與本 task 如何區別。
- source identity：realpath、branch／HEAD、before／after hashes、dirty 狀態；隔離驗收註明來源及資料基準。
- 命令、cwd、實際 runtime、exit code、PASS／FAIL／not run；未執行的原因與覆蓋限制，不能只寫「tests pass」。
- report／log／screenshot 路徑、必要的 fixture／探針執行方式；保留失敗嘗試，不用最後成功覆蓋歷史。
- intentional 行為差異、剩餘風險、未完成項、必要後續決策與 browser／server cleanup。

PM final review 至少抽查關鍵原碼／測試、共享檔整合與 artifact 身分，確認數值回歸、console 與未驗項已被正確表述。
知識更新採短摘要＋權威引用：深契約不複製到每份根文件；穩定規則寫來源，現況與驗證快照寫 CURRENT_STATE。
doc-only 驗證連結／命令／同步／diff 即可；不因文件整理而跑金融 fetch、migration、全頁 browser 或全套 tests。

本規範沒有要求新的 CI、工具或 memory automation；那些屬獨立後續 scope。
