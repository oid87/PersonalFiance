"""Fetch 3-country (TW/US/JP) margin-vs-index "excess growth + turn-down" panel
→ data/liquidity_leverage.json

為什麼:融資餘額會隨股價自然放大(抵押品市值上升),單看融資餘額創高看不出散戶是否在
「主動加碼」。用 excess = margin_yoy − index_yoy 扣掉指數自身漲幅,才抓得到超額槓桿;
行動點 = 超額>0 且 margin_yoy 從高檔翻頭往下(單看高檔可以撐很久,翻頭才是動能轉弱的訊號)。

邏輯照抄自 Financial_work/margin_vs_index_excess.py(已驗證 PASS),搬進本 repo 資料管線,
不是 import(兩個 repo 各自獨立)。全部計算皆 trailing,無未來函數:
    margin_yoy = margin.pct_change(12) * 100
    index_yoy  = index.pct_change(12) * 100
    excess     = margin_yoy - index_yoy
    翻頭 turn_down = margin_yoy.diff().rolling(3).mean() 由正轉負(shift(1)>0 且 現值<=0)
    high_zone      = margin_yoy > margin_yoy.expanding().median()  (只用截至當下資料)
    action_point   = turn_down & high_zone & (excess > 0)

三國資料源(TW 全部重用既有 json,不新抓；US/JP 部分需新抓):
    TW: 融資=data/taiwan_margin_total.json(既有,margin_money 億元)
        指數=data/TWII.json(既有,^TWII 收盤)
        貨幣=data/taiwan_money_supply.json(既有,m1b_yoy/m2_yoy 已是央行公布同比,直接用)
    US: 融資=data/liquidity.json 的 margin[].debit(既有,FINRA margin debit balance,USD millions)
        指數=data/SPY.json(既有,yfinance SPY 收盤,auto_adjust=False)
        貨幣=FRED M2SL 優先重用 data/M2.json(既有,fetch_yields.py 已抓);M1SL 本腳本新抓(無 key CSV)
    JP: 融資=JPX官網「信用取引現在高 過去推移表」xls(新抓,即時,東京・名古屋二市場合計買残高金額,
            百万円,週頻→月底重取樣;起點約 2002-08)
        指數=yfinance ^N225(新抓,月收盤,auto_adjust=False)
        貨幣=FRED MYAGM1JPM189S / MYAGM2JPM189S(新抓;⚠️這兩個 OECD MEI 系列已於 2017-02 起停更,
            2017-02 之後 m1_yoy/m2_yoy 留空,index/margin 不受影響 — graceful 但誠實標注,
            並非「查不到」而是「查到但資料源已停更」)

Graceful degrade:任一子來源失敗,try/except 包住,保留前次 data/liquidity_leverage.json 對應
市場區塊,不得 crash、不得清空既有檔案。
"""
from __future__ import annotations

import csv
import io
import json
import re
import tempfile
import traceback
from datetime import date
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "liquidity_leverage.json"

UA = {"User-Agent": "PersonalFiance/1.0"}


# ─────────────────────────────────────────────────────────────────────────
# Shared calc helpers (trailing only, no lookahead)
# ─────────────────────────────────────────────────────────────────────────
def month_end(s: pd.Series) -> pd.Series:
    """Resample any-frequency series to month-end, re-index to month-start."""
    s = s.sort_index()
    m = s.resample("ME").last()
    m.index = m.index.to_period("M").to_timestamp()
    return m


def yoy(s: pd.Series) -> pd.Series:
    return s.pct_change(12) * 100


def compute_excess_frame(margin_m: pd.Series, index_m: pd.Series) -> pd.DataFrame:
    """Core: margin_yoy / index_yoy / excess + turn-down action_point. All trailing."""
    df = pd.DataFrame({"margin": margin_m, "index": index_m}).sort_index()
    df["margin_yoy"] = yoy(df["margin"])
    df["index_yoy"] = yoy(df["index"])
    df["excess"] = df["margin_yoy"] - df["index_yoy"]

    d1 = df["margin_yoy"].diff()
    mom3 = d1.rolling(3).mean()
    turn = (mom3.shift(1) > 0) & (mom3 <= 0)
    high = df["margin_yoy"] > df["margin_yoy"].expanding().median()
    df["action_point"] = (turn.fillna(False) & high.fillna(False) & (df["excess"] > 0)).fillna(False)
    return df


def rows_from_frame(df: pd.DataFrame, extra: dict[str, pd.Series], extra_names: dict[str, str]) -> list[dict]:
    """Build JSON-safe row list. Requires margin_yoy & index_yoy both present;
    `extra` columns (money supply yoy) are attached where available, else null."""
    out = []
    base = df.dropna(subset=["margin_yoy", "index_yoy"])
    for dt, row in base.iterrows():
        date_str = dt.strftime("%Y-%m-%d")
        rec = {
            "date": date_str,
            "index_yoy": round(float(row["index_yoy"]), 4),
            "margin_yoy": round(float(row["margin_yoy"]), 4),
            "excess": round(float(row["excess"]), 4),
            "action_point": bool(row["action_point"]),
        }
        for col, series in extra.items():
            v = series.get(date_str)
            rec[extra_names[col]] = None if v is None or pd.isna(v) else round(float(v), 4)
        out.append(rec)
    return out


# ─────────────────────────────────────────────────────────────────────────
# TW — 全部重用既有 json,不新抓
# ─────────────────────────────────────────────────────────────────────────
def build_tw() -> dict:
    margin_raw = json.loads((DATA_DIR / "taiwan_margin_total.json").read_text())
    dfm = pd.DataFrame(margin_raw["data"])
    dfm["date"] = pd.to_datetime(dfm["date"])
    margin_daily = dfm.set_index("date")["margin_money"].astype(float)
    margin_m = month_end(margin_daily)
    margin_start = dfm["date"].min().strftime("%Y-%m-%d")

    twii_raw = json.loads((DATA_DIR / "TWII.json").read_text())
    dft = pd.DataFrame(twii_raw["data"])
    dft["date"] = pd.to_datetime(dft["date"])
    idx_daily = dft.set_index("date")["close"].astype(float)
    idx_m = month_end(idx_daily)
    idx_start = dft["date"].min().strftime("%Y-%m-%d")

    df = compute_excess_frame(margin_m, idx_m)

    money_raw = json.loads((DATA_DIR / "taiwan_money_supply.json").read_text())
    m1b_by_date = {r["date"]: r.get("m1b_yoy") for r in money_raw.get("monthly", [])}
    m2_by_date = {r["date"]: r.get("m2_yoy") for r in money_raw.get("monthly", [])}

    monthly = rows_from_frame(
        df,
        extra={"m1b": m1b_by_date, "m2": m2_by_date},
        extra_names={"m1b": "m1b_yoy", "m2": "m2_yoy"},
    )
    return {
        "monthly": monthly,
        "note": (
            f"融資=data/taiwan_margin_total.json(全市場合計融資餘額金額,億元新台幣,起點 {margin_start})；"
            f"指數=data/TWII.json(^TWII 加權指數,起點 {idx_start})；"
            "貨幣=data/taiwan_money_supply.json(央行 M1B/M2 同比,已是官方 YoY,非本腳本重算)。"
            "全部重用既有資料,本腳本未新抓 TW 任何來源。"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────
# US — 指數/融資重用既有 json;M2 優先重用 data/M2.json,M1 新抓 FRED M1SL
# ─────────────────────────────────────────────────────────────────────────
def fetch_fred_monthly_yoy(series_id: str) -> dict[str, float]:
    """FRED no-key CSV → {YYYY-MM-01: yoy%}. Level series, trailing pct_change(12)."""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    by_month: dict[str, float] = {}
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = row.get("observation_date", "").strip()
        v = row.get(series_id, "").strip()
        if not d or v in (".", ""):
            continue
        try:
            by_month[d[:7] + "-01"] = float(v)
        except ValueError:
            continue
    s = pd.Series(by_month).sort_index()
    s.index = pd.to_datetime(s.index)
    return (yoy(s) * 1).dropna().to_dict()  # {Timestamp: yoy%} — converted to str keys below


def fetch_fred_yoy_by_datestr(series_id: str) -> dict[str, float]:
    raw = fetch_fred_monthly_yoy(series_id)
    return {k.strftime("%Y-%m-%d"): v for k, v in raw.items()}


def build_us() -> dict:
    spy_raw = json.loads((DATA_DIR / "SPY.json").read_text())
    dfs = pd.DataFrame(spy_raw["data"])
    dfs["date"] = pd.to_datetime(dfs["date"])
    idx_daily = dfs.set_index("date")["close"].astype(float)
    idx_m = month_end(idx_daily)
    idx_start = dfs["date"].min().strftime("%Y-%m-%d")

    liq_raw = json.loads((DATA_DIR / "liquidity.json").read_text())
    dfm = pd.DataFrame(liq_raw["margin"])
    dfm["date"] = pd.to_datetime(dfm["date"])
    margin_m = dfm.set_index("date")["debit"].astype(float).sort_index()
    margin_m.index = margin_m.index.to_period("M").to_timestamp()
    margin_start = dfm["date"].min().strftime("%Y-%m-%d")

    df = compute_excess_frame(margin_m, idx_m)

    # M2: reuse data/M2.json if present (fetch_yields.py already fetches M2SL) — DRY.
    m2_note = ""
    try:
        m2_raw = json.loads((DATA_DIR / "M2.json").read_text())
        s2 = pd.Series({r["date"]: r["value"] for r in m2_raw["data"]})
        s2.index = pd.to_datetime(s2.index)
        m2_yoy = yoy(s2.sort_index())
        m2_by_date = {dt.strftime("%Y-%m-%d"): v for dt, v in m2_yoy.dropna().items()}
        m2_note = "M2=重用 data/M2.json(FRED M2SL,fetch_yields.py 既有產物)"
    except Exception as exc:
        print(f"  [US money] M2 reuse failed ({exc}); fetching FRED M2SL directly")
        try:
            m2_by_date = fetch_fred_yoy_by_datestr("M2SL")
            m2_note = "M2=FRED M2SL(本腳本直抓,data/M2.json 不可用)"
        except Exception as exc2:
            print(f"  [US money] M2SL FRED fetch also failed ({exc2}); m2_yoy 留空")
            m2_by_date = {}
            m2_note = "M2=不可得(FRED M2SL 抓取失敗)"

    try:
        m1_by_date = fetch_fred_yoy_by_datestr("M1SL")
        m1_note = "M1=FRED M1SL(本腳本新抓,無 key CSV)"
    except Exception as exc:
        print(f"  [US money] M1SL FRED fetch failed ({exc}); m1_yoy 留空")
        m1_by_date = {}
        m1_note = "M1=不可得(FRED M1SL 抓取失敗)"

    monthly = rows_from_frame(
        df,
        extra={"m1": m1_by_date, "m2": m2_by_date},
        extra_names={"m1": "m1_yoy", "m2": "m2_yoy"},
    )
    return {
        "monthly": monthly,
        "note": (
            f"融資=data/liquidity.json margin[].debit(FINRA margin debit balance,USD millions,起點 {margin_start})；"
            f"指數=data/SPY.json(SPY,起點 {idx_start})；{m1_note}；{m2_note}。"
            "美國無 M1B,只有 M1/M2,別跟台灣 M1B 混用。"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────
# JP — 全新抓(指數 yfinance ^N225、融資 JPX xls、貨幣 FRED MYAGM1/2JPM189S)
# ─────────────────────────────────────────────────────────────────────────
def fetch_jp_index() -> tuple[pd.Series, str]:
    idx = yf.download("^N225", start="1990-01-01", auto_adjust=False, progress=False)
    if isinstance(idx.columns, pd.MultiIndex):
        idx.columns = idx.columns.get_level_values(0)
    if idx.empty:
        raise RuntimeError("yfinance ^N225 回傳空資料")
    idx_m = month_end(idx["Close"])
    return idx_m, idx.index.min().strftime("%Y-%m-%d")


def fetch_jp_margin() -> tuple[pd.Series, str]:
    """JPX「信用取引現在高 過去推移表」xls — 東京・名古屋二市場合計買残高金額(百万円)。
    照抄 Financial_work/margin_vs_index_excess.py::fetch_jp() 的欄位/sheet 判別邏輯。
    """
    page_url = "https://www.jpx.co.jp/markets/statistics-equities/margin/06.html"
    r = requests.get(page_url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    links = re.findall(r'href="([^"]+\.xls)"', r.text, re.I)
    if not links:
        raise RuntimeError("JPX 06.html 找不到 .xls 連結")
    base = "https://www.jpx.co.jp"
    target_bytes = None
    with tempfile.TemporaryDirectory() as tmpdir:
        for link in links:
            url = link if link.startswith("http") else base + link
            resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            raw_path = Path(tmpdir) / "jpx_margin_raw.xls"
            raw_path.write_bytes(resp.content)
            try:
                sheet_names = pd.ExcelFile(raw_path).sheet_names
            except Exception:
                continue
            # 只要「信用取引現在高」總表(合計買残高欄),不要一般/制度信用細分表
            if sheet_names and sheet_names[0].strip() == "信用取引現在高":
                target_bytes = raw_path.read_bytes()
                break
        if target_bytes is None:
            raise RuntimeError("JPX 06.html 的 xls 連結中找不到「信用取引現在高」總表(可能改版)")
        df = pd.read_excel(io.BytesIO(target_bytes), header=None)

    # col0=日期, col12=合計買残高 金額(百万円) — 逐行檢查過的固定欄位結構
    data_rows = df[pd.to_datetime(df[0], errors="coerce").notna()]
    dates = pd.to_datetime(data_rows[0])
    values = pd.to_numeric(data_rows[12], errors="coerce")
    s = pd.Series(values.values, index=dates.values).sort_index().dropna()
    if s.empty:
        raise RuntimeError("JPX xls 解析後合計買残高金額欄全空,格式可能已變")
    start = pd.Timestamp(s.index.min()).strftime("%Y-%m-%d")
    return month_end(s), start


def fetch_jp_money() -> tuple[dict, dict, str]:
    """FRED MYAGM1JPM189S / MYAGM2JPM189S — OECD MEI「M1/M2 for Japan」,national currency,
    monthly. ⚠️這兩個系列已於 2017-02 停更(OECD 未再更新 Japan MEI 提交),2017-02 後
    m1_yoy/m2_yoy 留空,但 index/margin 不受影響 — 誠實標注非「查不到」而是「查到但停更」。
    """
    note = ""
    m1_by_date, m2_by_date = {}, {}
    try:
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MYAGM1JPM189S"
        resp = requests.get(url, timeout=30, headers=UA)
        resp.raise_for_status()
        by_month = {}
        for row in csv.DictReader(io.StringIO(resp.text)):
            d = row.get("observation_date", "").strip()
            v = row.get("MYAGM1JPM189S", "").strip()
            if not d or v in (".", ""):
                continue
            by_month[d] = float(v)
        s1 = pd.Series(by_month).sort_index()
        s1.index = pd.to_datetime(s1.index)
        last_date = s1.index.max().strftime("%Y-%m") if len(s1) else "N/A"
        m1_by_date = {dt.strftime("%Y-%m-%d"): v for dt, v in yoy(s1).dropna().items()}
        note += f"M1=FRED MYAGM1JPM189S(國家貨幣,原始序列最後一筆 {last_date}，之後留空)；"
    except Exception as exc:
        print(f"  [JP money] M1 FRED fetch failed ({exc}); m1_yoy 留空")
        note += "M1=不可得(FRED MYAGM1JPM189S 抓取失敗)；"

    try:
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MYAGM2JPM189S"
        resp = requests.get(url, timeout=30, headers=UA)
        resp.raise_for_status()
        by_month = {}
        for row in csv.DictReader(io.StringIO(resp.text)):
            d = row.get("observation_date", "").strip()
            v = row.get("MYAGM2JPM189S", "").strip()
            if not d or v in (".", ""):
                continue
            by_month[d] = float(v)
        s2 = pd.Series(by_month).sort_index()
        s2.index = pd.to_datetime(s2.index)
        last_date = s2.index.max().strftime("%Y-%m") if len(s2) else "N/A"
        m2_by_date = {dt.strftime("%Y-%m-%d"): v for dt, v in yoy(s2).dropna().items()}
        note += f"M2=FRED MYAGM2JPM189S(國家貨幣,原始序列最後一筆 {last_date}，之後留空)。"
    except Exception as exc:
        print(f"  [JP money] M2 FRED fetch failed ({exc}); m2_yoy 留空")
        note += "M2=不可得(FRED MYAGM2JPM189S 抓取失敗)。"

    return m1_by_date, m2_by_date, note


def build_jp() -> dict:
    idx_m, idx_start = fetch_jp_index()
    margin_m, margin_start = fetch_jp_margin()
    df = compute_excess_frame(margin_m, idx_m)

    m1_by_date, m2_by_date, money_note = fetch_jp_money()

    monthly = rows_from_frame(
        df,
        extra={"m1": m1_by_date, "m2": m2_by_date},
        extra_names={"m1": "m1_yoy", "m2": "m2_yoy"},
    )
    return {
        "monthly": monthly,
        "note": (
            f"融資=JPX官網「信用取引現在高 過去推移表」(東京・名古屋二市場合計買残高金額,百万円,"
            f"即時抓取,起點 {margin_start})；指數=yfinance ^N225(起點 {idx_start})；{money_note} "
            "日本無 M1B,只有 M1/M2。"
        ),
    }


# ─────────────────────────────────────────────────────────────────────────
def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def main() -> None:
    existing = load_existing()
    result: dict = {}

    for key, builder, label in [("tw", build_tw, "TW"), ("us", build_us, "US"), ("jp", build_jp, "JP")]:
        try:
            result[key] = builder()
            n = len(result[key]["monthly"])
            print(f"  [{label}] OK — {n} monthly rows")
        except Exception as exc:
            print(f"  [{label}] FAILED ({exc}); keeping previous block if any")
            traceback.print_exc()
            if key in existing:
                result[key] = existing[key]
            else:
                result[key] = {"monthly": [], "note": f"抓取失敗,無前次資料可保留: {exc}"}

    payload = {
        "updated": date.today().isoformat(),
        "source": (
            "TW: FinMind-derived data/taiwan_margin_total.json + data/TWII.json + "
            "data/taiwan_money_supply.json(皆既有,未新抓)。"
            "US: data/liquidity.json(FINRA margin debit) + data/SPY.json(皆既有) + FRED M1SL/M2SL。"
            "JP: JPX 官網信用取引現在高 xls(即時) + yfinance ^N225(即時) + FRED MYAGM1/2JPM189S。"
        ),
        "note": (
            "融資餘額絕對金額各國單位/定義不同不可跨國比較(台=億元、美=USD millions、日=百万円)；"
            "本 json 只提供 YoY%/excess(比率),可跨國比較「相對強度」但不做精確數值加減。"
            "所有計算皆 trailing(pct_change(12)/diff/rolling/expanding 只用截至當下資料),無未來函數。"
            "當月資料未滿月時,margin_yoy/index_yoy/excess 讀數會隨月底重取樣持續變動。"
        ),
        "tw": result["tw"],
        "us": result["us"],
        "jp": result["jp"],
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {OUT.name}: tw={len(result['tw']['monthly'])} us={len(result['us']['monthly'])} "
          f"jp={len(result['jp']['monthly'])} monthly rows")


if __name__ == "__main__":
    main()
