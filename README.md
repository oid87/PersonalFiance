# PersonalFiance

個人總經儀表板（長期願景：個人版 [財經 M 平方](https://www.macromicro.me/)）：情緒、流動性、位階、分析四大類，數十個 tab 的圖表與指標。

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
- 兩邊共用同一套協作流程（spec → executor 實作 → verifier 驗收）與同一份 repo 規則：新增 tab、新增資料源、`js/utils` 共用函式速查表、重構驗收方法，都寫在 `CLAUDE.md` / `AGENTS.md`。
- 工作守則：只 stage 該功能相關的檔案（不要 `git add -A`）；`data/` 只由 GitHub Actions 寫入，本地實跑腳本產生的 `data/` 變動不要 commit。

## 快速開始

```bash
python3 -m http.server 8899   # 然後開 http://localhost:8899
```

更新本地資料（僅供預覽；`data/` 由 CI 發佈，本地**不** commit）：

```bash
pip install -r scripts/requirements.txt
bash scripts/update_all.sh
```

FinMind 來源的腳本需要 token：放在 repo 根目錄的 `.finmind_token`（或環境變數 `FINMIND_TOKEN`）；沒有則匿名呼叫（額度低）。

## 專案結構

| 路徑 | 內容 |
|---|---|
| `index.html` | 每個 tab 一個 `<section id="tab-<id>">`；導覽列由 `js/boot.js` 的 `CATEGORIES` 動態產生 |
| `js/boot.js`、`js/switcher.js` | tab 註冊、分類導覽、切換與懶載入 |
| `js/tabs/*.js` | 各 tab（export `init`，選用 `onThemeChange` / `resize`）；新 tab 從 `js/scaffold/_template.js` 起手 |
| `js/utils/` | 共用函式：`theme`（色票 `PALETTE`）、`dates`、`math`、`data`、`dom`（`bindOnce` / `chipPicker`） |
| `css/main.css` | 樣式；主題色用 CSS 變數（`--bg/--panel/--border/--text/--muted`） |
| `scripts/fetch_*.py`、`compute_*.py` | 資料抓取／計算；共用模組 `_common.py`、`_breadth.py` |
| `scripts/update_all.sh` | 本地一次跑完主資料更新（不 commit；forward P/E 由 `forward_pe.yml` 獨立更新，本地不含） |
| `data/*.json` | 前端讀的資料檔，慣例為 `{ "updated": "YYYY-MM-DD", "data": [{ "date": "YYYY-MM-DD", ... }] }` |
| `api/` | Vercel serverless（`trend` tab 即時查任意 ticker） |
| `.github/workflows/` | `fetch.yml`（每日資料）、`forward_pe.yml`（forward P/E） |

清單會隨時間增加，**現況以程式碼為準**：`ls js/tabs/`、`ls scripts/`、`.github/workflows/*.yml`。

## 資料更新

GitHub Actions 每天自動抓取並 commit `data/`（時間皆為台北）：

- `fetch.yml`：06:00 週二–週六（美股收盤後）、18:00 週一–週五（台股收盤後）
- `forward_pe.yml`：13:00 週一–週五

新增資料來源時三處都要加：`scripts/fetch_*.py` → `.github/workflows/fetch.yml`（`continue-on-error: true`）→ `scripts/update_all.sh`。

## 測試

```bash
node --test $(find js -name '*.test.mjs')           # 前端單元測試
python3 -m unittest discover -s scripts/tests        # Python 單元測試（含 agent 文件同步檢查）
python3 ../Financial_work/check_reuse.py             # 共用函式 lint（需要相鄰的 Financial_work repo）
```

前端重構的行為等價驗收用 `js/__tests__/ui_harness.cjs`（Playwright；用法見檔頭與 `CLAUDE.md`）。

## 資料注意事項

- 股價皆為**原始收盤價**（`auto_adjust=False`，未做股息／分割調整；0050 的 2014 分割另有修補）。
- CNN 恐懼貪婪指數最早只到 2011（資料源限制）。
- 其他資料源的陷阱與不可變事實見 `CLAUDE.md`「不可變事實與陷阱」。
