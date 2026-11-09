#!/usr/bin/env python3
"""主流族群每日判定的原始事實 → data/tw_mainstream.json（判定規則在 js/tabs/mainstream_calc.mjs）

來源（免費、免 token）：
  上市：TWSE MI_INDEX（type=ALLBUT0999）每日收盤行情：開高低收、漲跌價差、成交股數
  上櫃：TPEx afterTrading/dailyQuotes：開高低收、漲跌、成交股數
  產業別：TWSE OpenAPI t187ap03_L、TPEx OpenAPI mopsfin_t187ap03_O（現在的快照；已下市的股票沒有產業＝空字串）
只收普通股（4 碼、1～9 開頭）。價格是原始收盤（未還原），漲幅用交易所公布的漲跌價差（已考慮除權息參考價）。

每天每檔算出：
  ret   當日漲幅（%）＝漲跌價差 ÷ 前一日參考價
  vr    成交量 ÷ 前 20 個交易日平均成交量（不含當天；20 日內至少 16 天有量才算）
  hi    收盤 > 前 N 日最高收盤 的最大 N（N ∈ HI_WINDOWS；都沒有＝0）
  lock  開盤即鎖漲停（近似）：開盤漲幅 ≥ 9.5% 且 開＝高＝收
寬鬆門檻（LOOSE）以上的股票才寫進輸出，方便前端改參數校準；正式門檻在 mainstream_calc.mjs。

快取 data/tw_mainstream_bars.json：最近 CACHE_DAYS 個交易日每檔 [收盤, 成交量]，供每日增量。
回補：TW_MS_FLOOR=2021-09-01 TW_MS_MAX_DAYS=2000；TW_MS_RAW_DIR 可指定原始回應暫存資料夾（中斷可續抓）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from datetime import date, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_mainstream.json"
CACHE = ROOT / "data" / "tw_mainstream_bars.json"
TWII = ROOT / "data" / "TWII.json"
HEATMAP = ROOT / "data" / "tw_heatmap.json"
SIGNAL = ROOT / "data" / "tw_mainstream_signal.json"   # 由 build_tw_mainstream_signal.mjs 寫
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
FLOOR = os.environ.get("TW_MS_FLOOR", "2021-09-01")
OUT_FROM = "2022-01-01"
MAX_DAYS = int(os.environ.get("TW_MS_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("TW_MS_SLEEP", "2.5"))
RAW_DIR = os.environ.get("TW_MS_RAW_DIR")
HI_WINDOWS = (20, 40, 60, 120)
CACHE_DAYS = 121
VOL_DAYS, VOL_COVER = 20, 0.8
LOOSE = {"ret": 2.0, "vr": 1.5, "hi": 20}
LOCK_OPEN = 9.5
CODE_RE = re.compile(r"^[1-9]\d{3}$")
MIN_TWSE, MIN_TPEX = 800, 500
INDUSTRY = {
    "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜",
    "08": "玻璃陶瓷", "09": "造紙", "10": "鋼鐵", "11": "橡膠", "12": "汽車", "14": "建材營造",
    "15": "航運", "16": "觀光餐旅", "17": "金融保險", "18": "貿易百貨", "19": "綜合", "20": "其他",
    "21": "化學", "22": "生技醫療", "23": "油電燃氣", "24": "半導體", "25": "電腦及週邊設備",
    "26": "光電", "27": "通信網路", "28": "電子零組件", "29": "電子通路", "30": "資訊服務",
    "31": "其他電子", "32": "文化創意", "33": "農業科技", "34": "電子商務", "35": "綠能環保",
    "36": "數位雲端", "37": "運動休閒", "38": "居家生活",
}


def num(s):
    try:
        v = float(re.sub(r"<[^>]*>", "", str(s)).replace(",", "").strip())
        return v if v == v else None
    except Exception:
        return None


def get(url, params=None, tries=4):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            time.sleep(3 + 5 * i)
        except Exception:
            time.sleep(2 + 3 * i)
    return None


def raw(kind: str, d: str, fetch):
    """原始回應暫存：有 RAW_DIR 就先讀檔。"""
    p = Path(RAW_DIR) / f"{kind}_{d}.json" if RAW_DIR else None
    if p and p.exists():
        return json.loads(p.read_text())
    js = fetch()
    if p and js is not None:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(js, ensure_ascii=False))
    return js


def twse_day(d: str):
    js = raw("twse", d, lambda: get("https://www.twse.com.tw/exchangeReport/MI_INDEX",
                                     {"response": "json", "date": d.replace("-", ""), "type": "ALLBUT0999"}))
    if not js or js.get("stat") != "OK":
        return None
    out = {}
    for t in js.get("tables", []):
        f = [str(x) for x in t.get("fields", [])]
        if "證券代號" not in f or "收盤價" not in f:
            continue
        ix = {k: f.index(k) for k in ("證券代號", "開盤價", "最高價", "收盤價", "漲跌(+/-)", "漲跌價差", "成交股數")}
        for r in t.get("data", []):
            code = str(r[ix["證券代號"]]).strip()
            c, o, h = num(r[ix["收盤價"]]), num(r[ix["開盤價"]]), num(r[ix["最高價"]])
            if not CODE_RE.match(code) or not c:
                continue
            sign = -1 if "-" in str(r[ix["漲跌(+/-)"]]) else 1
            chg = (num(r[ix["漲跌價差"]]) or 0) * sign
            out[code] = (o, h, c, chg, num(r[ix["成交股數"]]))
    return out if len(out) >= MIN_TWSE else None


def tpex_day(d: str):
    js = raw("tpex", d, lambda: get("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes",
                                     {"date": d.replace("-", "/"), "response": "json"}))
    if not js:
        return None
    out = {}
    for t in js.get("tables", []):
        f = [str(x).strip() for x in t.get("fields", [])]
        if "代號" not in f or "收盤" not in f:
            continue
        ix = {k: f.index(k) for k in ("代號", "開盤", "最高", "收盤", "漲跌", "成交股數")}
        for r in t.get("data", []):
            code = str(r[ix["代號"]]).strip()
            c, o, h = num(r[ix["收盤"]]), num(r[ix["開盤"]]), num(r[ix["最高"]])
            if not CODE_RE.match(code) or not c:
                continue
            out[code] = (o, h, c, num(r[ix["漲跌"]]) or 0.0, num(r[ix["成交股數"]]))
    return out if len(out) >= MIN_TPEX else None


NAMES: dict[str, str] = {}


def industries() -> dict[str, str]:
    m = {}
    for r in get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L") or []:
        k = str(r.get("公司代號", "")).strip()
        m[k] = INDUSTRY.get(str(r.get("產業別", "")).strip(), "")
        NAMES[k] = str(r.get("公司簡稱", "")).strip()
    for r in get("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O") or []:
        k = str(r.get("SecuritiesCompanyCode", "")).strip()
        m[k] = INDUSTRY.get(str(r.get("SecuritiesIndustryCode", "")).strip(), "")
        NAMES[k] = str(r.get("CompanyAbbreviation", "")).strip()
    return {k: v for k, v in m.items() if k}


def write_heatmap(d, last_q, ind) -> None:
    """族群熱力圖：最新交易日每檔 [代號, 簡稱, 產業, 漲跌%] → data/tw_heatmap.json。當天沒新抓就補抓那一天。"""
    if not d:
        return
    if last_q is None:
        a, b = twse_day(d), tpex_day(d)
        if a is None or b is None:
            print(f"  heatmap {d}: 行情不完整，保留舊檔")
            return
        q = {**b, **a}
    else:
        q = last_q[1]
    rows = []
    for code, (o, h, c, chg, v) in sorted(q.items()):
        prev = c - chg
        if prev > 0 and ind.get(code):
            rows.append([code, NAMES.get(code, ""), ind[code], round(100 * chg / prev, 2)])
    HEATMAP.write_text(json.dumps({
        "source": "TWSE MI_INDEX、TPEx dailyQuotes 收盤行情；產業別與簡稱 TWSE t187ap03_L、TPEx mopsfin_t187ap03_O",
        "note": "上市＋上櫃普通股，最新交易日 [代號, 簡稱, 產業, 漲跌%]；漲跌＝漲跌價差 ÷ 前一日收盤。沒有產業別（已下市等）不列。",
        "updated": datetime.now().strftime("%Y-%m-%d"), "date": d, "data": rows,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"  heatmap {d}: {len(rows)} 檔")


def trading_dates() -> list[str]:
    rows = json.loads(TWII.read_text())["data"]
    return sorted(r["date"] for r in rows if r.get("date", "") >= FLOOR)


def day_facts(d, quotes, cache, ind):
    """quotes: code → (open, high, close, chg, vol)；cache: code → [[close, vol], ...]（不含當天）。"""
    cands, lock, n = [], 0, 0
    for code, (o, h, c, chg, v) in quotes.items():
        prev = c - chg
        if prev <= 0:
            continue
        n += 1
        ret = 100 * chg / prev
        if o and h and o >= prev * (1 + LOCK_OPEN / 100) and o == h == c:
            lock += 1
        hist = cache.get(code, [])
        hi = 0
        for w in HI_WINDOWS:
            if len(hist) < w or c <= max(x[0] for x in hist[-w:]):
                break
            hi = w
        vols = [x[1] for x in hist[-VOL_DAYS:] if x[1]]
        vr = (v / (sum(vols) / len(vols))) if v and len(vols) >= VOL_DAYS * VOL_COVER else None
        if ret >= LOOSE["ret"] and vr is not None and vr >= LOOSE["vr"] and hi >= LOOSE["hi"]:
            cands.append([code, round(ret, 2), round(vr, 2), hi, ind.get(code, "")])
    cands.sort(key=lambda x: -x[2])
    return {"date": d, "n": n, "lock": lock, "c": cands}


def main() -> None:
    old = json.loads(OUT.read_text()) if OUT.exists() else {"data": []}
    rows = {r["date"]: r for r in old.get("data", [])}
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {"dates": [], "bars": {}}
    bars, cdates = cache["bars"], cache["dates"]
    todo = [d for d in trading_dates() if (not cdates or d > cdates[-1])][:MAX_DAYS]
    ind = industries()
    if not ind:
        raise SystemExit("產業別 OpenAPI 抓不到")
    print(f"{len(todo)} days to fetch; industry map {len(ind)}")
    last_q = None
    for d in todo:
        cached = RAW_DIR and (Path(RAW_DIR) / f"twse_{d}.json").exists() and (Path(RAW_DIR) / f"tpex_{d}.json").exists()
        a, b = twse_day(d), tpex_day(d)
        if not cached:
            time.sleep(SLEEP)
        if a is None or b is None:
            print(f"  {d}: 資料不完整（上市 {a is not None}、上櫃 {b is not None}），停在這裡")
            break
        q = {**b, **a}
        last_q = (d, q)
        if d >= OUT_FROM:
            rows[d] = day_facts(d, q, bars, ind)
        for code, (o, h, c, chg, v) in q.items():
            bars.setdefault(code, []).append([c, v or 0])
        cdates.append(d)
        for code in list(bars):
            if len(bars[code]) > CACHE_DAYS:
                bars[code] = bars[code][-CACHE_DAYS:]
        cdates[:] = cdates[-CACHE_DAYS:]
        if d in rows:
            r = rows[d]
            print(f"  {d}: n={r['n']} lock={r['lock']} loose={len(r['c'])}")
    CACHE.write_text(json.dumps({"note": "滾動快取：最近 121 個交易日每檔 [原始收盤, 成交股數]，供 fetch_tw_mainstream.py 增量", "dates": cdates, "bars": bars}, separators=(",", ":")) + "\n")
    data = [rows[k] for k in sorted(rows)]
    OUT.write_text(json.dumps({
        "source": "TWSE MI_INDEX、TPEx dailyQuotes 每日收盤行情；產業別 TWSE t187ap03_L、TPEx mopsfin_t187ap03_O",
        "note": ("上市＋上櫃普通股，原始收盤。c＝寬鬆門檻以上的候選 [代號, 漲幅%, 量÷前20日均量, 收盤創N日新高的最大N, 產業]；"
                 "lock＝開盤即鎖漲停（近似：開盤漲幅≥9.5%且開＝高＝收）家數；n＝當日納入檔數。"
                 "產業別是現在的快照，已下市股票產業為空。正式判定規則在 js/tabs/mainstream_calc.mjs。"),
        "updated": datetime.now().strftime("%Y-%m-%d"),
        "loose": LOOSE, "hi_windows": list(HI_WINDOWS),
        "data": data,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"wrote {len(data)} rows")
    write_heatmap(cdates[-1] if cdates else None, last_q if last_q and last_q[0] == (cdates[-1] if cdates else None) else None, ind)
    if shutil.which("node"):   # 判定結果（給其他分頁讀）：規則只在 mainstream_calc.mjs 一處
        subprocess.run(["node", str(ROOT / "scripts" / "build_tw_mainstream_signal.mjs")], check=True)


if __name__ == "__main__":
    main()
