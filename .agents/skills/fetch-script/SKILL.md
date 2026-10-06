---
name: fetch-script
description: >
  為 PersonalFiance 新增一個 fetch_xxx.py 資料腳本，
  並同步更新 source_manifest.json、update_all.sh、validate_data.py（若需要）、
  以及 GitHub Actions workflow。
  適用於：新增 tab 的資料源、更換現有資料的 API、補歷史資料。
---

# fetch-script skill

## 用途

新增或更換資料源時使用；新 tab 可直接復用既有資料，不一定需要新 fetch script。這個 skill 封裝資料來源的流程：
從確認資料來源→寫 script→接上 pipeline→驗證，確保沒有遺漏步驟。

## 呼叫方式

```
/fetch-script <目標資料說明>
例：/fetch-script 美國 ISM 製造業 PMI，FRED 免費，月頻
例：/fetch-script 台股融資維持率重建，TWSE 逐檔算法
```

## 分析階段（先做，再動手）

### 1. 確認資料來源

詢問或確認：
- 資料源 URL 與格式（CSV / JSON / HTML / XLS）
- 是否需要認證（FinMind token / FRED key）
- 頻率（日/週/月）
- 歷史起點（會影響 tab 的使用範圍）
- 已知陷阱（split、尾端覆蓋不足、付費牆）

對照 `reference_data_traps` 記憶：
- 有 split 風險嗎（yfinance 股價類）？
- 尾端資料是否滾動更新（會覆蓋）？
- 是否有前視偏誤風險？

### 2. 確認輸出格式

看現有 script 決定輸出結構（`data/xxx.json`）：

```python
# 標準結構（參考 fetch_fsi.py / fetch_umich.py）
{
  "source": "來源說明 (URL)",
  "note": "欄位說明 / 單位 / 注意事項",
  "updated": "YYYY-MM-DD",
  "data": [{"date": "YYYY-MM-DD", ...}]   # 按 date 升序
}
```

月頻資料的 date 慣例：`YYYY-MM-01`（月初）。

## 實作階段

### Step 1：寫 fetch_xxx.py

必須符合的慣例：

```python
"""<一行說明> → data/xxx.json

Sources:
  <來源1> — <說明>
  <來源2> — <說明>

Output data/xxx.json:
  {source, note, updated,
   data: [{date, field1, field2}]}
"""
from __future__ import annotations
import json
from collections import OrderedDict
from datetime import date
from pathlib import Path
import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "xxx.json"

# headers 依來源決定，不要全 repo 統一：新來源先用簡單 UA 試，被擋（如 403 /
# Incapsula）才加完整瀏覽器 headers（參考 AAII 的例子：Referer + 完整瀏覽器
# headers 才過得了 Incapsula）；已驗證過能用的來源，沿用它已驗證的 headers，
# 不要「順手」統一改寫。
UA = {"User-Agent": "Mozilla/5.0"}

def fetch_rows() -> "OrderedDict[str, dict]":
    """Return {date: record} keyed by YYYY-MM-DD."""
    ...

def load_existing() -> "OrderedDict[str, dict]":
    return _common.load_rows_by_date(OUT)  # {date: row}；純 list 用 _common.load_rows(OUT)

def main() -> None:
    existing = load_existing()
    try:
        fresh = fetch_rows()
    except Exception as exc:
        if existing:
            print(f"  [xxx] FAILED ({exc}); keeping {len(existing)} existing rows")
        raise
    merged = OrderedDict(existing)
    merged.update(fresh)          # 新覆舊（idempotent）
    data = [merged[d] for d in sorted(merged)]

    payload = {
        "source": "...",
        "note": "...",
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows")

if __name__ == "__main__":
    main()
```

**必查清單**：
- [ ] `load_existing()` + idempotent merge（新覆舊，不是直接覆蓋）；優先用
      `_common.load_rows_by_date(OUT)` / `_common.load_rows(OUT)`，別自己重寫
      loader。多條序列組列合併用 `_common.idempotent_merge(existing_path, new_rows, key_field="date")`。
- [ ] 失敗時保留舊資料，回傳非零或 raise；optional 路由由 workflow／run_script 控制繼續，不能把失敗報成成功
- [ ] headers 依來源決定，不要全 repo 統一（見上方 UA 的說明）
- [ ] date 升序、format 統一
- [ ] 最後一行輸出 row count（CI log 可查）
- [ ] 完成後把新 fetch 腳本與對應 data seed 檔一起 `git add`（不要只 stage
      wiring 檔如 `update_all.sh`/`fetch.yml`）；不執行 commit，由使用者決定

### Step 2：依實際路由接入本地入口

先核對 `scripts/source_manifest.json` 的 `required`、`routes`、`status` 與 `depends_on`。新來源採已確定的資料契約與路由；不能從範本推定為 optional 或主排程來源。

只有 `routes` 含 `local` 的來源才加入 `scripts/update_all.sh`，放在全庫 `validate_data.py` 之前並遵守依賴順序。按該來源的既有／已確定分類選用其中一種：

```bash
# required 本地路由：失敗停止
run_script required fetch_xxx.py || exit 1
# optional 本地路由：run_script 記錄失敗後繼續，最後仍需驗資料
run_script optional fetch_xxx.py
```

兩行是互斥範例，不是同一來源跑兩次。script 本身不吞錯；繼續或停止由入口的實際路由負責。
`fetch_forward_pe.py` 的 `routes: ["forward_pe"]`／`status: "independent_schedule"` 只走獨立 workflow，不加入本地刷新。`fetch_margin_ratio_mm.py` 的空 routes／`manual_research` 不接入 production 排程。獨立排程或手動來源需在 manifest 記錄實際例外。

### Step 3：登錄並驗證資料契約

在 `scripts/source_manifest.json` 加入 script、outputs、output_contracts、required、routes、status、depends_on。profile 依實際 payload 選擇，特殊結構需明確契約；不能為了通過檢查而放入無條件白名單。詳見 `docs/source-contracts.md`。

`python3 scripts/check_pipeline.py` 驗清單／路由／依賴；`python3 scripts/validate_data.py` 驗必要股票檔、日期／欄位／有限數值、JSONL、macro archive 與資料縮減。Synthetic partial fixture 明確使用 `--allow-partial`，不放寬已知檔案 schema。

### Step 4：確認 GitHub Actions

依 manifest 的實際 `routes` 核對 workflow：`us`／`tw` 走 `.github/workflows/fetch.yml` 對應 job；`forward_pe` 走 `.github/workflows/forward_pe.yml`；manual research 不加入 production 排程。
`fetch.yml` 逐支列 step，不執行 `update_all.sh`。只有走該 job 的新來源才加 step；位置需在資料驗證之前，且符合 `depends_on`。`scheduled_macro_pipeline` 則經現有 macro shell pipeline 接線，不能另建重複 step。

```yaml
      - name: Fetch <說明>
        run: python scripts/fetch_xxx.py
```

此片段只示範執行命令，不設定 failure policy。逐項核對該來源已確定的 workflow 路由；不要一律新增 `continue-on-error: true`，也不要因 manifest 的 `required` 欄位而順帶修改既有 stock step／其他資料發布 policy。若路由或發布規則尚未確定，記錄未定項，範本不能代替決策。
若腳本需要密鑰（如 `FINMIND_TOKEN`），依既有 workflow 的 env 注入方式接線；不把 token 寫進 script、JSON 或報告。

## 驗證

```bash
cd scripts
python3 fetch_xxx.py
# 預期：輸出 "Wrote xxx.json: N rows"
python3 validate_data.py
# 預期：0 failures
```

如果本地沒有資料可驗（e.g. 需要 FinMind token），說明測試方式並提供 mock。

## 常見資料來源模式

| 來源 | 取法 | 注意 |
|------|------|------|
| FRED | `_common.fetch_fred_csv(series_id, headers=...)`；重試包 `_common.retry_call(...)` | 注意 FRED 單位（千/百萬）|
| yfinance | `yf.download(ticker, auto_adjust=False)`（原始收盤價，全 repo 慣例） | split 斷崖要另外處理，參考 `fetch_stocks.py` 的 `SPLICE_FIXES`（idempotent ratio-splice） |
| FinMind | token 一律用 `_common.get_finmind_token()`（CI 讀 `FINMIND_TOKEN` env，本地讀 `.finmind_token`） | 個股資料是付費牆 |
| TAIFEX P/C ratio | HTML 爬蟲 + BeautifulSoup | 2005 起有歷史 |
| FINRA margin debt | 單一 xlsx curl 直抓 | 每月更新一次 |
| OFR FSI | CSV 直抓無需 key | 免費，日頻，2000+ |

## 結尾確認清單

完成後確認使用者知道：
1. 新 `data/xxx.json` 在哪、格式是什麼
2. CI 何時會自動跑（美股/台股收盤後）
3. 本地預覽：`bash scripts/update_all.sh` 刷 data/、不 push、不丟棄本地變動；`--dry-run` 只列步驟，`--sync-data` 才顯式允許條件式 fast-forward pull
4. 如果 tab JS 還沒寫，提示下一步是 `js/tabs/xxx.js`
