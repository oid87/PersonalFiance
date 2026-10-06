# PersonalFiance

個人總經儀表板（長期願景：個人版 [財經 M 平方](https://www.macromicro.me/)）：8 個分類、72 個畫面的圖表與指標，支援搜尋、收藏與畫面深連結。

- 線上版：<https://personal-fiance-nine.vercel.app>（Vercel，push 到 `main` 即自動部署）
- 純前端 SPA，**無建置步驟**：`index.html` + `js/boot.js` + `js/tabs/*.js`（ES module）+ ECharts（CDN）
- 資料是 `data/*.json`，由 `scripts/fetch_*.py`（Python：yfinance / requests / FinMind / FRED…）每天自動抓取

> 本 README 給人看、也給 AI agent 當入口。**細節規則以 `CLAUDE.md`（= `AGENTS.md`）為準**，這裡只放導覽。

## 給 AI agent（Claude Code / Codex / ChatGPT）

| 工具 | 讀這些 | 備註 |
|---|---|---|
| Claude Code | `CLAUDE.md`、`.claude/skills/`、`.claude/agents/` | `.claude/` 在 `.gitignore`，只存在本機 |
| Codex / ChatGPT | `AGENTS.md`、`.agents/skills/`、`.codex/agents/` | `AGENTS.md` 與 `.agents/skills/` 是**產生檔** |

- **唯一來源是 `CLAUDE.md` 與 `.claude/skills/`**。改完後跑 `python3 scripts/sync_agent_docs.py` 重新產生 `AGENTS.md` 與 `.agents/skills/`；`scripts/tests/test_agent_docs.py` 會在兩邊不同步時失敗。
- `.codex/agents/` 與 `.claude/agents/` 由人工保持同義，不屬於 sync script 範圍。當次使用者 scope 與授權優先。

## 工程知識入口

先讀適用的 repo 規則與 dated snapshot，再按任務選入口；不用每次重讀全部頁面。

| 文件 | 責任／何時讀 |
| --- | --- |
| [PROJECT_CONTEXT](PROJECT_CONTEXT.md) | 產品用途、8 類／72 頁、資料流與金融語意 |
| [ARCHITECTURE](ARCHITECTURE.md) | 「改 X → 讀哪些模組」、核心／擴充點、重複與抽象邊界 |
| [AGENT_RULES](AGENT_RULES.md) | PM／Coding／QA handoff、file ownership、WIP 與交付證據 |
| [TESTING](TESTING.md) | scope 對應 checks、環境前提、browser／IME 證據限制 |
| [CURRENT_STATE](CURRENT_STATE.md) | 日期、驗證來源、工程主幹、剩餘 WIP 與限制 |

細節規則的唯一來源仍是 CLAUDE.md；根文件是短摘要與索引，深契約保留在 `docs/`，原碼與本次驗證決定現況。

## 快速開始

```bash
python3 -m http.server 8899   # 然後開 http://localhost:8899
```

環境準備與本地資料預覽見 [development](docs/development.md)。fetch 會連網及寫入 `data/`，不是啟動 UI 或驗收的必要步驟；本地資料不 commit。
資料／token 來源與不可任改的金融語意見 [PROJECT_CONTEXT](PROJECT_CONTEXT.md) 及 CLAUDE.md。
專案結構與功能改動入口見 [ARCHITECTURE](ARCHITECTURE.md)，不以 `js/tabs/` 的檔案數當作頁數。

## 資料更新

GitHub Actions 每天自動抓取並 commit `data/`（時間皆為台北）：

- `fetch.yml`：06:00 週二–週六（美股收盤後）、18:00 週一–週五（台股收盤後）
- `forward_pe.yml`：13:00 週一–週五

新增資料來源須更新 `scripts/source_manifest.json` 與對應 workflow／本地路由，並通過 `scripts/check_pipeline.py`；[資料契約](docs/source-contracts.md) 說明 profile、缺檔與例外。

本地更新預設不執行 Git 操作；`--dry-run` 可只列步驟。只有明確指定 `--sync-data` 且 main 的 data 無變動，才允許 fast-forward pull。

## 測試與細部契約

離線檢查、局部 tests、reuse／data validators、browser before／after 與安全 fallback 見 [TESTING](TESTING.md)。
依改動 scope 選必要 checks，回報實際 runtime、命令／結果與未驗項；沒有 build 步驟。
手機驗收包含 390×844、844×390 與短高度；Chromium 模擬不等同實機 Safari。

[載入與圖表生命週期](docs/runtime-contracts.md)、[選單操作](docs/navigation.md)、[共用 UI](docs/ui-components.md)、[資料來源](docs/source-contracts.md)、[Python 共用函式](docs/shared-python.md) 是各領域詳細契約。
