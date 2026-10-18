# 目前工程狀態

核對日期：**2026-10-04**。此為 dated snapshot；後續 agent 先核對 checkout，不把本頁當永久測試保證。
第二輪 10 份文件／agent 指引已套用原 checkout 並經使用者接受；10 檔與保存草案逐位元一致。
第三輪僅建立 Portable Browser Smoke Harness，保留既有產品／資料 WIP，不新增產品功能或架構重構。

## Checkout 與產品狀態

- 原 repo：`/Users/orangembpm2/work/code/personal_financial/PersonalFiance`，branch `main`，HEAD `5fcea8c43ebd472c27b9909f66bff6313f8dee7b`。
- 本輪開始有 **317 個 porcelain 狀態記錄：234 modified、83 untracked、0 staged**；包含大量他人／使用者 WIP，不能用 HEAD 代表實際產品。
- 已有 8 類／72 頁、搜尋／收藏／深連結、lazy activation／重試、共用 cache／chart state／UI 與市場資料管線；入口見 [PROJECT_CONTEXT](PROJECT_CONTEXT.md)、[ARCHITECTURE](ARCHITECTURE.md)。
- 策略頁、描述性事件研究、研究 repo 回測與 legacy 持倉報告是不同層次；主 SPA **尚未整合完整 Portfolio／交易帳本／P&L 服務**。
- 主要 runtime 是原生 ES modules＋ECharts CDN，Python 產製資料，Node serverless 僅 ticker fallback；不需要替此整理引入 framework 或 build。

## 已接受的 Vela 第一輪

使用者已接受第一輪，借鑑搜尋捷徑、圖表 focus 與局部 dashboard layout 概念；沒有複製 Vela component、改資料模型或投資邏輯。
實作是 Cmd／Ctrl+K 開啟既有搜尋、趨勢／金融壓力圖表放大與還原，以及金融壓力摘要卡 responsive grid。
核心證據：[navigation](js/navigation.js)、[chartFocus](js/utils/chartFocus.js)、[chart-focus CSS](css/chart-focus.css)、[dashboard-layout CSS](css/dashboard-layout.css)。
介面契約見 [navigation](docs/navigation.md)、[chart focus](docs/chart-focus.md)、[dashboard layout](docs/dashboard-layout.md)。
設計分析與拆分見 [adoption plan](docs/references/vela-adoption-plan.md)；該報告較早的 browser 狀態由下列後續原 checkout smoke 補充，不能把歷史限制誤寫成今日全站通過。
上游研究 checkout 記錄為 Vela `0.8.1`／`d5199cb8908fd1a18c3f83c02981874c0682cc55`；[reference](docs/references/vela.md) 是 source map，不是 production dependency。

## 驗證 baseline：歷史與本輪分開

| 時點／範圍 | 結果 | 限制 |
| --- | --- | --- |
| 第一輪含 WIP 的隔離 after 全套離線 checks | PASS：151 Python、244 JS | 歷史結果；不保證新的資料或其餘 WIP，沒有 build |
| 第一輪 apply 後原 checkout JS | PASS：244 JS | 未重新執行全部 Python；既有 Node module-type warning 保留 |
| 同使用者 Mac 原 checkout targeted browser smoke | 21 PASS、0 FAIL；native IME 1 未驗證 | Playwright 1.58.0／Chromium 145.0.7632.6；趨勢／金融壓力及搜尋 guard，1280×900、390×844；不是全 72 頁 |
| Chromium CDP IME 補驗 | 5 PASS、0 FAIL；native macOS 候選窗 E2E 1 未驗證 | composing trusted key 不觸發搜尋、commit 後恢復；compositionend.isTrusted=false 如實保留，editor guard 亦獨立存在 |
| 第二輪文件／指引套用 | PASS：10 檔逐位元一致、200 links、67 source refs、文件 tests 4/4 | 初次 apply 被拒，後續限定 task 已成功套用；其餘 2308 檔／WIP 未變，沒有 fetch |

原 checkout browser smoke 核對 107 個本地 HTTP response 的 bytes；IME 階段另核對 24 個，均對應原 checkout 磁碟內容。
驗 chart instance、series／axes、zoom／legend、Escape／路由切換、焦點／inert／scroll cleanup；4 個 smoke phase 與 IME console 沒有 error／warning／pageerror／failed request。
當時 2305 個 snapshot files 與 12 個交付檔指紋未變；browser／server 已關閉，歷史 localhost URL **目前不表示服務仍在執行**。
首次 stress legend 與 IME trust 假設的失敗嘗試有保留；修正的是 workspace 驗證探針／斷言，沒有為測試更改產品或事件屬性。
原始 JSON／log／截圖在當輪交接 artifact bundle，並非 repo 內已建立的可重現全站 test suite；每次新驗收需重新產生證據。

## 已知限制與協作落差

- native macOS IME、實機 Safari／觸控與全 72 頁 chip／focus matrix 尚無本輪原 checkout 的完整證據；不能由 CDP 或桌面模擬推定。
- chartFocus 目前只有兩個 pilot；nested host、不同圖表高度與多圖頁需明確 adapter／驗收才擴展。
- 各 tab 成功 cache、共用 request cache 與 state 有不同所有權；refresh／controller 統一不是低風險外觀整理。
- 0050 的既有規則稱「2014 真實分割」，fetch 原碼描述 vendor adjustment ratio-splice；目前保留實作並明確區分，尚未另做資料 provenance 裁定。
- 舊 ui_harness 檔頭示範 HEAD baseline／排除不同 tab，與目前 WIP＋兩次穩定基準要求不同；以 [TESTING](TESTING.md) 為操作基線，尚未改 harness。
- verifier 接線與 stage 門檻已於第二輪套用；兩套 agent 定義不受 sync script 同步，仍需同義 review。
- 第三輪將局部探針納入 repo 的 `npm run test:browser`；執行／handoff 見 [TESTING](TESTING.md)。browser 仍獨立於離線 checks／CI，不能宣稱 CI 已覆蓋。

## 第二輪候選與第三輪 scope

相對成本是局部估計，須以下一輪 spec 定義實際頁面；shared core 仍由單一整合 owner 修改。

| 候選 | 使用者價值 | 成本／風險／依賴 | 平行工作與驗收 | 現在是否做 |
| --- | --- | --- | --- | --- |
| 1. 將兩頁 targeted browser smoke 整理成可攜 regression 探針 | 減少 UI 回歸漏驗與重建探針成本 | 中／低至中；既有 Playwright runtime、明確 server identity 與資料基準 | 可由 QA owner 獨立做 tests／artifacts，不碰產品 core；驗 focus、keyboard、zoom／legend、console 與 cleanup，標未驗 IME | **第三輪已授權**，僅兩頁 harness |
| 2. 有實際手機缺陷的 2–3 頁復用既有 UI classes | 提升可讀性、減少重複 layout 修復 | 低至中／低；先有畫面證據，沿用 tokens／局部 selector | 分頁 Coding，core CSS／HTML 單 owner；直橫向／短高度、數值／chart state 無回歸 | **條件建議**：只選已確認缺陷頁 |
| 3. wkrev 或 roc4 一頁事件計算移至頁面專用純模組 | 降低下一次策略功能的理解與測試成本 | 中／中；固定 horizon、樣本／缺值契約與 before oracle | 單頁 calc／fixture owner，可與 QA 工具平行；純函式與原式等價、頁面 financial snapshot | **條件建議**：下一個功能需要時先做一頁 |
| 4. 一個具體 nested chart host 的 focus adapter | 支援確定有需求的圖表放大 | 中／中；先確認 host 與 UX，需要 core owner | 勿與其他 chartFocus 改動平行；驗 instance、尺寸、focus／inert、resize／restore | 暫緩，兩個 pilot 不構成全站推廣理由 |
| 5. 通用 controller／refresh store、統一回測或 Portfolio 整合 | 價值待產品需求決定 | 高／高；state、金融口徑及資料權限重大決策 | 低平行度；先做產品與 architecture spec | **現在不做** |

第三輪只做候選 1；其餘候選未啟動。完成後停止，不自行開始第四輪；資料模型或主要 framework 決策仍交使用者。

## 第二輪 checkpoint

未建立 commit：README／CLAUDE／AGENTS 的第二輪 before 已含先前 WIP，且新文件引用未提交 infrastructure；直接 stage 全部 10 檔會混入舊 WIP。index 保持空白，第二輪精確 `changes.patch` 已保留為可 review checkpoint，與其 before／after／handoff 一併保存。第三輪沒有 commit／push／deploy 授權。

## 第三輪 Portable Browser Smoke 驗證

固定 repo 入口 `npm run test:browser`，只涵蓋 trend／stressdash。原 checkout 兩次正常執行各 PASS 29/29，console error／warning／pageerror／failed request 皆 0，135 個本地 HTTP response 與磁碟 hash 一致。Chromium 145.0.7632.6／Playwright 1.58.0，1280×900 與 390×844；native IME／Safari／screen reader／真機 touch 不在覆蓋範圍。
失敗交付 self-test 為預期 exit 1、FAIL 29/30，只有 runner controlled assertion 失敗，保留 screenshot／state／trace；browser／server 已清理。首次 sandbox listen EPERM 的 FAIL 報告亦保留，後續同命令經正常工具權限審查執行，Chromium sandbox 保持開啟。
既有離線 JS before 244/244、加入 3 個 infra unit tests 後 247/247；Python 151/151（既有 conda 3.13.2）。PATH Python 3.10 缺 pandas／yfinance 的初次 import failure 另保存；未安裝 dependency。Node 為 25.4.0，這些本機結果不等於 CI Python 3.11／Node 22 已執行。產品 source／data 與既有 WIP 指紋未改；第三輪未 commit／push／deploy。
