"""Fetch TWSE T86 foreign investor (外資) daily net buy by sector.

Pipeline:
1. Stock→sector map from FinMind TaiwanStockInfo (cached weekly in tw_sector_map_cache.json)
2. TWSE T86 per date → aggregate 張 by sector
3. Output: data/tw_sector_flow.json  (rolling 252 trading days)

Unit: 張 (lots = 1000 shares).  net_lots > 0 = foreign net buy.
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT   = Path(__file__).resolve().parent.parent
DATA   = ROOT / "data"
OUT    = DATA / "tw_sector_flow.json"
CACHE  = DATA / "tw_sector_map_cache.json"

T86_URL   = "https://www.twse.com.tw/fund/T86"
FINMIND   = "https://api.finmindtrade.com/api/v4/data"

BACKFILL_DAYS   = 365
RECENT_DAYS     = 21
ROLLING_KEEP    = 252
CACHE_TTL_DAYS  = 7
REQUEST_DELAY   = 0.6
RETRY_MAX       = 3
RETRY_BACKOFF   = 8

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer":    "https://www.twse.com.tw/",
    "Accept":     "application/json",
}

INDUSTRY_TO_SECTOR: dict[str, str] = {
    "半導體業":          "semiconductor",
    "電腦及週邊設備業":   "computer",
    "光電業":            "optoelectronics",
    "通信網路業":         "telecom",
    "電子零組件業":       "e_components",
    "電子通路業":         "e_components",
    "其他電子類":         "electronics",
    "其他電子業":         "electronics",
    "電子工業":           "electronics",
    "電子商務業":         "digital_cloud",
    "資訊服務業":         "digital_cloud",
    "數位雲端業":         "digital_cloud",
    "數位雲端":           "digital_cloud",
    "數位雲端類":         "digital_cloud",
    "金融保險業":         "finance",
    "金融保險":           "finance",
    "金融業":            "finance",
    "銀行業":            "finance",
    "保險業":            "finance",
    "證券期貨業":         "finance",
    "生技醫療業":         "biotech",
    "化學生技醫療":       "biotech",
    "鋼鐵工業":           "steel",
    "航運業":            "shipping",
    "食品工業":           "food",
    "塑膠工業":           "plastics",
    "油電燃氣業":         "oil_gas",
    "綠能環保業":         "green_energy",
    "綠能環保":           "green_energy",
    "綠能環保類":         "green_energy",
    "建材營造業":         "construction",
    "建材營造":           "construction",
    "觀光餐旅業":         "tourism",
    "觀光餐旅":           "tourism",
    "觀光事業":           "tourism",
    "電機機械":           "machinery",
    "電器電纜業":         "machinery",
    "電器電纜":           "machinery",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def get_token() -> str:
    import os
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""


def load_sector_map() -> dict[str, str]:
    if CACHE.exists():
        try:
            cached = json.loads(CACHE.read_text())
            cached_date = datetime.fromisoformat(cached.get("updated", "2000-01-01")).date()
            if (date.today() - cached_date).days < CACHE_TTL_DAYS:
                return cached["map"]
        except Exception:
            pass

    token = get_token()
    params: dict = {"dataset": "TaiwanStockInfo"}
    if token:
        params["token"] = token
    try:
        r = requests.get(FINMIND, params=params, timeout=60)
        r.raise_for_status()
        payload = r.json()
        rows = payload.get("data", [])
    except Exception as e:
        print(f"  FinMind TaiwanStockInfo failed: {e}")
        return json.loads(CACHE.read_text()).get("map", {}) if CACHE.exists() else {}

    mapping: dict[str, str] = {}
    for row in rows:
        sid = str(row.get("stock_id", "")).strip()
        ind = str(row.get("industry_category", "")).strip()
        sector = INDUSTRY_TO_SECTOR.get(ind)
        if sid and sector:
            mapping[sid] = sector

    CACHE.write_text(json.dumps({"updated": date.today().isoformat(), "map": mapping},
                                ensure_ascii=False, separators=(",", ":")))
    print(f"  Sector map refreshed: {len(mapping)} stocks → {len(set(mapping.values()))} sectors")
    return mapping


def find_net_col(fields: list[str]) -> int | None:
    for i, f in enumerate(fields):
        if "外資" in f and "買賣超" in f and "自營商" not in f:
            return i
    for i, f in enumerate(fields):
        if "外資" in f and "買賣超" in f:
            return i
    return None


def find_code_col(fields: list[str]) -> int:
    for i, f in enumerate(fields):
        if "代號" in f or "代碼" in f:
            return i
    return 0


def parse_int(s: str) -> int:
    try:
        return int(str(s).replace(",", "").replace("+", "").strip())
    except (ValueError, TypeError):
        return 0


def fetch_t86(dt: date) -> dict[str, int] | None:
    for attempt in range(RETRY_MAX):
        try:
            resp = SESSION.get(
                T86_URL,
                params={"response": "json", "date": dt.strftime("%Y%m%d"), "selectType": "ALLBUT0999"},
                timeout=30,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(RETRY_BACKOFF * (attempt + 1))
                continue
            if resp.status_code != 200:
                return None
            j = resp.json()
            if j.get("stat") != "OK" or not j.get("data"):
                return None

            fields  = j["fields"]
            net_col = find_net_col(fields)
            cod_col = find_code_col(fields)
            if net_col is None:
                return None

            result: dict[str, int] = {}
            for row in j["data"]:
                sid  = str(row[cod_col]).strip()
                lots = parse_int(row[net_col]) // 1000   # shares → 張
                if sid:
                    result[sid] = lots
            return result
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None


def trading_dates(start: date, end: date) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def load_existing() -> dict[str, list[list]]:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text()).get("sectors", {})
    except Exception:
        return {}


def save(sectors: dict[str, list[list]], today: date) -> None:
    for key in sectors:
        by_date: dict[str, int] = {}
        for row in sectors[key]:
            by_date[row[0]] = row[1]
        sorted_rows = sorted([[d, v] for d, v in by_date.items()])
        sectors[key] = sorted_rows[-ROLLING_KEEP:]
    OUT.write_text(json.dumps(
        {"updated": today.isoformat(), "sectors": sectors},
        ensure_ascii=False, separators=(",", ":"),
    ))


def main() -> None:
    today    = date.today()
    existing = load_existing()
    sector_map = load_sector_map()
    if not sector_map:
        print("No sector map — aborting")
        return

    if existing:
        latest_dates = [rows[-1][0] for rows in existing.values() if rows]
        if latest_dates:
            last = max(latest_dates)
            start = datetime.strptime(last, "%Y-%m-%d").date() - timedelta(days=RECENT_DAYS)
        else:
            start = today - timedelta(days=BACKFILL_DAYS)
    else:
        start = today - timedelta(days=BACKFILL_DAYS)

    dates = trading_dates(start, today)
    print(f"Fetching T86 for {len(dates)} trading days ({start} → {today})")

    fetched = skipped = consec_skip = 0
    for i, dt in enumerate(dates):
        stock_flow = fetch_t86(dt)
        if stock_flow:
            sector_totals: dict[str, int] = {}
            for sid, lots in stock_flow.items():
                sector = sector_map.get(sid)
                if sector:
                    sector_totals[sector] = sector_totals.get(sector, 0) + lots
            for sector, total in sector_totals.items():
                if sector not in existing:
                    existing[sector] = []
                existing[sector].append([dt.strftime("%Y-%m-%d"), total])
            fetched += 1
            consec_skip = 0
        else:
            skipped += 1
            consec_skip += 1

        if (i + 1) % 30 == 0:
            print(f"  {i+1}/{len(dates)} ({fetched} ok, {skipped} skip)")
            save(existing, today)

        if consec_skip >= 10:
            print(f"  {consec_skip} consecutive skips at {dt}, pausing 30s…")
            save(existing, today)
            time.sleep(30)
            consec_skip = 0
        elif i < len(dates) - 1:
            time.sleep(REQUEST_DELAY)

    save(existing, today)
    print(f"Done: {fetched} days fetched, {skipped} skipped → {OUT}")
    for k in sorted(existing):
        print(f"  {k}: {len(existing[k])} pts")


if __name__ == "__main__":
    main()
