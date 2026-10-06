# 測試與驗證

以下命令從 repo 根目錄執行。此專案是原生 ES modules／靜態 SPA，**沒有 build 步驟**。
測試入口與版本以 [package.json](package.json)、[run_checks.py](scripts/run_checks.py) 及 [checks.yml](.github/workflows/checks.yml) 為準。
深入契約見 [runtime](docs/runtime-contracts.md)、[資料來源](docs/source-contracts.md)、[導覽](docs/navigation.md) 與 [UI](docs/ui-components.md)。

## 環境前提

- CI 與建議開發環境：Python 3.11（`.python-version`）、Node 22（`.nvmrc`）。回報實際版本，不能把其他版本的通過視為 CI 驗證。
- Python 全套依賴由 `requirements-dev.txt` 引入 `scripts/requirements.txt`；目前沒有獨立輕量 test requirements。
- 已授權且需補齊依賴時才執行 `python3 -m pip install -r requirements-dev.txt`、`npm ci --ignore-scripts`；這些命令會連網及寫入環境／`node_modules`。
- Playwright npm 套件固定為 1.58.0；Chromium runtime 另需存在。先查既有安裝，不把安裝瀏覽器當成 smoke 的隱含步驟。
- Python 唯讀檢查可加 `PYTHONDONTWRITEBYTECODE=1`，避免在原 checkout 產生 `__pycache__`；測試仍可能使用暫存 fixtures。

```sh
python3 --version
node --version
node -e 'const p=require(process.env.PLAYWRIGHT_MODULE || "playwright"); console.log(p.chromium.executablePath())'
```

`PLAYWRIGHT_MODULE` 可指向已安裝模組；記錄其實際版本。binary 由 `chromium.executablePath()` 取得，勿複製個人 cache 路徑。

## 測試矩陣

| 面向 | 全庫入口 | 局部入口／使用時機 | 前提與副作用 |
|---|---|---|---|
| 離線整合 | `python3 scripts/run_checks.py` | `--skip-js`：manifest＋Python；`--js-only`：JS | Python、Node、Python dependencies；不 fetch 市場資料 |
| Python | `python3 -m unittest discover -s scripts/tests` | `python3 -m unittest discover -s scripts/tests -p 'test_retry_call.py'` | 按改動選相關 tests；全套含不同 fetch 模組的離線 mocks |
| JavaScript | `npm test` | `node --check js/navigation.js`；`node --test js/__tests__/navigation_shortcuts.test.mjs` | `npm test` 呼叫 `run_checks.py --js-only`，仍需 Python；Node 內建 test runner |
| reuse lint | 鄰庫 `check_reuse.py` 無參數模式 | `python3 ../Financial_work/check_reuse.py js/tabs/trend.js` | 需鄰庫；全庫模式寫鄰庫 report，指定檔案不寫 report；不是 run_checks 的一部分 |
| manifest | `python3 scripts/check_pipeline.py` | 修改來源清單、workflow／本地路由或依賴順序時 | 讀清單與實際入口；不執行 fetch、workflow 或更新 |
| data | `python3 scripts/validate_data.py` | `--data-dir <fixture>`、`--baseline-dir <before-data>` | 讀現有資料，不修復；預設比較 HEAD 的資料縮減 |
| forward P/E | `python3 scripts/validate_forward_pe.py` | `--data-dir <fixture>` | 獨立驗 VOO／QQQ JSONL 與 chart 關係；不在 run_checks 內 |
| browser | `npm run test:browser`（兩頁 pilot）；legacy `smoke_tabs.cjs`／`ui_harness.cjs` | 本節固定 smoke；其他受影響頁面另選探針 | 既有 Playwright＋browser、HTTP preview、資料與 CDN 可用；產生 report／截圖／暫存 profile |
| document-only | `git diff --check`＋連結／命令／來源一致性核對 | agent 文件變動再跑 `test_agent_docs.py` | 不需要全庫單元測試、72 頁 harness、資料更新或 browser |

`run_checks.py` 先 manifest、再 Python，最後對 `js/` 全部 `.js`／`.mjs` 做 syntax check，並執行 `js/` 的 `*.test.mjs`；失敗即停止。
它不涵蓋 reuse lint、當前資料完整性、browser，亦不自動執行 `scripts/tests/*.test.mjs` 或獨立 oracle。
新增測試要確認入口真的收得到；檔案盤點使用 `rg --files js scripts/tests`，不要用 find 式 shell 展開。
reuse 對未登錄 navigation catalogue 的 tab，即使指名也可能略過；先接線再 lint。utils、scaffold、tests 等排除範圍需人工核對。
Synthetic partial data fixture 才用 `--allow-partial`；它仍驗已知 schema。WIP 資料比較用明確 `--baseline-dir`，勿把 HEAD 當成改前資料。
`--no-shrink` 只停用預設 HEAD 縮減比較，不能代替 baseline，也不能把缺資料宣稱通過。

## Portable Browser Smoke：兩頁固定入口

[runner](scripts/browser_smoke.cjs) 復用 `package.json` 的 Playwright 1.58.0，不依賴 Dot／Codex browser control、聊天歷史、個人 scratch 路徑或預先啟動的服務。從 repo 根執行：

```sh
npm run test:browser
npm run test:browser -- --help
# 可指定尚未存在的輸出目錄；不要重用舊結果目錄。
npm run test:browser -- --output /tmp/personalfiance-browser-qa-001
```

預設在系統暫存目錄建立本次唯一 artifacts 目錄，終端列出 `report.json` 的絕對位置；交接前將整個目錄保存到持久的 task artifact storage，不能只交歷史 localhost URL。runner 從自身路徑推導原 repo root，Node 啟動只綁 `127.0.0.1` 的 HTTP server，自選空 port，並在 finally 關閉 sandboxed Chromium／server。無需 Python preview、固定 port 或額外 testing framework。不要把它接進離線 `npm test`。

先用上方環境命令核對既有 Playwright／Chromium；`PLAYWRIGHT_MODULE` 可指向另一台 Mac 已安裝的模組，結果會記錄實際版本。缺 dependency／binary／CDN 或 loopback listen 權限時 runner 回報 FAIL 與具體診斷，不自行 install；經授權且確實缺少才執行 `npm ci --ignore-scripts` 或 `npx playwright install chromium`。後者下載 browser；不能以關閉 sandbox 排除 launch 錯誤。測試使用 repo 現有市場 JSON，ECharts CDN 必須可連線；不 fetch／更新金融資料。

固定範圍是 `trend` 與 `stressdash`，desktop 1280×900、mobile 390×844：

- Cmd／Ctrl+K 開啟搜尋與 Escape 焦點還原；input、textarea、其他 dialog、synthetic `isComposing`／229 避讓。
- Chromium CDP browser composition、trusted composing key、commit 後離開 editor 恢復快捷鍵；原始 event trust 值保存在報告。
- 兩頁 focus／Escape／同 document route cleanup；同一 ECharts instance、series／axes hash、實際 mouse zoom／legend 變更及狀態保存、focus／scroll／inert／ARIA／canvas 還原。
- 壓力摘要 desktop 三欄、390px 單欄；頁面、卡片／子元素及圖表 viewport overflow／clipping。
- 從 boot 起完整收集 console error **及 warning**、pageerror、request failure；**預期全部為 0，無 allowlist**。Node 既有 module-type warning 是離線測試的 runtime 訊息，不能用來豁免 browser warning。

每個 local HTTP response 對照磁碟 SHA256，並記 root realpath、Git HEAD／branch／dirty、runtime／viewport，證明測的是指定 working tree。`report.json` 有 `sourceIdentity`、`runtime`、`cases`、`console`、`requests`、`artifacts`、`limitations`、`cleanup`、`summary`；終端輸出 PASS／FAIL、passed／total、console counts、failed scenarios 與 artifacts。任一 scenario／startup／identity／console 失敗皆非零 exit；有可用 browser page 的失敗保留 screenshot、browser state 與 trace；runtime／listen 啟動受阻時保留 `report.json` 診斷與各案例 blocked 原因。成功不需截圖。失敗嘗試不得被下一次 PASS 覆蓋。

驗 runner 的失敗交付路徑可執行以下命令；**預期 exit 1 與 FAIL**，是 test-control assertion，不修改產品來製造錯誤，也不屬產品 smoke PASS：

```sh
npm run test:browser -- --self-test-failure
node --test js/__tests__/browser_smoke.test.mjs
```

infra unit test 只啟動暫存 loopback server，不啟動 Chromium；受管理 sandbox 若禁止 listen，需正常工具權限審查，不能將 EPERM 當成產品失敗或停用 Chromium sandbox。

Coding → QA：交 scope／精確 task diff、新檔、原 checkout／資料指紋，請另一 session 只讀本文與 AGENT_RULES 後在目標 checkout 執行固定命令。QA → PM：交實際命令／exit、完整 artifacts bundle、failed scenarios、console counts、HTTP identity、cleanup、未驗能力；PM 核對 `summary` 與每個 case，不能只接受 Coding 的 PASS 文句。新 Mac 必須自行重跑，舊報告不能代表新 checkout。

這是兩頁 smoke，不是 72 頁 matrix 或金融 before／after oracle。CDP／synthetic 不證明 native macOS IME 候選窗；Safari、screen reader、真機 touch 尚未覆蓋。其他頁、refactor 等價及故障注入仍使用下節 legacy 探針，按 impact 選擇。

## 瀏覽器驗證入口與輸出

先核對欲服務的根目錄、可用 port 與已有 server；需要新 preview 時綁定 loopback，並固定 `--directory`：

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$PWD"
SMOKE_OUTPUT="$ARTIFACT_DIR/smoke.json" node scripts/smoke_tabs.cjs http://127.0.0.1:8765
MARKET_TEST_OUTPUT="$ARTIFACT_DIR/market.json" MARKET_SCREENSHOT="$ARTIFACT_DIR/market.png" node scripts/test_marketstructure_browser.cjs http://127.0.0.1:8765
```

先建立可寫的 `$ARTIFACT_DIR`；market suite 不會替 report 建目錄。smoke 預設寫 cwd 的 `smoke-report.json`，執行時應明確指定隔離輸出。
smoke 逐頁驗資料／圖表與切頁，另切主題、resize；`SMOKE_MOBILE=1` 使用 390×844。它不是完整 chip 行為等價驗收。
market suite 注入 503／畸形 200，驗 cache 標記、重試與 cold partial failure；其他頁依其必要／optional 契約補探針。
breadth 兩套 suite 以 `BREADTH_TEST_URL` 指向 preview；執行前設定 `PLAYWRIGHT_MODULE`，避免其歷史個人路徑 fallback。
它們會下載暫存模板及輸出暫存截圖；目前部分檔名固定，交接時移至本次 artifacts 並記錄實際產物，不能推論全頁面涵蓋。
腳本預設 browser 設定不等於下節安全 fallback 的完整設定；fallback 探針需明確保存 sandbox 與 server 身分證據。

## 前端重構的 before／after 比較

`ui_harness.cjs` 舊檔頭的 HEAD 基準與「排除兩次不同頁面」說明，由本文的 WIP 基準、固定日期及差異查明規則取代；原 harness 尚未實作這些操作設定。

1. **改前快照包含既有 WIP**：保留 source、data、未追蹤但必要的檔案與指紋；只有工作目錄乾淨且 HEAD 確為基準時才用 `git archive HEAD`。
2. before／after 使用相同資料、viewport、時區及固定時刻；記錄所選時刻。不得在比較途中 fetch 或拿不同日期快照對拍。
3. 先對 before 跑兩次。不同即查 cache、日期、載入與非決定性來源，不能直接排除數值差異後稱等價。
4. 共用 DOM／chip／lifecycle 改動才依 impact 決定全頁 harness；局部頁面改動先做明確局部探針。document-only 不跑全 72 頁。
5. 保留 chart 完整 series／axes／dataZoom、chip active、表格與整頁文字摘要及 errors；比對差異時分開列 intentional UI 文案與非預期金融數值差異。

```sh
node js/__tests__/ui_harness.cjs "$BEFORE_ROOT" 8901 "$ARTIFACT_DIR/base1.json"
node js/__tests__/ui_harness.cjs "$BEFORE_ROOT" 8902 "$ARTIFACT_DIR/base2.json"
cmp "$ARTIFACT_DIR/base1.json" "$ARTIFACT_DIR/base2.json"
node js/__tests__/ui_harness.cjs "$AFTER_ROOT" 8903 "$ARTIFACT_DIR/after.json"
cmp "$ARTIFACT_DIR/base1.json" "$ARTIFACT_DIR/after.json"
```

上述變數需先指向已準備的隔離樹／輸出目錄。harness 自行啟動並結束 server、跑全頁，不支援 tab filter 或固定時刻參數。
固定時刻需在隔離探針建立 page 後、導航前設定 `page.clock.setFixedTime(new Date(<固定 ISO 時刻>))`，並在報告交代與原 harness 的差異。
harness 只點當時可見的 chips；隱藏 chips、hover tooltip、非 ECharts 畫布、真正觸控與螢幕閱讀器另驗。
fetch 重構須在隔離樹以 fixtures／mock 強迫重算、cache miss 與重試路徑；兩次都 freshness skip 的 bytes 相同不能證明等價。

## 同 Mac 的安全 fallback 與 IME 證據

受管理 browser 工具不可用時，若已有工具且當前規範允許，可用既有 shell Playwright 對原 checkout 做唯讀 loopback 探針。
不得繞過工具禁令、下載 browser、改空 `serverURL` 來宣稱工具可用，或修改產品來配合測試；不可用就記錄該能力未驗證。
探針從 API 查 executable，使用短生命週期 profile、`chromiumSandbox: true`；保留 sandbox，不加 `--no-sandbox`。
固定 server root，將 HTTP 的 index、改動 JS／CSS 及實際使用 data 與磁碟內容逐項 hash 對照，證明載入的是該 checkout。
記錄 URL/hash 深連結、branch／commit、WIP 指紋、browser／Playwright／OS、console error **及 warning**、pageerror、請求失敗及前後截圖；finally 關閉 browser／server。
桌面、手機直橫向／短高度、theme、resize／hidden re-entry、zoom／legend、dialog ownership 與焦點還原依 impact 明列；Chromium emulation 不等於實體 Safari。
已有同 Mac Playwright 1.58.0／Chromium 145 的局部 smoke 經驗可作方法參考，每次 checkout 仍須自行產生結果。

| IME 層級 | 可以證明 | 必須保留的限制 |
|---|---|---|
| synthetic guard | `isComposing`／229 guard 分支不誤觸 | DOM synthetic events 的 `isTrusted=false`，不是原生輸入法 |
| CDP Chromium composition | `Input.imeSetComposition`→實際 key dispatch→`Input.insertText` commit 的 browser lifecycle | 保留事件原值；compositionstart/input/key 可 trusted，composing key 應 `isComposing=true`；Chromium 145 的 compositionend 曾為 `isTrusted=false` |
| native macOS candidate E2E | 實際輸入法候選窗、選字／取消／commit 與快捷鍵互動 | 需原生輸入法操作與證據；CDP／headless 通過不能取代 |

CDP 測試還需驗 commit 後離開 editor，下一個 trusted、non-composing key 能恢復快捷鍵；editor guard 與 IME guard 分開判讀。
交接 report 至少含 `scope`、`sourceIdentity`、`runtime`、`commands`／exit code、`cases`（PASS／FAIL／未驗證）、`console`、`artifacts`、`limitations`、`cleanup`。
歷史通過數、未執行項目與本次結果分開；未驗證 native IME 或其他能力不能因 synthetic／CDP 通過而消失。
