"""台股每日統計（上市＋上櫃）：漲跌／漲跌停家數、觀察類股（帶量創短期新高）家數 → data/tw_daily_stats.json

Sources（免 token）:
  TWSE MI_INDEX（type=ALLBUT0999）— 「漲跌證券數合計」表的「股票」欄（上漲、下跌及其中漲停、跌停），
                                    以及每日收盤行情（逐檔收盤、成交股數）
  TPEx afterTrading/otc（type=EW）— 上櫃逐檔收盤、漲跌、成交股數、次日漲跌停價；
                                    上櫃漲跌停＝收盤觸及「前一交易日公布的次日漲停／跌停價」（缺前一日時用 ±9.5% 近似）

觀察股（個股層級的「第一根且帶大量」；流動性與無觀察門檻相對於過去一年，讓 2013 起的歷史用同一把尺回測）：
  普通股 4 碼代號，當天上漲、收盤 > 前 HIGH_N 個交易日最高收盤（創波段新高，約一個月），
  且成交量 ≥ VOL_MULT × 前 VOL_N 日均量（帶大量）、成交量 ≥ LIQ_FRAC × 前 LIQ_N 日「全市場每日成交張數」平均
  （排除冷門股；2024 年約 1,000 張、2015 年約 500 張）。
  無觀察類股日（no_obs=1）＝觀察股占比（obs_share）落在前 PCT_WIN 日的最低 PCT_Q；不看族群。
  obs_groups（同類股 ≥ GROUP_MIN 檔觀察股的類股數，類股＝tw_sector_map_cache.json）只供參考。
  0050 版（對照用）：obs50／n50＝當天臺灣50成分股（_tw50_history.py 還原的當時名單）中的觀察股數／有效檔數。
  前 PCT_MIN 日歷史不足時 no_obs 留空。參數以 2024（全年約 11 天、集中在 7–8 月）、2025 年 3–4 月（連續約 12 天）
  兩個情況，加上 2013 起各年分布校準，見 docs/research/nonnormal-dashboard.md。

滾動快取 data/tw_daily_stats_cache.json 保留最近 CACHE_DAYS 個交易日的逐檔收盤與成交張數（計算新高與均量用）。
每日增量：抓缺的平日 → 更新快取 → 寫當日統計。首次回補：TW_STATS_MAX_DAYS 設大、TW_STATS_FLOOR 設起點。
相對門檻需要的前一年 lots／obs_share 直接讀既有輸出列，每日增量不必加大快取。
TW_STATS_RAW_DIR：另存每日原始逐檔資料（回補與參數校準用，不進 repo）；
--from-raw DIR：不連網，從原始檔重算全部輸出（改參數後重建歷史用）。

Output data/tw_daily_stats.json:
  {source, note, params, updated,
   data: [{date, up, down, limit_up, limit_down, twse_down, twse_limit_down, tpex_down, tpex_limit_down,
           lots, n, obs, obs_share, obs_groups, no_obs, n50, obs50}]}
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests

import _common
import _tw50_history

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_daily_stats.json"
CACHE = ROOT / "data" / "tw_daily_stats_cache.json"
SECTORS = ROOT / "data" / "tw_sector_map_cache.json"
TWSE = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
TPEX = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
FLOOR = os.environ.get("TW_STATS_FLOOR", "2013-01-02")
MAX_DAYS = int(os.environ.get("TW_STATS_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("TW_STATS_SLEEP", "1.5"))
RAW_DIR = os.environ.get("TW_STATS_RAW_DIR")
UNTIL = os.environ.get("TW_STATS_UNTIL")   # 回補分段用：抓到這天為止（含）

HIGH_N = 20       # 創波段新高：收盤高於前 20 個交易日（約一個月）最高收盤
VOL_N = 10        # 均量天數
VOL_MULT = 2.0    # 帶大量：成交量 ≥ 2 倍 10 日均量
LIQ_N = 250       # 流動性門檻看前一年
LIQ_FRAC = 2e-4   # 成交量 ≥ 全市場日均成交張數的萬分之 2（排除冷門股，隨市場量能調整）
LIQ_MIN = 20      # 前面不到 20 日時不算
GROUP_MIN = 3     # 參考用：同類股 ≥ 3 檔觀察股的類股數（不影響 no_obs）
PCT_WIN = 250     # 觀察股占比和前一年比
PCT_Q = 0.04      # 落在最低 4% 才算「沒有」
PCT_MIN = 120     # 歷史不足 120 日時 no_obs 留空
CACHE_DAYS = max(HIGH_N, VOL_N) + 1
MIN_TWSE, MIN_TPEX = 600, 400   # 逐檔表檔數下限；低於視為殘缺
CODE_RE = re.compile(r"^[1-9]\d{3}$")
LIMIT_APPROX = 0.095


def num(s):
    try:
        return float(re.sub(r"[,\s]", "", str(s)))
    except Exception:
        return None


def get_json(url, params, tries=3):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                time.sleep(3 + 5 * i)
                continue
        except Exception:
            time.sleep(2 + 3 * i)
    return None


def split_count(s):
    """'2,880(1,333)' → (2880, 1333)"""
    m = re.match(r"^\s*([\d,]+)\s*\(\s*([\d,]+)\s*\)", str(s))
    return (int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))) if m else (None, None)


def fetch_twse(d_iso):
    j = get_json(TWSE, {"response": "json", "date": d_iso.replace("-", ""), "type": "ALLBUT0999"})
    if not j or j.get("stat") != "OK":
        return None
    summ, px = {}, {}
    for t in j.get("tables", []):
        f = [str(x).strip() for x in t.get("fields", [])]
        if "漲跌證券數" in str(t.get("title")) and "股票" in f:
            k = f.index("股票")
            for r in t["data"]:
                if str(r[0]).startswith("上漲"):
                    summ["up"], summ["limit_up"] = split_count(r[k])
                elif str(r[0]).startswith("下跌"):
                    summ["down"], summ["limit_down"] = split_count(r[k])
        if "證券代號" in f and "收盤價" in f and "成交股數" in f:
            ci, pi, vi = f.index("證券代號"), f.index("收盤價"), f.index("成交股數")
            for r in t["data"]:
                code, c, v = str(r[ci]).strip(), num(r[pi]), num(r[vi])
                if CODE_RE.match(code) and c and c > 0 and v is not None:
                    px[code] = [c, round(v / 1000)]
    if len(px) < MIN_TWSE or None in (summ.get("down"), summ.get("limit_down")):
        return None
    return {"summary": summ, "px": px}


def fetch_tpex(d_iso, prev_limits):
    y, m, d = d_iso.split("-")
    j = get_json(TPEX, {"date": f"{y}/{m}/{d}", "type": "EW", "response": "json"})
    tables = (j or {}).get("tables") or []
    if not tables or not tables[0].get("data"):
        return None
    t = tables[0]
    f = [str(x).strip() for x in t.get("fields", [])]
    try:
        ci, pi, chi, vi = f.index("代號"), f.index("收盤"), f.index("漲跌"), f.index("成交股數")
    except ValueError:
        return None
    ui = f.index("次日漲停價") if "次日漲停價" in f else None
    li = f.index("次日跌停價") if "次日跌停價" in f else None
    px, limits, s = {}, {}, {"up": 0, "down": 0, "limit_up": 0, "limit_down": 0}
    for r in t["data"]:
        code = str(r[ci]).strip()
        if not CODE_RE.match(code):
            continue
        c, ch, v = num(r[pi]), num(r[chi]), num(r[vi])
        if ui is not None and li is not None:
            limits[code] = [num(r[ui]), num(r[li])]
        if not c or c <= 0 or ch is None or v is None:
            continue
        px[code] = [c, round(v / 1000)]
        prev = c - ch
        pl = prev_limits.get(code)
        if ch > 0:
            s["up"] += 1
            if (pl and pl[0] and c >= pl[0] - 1e-9) or (not pl and prev > 0 and ch / prev >= LIMIT_APPROX):
                s["limit_up"] += 1
        elif ch < 0:
            s["down"] += 1
            if (pl and pl[1] and c <= pl[1] + 1e-9) or (not pl and prev > 0 and ch / prev <= -LIMIT_APPROX):
                s["limit_down"] += 1
    if len(px) < MIN_TPEX:
        return None
    return {"summary": s, "px": px, "limits": limits}


def relative_limits(prev):
    """prev：當天以前的輸出列（升序）。回傳 (流動性張數門檻, obs_share 低標)；歷史不足時為 None。"""
    lots = [r["lots"] for r in prev[-LIQ_N:] if r.get("lots")]
    share = sorted(r["obs_share"] for r in prev[-PCT_WIN:] if r.get("obs_share") is not None)
    min_lots = LIQ_FRAC * sum(lots) / len(lots) if len(lots) >= LIQ_MIN else None
    low = share[int(PCT_Q * len(share))] if len(share) >= PCT_MIN else None
    return min_lots, low


def observe(dates, series, sectors, min_lots, low=None, members=frozenset()):
    """series: {code: [[close, lots] | None, ...]}（與 dates 對齊，最後一筆＝當天）。members：當天的臺灣50成分股（另計 obs50／n50）。"""
    need = max(HIGH_N, VOL_N) + 1
    if len(dates) < need or min_lots is None:
        return None
    n = obs = n50 = obs50 = 0
    groups = {}
    for code, s in series.items():
        w = s[-need:]
        if len(w) < need or w[-1] is None:
            continue
        hist = [x for x in w[:-1] if x is not None]
        if len(hist) < need - 1:
            continue
        n += 1
        in50 = code in members
        n50 += in50
        c, lots = w[-1]
        prev_c = hist[-1][0]
        hi = max(x[0] for x in hist[-HIGH_N:])
        avg = sum(x[1] for x in hist[-VOL_N:]) / VOL_N
        if c > hi and c > prev_c and lots >= min_lots and lots >= VOL_MULT * avg:
            obs += 1
            obs50 += in50
            g = sectors.get(code)
            if g:
                groups[g] = groups.get(g, 0) + 1
    og = sum(1 for v in groups.values() if v >= GROUP_MIN)
    share = round(obs / n, 5) if n else None
    no_obs = None if low is None or share is None else int(share <= low)
    return {"n": n, "obs": obs, "obs_share": share, "obs_groups": og, "no_obs": no_obs, "n50": n50, "obs50": obs50}


def load_cache():
    if not CACHE.exists():
        return [], {}, {}
    try:
        c = json.loads(CACHE.read_text())
        return c.get("dates", []), c.get("px", {}), c.get("tpex_limits", {})
    except Exception:
        return [], {}, {}


def save_cache(dates, series, limits):
    keep = dates[-CACHE_DAYS:]
    off = len(dates) - len(keep)
    out = {code: s[off:] for code, s in series.items() if any(x is not None for x in s[off:])}
    CACHE.write_text(json.dumps({"note": "滾動快取：最近交易日的逐檔 [收盤, 成交張數]（上市＋上櫃普通股）與上櫃次日漲跌停價，供 fetch_tw_daily_stats.py 計算觀察類股",
                                 "dates": keep, "px": out, "tpex_limits": limits},
                                ensure_ascii=False, separators=(",", ":")) + "\n")


def save_out(rows):
    data = [rows[d] for d in sorted(rows)]
    OUT.write_text(json.dumps({
        "source": "TWSE MI_INDEX（漲跌證券數合計・股票）＋ TPEx 上櫃每日收盤行情，自算",
        "note": ("上市＋上櫃股票的上漲／下跌與其中漲停／跌停家數（上市用交易所統計；上櫃以前一交易日公布的次日漲跌停價判斷）。"
                 "lots＝上市＋上櫃普通股當天成交張數合計。"
                 "觀察股＝當天上漲、收盤創前 20 日新高、成交量 ≥ 2 倍 10 日均量，且 ≥ 前 250 日全市場日均成交張數萬分之 2 的普通股；"
                 "obs_share＝觀察股占有效檔數比例；obs_groups＝有 ≥ 3 檔觀察股的類股數（參考用）；"
                 "no_obs=1 表示 obs_share 落在前 250 日最低 4%（前 120 日歷史不足時為 null）。"
                 "obs50／n50＝當天臺灣50成分股（當時名單）中的觀察股數／有效檔數（對照用）。原始收盤（未還原）。"),
        "params": {"high_n": HIGH_N, "vol_n": VOL_N, "vol_mult": VOL_MULT, "liq_n": LIQ_N, "liq_frac": LIQ_FRAC,
                   "group_min": GROUP_MIN, "pct_win": PCT_WIN, "pct_q": PCT_Q, "pct_min": PCT_MIN},
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    return data


def add_day(d_iso, rec, dates, series, sectors, prev):
    px = {**rec["tpex"]["px"], **rec["twse"]["px"]}
    for code in set(series) | set(px):
        series.setdefault(code, [None] * len(dates)).append(px.get(code))
    dates.append(d_iso)
    a, b = rec["twse"]["summary"], rec["tpex"]["summary"]
    row = {"date": d_iso, "lots": sum(v[1] for v in px.values() if v), "up": a["up"] + b["up"], "down": a["down"] + b["down"],
           "limit_up": a["limit_up"] + b["limit_up"], "limit_down": a["limit_down"] + b["limit_down"],
           "twse_down": a["down"], "twse_limit_down": a["limit_down"], "tpex_down": b["down"], "tpex_limit_down": b["limit_down"]}
    ob = observe(dates, series, sectors, *relative_limits(prev), members=_tw50_history.members_on(d_iso))
    if ob:
        row.update(ob)
    # 只保留計算需要的長度，回補時記憶體不會一直長
    if len(dates) > CACHE_DAYS * 3:
        cut = len(dates) - CACHE_DAYS
        del dates[:cut]
        for code in list(series):
            series[code] = series[code][cut:]
            if not any(x is not None for x in series[code]):
                del series[code]
    return row


def load_sectors():
    try:
        return json.loads(SECTORS.read_text()).get("map", {})
    except Exception:
        return {}


def rebuild_from_raw(raw_dir):
    """從原始檔重算；比原始檔更新的既有列（每日排程已抓的）保留，快取若比原始檔新也保留。"""
    sectors, rows, dates, series = load_sectors(), {}, [], {}
    files = sorted(Path(raw_dir).glob("*.json"))
    prev = []
    for p in files:
        rec = json.loads(p.read_text())
        rows[rec["date"]] = row = add_day(rec["date"], rec, dates, series, sectors, prev)
        prev.append(row)
    last = dates[-1] if dates else ""
    newer = {d: r for d, r in _common.load_rows_by_date(OUT).items() if d > last}
    rows.update(newer)
    cached = load_cache()[0]
    if not cached or cached[-1] <= last:
        save_cache(dates, series, {})
    data = save_out(rows)
    print(f"Rebuilt {OUT.name} from {len(files)} raw days (+{len(newer)} newer rows kept): {len(data)} rows ({data[0]['date']} → {data[-1]['date']})")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--from-raw":
        return rebuild_from_raw(sys.argv[2])
    sectors = load_sectors()
    if not sectors:
        print("  [tw_daily_stats] WARNING: no sector map; obs_groups will be 0", flush=True)
    rows = _common.load_rows_by_date(OUT)
    dates, series, limits = load_cache()
    start = date.fromisoformat(dates[-1]) + timedelta(days=1) if dates else date.fromisoformat(FLOOR)
    todo, d = [], start
    end = min(date.today(), date.fromisoformat(UNTIL)) if UNTIL else date.today()
    while d <= end:
        if d.weekday() < 5:
            todo.append(d.isoformat())
        d += timedelta(days=1)
    todo = todo[:MAX_DAYS]
    print(f"{len(rows)} existing rows · cache {len(dates)} days · {len(todo)} days to fetch (cap {MAX_DAYS})", flush=True)
    if RAW_DIR:
        Path(RAW_DIR).mkdir(parents=True, exist_ok=True)
    fetched = 0
    for d_iso in todo:
        tw = fetch_twse(d_iso)
        time.sleep(SLEEP)
        if tw is None:
            continue   # 假日或殘缺表
        tp = fetch_tpex(d_iso, limits)
        time.sleep(SLEEP / 2)
        if tp is None:
            print(f"  [tw_daily_stats] {d_iso}: TWSE ok but TPEx missing; skip day", flush=True)
            continue
        limits = tp.pop("limits")
        rec = {"date": d_iso, "twse": tw, "tpex": tp}
        if RAW_DIR:
            (Path(RAW_DIR) / f"{d_iso}.json").write_text(json.dumps(rec, separators=(",", ":")))
        prev = [rows[k] for k in sorted(rows) if k < d_iso][-max(LIQ_N, PCT_WIN):]
        rows[d_iso] = add_day(d_iso, rec, dates, series, sectors, prev)
        fetched += 1
        if fetched % 25 == 0:
            save_cache(dates, series, limits)
            save_out(rows)
            print(f"  ...{fetched} days · latest {d_iso} {rows[d_iso]}", flush=True)
    if fetched == 0 and not rows:
        raise RuntimeError("no daily stats rows produced")
    save_cache(dates, series, limits)
    data = save_out(rows)
    print(f"Wrote {OUT.name}: {len(data)} rows ({data[0]['date']} → {data[-1]['date']}); +{fetched} days fetched")


if __name__ == "__main__":
    main()
