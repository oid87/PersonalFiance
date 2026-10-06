# Shared Python I/O and weekday helpers

The fetch scripts retain their public functions and pass their own `OUT`, `FLOOR`, `CEIL`, and current date to small helpers in `scripts/_common.py`. Fetch requests, headers, retries, source units, saved JSON formats, and financial calculations are unchanged.

| Helper | Policy | Callers |
|---|---|---|
| `load_existing_object(path)` | Missing file or any read/JSON error returns `{}`; valid JSON is returned whole, including metadata. | bullbear, cpi, liquidity, liquidity_leverage, umich |
| `load_strict_rows_by_date(path)` | Missing file or **any** invalid row returns `{}`; dated rows form an insertion-ordered dict, later duplicate dates overwrite values. | margin_jp, margin_kr, net_liquidity |
| `weekday_dates(start,end)` | Inclusive Monday–Friday generator, with no exchange-holiday calendar. | finra_short and putcall retain generator wrappers; taifex_foreign_oi and tw_sector_flow retain list wrappers. |
| `stratified_missing_weekdays(have,floor,ceiling,today)` | Missing weekdays within the original bounds, newest-first within stride layers 32→16→8→4→2→1. | margin_ratio_mm, tpex_margin, twse_mktcap |

The strict date-map policy is intentionally distinct from `_common.load_rows_by_date`, which already serves other fetchers. No JSON writers were unified. Date wrappers still let tests monkeypatch each caller's globals.

The frozen before-source oracle in `Financial_work/artifacts/refactor_delivery_2026_10_02/python-common/` compares 56 edge cases across all 15 wrappers, including missing/bad JSON, invalid/duplicate/reversed rows, weekends, empty `CEIL`, and stride order. All cases and result types match. AST comparison confirms every other function in those fetch files is unchanged. The product test `scripts/tests/test_shared_io_dates.py` embeds the before-snapshot stride order and exercises wrapper return types and cache policies without importing fetchers or accessing the network.

`Financial_work/check_reuse.py` reports three existing product-fetch patterns: inline YoY and yfinance in `fetch_liquidity_leverage.py`, and FinMind access in `fetch_tw_sector_flow.py`. They predate this extraction. This product repository must remain independent of the neighboring research sandbox's `lab.py`; changing those fetch algorithms was outside this package.
