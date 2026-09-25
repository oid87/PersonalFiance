"""Fetch a self-built Taiwan semiconductor basket's NTM forward PE.

Appends result to data/tw_semi_valuation.json. Counterpart to
fetch_soxx_valuation.py so the two can be compared on the same
forward-PE methodology (see js/tabs/sox_vs_tw_semi_pe.js).

Why self-built (not a ready-made index)
----------------------------------------
FinMind does have a Taiwan sector-index dataset (TaiwanStockIndex,
covering 半導體業指數 etc.), but it's gated behind the paid Sponsor
plan — the free/anonymous tier this project uses cannot access it.
So instead of a licensed index, this script builds its own
market-cap-weighted basket of individual TWSE/TPEx-listed
semiconductor stocks, exactly like fetch_tw_valuation.py already does
for the 0050/TWII basket and fetch_soxx_valuation.py does for SOXX's
top-20 holdings.

Basket composition (verified 2026-09-13)
-----------------------------------------
Selection method: started from a candidate list of Taiwan-listed
semiconductor names (TSMC + major fabless/IC-design + OSAT + memory +
wafer + IC-substrate-adjacent names), queried live yfinance
`info['marketCap']` for each to rank by market cap, then took the
top 10 by market cap that are classified as core "半導體業"
(foundry / IC design / OSAT / memory / wafer) — excluding names whose
primary business is PCB/IC-substrate manufacturing (e.g. Unimicron
3037, Nan Ya PCB 8046) even though they're semiconductor-supply-chain
adjacent, to keep the basket aligned with TWSE's own 半導體業 sector
classification and comparable to SOXX (which is pure semiconductor
companies, not equipment/materials suppliers).

Market cap snapshot used for weighting (yfinance, TWD, 2026-09-13):
  2330.TW  台積電 TSMC              62,497,012,842,496
  2454.TW  聯發科 MediaTek           7,323,012,562,944
  3711.TW  日月光投控 ASE Tech       3,218,130,337,792
  2303.TW  聯電 UMC                 1,761,805,729,792
  2408.TW  南亞科 Nanya Technology  1,527,623,581,696
  3443.TW  創意 Global Unichip        820,147,322,880
  8299.TWO 群聯 Phison                440,118,345,728
  6488.TWO 環球晶 GlobalWafers         431,258,566,656
  2379.TW  瑞昱 Realtek                361,055,551,488
  2449.TW  京元電子 King Yuan Elec     337,661,034,496

Resulting weights (renormalized to 100%, before any PE-based
exclusion): TSMC ~79.4%, MediaTek ~9.3%, ASE Tech ~4.1%, UMC ~2.2%,
Nanya Tech ~1.9%, Global Unichip ~1.0%, Phison ~0.6%, GlobalWafers
~0.6%, Realtek ~0.5%, King Yuan Elec ~0.4%.

⚠️ Note the concentration: TSMC alone is ~79% of this basket. That's
not a methodology artifact — it reflects reality: TSMC really is the
overwhelming majority of Taiwan's listed semiconductor market cap.
Practically this means the basket's forward PE (especially the
harmonic mean — see below) tracks close to TSMC's own NTM PE, with
the other 9 names as a (much smaller) tilt. This is a real structural
difference from SOXX, whose top holding (NVDA) is "only" ~20%.

Candidates considered but excluded from the final 10 (for reference,
so a future rebalance doesn't have to re-derive this):
  5347.TWO 世界先進 VIS (~296B) — market cap rank 11, cut for top-10.
  2337.TW  旺宏 Macronix (~236B), 3529.TWO 力旺 eMemory (~193B),
  6415.TW  矽力*-KY Silergy (~156B), 5269.TW 祥碩 ASMedia (~98B),
  3006.TW  晶豪科 ESMT (~83B) — all smaller-cap, below the top-10 cut.
  3037.TW  欣興 Unimicron (~1,603B), 8046.TW 南亞電路板 Nan Ya PCB
  (~698B) — excluded as PCB/IC-substrate makers, not semiconductor
  manufacturers proper (see selection method above), despite larger
  market cap than several included names.

NTM forward PE (matches fetch_soxx_valuation.py exactly)
-----------------------------------------------------------
NTM (Next Twelve Months) EPS = (m/12)×current_FY_EPS_estimate +
((12-m)/12)×next_FY_EPS_estimate, from yfinance `earnings_estimate`
('0y'/'+1y' rows), where m = months remaining in the current fiscal
year. Stocks with NTM PE missing, <= 5x, or > 70x are excluded and
weights renormalized. As of 2026-09-13 all 10 basket stocks had valid
`earnings_estimate` coverage and passed the 5x-70x band, so realized
weight coverage = 100%. Taiwan-listed stocks' `earnings_estimate`
coverage on yfinance is generally less complete than US megacaps
though — if a future run drops below 40% coverage, that's flagged
in stdout and should be flagged again wherever this data is surfaced
(commit message / dashboard note), not silently treated as normal.

Two weighted means, on purpose (lesson from fetch_soxx_valuation.py)
-----------------------------------------------------------------------
fpe = weighted ARITHMETIC mean = Σ(weight×PE) / Σweight. This is the
"legacy" style metric but can be skewed by a handful of small-weight,
high-PE outliers (realized while building the SOXX tab: INTC/MRVL/AMD
pulled SOXX's arithmetic mean to 23.87x vs Yardeni's independently
published ~16.3x — harmonic mean at 18.88x tracked much closer).
fpe_harmonic = weighted HARMONIC mean = total_weight / Σ(weight/PE),
equivalent to Σ(mv)/Σ(mv/PE), i.e. market-cap-weighted "aggregate
P/E". This is the more standard index-level metric and is far less
distorted by outliers. For THIS basket the two are much closer to
each other than SOXX's were (~20.2x vs ~18.3x as of 2026-09-13),
precisely because TSMC's ~79% weight anchors both means near TSMC's
own PE — but both are still computed and stored, per project policy,
because the divergence risk is basket-composition-dependent and this
basket's dominant-holding structure could change over time.

Idempotent daily append, retry/backoff and JSON shape are copied
directly from fetch_soxx_valuation.py's calc_fpe()/load_existing().
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import _common
import _valuation

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_semi_valuation.json"

# Taiwan semiconductor basket, weights = market cap (TWD) as of 2026-09-13,
# see docstring above for full sourcing/rationale. Update ~quarterly.
HOLDINGS: dict[str, float] = {
    "2330.TW":  62_497_012_842_496,   # 台積電 TSMC
    "2454.TW":   7_323_012_562_944,   # 聯發科 MediaTek
    "3711.TW":   3_218_130_337_792,   # 日月光投控 ASE Technology
    "2303.TW":   1_761_805_729_792,   # 聯電 UMC
    "2408.TW":   1_527_623_581_696,   # 南亞科 Nanya Technology
    "3443.TW":     820_147_322_880,   # 創意 Global Unichip
    "8299.TWO":    440_118_345_728,   # 群聯 Phison
    "6488.TWO":    431_258_566_656,   # 環球晶 GlobalWafers
    "2379.TW":     361_055_551_488,   # 瑞昱 Realtek
    "2449.TW":     337_661_034_496,   # 京元電子 King Yuan Electronics
}

FPE_CAP = 70.0
FPE_FLOOR = 5.0
COVERAGE_WARN_THRESHOLD = 40.0  # % — below this, flag data-quality issue loudly


def _ntm_pe(sym: str, retries: int = 3) -> float | None:
    """Compute NTM (Next Twelve Months) PE from analyst earnings estimates.

    Identical logic to fetch_soxx_valuation.py's _ntm_pe(): NTM EPS =
    (m/12) × current_FY_EPS + ((12-m)/12) × next_FY_EPS, m = months
    remaining in current fiscal year.
    """
    return _valuation.ntm_pe(sym, throttle=0.8, retries=retries)


def calc_fpe(holdings: dict[str, float]) -> tuple[float | None, float | None, float]:
    """Returns (arithmetic-weighted NTM PE, harmonic-weighted NTM PE, coverage_pct).

    coverage_pct = share of total basket weight that had a usable NTM PE
    (i.e. earnings_estimate available AND 5x < PE <= 70x). Stocks with no
    earnings_estimate are excluded outright — never backfilled with
    trailing PE, to avoid mixing forward/trailing methodology.
    """
    total_w = sum(holdings.values())
    valid: list[tuple[float, float]] = []
    excluded: list[str] = []
    for sym, weight in holdings.items():
        pe = _ntm_pe(sym)
        if pe and FPE_FLOOR < pe <= FPE_CAP:
            valid.append((pe, weight))
        else:
            excluded.append(sym)
            print(f"  [{sym}] NTM PE={pe} — excluded")

    if not valid:
        return None, None, 0.0

    valid_w = sum(w for _, w in valid)
    coverage = 100.0 * valid_w / total_w
    arith, harmonic = _valuation.weighted_means(valid)
    print(
        f"  NTM forward PE: arithmetic={arith:.2f}x harmonic={harmonic:.2f}x  "
        f"({len(valid)}/{len(holdings)} stocks, coverage {coverage:.1f}%)"
    )
    if excluded:
        print(f"  Excluded: {', '.join(excluded)}")
    if coverage < COVERAGE_WARN_THRESHOLD:
        print(
            f"  ⚠️  COVERAGE {coverage:.1f}% < {COVERAGE_WARN_THRESHOLD:.0f}% "
            "— data quality degraded, treat this reading with caution."
        )
    return round(arith, 2), round(harmonic, 2), round(coverage, 1)


def load_existing() -> list[dict]:
    return _common.load_rows(OUT)


def main() -> None:
    today = date.today().isoformat()
    print(f"Fetching Taiwan semiconductor basket NTM forward PE for {today} ...")
    print(f"  Basket: {', '.join(HOLDINGS.keys())} ({len(HOLDINGS)} stocks)")

    fpe, fpe_harmonic, coverage = calc_fpe(HOLDINGS)

    if fpe is None:
        print("  No valid PE data — skipping update.")
        return

    entry = {
        "date": today,
        "src": "calc",
        "fpe": fpe,
        "fpe_harmonic": fpe_harmonic,
        "coverage_pct": coverage,
    }

    coverage_note = (
        f"⚠️ 資料覆蓋率偏低({coverage:.1f}% < {COVERAGE_WARN_THRESHOLD:.0f}%),此讀數品質存疑。"
        if coverage < COVERAGE_WARN_THRESHOLD else ""
    )
    note = (
        "台灣半導體代表籃子（自建，因 FinMind 台股類股指數需付費 Sponsor 方案，"
        "改用個股市值加權籃子近似，比照 fetch_tw_valuation.py 的做法）。"
        "籃子組成（2026-09-13 查證，市值前10大核心半導體業個股，權重=市值佔比）："
        "台積電2330(~79%)、聯發科2454(~9%)、日月光投控3711(~4%)、聯電2303(~2%)、"
        "南亞科2408(~2%)、創意3443(~1%)、群聯8299(~0.6%)、環球晶6488(~0.6%)、"
        "瑞昱2379(~0.5%)、京元電子2449(~0.4%)；排除欣興3037/南亞電路板8046等"
        "IC載板/PCB廠商（非半導體業本身）。"
        "fpe=forward（NTM加權算術平均，排除PE<=5x或>70x；NTM=(m/12)×當FY+(12-m)/12×次FY，"
        "與SOXX/SPY同一套算法）；"
        "fpe_harmonic=同一籃子的NTM加權調和平均（= total_weight/Σ(weight/PE)，"
        "等價市值加權聚合PE，不受少數高PE小權重成分股扭曲）。"
        "此籃子因台積電權重高達~79%，兩種平均差距通常遠小於SOXX（後者最大持股僅~20%），"
        "數值會非常接近台積電自身的NTM PE。"
        f"coverage_pct=當日籃子中通過篩選(有estimate且落在5x-70x區間)的權重佔比。{coverage_note}"
    )
    merged = _valuation.write_daily_snapshot(OUT, today, entry, note)
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
