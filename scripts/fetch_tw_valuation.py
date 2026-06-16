"""Fetch 台灣加權指數 (0050/TWII) 本益比 and append to data/TW_valuation.json.

Method:
  1. Get live 0050.TW top holdings from yfinance (holdingPercent weights).
  2. For each holding (e.g. 2330.TW), fetch trailing P/E from TWSE BWIBBU_d endpoint.
     TWSE calculates P/E using the latest quarterly EPS × 4 — close to forward PE
     for growing companies.
  3. Cap outliers at PE_CAP (40x) to avoid distortion from anomalous quarters.
  4. Compute weighted arithmetic mean; renormalize weights after exclusions.
  5. Fallback: if yfinance coverage < 40%, use yfinance trailingPE for 0050.TW directly.

Note: TWSE publishes trailing PE, not forward PE. For TSMC (>60% of 0050) this tracks
      well with analyst forward estimates given secular earnings growth.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "TW_valuation.json"

PE_CAP = 40.0

TWSE_URL = (
    "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d"
    "?date={ymd}&type=MS&response=json"
)
TWSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.twse.com.tw/zh/",
    "Accept": "application/json, */*",
}

# Fallback: top-20 0050 holdings, approximate weights as of 2026-06 (元大投信)
# Update quarterly. Weights in 0-100 scale.
HOLDINGS_FALLBACK: dict[str, float] = {
    "2330": 60.0,   # 台積電 TSMC
    "2454": 5.2,    # 聯發科 MediaTek
    "2308": 4.2,    # 台達電 Delta Electronics
    "2317": 3.4,    # 鴻海 Hon Hai
    "3711": 1.8,    # 日月光 ASE Technology
    "2382": 1.5,    # 廣達 Quanta
    "2881": 1.4,    # 富邦金 Fubon Financial
    "2891": 1.3,    # 中信金 CTBC Financial
    "2882": 1.2,    # 國泰金 Cathay Financial
    "1301": 1.1,    # 台塑 Formosa Plastics
    "2886": 1.0,    # 兆豐金 Mega Financial
    "2412": 1.0,    # 中華電 Chunghwa Telecom
    "1303": 0.9,    # 南亞 Nan Ya Plastics
    "3008": 0.9,    # 大立光 LARGAN
    "2379": 0.8,    # 瑞昱 Realtek
    "5876": 0.7,    # 上海商銀 SinoPac
    "2885": 0.7,    # 元大金 Yuanta Financial
    "6505": 0.6,    # 台塑化 Formosa Petrochem
    "2395": 0.6,    # 研華 Advantech
    "2303": 0.6,    # 聯電 UMC
}


def fetch_live_holdings() -> dict[str, float] | None:
    """Get live 0050.TW holdings from yfinance. Returns {tw_code: weight_pct}."""
    try:
        t = yf.Ticker("0050.TW")
        top = t.funds_data.top_holdings
        if top is None or top.empty:
            return None
        holdings = {}
        for sym, row in top.iterrows():
            # yfinance returns "2330.TW" style; strip ".TW"
            code = str(sym).upper().replace(".TW", "").replace(".TWO", "")
            pct = row.get("Holding Percent", row.get("holdingPercent", 0))
            if code and pct:
                holdings[code] = float(pct) * 100
        return holdings if holdings else None
    except Exception as e:
        print(f"  [live holdings] failed: {e}")
        return None


def fetch_twse_pe(ymd: str) -> dict[str, float]:
    """Fetch {stock_code: trailing_pe} from TWSE BWIBBU_d for the given date."""
    try:
        url = TWSE_URL.format(ymd=ymd)
        resp = requests.get(url, headers=TWSE_HEADERS, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        pe_map = {}
        for row in data.get("data", []):
            # row: [code, name, close, yield, div_year, pe, pb, period]
            code = str(row[0]).strip()
            pe_str = str(row[5]).replace(",", "").strip()
            try:
                pe = float(pe_str)
                if pe > 0:
                    pe_map[code] = pe
            except ValueError:
                pass
        return pe_map
    except Exception as e:
        print(f"  [TWSE fetch] failed: {e}")
        return {}


def calc_fpe(holdings: dict[str, float], pe_map: dict[str, float]) -> tuple[float | None, float]:
    """Compute weighted PE. Returns (weighted_pe, coverage_pct)."""
    valid: list[tuple[float, float]] = []
    for code, weight in holdings.items():
        pe = pe_map.get(code)
        if pe and 3 < pe <= PE_CAP:
            valid.append((pe, weight))
        elif pe:
            print(f"  [{code}] pe={pe:.1f} — excluded (cap {PE_CAP}x)")
        else:
            print(f"  [{code}] pe=None — no data")

    if not valid:
        return None, 0.0

    total_w = sum(w for _, w in valid)
    weighted = sum(pe * w for pe, w in valid) / total_w
    print(f"  Weighted PE: {weighted:.2f}x  ({len(valid)} stocks, coverage {total_w:.1f}%)")
    return round(weighted, 2), total_w


def calc_forward(holdings: dict[str, float], cap: float = 60.0) -> float | None:
    """Weighted forward PE from constituents' yfinance forwardPE (台股個股有 forward)."""
    valid: list[tuple[float, float]] = []
    for code, w in holdings.items():
        try:
            time.sleep(0.3)
            f = yf.Ticker(f"{code}.TW").info.get("forwardPE")
            if f and isinstance(f, (int, float)) and 3 < f <= cap:
                valid.append((float(f), w))
            else:
                print(f"  [{code}] forwardPE={f} — excluded")
        except Exception as e:
            print(f"  [{code}] forward error: {e}")
    if not valid:
        return None
    tw = sum(w for _, w in valid)
    val = round(sum(f * w for f, w in valid) / tw, 2)
    print(f"  Weighted forward PE: {val}x  ({len(valid)} stocks, coverage {tw:.1f})")
    return val


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def main() -> None:
    today = date.today().isoformat()
    ymd = today.replace("-", "")
    print(f"Fetching TW (0050/TWII) PE for {today} ...")

    # Step 1: get holdings
    live = fetch_live_holdings()
    if live:
        print(f"  Live holdings from yfinance ({len(live)} stocks)")
        holdings = live
    else:
        print("  Falling back to hardcoded holdings")
        holdings = HOLDINGS_FALLBACK

    # Step 2: fetch TWSE PE
    print("  Fetching TWSE stock PE data...")
    pe_map = fetch_twse_pe(ymd)

    # Try previous trading day if today has no data (e.g. weekend/holiday)
    if not pe_map:
        from datetime import timedelta
        for delta in range(1, 5):
            prev = (date.fromisoformat(today) - timedelta(days=delta)).strftime("%Y%m%d")
            print(f"  Trying previous date {prev}...")
            pe_map = fetch_twse_pe(prev)
            if pe_map:
                break

    tpe, coverage = calc_fpe(holdings, pe_map)   # TWSE-derived weighted trailing PE

    # Step 3: fallback to yfinance 0050.TW trailingPE if coverage < 40%
    if tpe is None or coverage < 40:
        print(f"  Coverage {coverage:.1f}% too low, trying yfinance 0050.TW trailingPE...")
        try:
            info = yf.Ticker("0050.TW").info
            yf_pe = info.get("trailingPE")
            if yf_pe and isinstance(yf_pe, (int, float)):
                tpe = round(float(yf_pe), 2)
                src_label = "yf-trailing"
                print(f"  yfinance trailingPE: {tpe}x")
            else:
                print("  yfinance trailingPE also unavailable — skipping trailing.")
                tpe = None
        except Exception as e:
            print(f"  yfinance fallback failed: {e}")
            tpe = None
    else:
        src_label = "calc-live" if live else "calc"

    # Step 4: forward PE — weighted yfinance forwardPE of constituents (台股個股有 forward)
    fwd = calc_forward(holdings)

    if tpe is None and fwd is None:
        print("  No PE data — skipping.")
        return

    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    entry = {**by_date.get(today, {}), "date": today, "src": src_label}
    if tpe is not None:
        entry["tpe"] = tpe
    if fwd is not None:
        entry["fpe"] = fwd
    by_date[today] = entry
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "台灣 50（0050）估值。tpe=trailing（FinMind 成分股 PER 加權回溯至 2010 + TWSE 每日實值）；"
        "fpe=forward（前15大成分股 yfinance forwardPE 加權，排除>60x；今起每日累積，無深歷史）。"
        "歷史底部：~12x（2015-16 / 2022）；當前 trailing ~30x、forward ~21x。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
