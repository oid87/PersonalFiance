---
name: fetch-script
description: >
  為 PersonalFiance 新增一個 fetch_xxx.py 資料腳本，
  並同步更新 update_all.sh、validate_data.py（若需要）、
  以及 GitHub Actions workflow。
  適用於：新增 tab 的資料源、更換現有資料的 API、補歷史資料。
---

# fetch-script skill

## 用途

每新增一個 tab 就需要一個 fetch script。這個 skill 封裝整個流程：
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

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "xxx.json"

UA = {"User-Agent": "PersonalFiance/1.0"}

def fetch_rows() -> "OrderedDict[str, dict]":
    """Return {date: record} keyed by YYYY-MM-DD."""
    ...

def load_existing() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()

def main() -> None:
    existing = load_existing()
    try:
        fresh = fetch_rows()
    except Exception as exc:
        if existing:
            print(f"  [xxx] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
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
- [ ] `load_existing()` + idempotent merge（新覆舊，不是直接覆蓋）
- [ ] try/except：失敗時保留舊資料，不 raise（避免 CI 整批失敗）
- [ ] `User-Agent: PersonalFiance/1.0`
- [ ] date 升序、format 統一
- [ ] 最後一行輸出 row count（CI log 可查）
- [ ] 完成後把新 fetch 腳本與對應 data seed 檔一起 `git add`（不要只 stage
      wiring 檔如 `update_all.sh`/`fetch.yml`）；不執行 commit，由使用者決定

### Step 2：加進 update_all.sh

找到 `scripts/update_all.sh`，在 `validate_data.py` 那行**之前**插入：

```bash
$PYTHON fetch_xxx.py          || true
```

位置：依邏輯順序插（美股日頻放前段、台股放中段、月頻指標放後段）。

### Step 3：確認 validate_data.py 不需要異常處理

`validate_data.py` 做三件事：
1. 偵測 git conflict marker
2. 確認合法 JSON
3. row count 不能比上一次 commit 少 50%

通常不需要改，除非新檔有特殊結構（不是 `data` 陣列）。
如果輸出結構特殊，說明清楚讓使用者決定是否加白名單。

### Step 4：確認 GitHub Actions

查 `.github/workflows/fetch.yml`。這個 workflow 是逐一列出每支腳本的 step（不是跑
`update_all.sh`），所以新增腳本必須手動加一個 step，格式仿現有：

```yaml
      - name: Fetch <說明>
        continue-on-error: true
        run: python scripts/fetch_xxx.py
```

插入位置放在 `Validate data integrity` step 之前。若腳本需要密鑰（如
`FINMIND_TOKEN`），加 `env:` 區塊比照 `fetch_taiwan_fut_inst.py` 的 step。

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
| FRED | `requests.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}")` | 注意 FRED 單位（千/百萬）|
| yfinance | `yf.download(ticker, auto_adjust=True)` | split 斷崖要另外處理 |
| FinMind | 需要 FINMIND_TOKEN env var | 個股資料是付費牆 |
| TAIFEX P/C ratio | HTML 爬蟲 + BeautifulSoup | 2005 起有歷史 |
| FINRA margin debt | 單一 xlsx curl 直抓 | 每月更新一次 |
| OFR FSI | CSV 直抓無需 key | 免費，日頻，2000+ |

## 結尾確認清單

完成後確認使用者知道：
1. 新 `data/xxx.json` 在哪、格式是什麼
2. CI 何時會自動跑（美股/台股收盤後）
3. 本地預覽：`bash scripts/update_all.sh` 只會刷 data/，不 push
4. 如果 tab JS 還沒寫，提示下一步是 `js/tabs/xxx.js`
