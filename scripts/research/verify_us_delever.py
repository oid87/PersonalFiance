#!/usr/bin/env python3
"""獨立複核 js/research/usdelever_*.mjs 的關鍵數字（不共用 JS 程式碼，用 Python 從 data/*.json 重算）。

  python3 scripts/research/verify_us_delever.py
複核：下跌波段、CFTC 轉倉標記與週變動、可得日對應、NFCI z-score 事件、FINRA 模型公布日事件、
VIX 事件與警報後 20 日報酬／再破底、L3 壓力日數。全部一致才印 ALL OK、exit 0。
"""
import bisect, datetime as dt, json, os, statistics as st, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
R = lambda p: json.load(open(os.path.join(ROOT, p)))
tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False); tmp.close()
subprocess.run(["node", os.path.join(ROOT, "scripts/research/backtest_us_delever.mjs"), "--out", os.devnull, "--json", tmp.name],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT)
res = json.load(open(tmp.name)); os.unlink(tmp.name)
ok = True
def chk(name, a, b, tol=1e-6):
    global ok
    good = (abs(a - b) < tol) if isinstance(a, float) or isinstance(b, float) else a == b
    if not good: ok = False
    print(("OK  " if good else "FAIL"), name, a, b)

spy = {r["date"]: r for r in R("data/SPY.json")["data"]}; qqq = {r["date"]: r for r in R("data/QQQ.json")["data"]}
cal = sorted(d for d in spy if d in qqq); idx = {d: i for i, d in enumerate(cal)}; N = len(cal)
START, END = "2020-01-01", "2026-10-16"
si = next(i for i, d in enumerate(cal) if d >= START); ei = max(i for i, d in enumerate(cal) if d <= END)
def on_or_after(d): return bisect.bisect_left(cal, d) if bisect.bisect_left(cal, d) < N else None
def on_or_before(d): j = bisect.bisect_right(cal, d) - 1; return j if j >= 0 else None
def add(d, n): return (dt.date.fromisoformat(d) + dt.timedelta(n)).isoformat()
close = {"SPY": [spy[d]["close"] for d in cal], "QQQ": [qqq[d]["close"] for d in cal]}
opn = {"SPY": [spy[d]["open"] for d in cal], "QQQ": [qqq[d]["open"] for d in cal]}
low = {"SPY": [spy[d]["low"] for d in cal], "QQQ": [qqq[d]["low"] for d in cal]}
dd = {}
for s in close:
    dd[s] = []
    for i in range(N):
        hi = max(close[s][max(0, i - 119):i + 1]); dd[s].append((1 - close[s][i] / hi) * 100)

def waves(s):
    out = []; cur = None
    for i in range(si, ei + 1):
        if cur is None and dd[s][i] >= 8: cur = [i, i]
        if cur is not None:
            if close[s][i] < close[s][cur[1]]: cur[1] = i
            if dd[s][i] < 3 or i == ei: out.append((cal[cur[0]], cal[cur[1]])); cur = None
    return out
for s in ("SPY", "QQQ"):
    chk(f"waves {s}", waves(s), [(w["startDate"], w["lowDate"]) for w in res["waves"][s]])

def clusters(idxs, cd=10):
    ev = []
    for i in sorted(set(idxs)):
        if ev and i - ev[-1][1] <= cd: ev[-1][1] = i
        else: ev.append([i, i])
    return [e[0] for e in ev]
def fwd20(s, i):
    e = i + 1; x = e + 19
    if x >= N: return None
    ent = opn[s][e]; brk = any(low[s][j] < low[s][i] for j in range(e, x + 1))
    return (close[s][x] / ent - 1) * 100, brk
def summarize(s, events):
    v = [fwd20(s, i) for i in events]; v = [x for x in v if x]
    return len(v), st.median(x[0] for x in v), sum(1 for x in v if x[1]) / len(v) * 100
sc = {r["id"]: r for r in res["score"]}

# VIX
vix = {r["date"]: r["close"] for r in R("data/VIX.json")["data"] if isinstance(r["close"], (int, float))}
for th, sid in ((25, "vix25"), (30, "vix30")):
    fl = [i for i in range(si, ei + 1) if cal[i] in vix and vix[cal[i]] >= th]
    ev = clusters(fl); chk(sid + " events", len(ev), sc[sid]["events"])
    n, med, bp = summarize("SPY", ev); chk(sid + " SPY20 n", n, sc[sid]["sum"]["SPY"]["20"]["n"]); chk(sid + " SPY20 median", med, sc[sid]["sum"]["SPY"]["20"]["retMedian"])
    chk(sid + " SPY20 rebreak", bp, sc[sid]["sum"]["SPY"]["20"]["breakPct"])

# CFTC
rows = {}
for src in (R("data/research/us_delever/cftc_tff_2019_2021.json"), R("data/cftc_positions.json")):
    for ins in src["instruments"]:
        rows.setdefault(ins["id"], {}).update({r["date"]: r for r in ins["rows"]})
def third_friday(y, m):
    d = dt.date(y, m, 1); fr = [d + dt.timedelta(i) for i in range(31) if (d + dt.timedelta(i)).month == m and (d + dt.timedelta(i)).weekday() == 4]; return fr[2]
exps = [third_friday(y, m) for y in range(2018, 2028) for m in (3, 6, 9, 12)]
def roll_wk(d):
    dd_ = dt.date.fromisoformat(d); near = min(exps, key=lambda e: abs((dd_ - e).days)); return round((dd_ - near).days / 7)
per = {}
for k in ("sp500", "nasdaq100", "russell2000"):
    rs = [rows[k][d] for d in sorted(rows[k])]; prev = None; out = {}
    for r in rs:
        roll = roll_wk(r["date"]) in (0, 1); g = r["lev_long"] + r["lev_short"]
        rec = {"roll": roll, "gross": g, "g": None, "avail": on_or_after(add(r["date"], 3))}
        if not roll:
            if prev is not None: rec["g"] = (g / prev - 1) * 100
            prev = g
        out[r["date"]] = rec
    per[k] = out
dates = sorted(set(per["sp500"]) | set(per["nasdaq100"]))
def flags_both(t):
    o = []
    for d in dates:
        a, b = per["sp500"].get(d), per["nasdaq100"].get(d)
        if not a or not b or a["roll"] or b["roll"] or a["g"] is None or b["g"] is None: continue
        if a["g"] <= -t and b["g"] <= -t:
            av = max(a["avail"], b["avail"]); o.append(av)
    return [i for i in o if si <= i <= ei]
for t in (4, 6, 8):
    sid = f"cftc_both_g{t}"; ev = clusters(flags_both(t)); chk(sid + " events", len(ev), sc[sid]["events"])
    n, med, bp = summarize("SPY", ev); chk(sid + " SPY20 median", med, sc[sid]["sum"]["SPY"]["20"]["retMedian"])
fl = []
for d in dates:
    a = per["sp500"].get(d)
    if a and not a["roll"] and a["g"] is not None and a["g"] <= -6 and a["avail"] is not None and si <= a["avail"] <= ei: fl.append(a["avail"])
chk("cftc_sp_g6 events", len(clusters(fl)), sc["cftc_sp_g6"]["events"])

# NFCI z
nf = sorted(R("data/nfci.json")["data"], key=lambda r: r["date"])
dl = [None] + [nf[i]["leverage"] - nf[i - 1]["leverage"] for i in range(1, len(nf))]
fl = []
for i in range(1, len(nf)):
    w = [dl[j] for j in range(max(1, i - 52), i)]
    if len(w) < 26: continue
    m = sum(w) / len(w); sd = (sum((x - m) ** 2 for x in w) / len(w)) ** 0.5
    if sd > 0 and (dl[i] - m) / sd >= 1.5:
        a = on_or_after(add(nf[i]["date"], 5))
        if a is not None and si <= a <= ei: fl.append(a)
chk("nfci_lev_up events", len(clusters(fl)), sc["nfci_lev_up"]["events"])

# FINRA (model: month end + 25d clamped to (not_yet, known_by]; missing → month end + 25d)
rel = R("data/research/us_delever/finra_release_dates.json")["release"]
fm = sorted(R("data/margin_global_us.json")["data"], key=lambda r: r["date"])
def month_end(ym):
    y, m = int(ym[:4]), int(ym[5:7]); return (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.timedelta(1)).isoformat()
fl = []
for i in range(1, len(fm)):
    mom = (fm[i]["margin_balance"] / fm[i - 1]["margin_balance"] - 1) * 100
    key = fm[i]["date"][:7]; known = add(month_end(key), 25); r = rel.get(key)
    if r:
        if r["not_yet"] and known < add(r["not_yet"], 1): known = add(r["not_yet"], 1)
        if known > r["known_by"]: known = r["known_by"]
    a = on_or_after(known)
    if mom <= -3 and a is not None and si <= a <= ei: fl.append(a)
chk("finra_mom3 events", len(clusters(fl)), sc["finra_mom3"]["events"])

# L3 壓力日數
vxn = {r["date"]: r["close"] for r in R("data/VXN.json")["data"]}
ts = {r["date"]: r["vix"] / r["vix3m"] for r in R("data/vix_term.json")["data"] if r["vix"] and r["vix3m"]}
oas = {r["date"]: r["hy"] for r in R("data/credit_spread.json")["data"]}
hyg = {r["date"]: r["close"] for r in R("data/HYG.json")["data"]}; lqd = {r["date"]: r["close"] for r in R("data/LQD.json")["data"]}
br = {r["date"]: r["above50_pct"] for r in R("data/breadth.json")["data"] if r.get("above50_pct") is not None}
ratio = [hyg[d] / lqd[d] if d in hyg and d in lqd else None for d in cal]
cnt = 0
for i in range(si, ei + 1):
    d = cal[i]; c = 0
    if d in vix and vix[d] >= 25: c += 1
    if d in vxn and vxn[d] >= 28: c += 1
    if d in ts and ts[d] >= 1.0: c += 1
    o5 = oas[d] - oas[cal[i - 5]] if d in oas and i >= 5 and cal[i - 5] in oas else None
    h20 = (ratio[i] / ratio[i - 20] - 1) * 100 if i >= 20 and ratio[i] and ratio[i - 20] else None
    if o5 is not None:
        if o5 >= 0.5: c += 1
    elif h20 is not None and h20 <= -2.5: c += 1
    if d in br and br[d] <= 35: c += 1
    if c >= 2: cnt += 1
chk("L3 stress days", cnt, res["layers"]["shares"]["L3"])
os.sys.exit(0 if (print("ALL OK" if ok else "SOME FAIL") or ok) else 1)
