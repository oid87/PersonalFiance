"""台股大盤融資維持率 — 同時重建「玩股網式(含ETF)」與「M平方式(分子排除ETF)」兩種口徑。

背景：2026-07 台股「融資維持率之亂」暴露出各數據商口徑不一致 —— 證交所整戶合併 175%、
XQ全球贏家(含ETF) 163%、CMoney/財經M平方(排除ETF) 143%/140%。既有
`fetch_taiwan_margin_ratio.py` 只產出含ETF口徑一種，且僅回補到 2022-12。本腳本補上
排除ETF口徑，並可回補到 2004（TWSE MI_MARGN 逐檔表實測 2004 起欄位版型一致）。

公式
  分子A 全部擔保品市值  = Σ_全部檔 (融資今日餘額張 × 收盤 × 1000)
  分子B 排除ETF擔保品   = Σ_非ETF檔 (融資今日餘額張 × 收盤 × 1000)
  分母   融資餘額金額   = MI_MARGN 市場彙總「融資金額(仟元)」今日餘額 × 1000  ← 兩種口徑共用
  ratio_all   = 分子A / 分母 × 100   (玩股網 / XQ全球贏家式)
  ratio_exetf = 分子B / 分母 × 100   (財經M平方 / CMoney式；分子排除ETF但分母仍是全市場)

ETF 判定：證券代號以 "00" 開頭。台股上市普通股代號一律 1000–9999（首碼 1–9），
以 00 開頭者為 ETF / ETN / 早期封閉式基金（0001 鴻運、0015 富邦等）。後者嚴格說不是 ETF，
但同屬非普通股且 2004 年前後融資額極小（實測影響 <0.1pt），一併排除。

已知限制：ratio_exetf 相對財經M平方官網公布值仍有系統性落差（2026-07-28 本式 154.93%
vs M平方官網 140.38%，差 14.55pt），成因未明 —— 可能 M平方另外排除全額交割/處置/警示股，
或分子分母日期未對齊。本腳本只保證口徑定義透明可複現，不宣稱等同 M平方官網數字。
2024-08-05 本式算得 140.90%，與用戶記憶的 M平方顯示值 140.x% 吻合，落差大小本身不穩定。

每交易日 2 個 TWSE request，keep-alive session + 禮貌間隔 + 重試，idempotent 合併 → 可重跑/續傳。
回補順序刻意用 **stride 分層**（先每 32 天一點，再 16、8、4、2、1 逐層加密）而非單純
newest-first：2004 起全段近 5,900 個交易日、單跑數小時，分層讓任一時點的部分結果都是
全歷史的近均勻樣本，可以先看出整段輪廓（哪些年份逼近門檻）再等細節補齊，不必等跑完。
Output: data/taiwan_margin_ratio_mm.json
        {source, note, updated, data:[{date, ratio_all, ratio_exetf, collateral_all_yi,
                                       collateral_exetf_yi, margin_yi, n, n_etf}]}
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_margin_ratio_mm.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
MARGN = "https://www.twse.com.tw/exchangeReport/MI_MARGN"
MINDEX = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
FLOOR = os.environ.get("MM_FLOOR", "2004-01-01")
CEIL = os.environ.get("MM_CEIL", "")  # 空 = today
MAX_DAYS = int(os.environ.get("MM_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("MM_SLEEP", "0.5"))
ONLY = [d for d in os.environ.get("MM_ONLY", "").split(",") if d]  # 指定日期驗證用

SESS = requests.Session()  # keep-alive：省掉每個 request 的 TCP+TLS handshake


def is_etf(code: str) -> bool:
    """非普通股（ETF/ETN/受益憑證）：代號以 00 開頭。普通股一律 1000–9999。"""
    return str(code).strip().startswith("00")


def num(s):
    try:
        return float(str(s).replace(",", "").replace(" ", ""))
    except Exception:
        return None


def get_json(url, params, tries=4):
    for i in range(tries):
        try:
            r = SESS.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                time.sleep(3 + 4 * i)
                continue
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def fetch_day(d_iso):
    ymd = d_iso.replace("-", "")
    mg = get_json(MARGN, {"response": "json", "date": ymd, "selectType": "ALL"})
    if not mg or mg.get("stat") != "OK" or not mg.get("tables"):
        return None
    rows = max(mg["tables"], key=lambda t: len(t.get("data", [])))["data"]
    lots = {}
    for r in rows:
        v = num(r[6]) if len(r) > 6 else None  # 融資今日餘額(張)
        if v is not None and r[0]:
            lots[str(r[0]).strip()] = v
    if not lots:
        return None

    margin_money = None
    for t in mg["tables"]:
        for r in t.get("data", []):
            if r and "融資金額" in str(r[0]):
                margin_money = num(r[-1])
                break
        if margin_money:
            break
    if not margin_money:
        return None
    den = margin_money * 1000.0

    time.sleep(SLEEP)
    px = get_json(MINDEX, {"response": "json", "date": ymd, "type": "ALLBUT0999"})
    if not px or px.get("stat") != "OK":
        return None
    closes = {}
    for t in px.get("tables", []):
        f = t.get("fields", [])
        ci = [i for i, x in enumerate(f) if "代號" in str(x)]
        pi = [i for i, x in enumerate(f) if "收盤" in str(x)]
        if ci and pi:
            for r in t["data"]:
                v = num(r[pi[0]])
                if v is not None:
                    closes[str(r[ci[0]]).strip()] = v
    if not closes:
        return None

    matched = [c for c in lots if c in closes and closes[c]]
    if len(matched) < 0.5 * len(lots):  # coverage guard — 部分價格表 → 跳過
        return None
    coll_all = sum(lots[c] * closes[c] * 1000.0 for c in matched)
    etfs = [c for c in matched if is_etf(c)]
    coll_etf = sum(lots[c] * closes[c] * 1000.0 for c in etfs)
    coll_ex = coll_all - coll_etf
    return {
        "date": d_iso,
        "ratio_all": round(coll_all / den * 100, 2),
        "ratio_exetf": round(coll_ex / den * 100, 2),
        "collateral_all_yi": round(coll_all / 1e8, 1),
        "collateral_exetf_yi": round(coll_ex / 1e8, 1),
        "margin_yi": round(den / 1e8, 1),
        "n": len(matched),
        "n_etf": len(etfs),
    }


def missing_trading_days(have):
    """[FLOOR, CEIL] 內尚未抓過的平日，依 stride 分層排序（32→16→8→4→2→1）。

    每層取「index % stride == 0 且尚未被前層取走」的日子，層內 newest-first。
    效果：跑到任何一個中途點停下來，手上的樣本都均勻散佈在整段歷史上，
    而不是只有最近幾個月密、2004–2020 全空。
    """
    days = []
    d = date.fromisoformat(CEIL) if CEIL else date.today()
    floor = date.fromisoformat(FLOOR)
    while d >= floor:
        if d.weekday() < 5 and d.isoformat() not in have:
            days.append(d.isoformat())
        d -= timedelta(days=1)
    out, taken = [], set()
    for stride in (32, 16, 8, 4, 2, 1):
        for i, iso in enumerate(days):
            if i % stride == 0 and iso not in taken:
                taken.add(iso)
                out.append(iso)
    return out


def save(by_date):
    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "TWSE MI_MARGN(逐檔融資張+融資金額彙總) × MI_INDEX(收盤)",
        "note": ("ratio_all=含ETF(玩股網/XQ式); ratio_exetf=分子排除ETF、分母仍為全市場融資餘額"
                 "(財經M平方/CMoney式). ETF判定=代號以00開頭. 上市only. "
                 "ratio_exetf 與M平方官網值仍有未解落差(2026-07-28: 本式154.93 vs 官網140.38)."),
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")


def main():
    by_date = {}
    if OUT.exists():
        try:
            by_date = {r["date"]: r for r in json.loads(OUT.read_text()).get("data", [])}
        except Exception:
            by_date = {}
    todo = ONLY if ONLY else missing_trading_days(set(by_date))[:MAX_DAYS]
    print(f"{len(by_date)} existing · {len(todo)} days to fetch "
          f"(cap {MAX_DAYS}, floor {FLOOR}, ceil {CEIL or 'today'})", flush=True)

    done = skipped = 0
    for d in todo:
        res = fetch_day(d)
        if res:
            by_date[d] = res
            done += 1
            if done % 20 == 0:
                save(by_date)
                print(f"  ...{done} fetched · {d} all={res['ratio_all']}% "
                      f"exETF={res['ratio_exetf']}% (saved)", flush=True)
        else:
            skipped += 1
        time.sleep(SLEEP)

    save(by_date)
    data = sorted(by_date.values(), key=lambda r: r["date"])
    if data:
        print(f"Wrote {len(data)} rows ({data[0]['date']}..{data[-1]['date']}); "
              f"+{done} new, {skipped} skipped this run", flush=True)


if __name__ == "__main__":
    main()
