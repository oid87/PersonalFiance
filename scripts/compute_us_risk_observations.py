"""Archive observed versions of existing PF inputs; no network and no release-date estimates.

First import of historical rows proves availability NOW, never on the observation date.
Unchanged values keep their original observed_at. Revisions append; old values survive.

Provenance rule: observed_at must come from the scheduled pipeline, so by default this script only
writes the shared data/ archive when running in GitHub Actions. Local experiments use
`--data-dir <scratch copy>` (any non-default directory) or the explicit `--allow-local-write`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = "us_risk_observations.json"
START = "2018-01-01"
YAHOO = "https://ranaroussi.github.io/yfinance/"
CBOE = "https://www.cboe.com/tradable-products/vix/vix-historical-data"
CFTC = "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm"
FINRA = "https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics"


def spec(label, file, fields, *, frequency="daily", unit="index points", url=YAHOO,
         delay="收盤後；上游無逐筆發布時間，僅採本系統首次觀測時間", quality="eod_history_no_vintages",
         license_note="沿用既有個人研究資料；供應商保留權利，公開再散布授權未確認", history=True, **extra):
    return dict(label=label, source_file=f"data/{file}.json", fields=fields, frequency=frequency,
                unit=unit, source_url=url, delay=delay, quality=quality, license=license_note,
                history_eligible=history, **extra)


SPECS = {}
for ticker in ("SPY", "QQQ", "SOXX", "HYG", "LQD"):
    SPECS[ticker] = spec(ticker, ticker, {k: k for k in ("open", "high", "low", "close")}, unit="USD raw price (not total return)")
for ticker in ("VIX", "VXN"):
    SPECS[ticker] = spec(ticker, ticker, {"value": "close"})
SPECS["VIX3M"] = spec("VIX3M", "vix_term", {"value": "vix3m"}, url=CBOE)
SPECS["NDX_BREADTH"] = spec("Nasdaq-100 >50MA", "breadth_ndx",
    {"value": "above50_pct", "total": "total", "above50_total": "above50_total"}, unit="%",
    quality="current_constituents_mixed_vintages", history=False,
    reason="現今成分股回填／混合版本；歷史回測 unavailable，分母依窗口有效股數")
for series, field in (("NFCI_RISK", "risk"), ("NFCI_CREDIT", "credit"), ("NFCI_LEVERAGE", "leverage")):
    SPECS[series] = spec(series, "nfci", {"value": field}, frequency="weekly", unit="standard deviations",
        url="https://www.chicagofed.org/research/data/nfci/current-data", quality="revised_latest_no_alfred",
        delay="通常下週三美東08:30；假日可能變更，未知逐期發布日",
        license_note="Chicago Fed/FRED 來源；保留歸屬，不宣稱所有第三方輸入皆無權利限制",
        reason="歷史會重估；不是融資維持率；嚴格確認僅用本系統已觀測版本")
for series, instrument, label, code in (("CFTC_ES", "sp500", "S&P 500 consolidated", "13874+"),
        ("CFTC_NQ", "nasdaq100", "Nasdaq-100 consolidated", "20974+"),
        ("CFTC_RTY", "russell2000", "Russell E-mini", "239742")):
    SPECS[series] = spec(label, "cftc_positions", {"long": "lev_long", "short": "lev_short", "oi": "open_interest"},
        frequency="weekly", unit="contracts; long+short excludes spreading", url=CFTC,
        delay="通常週二持倉、週五美東15:30公布；假日／中斷例外，不以公式推估發布日",
        license_note="CFTC 公開政府統計，保留來源與修正資訊", quality="consolidated_contract_counts",
        instrument=instrument, contract_code=code, reason="不是全市場槓桿或強制平倉；不同合約不能相加成美元曝險")
SPECS["FINRA"] = spec("FINRA margin debt (mirror)", "margin_global_us", {"value": "margin_balance"},
    frequency="monthly", unit="USD millions", url=FINRA, quality="third_party_mirror_no_release_calendar",
    delay="FINRA 通常次月第三週；鏡站另有延遲，逐期官方發布時間未知",
    mirror_url="https://www.thetrading.tools/data/indicators/margin-debt.csv",
    reason="第三方鏡站；收縮不能證明被迫平倉；不使用月底+25天估計作回測可得日")
# Explicitly restricted / unverified new publication is a visible unavailable state.
SPECS["HY_OAS"] = spec("ICE BofA HY OAS", "credit_spread", {"value": "hy"}, unit="percentage points",
    url="https://fred.stlouisfed.org/series/BAMLH0A0HYM2", history=False, blocked=True,
    quality="license_restricted", license_note="ICE/FRED 明定 internal use only；公開再散布須事先書面同意",
    delay="日收盤統計，通常次日更新；FRED 2026-04 起只提供3年",
    reason="unavailable：尚無公開再散布授權；不複製 OAS，信用背景改以明示 HYG/LQD 價格代理")
SPECS["CNN_FG"] = spec("CNN Fear & Greed", "fear_greed", {"value": "value"}, history=False, blocked=True,
    url="https://www.cnn.com/markets/fear-and-greed", unit="0–100", quality="license_unverified",
    reason="unavailable：既有檔不代表已獲授權；未確認資料使用許可，不新增再散布或回測")
for ticker in ("RSP", "SMH"):
    SPECS[ticker] = spec(ticker, ticker, {}, unit="USD", history=False, blocked=True, quality="missing_source",
        reason="unavailable：repo 尚無既有資料；來源與授權確認前不新增抓取")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_archive(bundle):
    if bundle.get("schema_version") != 1 or not isinstance(bundle.get("series"), dict):
        raise ValueError("Invalid existing us-risk archive; refusing to overwrite")
    generated = datetime.fromisoformat(bundle["generated_at"].replace("Z", "+00:00"))
    if generated.tzinfo is None or generated.utcoffset().total_seconds() != 0:
        raise ValueError("Archive timestamp must be UTC")
    for key in ("SPY", "QQQ"):
        if not bundle["series"].get(key, {}).get("records"):
            raise ValueError("Archive core source missing")
    for item in bundle["series"].values():
        seen = set()
        for row in item.get("records", []):
            date.fromisoformat(row["date"])
            timestamp = datetime.fromisoformat(row["observed_at"].replace("Z", "+00:00"))
            published = row.get("published_at")
            if published is not None:
                release = datetime.fromisoformat(published.replace("Z", "+00:00"))
                if release.tzinfo is None or release.utcoffset().total_seconds() != 0:
                    raise ValueError("Published timestamp must be UTC")
            if not re.fullmatch(r"[a-f0-9]{64}", row.get("source_hash", "")):
                raise ValueError("Invalid archive provenance")
            if timestamp.tzinfo is None or timestamp.utcoffset().total_seconds() != 0 or timestamp > generated or not row.get("values") or not all(finite(v) or v is None for v in row["values"].values()):
                raise ValueError("Invalid archived observation")
            key = (row["date"], row["observed_at"])
            if key in seen:
                raise ValueError("Duplicate archive version")
            seen.add(key)


def build_bundle(data_dir, previous=None, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Capture time must have timezone")
    observed = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    today = now.astimezone(ZoneInfo("America/New_York")).date().isoformat()
    if previous is not None:
        validate_archive(previous)
        if now < datetime.fromisoformat(previous["generated_at"].replace("Z", "+00:00")):
            raise ValueError("Capture clock moved backwards")
    previous = previous or {"series": {}}
    bundle = {"schema_version": 1, "generated_at": observed, "series": {}}
    for key, definition in SPECS.items():
        old = previous["series"].get(key, {})
        records = list(old.get("records", []))
        meta = {k: v for k, v in definition.items() if k not in ("fields", "instrument", "blocked")}
        if definition.get("blocked"):
            meta.update(available=False, status="unavailable", input_sha256=None, input_updated=None,
                        last_observation=None, first_date=None, source_rows=0)
            bundle["series"][key] = {"meta": meta, "records": []}
            continue
        try:
            path = data_dir / Path(definition["source_file"]).name
            raw = path.read_bytes()
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("Expected source object")
            rows = payload.get("data")
            if definition.get("instrument"):
                item = next(i for i in payload.get("instruments", []) if i["id"] == definition["instrument"])
                rows = item["rows"]
            if not isinstance(rows, list) or not rows:
                raise ValueError("Empty source")
            new_rows = []
            dates = set()
            for row in rows:
                d = row.get("date")
                date.fromisoformat(d)
                if d in dates:
                    raise ValueError("Duplicate source date")
                dates.add(d)
                if d < START or d > today:
                    continue
                values = {out: row.get(field) for out, field in definition["fields"].items()}
                core = [v for field, v in values.items() if field not in ("total", "above50_total")]
                if any(v is not None and not finite(v) for v in values.values()):
                    raise ValueError("Nonfinite source value")
                if any(v is None for v in core):
                    continue  # missing never converted into zero, never creates a version
                new_rows.append((d, values))
            if not new_rows:
                raise ValueError("No usable source observations")
            new_rows.sort(key=lambda r: r[0])
            latest = {}
            for record in sorted(records, key=lambda r: (datetime.fromisoformat(r["observed_at"].replace("Z", "+00:00")), r["date"])):
                latest[record["date"]] = record
            input_hash = digest(raw)
            for d, values in new_rows:
                if d not in latest or latest[d]["values"] != values:
                    if d in latest and datetime.fromisoformat(latest[d]["observed_at"].replace("Z", "+00:00")) >= now:
                        raise ValueError("Conflicting revision at same or earlier capture time")
                    records.append({"date": d, "observed_at": observed, "published_at": None,
                                    "source_hash": input_hash, "values": values})
            meta.update(available=True, status="ok" if payload.get("status", "ok") == "ok" else "stale",
                        input_sha256=input_hash, input_updated=payload.get("updated"),
                        last_observation=new_rows[-1][0], first_date=new_rows[0][0], source_rows=len(new_rows))
            if key == "NDX_BREADTH":
                meta["constituents_basis"] = payload.get("meta", {}).get("constituentsBasis", "unknown")
        except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
            # Never stamp retained values as freshly observed after an upstream failure.
            for field in ("input_sha256", "input_updated", "last_observation", "first_date", "source_rows"):
                meta[field] = old.get("meta", {}).get(field)
            meta.update(available=bool(records), status="stale" if records else "unavailable",
                        reason=f"來源不可用，保留舊版與首次觀測時間：{type(exc).__name__}")
        records.sort(key=lambda r: (r["date"], datetime.fromisoformat(r["observed_at"].replace("Z", "+00:00"))))
        bundle["series"][key] = {"meta": meta, "records": records}
    for key in ("SPY", "QQQ"):
        if not bundle["series"][key]["records"]:
            raise ValueError(f"Required {key} unavailable; preserving previous output")
    validate_archive(bundle)
    return bundle


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--allow-local-write", action="store_true", help="write the shared archive from a non-CI environment (provenance warning)")
    args = parser.parse_args(argv)
    shared = args.data_dir.resolve() == (ROOT / "data").resolve()
    if shared and os.environ.get("GITHUB_ACTIONS") != "true" and not args.allow_local_write:
        print("Refusing to write the shared data/us_risk_observations.json outside GitHub Actions "
              "(first-observation times must come from the scheduled pipeline). Use --data-dir <scratch> or --allow-local-write.")
        return 2
    out = args.data_dir / OUTPUT
    try:
        previous = json.loads(out.read_text()) if out.exists() else None
        bundle = build_bundle(args.data_dir, previous)
    except (OSError, ValueError) as exc:
        # Previous archive stays untouched; the workflow step is continue-on-error so primary data still publishes.
        print(f"::warning::US risk archive NOT updated: {type(exc).__name__}: {exc}")
        return 1
    fd, temp_path = tempfile.mkstemp(prefix=".us-risk-", suffix=".tmp", dir=args.data_dir)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(bundle, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
        os.replace(temp_path, out)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    print(f"Wrote {out.name}: {sum(len(s['records']) for s in bundle['series'].values())} observed versions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
