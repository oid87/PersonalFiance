#!/usr/bin/env python3
"""Index forward P/E 時間序列自建 — VOO / QQQ。

跟既有的 fetch_spy_valuation.py / fetch_qqq_valuation.py **平行**存在（新方法論驗證期），
比對一段時間無誤後才切換過去。兩者的差別：

  舊：前 20 大持股，加權「算術」平均個股 NTM PE，排除 PE>70x 與負 EPS，權重重新正規化
  新：全成分股，Σ(shares×price) / Σ(shares×eps)，負 EPS 留在分母自然扣減，不剔除

分母（NTM 共識 EPS）沒有免費歷史資料，所以序列只能從第一次成功執行當天開始長，
**永不回填**。這是刻意的：假造的歷史比沒有歷史更糟。

## 公式

    index_forward_pe = Σ(sharesᵢ × priceᵢ) / Σ(sharesᵢ × forward_epsᵢ)

即「總市值 ÷ 總預估盈餘」，等價於以市值權重取個股 P/E 的調和平均。只有權重、沒有股數
的來源（QQQ）用等價式，代數上同一個東西：

    Σ(mvᵢ) / Σ(mvᵢ × epsᵢ/priceᵢ)      mvᵢ = sharesᵢ×priceᵢ 或 wᵢ，比值不變

所以兩個標的算的是同一個定義，負 EPS 在兩條路上都是自然扣減（epsᵢ/priceᵢ 為負）。

## Holdings 來源（2026-09-05 實測）

VOO — Vanguard 沒有公開的 holdings feed（investor.vanguard.com 的 API 回 HTML），
      改用 **IVV**（iShares Core S&P 500）代替：同追 S&P 500，plain requests 就過。
      ⚠️ 別用產品頁 JS 注入的 `…ajax?fileType=csv`，那支回 200 但 body 是產品頁 HTML。
QQQ — Invesco 的下載端點連 ticker 參數都不吃（QQQ / QQQM 回同一份 422KB HTML shell，
      裸 curl 是 406）；iShares 的 Nasdaq-100 只有 UCITS 線（CNDX，UK 站）且卡
      investor-type gate。改用 **slickcharts 的 NDX 指數權重**（QQQ 完全複製這組權重）。
      另存一份 Nasdaq 官方 API 的市值權重當交叉檢查，兩者差太多就把當天標 valid=false。

Usage:
  python3 scripts/fetch_forward_pe.py --ticker VOO --dry-run
  python3 scripts/fetch_forward_pe.py --ticker QQQ
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from datetime import date
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# ── 規格常數（改這裡等於改方法論，別散在程式各處）──────────────────────────
COVERAGE_MIN = 0.95        # 低於此值仍寫入，但標 valid=false，前端不畫
TRADING_DAYS_5Y = 1260     # 不足就輸出 null，不用短樣本假裝成 5y 均線
TRADING_DAYS_10Y = 2520
# PRIMARY_BASIS：暫定 "ntm"。fy2 / ntm 兩條線每天都完整寫入同一筆記錄，切換主序列
# 只改這個常數，不會遺失任何一邊的歷史（跑一段時間比對後再決定用哪條當主序列）。
PRIMARY_BASIS = "ntm"      # "ntm"（blended NTM）或 "fy2"（純 FY2，即舊版 forwardEps 行為）
PRIMARY_EPS_KEY = "ntm_eps" if PRIMARY_BASIS == "ntm" else "fwd_eps_fy2"
PRIMARY_LABEL = "blended_ntm" if PRIMARY_BASIS == "ntm" else "fy2_only"
EPS_SOURCE = "yfinance.earnings_estimate(0y,+1y) + info.nextFiscalYearEnd"
QQQ_CROSSCHECK_TOL = 0.05  # slickcharts 指數權重 vs Nasdaq 市值權重的容許相對差

# 基準：FactSet Earnings Insight 一手公布的 S&P 500 forward 12-month P/E，
# as-of 2026-09-04（"the forward 12-month P/E ratio for the S&P 500 is 19.5"）。
# QQQ（NASDAQ-100）沒有可用的同口徑 NTM 基準，設 None——三 basis 對照表對 QQQ
# 不印 vs 基準那一欄。僅供診斷期人眼比對用，不參與任何計算（不是 fallback、
# 不是校正因子）。
#
# WSJ 的 21.22（VOO）/25.25（QQQ）**保留但降為次要參考**：已查明是「日曆年
# CY2026」口徑、不是 NTM（WSJ 隱含 EPS 363.7 vs FactSet CY2026 bottom-up EPS
# $361.38，差 0.65%；WSJ 腳注雖寫 "Forward 12 months"，與其數字不符），
# 不可拿來當 NTM 基準比對用。
BENCHMARK_REF = {"VOO": 19.5, "QQQ": None}
WSJ_REF_CY2026 = {"VOO": 21.22, "QQQ": 25.25}  # 次要參考，日曆年口徑，非 NTM

FETCH_DELAY = 0.25
FETCH_RETRIES = 3

# iShares CSV 的 ticker 寫法跟 yfinance 不同（複數股別去掉了連字號）
TICKER_FIX = {"BRKB": "BRK-B", "BFB": "BF-B", "BFA": "BF-A", "LENB": "LEN-B"}

# 現金 / 衍生品：ticker 命中或 Asset Class 非 Equity 就排除
CASH_TICKERS = {"-", "USD", "XTSLA", "MWRRF", "BLKFDS", "SGAFT"}


SOURCES: dict[str, dict] = {
    "VOO": {
        "kind": "ishares_csv",
        "url": "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/latest-holdings.csv",
        "holdings_source": "iShares IVV latest-holdings.csv (VOO proxy)",
        "note": "VOO 無公開 holdings feed，用同追 S&P 500 的 IVV 持股代替。",
    },
    "QQQ": {
        "kind": "slickcharts",
        "url": "https://www.slickcharts.com/nasdaq100",
        "crosscheck_url": "https://api.nasdaq.com/api/quote/list-type/nasdaq100",
        "holdings_source": "slickcharts.com/nasdaq100 (NDX index weights)",
        "note": "Invesco holdings 端點被擋，改用 NDX 指數權重（QQQ 完全複製）。",
    },
}


# ── Step 1：holdings ────────────────────────────────────────────────────────
def _num(s: str) -> float | None:
    s = (s or "").strip().replace(",", "").replace("%", "").replace("$", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _get(url: str, **kw) -> requests.Response:
    r = requests.get(url, headers={"User-Agent": UA}, timeout=60, **kw)
    r.raise_for_status()
    return r


def _fetch_ishares_csv(url: str) -> tuple[list[dict], str]:
    """iShares latest-holdings.csv → ([{ticker,name,shares,weight,csv_price}], as_of)。

    前段是 metadata，真正的表頭是第一列等於 "Ticker" 的那行；檔尾偶有註腳，所以用
    「欄位數對得上且 Ticker 非空」當有效列判準，不靠行號硬切。
    """
    body = _get(url).text
    if body.lstrip().startswith("<"):
        raise RuntimeError(f"holdings endpoint 回了 HTML 不是 CSV（bot gate？）：{url}")

    rows = list(csv.reader(io.StringIO(body)))
    as_of, header_idx = "", None
    for i, row in enumerate(rows):
        if row and row[0].strip() == "Fund Holdings as of" and len(row) > 1:
            as_of = row[1].strip()
        if row and row[0].strip() == "Ticker":
            header_idx = i
            break
    if header_idx is None:
        raise RuntimeError("holdings CSV 找不到 Ticker 表頭列")

    header = [h.strip() for h in rows[header_idx]]
    col = {n: i for i, n in enumerate(header)}
    need = ["Ticker", "Name", "Asset Class", "Weight (%)", "Quantity", "Price"]
    missing = [c for c in need if c not in col]
    if missing:
        raise RuntimeError(f"holdings CSV 缺欄位 {missing}；實際欄位={header}")

    out = []
    for row in rows[header_idx + 1:]:
        if len(row) < len(header):
            continue
        sym = row[col["Ticker"]].strip().upper()
        if not sym or sym in CASH_TICKERS:
            continue
        if row[col["Asset Class"]].strip() != "Equity":
            continue
        shares, weight = _num(row[col["Quantity"]]), _num(row[col["Weight (%)"]])
        if not shares or weight is None:
            continue
        out.append({
            "ticker": TICKER_FIX.get(sym, sym),
            "name": row[col["Name"]].strip(),
            "shares": shares,
            "weight": weight / 100.0,
            "csv_price": _num(row[col["Price"]]),
        })
    return out, as_of


def _fetch_slickcharts(url: str) -> tuple[list[dict], str]:
    """slickcharts NDX 表 → ([{ticker,name,shares=None,weight,csv_price}], as_of='')。

    表格欄位：# / Company / Symbol / Weight / Price / Chg。用「第一欄是數字且第四欄
    以 % 結尾」認有效列，避免掃到表頭與 Chg% 欄。
    """
    soup = BeautifulSoup(_get(url).text, "lxml")
    out = []
    for tr in soup.find_all("tr"):
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(tds) < 5 or not tds[0].isdigit() or not tds[3].endswith("%"):
            continue
        sym = tds[2].strip().upper()
        w = _num(tds[3])
        if not sym or w is None:
            continue
        out.append({
            "ticker": TICKER_FIX.get(sym, sym),
            "name": tds[1],
            "shares": None,
            "weight": w / 100.0,
            "csv_price": _num(tds[4]),
        })
    if not out:
        raise RuntimeError(f"slickcharts 沒解析到任何列（版面可能改了）：{url}")
    return out, ""


def fetch_holdings(ticker: str) -> tuple[list[dict], str]:
    src = SOURCES[ticker]
    if src["kind"] == "ishares_csv":
        return _fetch_ishares_csv(src["url"])
    return _fetch_slickcharts(src["url"])


def fetch_nasdaq_crosscheck(url: str) -> dict[str, float] | None:
    """Nasdaq 官方 API 的市值權重 {SYM: weight}，抓不到就 None（交叉檢查而已，不擋流程）。"""
    try:
        j = _get(url).json()
        rows = j["data"]["data"]["rows"]
        mc = {}
        for r in rows:
            sym = str(r.get("symbol", "")).strip().upper()
            v = _num(str(r.get("marketCap", "")))
            if sym and v:
                mc[TICKER_FIX.get(sym, sym)] = v
        total = sum(mc.values())
        return {k: v / total for k, v in mc.items()} if total else None
    except Exception as e:                       # noqa: BLE001 — 交叉檢查失敗不該炸主流程
        print(f"      [crosscheck] 抓取失敗，略過：{e}")
        return None


# ── Step 2a：FX 換算 ─────────────────────────────────────────────────────────
# yf.Ticker(x).earnings_estimate 的 EPS 用「財報幣別」(info['financialCurrency'])
# 計價，但 info['regularMarketPrice'] / info['forwardEps'] 都是「報價幣別」
# (info['currency'])。ADR（PDD/ASML 等）兩者不同，不換算會讓分母被灌爆或縮水。
# 見 docs/forward_pe.md「EPS basis」一節的實測證據表。
_FX_CACHE: dict[tuple[str, str], float | None] = {}


def fx_rate(frm: str, to: str) -> float | None:
    """frm→to 匯率。相同幣別回 1.0（不打網路）；抓不到就重試 FETCH_RETRIES 次，
    全部失敗才回 None 並快取——匯率來源瞬斷不該讓該幣別整輪都變 None（見
    docs/forward_pe.md「FX 失敗與 retry」一節）。只有真的全失敗才快取 None，
    成功就快取該值，沿用 fetch_quote 的退避風格（15s * 嘗試次數）。
    """
    if not frm or not to:
        return None
    if frm == to:
        return 1.0
    key = (frm, to)
    if key in _FX_CACHE:
        return _FX_CACHE[key]
    rate = None
    for attempt in range(FETCH_RETRIES):
        try:
            fx_info = yf.Ticker(f"{frm}{to}=X").info
            price = fx_info.get("regularMarketPrice")
            if price:
                rate = float(price)
        except Exception:                     # noqa: BLE001 — 逐次容錯，靠迴圈重試
            rate = None
        if rate is not None:
            break
        if attempt < FETCH_RETRIES - 1:
            time.sleep(15 * (attempt + 1))
    _FX_CACHE[key] = rate
    return rate


def fetch_price_asof(ticker: str) -> str | None:
    """指數自己（VOO/QQQ，不是成分股）最後一筆收盤價的交易日，YYYY-MM-DD。抓不到回 None。

    `date`（entry 的日期）是腳本執行日；這個是報價實際 as-of 的交易日——多數情況下
    是執行日的前一天（收盤後才有當天資料），但遇連假/週末會差更多天，兩者不假設固定
    relationship，各自如實記錄。
    """
    try:
        h = yf.Ticker(ticker).history(period="5d")
        if h is not None and not h.empty:
            return h.index[-1].strftime("%Y-%m-%d")
    except Exception:                             # noqa: BLE001 — 診斷欄位，抓不到不擋流程
        pass
    return None


# ── Step 2b：報價 + forward EPS（FY2 與 blended NTM 兩條）──────────────────────
def _blank_quote(err: str | None) -> dict:
    return {
        "price": None, "fwd_eps_fy2": None, "fwd_eps_fy1": None,
        "fy1_end": None, "w": None, "ntm_eps": None, "fy2_source": None,
        "fx": None, "fin_ccy": None, "ccy": None,
        "est_fy2_raw": None, "est_fy2_fx": None, "forward_eps_info": None,
        "err": err,
    }


def fetch_quote(sym: str) -> dict:
    """回傳 {price, fwd_eps_fy2, fwd_eps_fy1, fy1_end, ntm_eps, fy2_source, err, ...}。

    fwd_eps_fy2：**回歸**用 info['forwardEps']（本來就是報價幣別，不需換算），取不到
    才 fallback 到「換算後」的 earnings_estimate['+1y']（fy2_source 如實記錄用了哪一
    個，供診斷用，不寫進最終 jsonl entry）。

    ntm_eps：完全由 earnings_estimate 的 0y/+1y **換算成報價幣別後**自洽計算，
    不混用 info['forwardEps']——兩個來源在部分公司（PANW/TTWO/MSTR）差異極大且非
    匯率因素，混用會讓 blend 內部不自洽、且在 w 變動時產生假跳動。fy1/fy2 換算值、
    fy1_end 任一缺，ntm_eps 就是 None，不單邊硬湊。

    earnings_estimate 抓取失敗、或幣別換算不到，**都不炸掉整檔**——price/fy2（來自
    forwardEps）還在就仍算得出 FY2 那條線，只是 ntm_eps 缺這檔。
    """
    last_err = None
    for attempt in range(FETCH_RETRIES):
        try:
            time.sleep(FETCH_DELAY)
            t = yf.Ticker(sym)
            info = t.info
            price = info.get("regularMarketPrice") or info.get("currentPrice")
            ccy = info.get("currency")
            fin_ccy = info.get("financialCurrency")
            fx = fx_rate(fin_ccy, ccy)

            fy1_est_fx = fy2_est_fx = None
            est_fy2_raw = None
            try:
                est = t.earnings_estimate
                if est is not None and not est.empty:
                    if "+1y" in est.index and pd.notna(est.loc["+1y", "avg"]):
                        est_fy2_raw = float(est.loc["+1y", "avg"])
                        if fx is not None:
                            fy2_est_fx = est_fy2_raw * fx
                    if ("0y" in est.index and pd.notna(est.loc["0y", "avg"])
                            and fx is not None):
                        fy1_est_fx = float(est.loc["0y", "avg"]) * fx
            except Exception:                     # noqa: BLE001 — 缺這個不該炸掉整檔
                pass

            forward_eps_info = info.get("forwardEps")
            forward_eps_info = (float(forward_eps_info)
                                 if forward_eps_info is not None else None)

            if forward_eps_info is not None:
                fy2 = forward_eps_info
                fy2_source = "forwardEps"
            elif fy2_est_fx is not None:
                fy2 = fy2_est_fx
                fy2_source = "earnings_estimate_fx_fallback"
            else:
                fy2 = None
                fy2_source = None

            fy1_end = None
            ts = info.get("nextFiscalYearEnd")
            if ts:
                try:
                    fy1_end = date.fromtimestamp(ts)
                except Exception:                 # noqa: BLE001
                    fy1_end = None

            # w：diagnostic 用途獨立於 ntm_eps 是否算得出來——只要有 fy1_end 就能算，
            # print_table/print_w_distribution/--dump 都吃這個欄位，不各自重算一份。
            w = None
            if fy1_end is not None:
                w = (fy1_end - date.today()).days / 365.0
                w = max(0.0, min(1.0, w))

            ntm_eps = None
            if fy1_est_fx is not None and fy2_est_fx is not None and w is not None:
                ntm_eps = w * fy1_est_fx + (1 - w) * fy2_est_fx

            return {
                "price": float(price) if price else None,
                "fwd_eps_fy2": fy2,
                "fwd_eps_fy1": fy1_est_fx,
                "fy1_end": fy1_end.isoformat() if fy1_end else None,
                "w": w,
                "ntm_eps": ntm_eps,
                "fy2_source": fy2_source,
                "fx": fx,
                "fin_ccy": fin_ccy,
                "ccy": ccy,
                "est_fy2_raw": est_fy2_raw,
                "est_fy2_fx": fy2_est_fx,
                "forward_eps_info": forward_eps_info,
                "err": None,
            }
        except Exception as e:                   # noqa: BLE001 — 逐檔容錯，單檔失敗不炸整批
            last_err = e
            if attempt < FETCH_RETRIES - 1:
                time.sleep(15 * (attempt + 1))
    return _blank_quote(str(last_err))


# ── Step 3：計算 + 品質門檻 ────────────────────────────────────────────────
def compute(rows: list[dict], eps_key: str) -> dict:
    """Σ(mv) / Σ(mv × eps/price)。缺 price 或缺該 basis 的 eps，分子分母**一起**排除。

    mv = shares×price（有股數時）或 weight（只有權重時）—— 比值不變，見模組 docstring。
    eps_key："fwd_eps_fy2" 或 "ntm_eps"——兩個 basis 各自算自己的 coverage（分母不同、
    缺漏檔不同，coverage 本來就不會一樣）。
    """
    num = den = 0.0
    used_w = 0.0
    used: list[str] = []
    dropped: list[str] = []
    for r in rows:
        eps = r.get(eps_key)
        if r["price"] is None or eps is None:
            dropped.append(r["ticker"])
            continue
        mv = r["shares"] * r["price"] if r["shares"] else r["weight"]
        num += mv
        den += mv * (eps / r["price"])
        used_w += r["weight"]
        used.append(r["ticker"])
    return {
        "forward_pe": round(num / den, 2) if den else None,
        "coverage": round(used_w, 4),
        "constituents_used": len(used),
        "constituents_total": len(rows),
        "dropped": dropped,
    }


# ── Step 4：append-only 寫入 ───────────────────────────────────────────────
def jsonl_path(ticker: str) -> Path:
    return DATA / f"forward_pe_{ticker.lower()}.jsonl"


def load_series(ticker: str) -> list[dict]:
    p = jsonl_path(ticker)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def plan_write(ticker: str, entry: dict) -> tuple[dict, str, list[dict]]:
    """決定這次要寫哪一筆、覆蓋還是新增，但不落地寫檔——dry-run 與正式跑共用，

    確保兩者印出的「新增 / 覆蓋」訊息與實際會發生的行為一致。兩道防護並存：

    1. 同一天重跑：以 `date` 為鍵覆蓋當日該筆（既有行為，不重複 append）。
    2. 同一 `price_asof` 不重複：生產排程是週一–週五 05:00 UTC，週一那次跑到的
       最後收盤仍是上週五，會跟週末手動跑的那筆撞同一個 `price_asof`。若既有序列
       中已存在相同 `price_asof`（非 None）的記錄，就不新增，而是覆蓋該筆——
       保留原本的 `date`，其餘欄位更新為這次抓到的值。`price_asof` 為 None
       （抓不到）時退回原本以 `date` 為鍵的行為，不套用這道防護。

    回傳 (最終要寫入的 entry, 說明文字, 目前既有序列)。
    """
    series = load_series(ticker)
    price_asof = entry.get("price_asof")

    if price_asof is not None:
        existing = next((r for r in series if r.get("price_asof") == price_asof), None)
        if existing is not None:
            msg = (f"price_asof 防護：覆蓋既有 price_asof={price_asof} 的那筆"
                   f"（原 date={existing['date']}，沿用原 date，其餘欄位更新）")
            final_entry = dict(entry)
            final_entry["date"] = existing["date"]
            return final_entry, msg, series
        msg = f"price_asof 防護：新增（price_asof={price_asof} 為新值）"
        return dict(entry), msg, series

    msg = "price_asof 防護：price_asof=None，退回以 date 為鍵的行為"
    return dict(entry), msg, series


def write_series(ticker: str, entry: dict) -> list[dict]:
    """依 plan_write() 的決定落地寫檔。"""
    final_entry, msg, series = plan_write(ticker, entry)
    print(f"      {msg}")
    by_date = {r["date"]: r for r in series}
    by_date[final_entry["date"]] = final_entry
    merged = sorted(by_date.values(), key=lambda r: r["date"])
    jsonl_path(ticker).write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in merged))
    return merged


# ── Step 6：Chart.js 輸出 ──────────────────────────────────────────────────
def write_chart(ticker: str, series: list[dict]) -> Path:
    """Chart.js 直接可用。invalid 的點輸出 null（前端自然斷線不畫）。

    兩條 forward P/E 線（blended NTM / FY2）各自套自己的 valid 過濾。
    5y/10y 均線只對 primary basis（PRIMARY_BASIS）算，資料點不足 1260/2520 前
    **整條輸出 null** —— 用 60 個點算「5 年均」是假的，寧可空著。
    """
    labels = [r["date"] for r in series]
    pe_ntm = [(r.get("forward_pe_ntm") if r.get("valid_ntm") else None) for r in series]
    pe_fy2 = [(r.get("forward_pe_fy2") if r.get("valid_fy2") else None) for r in series]

    primary_field = "forward_pe_ntm" if PRIMARY_BASIS == "ntm" else "forward_pe_fy2"
    primary_valid_field = "valid_ntm" if PRIMARY_BASIS == "ntm" else "valid_fy2"
    primary_pe = [(r.get(primary_field) if r.get(primary_valid_field) else None) for r in series]

    def moving_avg(window: int) -> list[None | float]:
        if len(series) < window:
            return [None] * len(series)
        out, acc = [], []
        for v in primary_pe:
            acc.append(v)
            if len(acc) > window:
                acc.pop(0)
            vals = [x for x in acc if x is not None]
            out.append(round(sum(vals) / len(vals), 2) if len(acc) == window and vals else None)
        return out

    payload = {
        "labels": labels,
        "datasets": [
            {"label": f"{ticker} Forward P/E (blended NTM)", "data": pe_ntm, "spanGaps": False},
            {"label": f"{ticker} Forward P/E (FY2)", "data": pe_fy2, "spanGaps": False},
            {"label": "5y avg", "data": moving_avg(TRADING_DAYS_5Y), "borderDash": [6, 4]},
            {"label": "10y avg", "data": moving_avg(TRADING_DAYS_10Y), "borderDash": [2, 3]},
        ],
        "meta": {
            "ticker": ticker,
            "primary_basis": PRIMARY_BASIS,
            "eps_basis_ntm": "blended_ntm：w×FY1 + (1-w)×FY2，"
                             "w = clamp((fy1_end－today).days/365, 0, 1)",
            "eps_basis_fy2": "fy2_only：yfinance earnings_estimate '+1y'"
                             "（缺則 fallback info.forwardEps）",
            "eps_source": EPS_SOURCE,
            "price_asof_note": "date 是腳本執行日；股價/EPS 實際反映的交易日記錄在每筆"
                                "entry 的 price_asof（通常是執行日的前一個交易日收盤，"
                                "遇連假/週末會差更多天，兩者各自記錄、不假設固定關係）。",
            "holdings_source": SOURCES[ticker]["holdings_source"],
            "series_start": labels[0] if labels else None,
            "points": len(labels),
            "avg_5y_available_after": TRADING_DAYS_5Y,
            "avg_10y_available_after": TRADING_DAYS_10Y,
            "note": SOURCES[ticker]["note"],
        },
    }
    p = DATA / f"chart_{ticker.lower()}.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return p


# ── 表格輸出（dry-run 驗收面）──────────────────────────────────────────────
def _f(v, nd=2):
    return "—" if v is None else f"{v:,.{nd}f}"


def print_table(ticker: str, as_of: str, rows: list[dict], limit: int | None) -> None:
    shown = rows if limit is None else rows[:limit]
    print()
    print(f"{ticker} 成分股原始資料 — holdings as of {as_of or 'n/a'}，"
          f"報價/EPS 為 {date.today().isoformat()} 即時"
          + ("" if limit is None else f"（前 {limit} 檔，共 {len(rows)}）"))
    head = (f"{'#':>3}  {'Ticker':<7} {'Name':<20} {'Weight':>7} {'Price':>9} "
            f"{'FY1':>8} {'FY2':>8} {'w':>5} {'ntmEPS':>8} {'ntmPE':>8} {'fy2PE':>8}")
    print(head)
    print("-" * len(head))
    for i, r in enumerate(shown, 1):
        price = r.get("price")
        fy1, fy2, ntm = r.get("fwd_eps_fy1"), r.get("fwd_eps_fy2"), r.get("ntm_eps")
        fy1_end = r.get("fy1_end")
        w = None
        if fy1_end:
            days = (date.fromisoformat(fy1_end) - date.today()).days
            w = max(0.0, min(1.0, days / 365.0))
        ntm_pe = (price / ntm) if (price and ntm) else None
        fy2_pe = (price / fy2) if (price and fy2) else None
        print(f"{i:>3}  {r['ticker']:<7} {r['name'][:20]:<20} {r['weight'] * 100:>6.2f}% "
              f"{_f(price):>9} {_f(fy1):>8} {_f(fy2):>8} {_f(w, 2):>5} "
              f"{_f(ntm):>8} {_f(ntm_pe):>8} {_f(fy2_pe):>8}")
    print()


def print_fx_diagnostics(holdings: list[dict]) -> None:
    """幣別換算診斷（dry-run 用，肉眼確認換算方向正確）。

    兩段：① 幣別非 USD（報價幣別）的成分股，換算前後的 est FY2 值；
    ② info['forwardEps'] 與換算後 est['+1y'] 相對差 > 20% 的成分股——這些是
    GAAP/non-GAAP 或估計 vintage 的真實分歧，不是 bug，只列出來讓人看得到。
    """
    non_usd = [h for h in holdings if h.get("fin_ccy") and h.get("ccy")
               and h["fin_ccy"] != h["ccy"]]
    print(f"      幣別非 USD（報價幣別）的成分股：{len(non_usd)} 檔")
    if non_usd:
        head = (f"      {'Ticker':<7} {'Weight':>7} {'fin_ccy':>8} {'fx':>10} "
                f"{'est_raw':>10} {'est_fx':>10}")
        print(head)
        for h in sorted(non_usd, key=lambda x: -x["weight"]):
            print(f"      {h['ticker']:<7} {h['weight'] * 100:>6.2f}% "
                  f"{h['fin_ccy']:>8} {_f(h.get('fx'), 4):>10} "
                  f"{_f(h.get('est_fy2_raw')):>10} {_f(h.get('est_fy2_fx')):>10}")

    diverge = []
    for h in holdings:
        fwd, est_fx = h.get("forward_eps_info"), h.get("est_fy2_fx")
        if fwd is not None and est_fx is not None and fwd != 0:
            rel = abs(est_fx - fwd) / abs(fwd)
            if rel > 0.20:
                diverge.append((h["ticker"], h["weight"], fwd, est_fx, rel))
    w_sum = sum(d[1] for d in diverge)
    print(f"      forwardEps vs 換算後 est[+1y] 差 > 20%：{len(diverge)} 檔，"
          f"權重合計 {w_sum * 100:.2f}%")
    for tkr, w, fwd, est_fx, rel in sorted(diverge, key=lambda x: -x[1]):
        print(f"      {tkr:<7} {w * 100:>6.2f}%  forwardEps={fwd:>8.3f}  "
              f"est_fx={est_fx:>8.3f}  差={rel * 100:>5.1f}%")


def print_basis_comparison(tk: str, res_fy1: dict, res_ntm: dict, res_fy2: dict) -> None:
    """三 basis 對照表（診斷用，BENCHMARK_REF 僅供人眼比對，不參與任何計算）。

    QQQ 沒有可用的同口徑 NTM 基準（BENCHMARK_REF["QQQ"] = None），vs 基準欄印
    "n/a — 無可用 NTM 基準"。
    """
    ref = BENCHMARK_REF.get(tk)
    print()
    if ref is not None:
        print(f"      三 basis 對照（FactSet 基準 as-of 2026-09-04，僅供驗證期比對，"
              f"不參與任何計算；{tk} FactSet NTM={_f(ref)}）")
    else:
        print(f"      三 basis 對照（{tk} 無可用 NTM 基準，vs 基準欄 n/a；"
              f"僅供驗證期比對，不參與任何計算）")
    head = f"      {'basis':<12} {'forward_pe':>10} {'coverage':>9} {'used':>9} {'vs 基準':>8}"
    print(head)
    for label, res in (("FY1 only", res_fy1), ("blended NTM", res_ntm), ("FY2 only", res_fy2)):
        pe = res["forward_pe"]
        used_str = f"{res['constituents_used']}/{res['constituents_total']}"
        if pe is not None and ref:
            vs_str = f"{(pe - ref) / ref * 100:+.1f}%"
        elif ref is None:
            vs_str = "n/a"
        else:
            vs_str = "—"
        print(f"      {label:<12} {_f(pe):>10} {res['coverage']:>9.4f} {used_str:>9} {vs_str:>8}")
    print()


def print_w_distribution(holdings: list[dict]) -> None:
    """w（NTM blend 權重，w≈1 表示幾乎全 FY1、w≈0 表示幾乎全 FY2）的分布。

    用來直接證明「NTM 有多少比重壓在 FY2 上」——這是主假說（EPS horizon 造成缺口）
    的關鍵證據，w 越小代表 blended NTM 越接近純 FY2。
    """
    pairs = [(h["weight"], h["w"]) for h in holdings if h.get("w") is not None]
    print(f"      w 分布（n={len(pairs)}/{len(holdings)}，缺 fy1_end 的檔不計入）")
    if not pairs:
        print("      （無可用資料）")
        return
    vals = sorted(w for _, w in pairs)
    n = len(vals)
    median = vals[n // 2] if n % 2 == 1 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    mean = sum(vals) / n
    print(f"      中位數={median:.4f}  平均={mean:.4f}")
    buckets = [(0.0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.0)]
    for lo, hi in buckets:
        inclusive_hi = hi == 1.0
        in_b = [(wt, w) for wt, w in pairs
                if (lo <= w <= hi if inclusive_hi else lo <= w < hi)]
        cnt = len(in_b)
        wsum = sum(wt for wt, _ in in_b)
        bracket = "]" if inclusive_hi else ")"
        print(f"        [{lo:.2f}, {hi:.2f}{bracket}  {cnt:>3} 檔  權重合計 {wsum * 100:>6.2f}%")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="Index forward P/E from full holdings")
    ap.add_argument("--ticker", default="VOO", choices=sorted(SOURCES))
    ap.add_argument("--dry-run", action="store_true", help="只抓取並印出，不寫任何檔案")
    ap.add_argument("--rows", type=int, default=30,
                    help="表格印幾檔（0 = 全印，預設 30）")
    ap.add_argument("--dump", default=None,
                    help="把每檔原始資料寫成一個 JSON 檔（診斷用，不可落在 data/ 目錄內）")
    args = ap.parse_args()
    tk = args.ticker

    dump_path = None
    if args.dump:
        dump_path = Path(args.dump).resolve()
        data_dir = DATA.resolve()
        if dump_path == data_dir or data_dir in dump_path.parents:
            print(f"❌ --dump 路徑不可落在 data/ 目錄內：{dump_path}", file=sys.stderr)
            return 1

    holdings, as_of = fetch_holdings(tk)
    wsum = sum(h["weight"] for h in holdings)
    print(f"[1/4] holdings: {len(holdings)} 檔，as of {as_of or 'n/a'}，"
          f"權重合計 {wsum * 100:.2f}%  ({SOURCES[tk]['holdings_source']})")

    print(f"[2/4] 抓報價與 forward EPS（{len(holdings)} 檔，間隔 {FETCH_DELAY}s）…")
    t0 = time.time()
    fails = 0
    for i, h in enumerate(holdings, 1):
        h.update(fetch_quote(h["ticker"]))
        if h["err"]:
            fails += 1
            print(f"      [{h['ticker']}] 失敗：{h['err'][:90]}")
        if i % 100 == 0:
            print(f"      … {i}/{len(holdings)}  ({time.time() - t0:.0f}s)")
    print(f"      耗時 {time.time() - t0:.0f}s，逐檔失敗 {fails} 檔")

    print_table(tk, as_of, holdings, None if args.rows == 0 else args.rows)

    print("[3/4] 計算與品質門檻（FY2 / blended NTM 兩個 basis 各自算）")
    res_fy2 = compute(holdings, "fwd_eps_fy2")
    res_ntm = compute(holdings, "ntm_eps")
    valid_fy2 = res_fy2["forward_pe"] is not None and res_fy2["coverage"] >= COVERAGE_MIN
    valid_ntm = res_ntm["forward_pe"] is not None and res_ntm["coverage"] >= COVERAGE_MIN
    print(f"      FY2 :  forward_pe = {_f(res_fy2['forward_pe'])}   "
          f"coverage = {res_fy2['coverage']:.4f}   "
          f"used {res_fy2['constituents_used']}/{res_fy2['constituents_total']}   "
          f"valid = {valid_fy2}")
    print(f"      NTM :  forward_pe = {_f(res_ntm['forward_pe'])}   "
          f"coverage = {res_ntm['coverage']:.4f}   "
          f"used {res_ntm['constituents_used']}/{res_ntm['constituents_total']}   "
          f"valid = {valid_ntm}")
    if res_fy2["dropped"]:
        d = res_fy2["dropped"]
        print(f"      FY2 缺 price/EPS 而排除：{', '.join(d[:25])}"
              + (f" …共 {len(d)} 檔" if len(d) > 25 else ""))
    if res_ntm["dropped"]:
        d = res_ntm["dropped"]
        w = sum(h["weight"] for h in holdings if h["ticker"] in d)
        print(f"      NTM 缺 price/EPS 而排除（權重合計 {w * 100:.2f}%）：{', '.join(d[:25])}"
              + (f" …共 {len(d)} 檔" if len(d) > 25 else ""))

    print("      幣別換算診斷")
    print_fx_diagnostics(holdings)

    # FX 換算失敗（非同幣別、但 fx_rate 重試後仍回 None）的成分股——這些檔的
    # ntm_eps／fy2 換算後值一定是 None，會被 compute() 排除，不計入 coverage。
    # 獨立算出來是為了讓「因匯率來源瞬斷而少算的權重」在 dry-run/警告裡看得見，
    # 不只是安靜地被 coverage 吸收掉。
    fx_failed = [h for h in holdings
                 if h.get("fin_ccy") and h.get("ccy") and h["fin_ccy"] != h["ccy"]
                 and h.get("fx") is None]
    fx_failed_weight = round(sum((h["weight"] for h in fx_failed), 0.0), 4)
    if fx_failed:
        names = ", ".join(h["ticker"] for h in fx_failed)
        print(f"      ⚠️ FX 換算失敗（重試 {FETCH_RETRIES} 次仍失敗）："
              f"{len(fx_failed)} 檔，權重合計 {fx_failed_weight * 100:.2f}%：{names}")

    # 純 FY1 basis：只做診斷（驗證「WSJ forward 是不是當年度 FY1 口徑」的主假說），
    # 不寫進 jsonl、不影響 PRIMARY_BASIS。
    res_fy1 = compute(holdings, "fwd_eps_fy1")
    print_basis_comparison(tk, res_fy1, res_ntm, res_fy2)
    print_w_distribution(holdings)

    if dump_path is not None:
        dump_fields = ["ticker", "name", "weight", "shares", "price",
                       "fwd_eps_fy1", "fwd_eps_fy2", "est_fy2_raw", "est_fy2_fx",
                       "forward_eps_info", "fx", "fin_ccy", "ccy", "fy1_end", "w", "ntm_eps"]
        dump_rows = [{k: h.get(k) for k in dump_fields} for h in holdings]
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        dump_path.write_text(json.dumps(dump_rows, ensure_ascii=False, indent=2) + "\n")
        print(f"      dump: {dump_path}（{len(dump_rows)} 筆）")

    price_asof = fetch_price_asof(tk)
    holdings_asof = as_of if as_of else None

    primary_res = res_ntm if PRIMARY_BASIS == "ntm" else res_fy2
    primary_valid = valid_ntm if PRIMARY_BASIS == "ntm" else valid_fy2

    entry = {
        "date": date.today().isoformat(),
        "ticker": tk,
        "price_asof": price_asof,
        "holdings_asof": holdings_asof,
        "forward_pe": primary_res["forward_pe"],
        "forward_pe_fy2": res_fy2["forward_pe"],
        "forward_pe_ntm": res_ntm["forward_pe"],
        "coverage_fy2": res_fy2["coverage"],
        "coverage_ntm": res_ntm["coverage"],
        "constituents_used_fy2": res_fy2["constituents_used"],
        "constituents_used_ntm": res_ntm["constituents_used"],
        "constituents_total": res_fy2["constituents_total"],
        "eps_basis": PRIMARY_LABEL,
        "eps_source": EPS_SOURCE,
        "valid_fy2": valid_fy2,
        "valid_ntm": valid_ntm,
        "valid": primary_valid,
        "fx_failed_weight": fx_failed_weight,
    }

    # QQQ 專屬：slickcharts 指數權重 vs Nasdaq 官方市值權重的交叉檢查。
    # slickcharts 是第三方 scrape，版面一改就可能靜默餵髒資料，所以獨立算一次比對。
    # 交叉檢查只對 primary basis 算（spec 未提及雙 basis 分別交叉檢查，這是最小延伸）。
    if SOURCES[tk].get("crosscheck_url"):
        cc = fetch_nasdaq_crosscheck(SOURCES[tk]["crosscheck_url"])
        if cc:
            alt = [dict(h, weight=cc[h["ticker"]]) for h in holdings if h["ticker"] in cc]
            alt_res = compute(alt, PRIMARY_EPS_KEY)
            entry["crosscheck_pe"] = alt_res["forward_pe"]
            if primary_res["forward_pe"] and alt_res["forward_pe"]:
                rel = abs(alt_res["forward_pe"] - primary_res["forward_pe"]) / primary_res["forward_pe"]
                entry["crosscheck_rel_diff"] = round(rel, 4)
                print(f"      交叉檢查（Nasdaq 市值權重，basis={PRIMARY_LABEL}）"
                      f"= {_f(alt_res['forward_pe'])}，"
                      f"相對差 {rel * 100:.2f}%（容許 {QQQ_CROSSCHECK_TOL * 100:.0f}%）")
                if rel > QQQ_CROSSCHECK_TOL:
                    entry["valid"] = False
                    print("      ⚠️ 超出容許，本日標 valid=false")

    print("[4/4] 寫入")
    _final_entry, _plan_msg, _ = plan_write(tk, entry)
    print(f"      {_plan_msg}")
    if args.dry_run:
        print("      --dry-run，不寫檔。本日將寫入的內容：")
        print("      " + json.dumps(_final_entry, ensure_ascii=False))
        return 0

    series = write_series(tk, entry)
    chart = write_chart(tk, series)
    print(f"      {jsonl_path(tk).name}: {len(series)} 筆（序列起點 {series[0]['date']}）")
    print(f"      {chart.name}: 5y/10y 均線 "
          f"{'已可計算' if len(series) >= TRADING_DAYS_5Y else 'null（點數不足，不假裝）'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
