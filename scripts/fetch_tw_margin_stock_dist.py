"""個股（非 ETF）融資維持率分布 — 上市＋上櫃，逐檔 vintage 估算。

交易所不公布逐檔或逐戶維持率，本檔用公開的逐檔融資張數與收盤價估算：
  - 每檔每天：資買張數視為以當日收盤價建倉的新 vintage（成本 = 收盤）。
  - 資賣＋現償以 75% LIFO（最新建倉先出）＋25% 等比例分攤沖銷（同 fetch_margin_costmap.py 假設）。
  - 沖銷後依交易所公布的今日餘額等比例校正，避免累積誤差。
  - vintage 維持率 = 收盤 / (成本 × 60%) × 100（融資成數 6 成、整戶合併與補繳不考慮）。
  - 單日價格變動超過 ±40%（減資、分割、恢復交易）時，所有 vintage 成本同比例調整。
分布以「融資金額」（張 × 成本 × 60%）加權，不是檔數。
排除代號 00 開頭（ETF／ETN／受益憑證）。

資料：TWSE MI_MARGN（逐檔融資）＋ MI_INDEX ALLBUT0999（收盤）；
      TPEx margin/balance（逐檔融資）＋ afterTrading/otc EW（收盤）。
Output: data/tw_margin_stock_dist.json   前端讀
        data/tw_margin_stock_state.json  逐檔 vintage 狀態（增量續算用）
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_margin_stock_dist.json"
STATE = ROOT / "data" / "tw_margin_stock_state.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
MARGN = "https://www.twse.com.tw/exchangeReport/MI_MARGN"
MINDEX = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
TP_MARGN = "https://www.tpex.org.tw/www/zh-tw/margin/balance"
TP_PX = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc"
FLOOR = os.environ.get("MSD_FLOOR", "2024-11-01")      # 暖機起點
OUT_FROM = os.environ.get("MSD_OUT_FROM", "2025-05-01")  # 輸出起點（前面當暖機）
MAX_DAYS = int(os.environ.get("MSD_MAX_DAYS", "40"))
SLEEP = float(os.environ.get("MSD_SLEEP", "0.6"))
LIFO = 0.75
FIN = 0.6
MAX_VINT = 24
EDGES = (130, 140, 150)
CODE_RE = re.compile(r"^[1-9]\d{3}[A-Z]?$")  # 普通股；排除 00 開頭

SESS = requests.Session()


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except Exception:
        return None


def get_json(url, params, tries=4):
    for i in range(tries):
        try:
            r = SESS.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                time.sleep(4 + 5 * i)
                continue
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def twse_day(ymd):
    mg = get_json(MARGN, {"response": "json", "date": ymd, "selectType": "ALL"})
    if not mg or mg.get("stat") != "OK" or mg.get("date") != ymd or not mg.get("tables"):
        return None
    rows = max(mg["tables"], key=lambda t: len(t.get("data", [])))["data"]
    flows = {}
    for r in rows:
        code = str(r[0]).strip()
        if CODE_RE.match(code):
            b, s, c, bal = num(r[2]), num(r[3]), num(r[4]), num(r[6])
            if None not in (b, s, c, bal):
                flows[code] = (b, s + c, bal)
    time.sleep(SLEEP)
    px = get_json(MINDEX, {"response": "json", "date": ymd, "type": "ALLBUT0999"})
    if not px or px.get("stat") != "OK" or px.get("date") != ymd:
        return None
    closes = {}
    for t in px.get("tables", []):
        f = t.get("fields", [])
        ci = [i for i, x in enumerate(f) if "代號" in str(x)]
        pi = [i for i, x in enumerate(f) if "收盤" in str(x)]
        if ci and pi:
            for r in t["data"]:
                v = num(r[pi[0]])
                if v:
                    closes[str(r[ci[0]]).strip()] = v
    if len(flows) < 600 or len(closes) < 600:
        return None
    return flows, closes


def tpex_day(d_iso):
    y, m, d = d_iso.split("-")
    q = {"date": f"{y}/{m}/{d}", "response": "json"}
    mg = get_json(TP_MARGN, q)
    t = ((mg or {}).get("tables") or [{}])[0]
    if not t.get("data"):
        return None
    f = [str(x).strip() for x in t.get("fields", [])]
    try:
        ci, bi, si, ri, li = f.index("代號"), f.index("資買"), f.index("資賣"), f.index("現償"), f.index("資餘額")
    except ValueError:
        return None
    flows = {}
    for r in t["data"]:
        code = str(r[ci]).strip()
        if CODE_RE.match(code):
            b, s, c, bal = num(r[bi]), num(r[si]), num(r[ri]), num(r[li])
            if None not in (b, s, c, bal):
                flows[code] = (b, s + c, bal)
    time.sleep(SLEEP)
    px = get_json(TP_PX, {**q, "type": "EW"})
    t = ((px or {}).get("tables") or [{}])[0]
    if not t.get("data"):
        return None
    f = [str(x).strip() for x in t.get("fields", [])]
    try:
        ci, pi = f.index("代號"), f.index("收盤")
    except ValueError:
        return None
    closes = {}
    for r in t["data"]:
        v = num(r[pi])
        if v and v > 0:
            closes[str(r[ci]).strip()] = v
    if len(flows) < 300 or len(closes) < 300:
        return None
    return flows, closes


def step_stock(st, flow, close):
    """st = {"p": 上次收盤, "v": [[成本, 張], ...] 舊→新}。原地更新。"""
    buy, out, bal = flow
    v = st["v"]
    prev = st.get("p")
    if prev and close and (close / prev > 1.4 or close / prev < 0.6):
        k = close / prev
        for x in v:
            x[0] *= k
    tot = sum(x[1] for x in v)
    out = min(out, tot)
    if out > 0 and tot > 0:
        lifo, prop = out * LIFO, out * (1 - LIFO)
        for x in reversed(v):
            take = min(x[1], lifo)
            x[1] -= take
            lifo -= take
            if lifo <= 0:
                break
        rest = sum(x[1] for x in v)
        if rest > 0:
            k = max(0.0, (rest - prop - lifo) / rest)
            for x in v:
                x[1] *= k
        v[:] = [x for x in v if x[1] > 1e-6]
    if buy > 0 and close:
        v.append([close, buy])
    tot = sum(x[1] for x in v)
    if bal <= 0:
        v.clear()
    elif tot <= 0:
        if close:
            v.append([close, bal])
    elif abs(tot - bal) > 1e-6:
        k = bal / tot
        for x in v:
            x[1] *= k
    while len(v) > MAX_VINT:  # 合併成本最接近的相鄰兩筆
        j = min(range(len(v) - 1), key=lambda i: abs(v[i][0] / v[i + 1][0] - 1))
        a, b = v[j], v[j + 1]
        n = a[1] + b[1]
        v[j:j + 2] = [[(a[0] * a[1] + b[0] * b[1]) / n, n]]
    if close:
        st["p"] = close


def distribution(stocks):
    buckets = [0.0, 0.0, 0.0, 0.0]
    for st in stocks.values():
        c = st.get("p")
        if not c:
            continue
        for cost, lots in st["v"]:
            amt = cost * lots * FIN  # 仟元
            r = c / (cost * FIN) * 100
            i = sum(r >= e for e in EDGES)
            buckets[i] += amt
    tot = sum(buckets)
    if tot <= 0:
        return None
    pct = [round(b / tot * 100, 2) for b in buckets]
    return {"lt130": pct[0], "b130": pct[1], "b140": pct[2], "ge150": pct[3],
            "lt150": round(pct[0] + pct[1] + pct[2], 2),
            "margin_yi": round(tot / 1e5, 1)}


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"last": None, "twse": {}, "tpex": {}}


def save(state, rows):
    for mk in ("twse", "tpex"):
        for st in state[mk].values():
            st["v"] = [[round(c, 4), round(n, 2)] for c, n in st["v"]]
            if st.get("p"):
                st["p"] = round(st["p"], 4)
    for r in rows:
        r.setdefault("lt150", round(r["lt130"] + r["b130"] + r["b140"], 2))
    STATE.write_text(json.dumps(state, separators=(",", ":")))
    OUT.write_text(json.dumps({
        "source": "TWSE MI_MARGN/MI_INDEX ＋ TPEx margin/balance、afterTrading/otc（逐檔融資張數與收盤）",
        "note": ("個股（排除 00 開頭 ETF）融資維持率分布，融資金額加權。逐檔 vintage 估算："
                 "資買以當日收盤建倉、資賣＋現償 75% LIFO＋25% 等比例沖銷、依今日餘額校正；"
                 "維持率＝收盤/(成本×60%)。估計值，非交易所公布；不含整戶合併與補繳。"),
        "updated": date.today().isoformat(),
        "edges": list(EDGES),
        "data": rows,
    }, ensure_ascii=False, separators=(",", ":")))


def main():
    state = load_state()
    rows = json.loads(OUT.read_text())["data"] if OUT.exists() and state["last"] else []
    d = date.fromisoformat(state["last"]) + timedelta(days=1) if state["last"] else date.fromisoformat(FLOOR)
    today = date.today()
    done = 0
    while d <= today and done < MAX_DAYS:
        if d.weekday() >= 5:
            d += timedelta(days=1)
            continue
        iso = d.isoformat()
        tw = twse_day(iso.replace("-", ""))
        time.sleep(SLEEP)
        if tw is None:
            print(f"{iso} 無上市資料（休市或尚未公布）", flush=True)
            if d >= today - timedelta(days=1):
                break
            d += timedelta(days=1)
            continue
        tp = tpex_day(iso)
        time.sleep(SLEEP)
        if tp is None:
            print(f"{iso} 上櫃資料缺，停在這天下次重試", flush=True)
            break
        for mk, (flows, closes) in (("twse", tw), ("tpex", tp)):
            book = state[mk]
            for code in list(book):
                if code not in flows:
                    del book[code]
            for code, fl in flows.items():
                st = book.setdefault(code, {"p": None, "v": []})
                step_stock(st, fl, closes.get(code))
        state["last"] = iso
        if iso >= OUT_FROM:
            dist = distribution({**{"w" + k: v for k, v in state["twse"].items()},
                                 **{"o" + k: v for k, v in state["tpex"].items()}})
            if dist:
                rows = [r for r in rows if r["date"] != iso] + [{"date": iso, **dist}]
                print(f"{iso} <130 {dist['lt130']}% 130-140 {dist['b130']}% 140-150 {dist['b140']}% ≥150 {dist['ge150']}%", flush=True)
        else:
            print(f"{iso} 暖機", flush=True)
        done += 1
        if done % 20 == 0:
            save(state, rows)
        d += timedelta(days=1)
    save(state, rows)


if __name__ == "__main__":
    main()
