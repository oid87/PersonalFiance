#!/usr/bin/env python3
"""Independent re-computation of the US Capitulation Alert backtest (Models A, B, A', E' and the VXN>=30 sensitive tier S) from the raw data files.

Written from the definitions in docs/research/us-capitulation-alert-backtest.md only (no JS code is imported or ported line
by line) and compared with docs/research/us-capitulation-alert-backtest.json. Exit code 0 only when every event date and every
forward return / MAE / MFE agrees.

    .venv/bin/python scripts/research/verify_us_capitulation.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
P = dict(gate=8.0, cooldown=10, lookback=120, vix=30.0, vxn=35.0, pcr_pct=95, pcr_window=504, pcr_min=126, pcr_avg=5,
         pcr_break="2019-10-05", confirm_window=40, no_new_low=5, vol_retreat=0.8, ma=10, horizons=(5, 10, 20, 60, 120))


def load(name):
    return pd.DataFrame(json.loads((ROOT / "data" / f"{name}.json").read_text())["data"]).set_index("date")


def pct_linear(values, p):
    """Linear-interpolation percentile (numpy default) — equals the JS helper's definition."""
    return float(np.percentile(np.asarray(values, dtype=float), p))


def frame(asset):
    px = load(asset)
    vix, vxn = load("VIX")["close"], load("VXN")["close"]
    pc = pd.DataFrame(json.loads((ROOT / "data" / "putcall.json").read_text())["equity"]).set_index("date")["pc"]
    df = px[["open", "high", "low", "close"]].copy()
    df["ok"] = (df.min(axis=1) > 0) & (df["low"] <= df[["open", "close"]].min(axis=1)) & (df["high"] >= df[["open", "close"]].max(axis=1))
    df["vix"], df["vxn"], df["pcr"] = vix.reindex(df.index), vxn.reindex(df.index), pc.reindex(df.index)
    df["vol"] = df["vix"] if asset == "SPY" else df["vxn"].where(df["vxn"].notna(), df["vix"])
    n = len(df)
    close, ok = df["close"].to_numpy(), df["ok"].to_numpy()
    dd = np.full(n, np.nan)
    for i in range(P["lookback"] - 1, n):
        w = slice(i - P["lookback"] + 1, i + 1)
        if ok[i] and ok[w].all():
            dd[i] = (1 - close[i] / close[w].max()) * 100
    df["dd"] = dd
    sma = np.full(n, np.nan)
    for i in range(P["ma"] - 1, n):
        w = slice(i - P["ma"] + 1, i + 1)
        if ok[i] and ok[w].all():
            sma[i] = close[w].mean()
    df["sma"] = sma
    seg = (df.index < P["pcr_break"]).astype(int)  # 1 = CBOE-only era, 0 = all-exchange era (labels only need to differ)
    raw = df["pcr"].to_numpy()
    avg = np.full(n, np.nan)
    for i in range(P["pcr_avg"] - 1, n):
        w = slice(i - P["pcr_avg"] + 1, i + 1)
        if np.isfinite(raw[w]).all() and (seg[w] == seg[i]).all():
            avg[i] = raw[w].mean()
    thr = np.full(n, np.nan)
    for i in range(n):
        if not np.isfinite(avg[i]):
            continue
        past = []
        for j in range(i - 1, max(-1, i - P["pcr_window"] - 1), -1):
            if seg[j] != seg[i]:
                break
            if np.isfinite(avg[j]):
                past.append(avg[j])
        if len(past) >= P["pcr_min"]:
            thr[i] = pct_linear(past, P["pcr_pct"])
    df["pcr_avg"], df["pcr_thr"] = avg, thr
    return df


def stage_a(df):
    v, x = df["vix"].to_numpy(), df["vxn"].to_numpy()
    vol_ext = np.where(np.isnan(v) & np.isnan(x), np.nan, ((np.nan_to_num(v, nan=-1) >= P["vix"]) | (np.nan_to_num(x, nan=-1) >= P["vxn"])).astype(float))
    elig = df["ok"].to_numpy() & np.isfinite(df["dd"].to_numpy()) & np.isfinite(vol_ext)
    a = elig & (vol_ext == 1) & (np.nan_to_num(df["dd"].to_numpy(), nan=-1) >= P["gate"])
    pcr_ok = np.isfinite(df["pcr_avg"].to_numpy()) & np.isfinite(df["pcr_thr"].to_numpy())
    b = a & pcr_ok & (df["pcr_avg"].to_numpy() >= np.nan_to_num(df["pcr_thr"].to_numpy(), nan=np.inf))
    x = df["vxn"].to_numpy()
    sens = df["ok"].to_numpy() & np.isfinite(df["dd"].to_numpy()) & np.isfinite(x) & (np.nan_to_num(x, nan=-1) >= 30.0) & (np.nan_to_num(df["dd"].to_numpy(), nan=-1) >= P["gate"])
    return a, b, sens


def events(flags):
    out, last = [], -10**9
    for i, f in enumerate(flags):
        if f and i - last >= P["cooldown"]:
            out.append(i)
            last = i
    return out


def confirm(df, a):
    close, ok, vol, sma = df["close"].to_numpy(), df["ok"].to_numpy(), df["vol"].to_numpy(), df["sma"].to_numpy()
    low, low_i, peak = math.inf, a, -math.inf
    for t in range(a, min(len(df) - 1, a + P["confirm_window"]) + 1):
        if not ok[t]:
            continue
        if close[t] <= low:
            low, low_i = close[t], t
        if np.isfinite(vol[t]) and vol[t] > peak:
            peak = vol[t]
        if t == a:
            continue
        if t - low_i >= P["no_new_low"] and np.isfinite(vol[t]) and peak > 0 and vol[t] <= P["vol_retreat"] * peak and np.isfinite(sma[t]) and close[t] > sma[t]:
            return t
    return None


def outcome(df, i):
    if i + 1 >= len(df) or not df["ok"].iloc[i + 1]:
        return None
    entry = df["open"].iloc[i + 1]
    res = {}
    for h in P["horizons"]:
        if i + h >= len(df):
            continue
        w = df.iloc[i + 1:i + h + 1]
        if not w["ok"].all():
            continue
        res[h] = (df["close"].iloc[i + h] / entry - 1) * 100, min(0.0, (w["low"].min() / entry - 1) * 100), max(0.0, (w["high"].max() / entry - 1) * 100)
    return res


def main() -> int:
    exp = json.loads((ROOT / "docs/research/us-capitulation-alert-backtest.json").read_text())
    bad = checked = 0
    for asset in ("SPY", "QQQ"):
        df = frame(asset)
        a, b, sens = stage_a(df)
        mine = {"A": events(a), "B": events(b), "S": events(sens)}
        mine["AS"] = [(i, confirm(df, i)) for i in mine["A"]]
        mine["E"] = [(i, confirm(df, i)) for i in mine["B"]]
        for model, base in (("A", "A"), ("B", "B"), ("AS", "A"), ("E", "B"), ("S", "S")):
            got = exp["assets"][asset]["models"][model]
            if model in ("A", "B", "S"):
                pairs = [(i, i) for i in mine[model]]
            else:
                pairs = [(i, c) for i, c in mine[model] if c is not None]
            trig = int({"A": a, "B": b, "S": sens}[base].sum())
            if trig != got["triggerDays"] or len(mine[base]) != got["base"]:
                print(f"FAIL {asset} {model}: trigger/base {trig}/{len(mine[base])} != {got['triggerDays']}/{got['base']}")
                bad += 1
            dates = [(df.index[p], df.index[c]) for p, c in pairs]
            theirs = [(e["panic"], e["date"]) for e in got["events"]]
            checked += 1
            if dates != theirs:
                print(f"FAIL {asset} {model}: event dates differ ({len(dates)} vs {len(theirs)}); first diffs {[d for d in zip(dates, theirs) if d[0] != d[1]][:3]}")
                bad += 1
                continue
            for (p, c), e in zip(pairs, got["events"]):
                o = outcome(df, c)
                for h in P["horizons"]:
                    cell = (e["out"] or {}).get("h", {}).get(str(h), {})
                    mine_h = (o or {}).get(h)
                    if (mine_h is None) != (cell.get("status") != "complete"):
                        print(f"FAIL {asset} {model} {df.index[c]} h={h}: completeness {mine_h is not None} vs {cell.get('status')}")
                        bad += 1
                        continue
                    if mine_h is None:
                        continue
                    checked += 1
                    for k, (v, key) in enumerate(zip(mine_h, ("ret", "mae", "mfe"))):
                        if abs(v - cell[key]) > 1e-9:
                            print(f"FAIL {asset} {model} {df.index[c]} h={h} {key}: {v} vs {cell[key]}")
                            bad += 1
    print(f"checked {checked} items; mismatches: {bad}")
    print("ALL OK" if not bad else "MISMATCH")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
