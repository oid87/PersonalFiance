"""美股成分股的觀察股（帶大量創波段新高）家數：QQQ／VOO 前五大板塊／SOXX 半導體三組 → data/us_obs_stats.json

Sources:
  yfinance（auto_adjust=True，已還原分割，與 fetch_breadth*.py 同口徑）— 個股每日收盤與成交量
  scripts/_us_index_history.py — S&P 500／Nasdaq-100 每天當時的成分股、板塊與半導體分類

觀察股（和台股版同一套「第一根且帶大量」定義，美股成分股都是大型股，不另設流動性門檻）：
  當天上漲、收盤 > 前 HIGH_N 個交易日最高收盤、成交量 ≥ VOL_MULT × 前 VOL_N 日均量。
三組（每天用當時的名單）：
  qqq  ＝ Nasdaq-100 成分股
  voo5 ＝ S&P 500 成分股中，屬於前五大板塊（_us_index_history.TOP5）的股票
  soxx ＝ S&P 500 ∪ Nasdaq-100 成分股中的半導體股（SOXX 沒有公開的歷史成分股，用這個近似）
已下市／被併購的成分股 Yahoo 多半沒有資料，<組>_n 只計有資料的檔數（早年偏少，有倖存者偏差）。

每次執行：下載近 RECENT_CAL 天、重算最近 RECOMPUTE 個交易日，依日期合併（新蓋舊）。
--full：從 FULL_START 起全部重算（首次回補用）。

Output data/us_obs_stats.json:
  {source, note, params, updated,
   data: [{date, qqq_n, qqq_obs, voo5_n, voo5_obs, soxx_n, soxx_obs}]}
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

import _common
import _us_index_history as U

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "us_obs_stats.json"

HIGH_N = 20         # 創波段新高：收盤高於前 20 個交易日最高收盤
VOL_N = 10          # 均量天數
VOL_MULT = 2.0      # 帶大量：成交量 ≥ 2 倍 10 日均量
GROUPS = ("qqq", "voo5", "soxx")
FULL_START = "2012-09-01"   # 2013-01 起每一天都有完整的 20 日視窗
RECENT_CAL = 75             # 每日增量下載的日曆天數（≥ 20 個交易日視窗＋重算區間）
RECOMPUTE = 15              # 每次重算最近幾個交易日（補上前幾天資料延遲）
CHUNK = 60
MIN_VALID = 50              # 一天有效檔數（三組合計）低於此視為殘缺，不寫


def download(tickers: list[str], start: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    frames = []
    for i in range(0, len(tickers), CHUNK):
        chunk = tickers[i:i + CHUNK]
        df = pd.DataFrame()
        for attempt in range(3):
            try:
                df = yf.download(chunk, start=start, auto_adjust=True, progress=False, threads=True)
                if not df.empty:
                    break
            except Exception as exc:
                print(f"  [chunk {i // CHUNK + 1}] attempt {attempt + 1} error: {exc}", flush=True)
            time.sleep(3)
        if df.empty:
            print(f"  [chunk {i // CHUNK + 1}] no data, skipping", flush=True)
            continue
        frames.append(df[["Close", "Volume"]])
    if not frames:
        raise RuntimeError("no price data downloaded")
    big = pd.concat(frames, axis=1)
    return big["Close"], big["Volume"]


def observe(close: pd.DataFrame, volume: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(valid, obs)：與 close 同形狀的布林表。valid＝前 HIGH_N 日收盤與前 VOL_N 日量都齊全。"""
    hi = close.shift(1).rolling(HIGH_N, min_periods=HIGH_N).max()
    avg = volume.shift(1).rolling(VOL_N, min_periods=VOL_N).mean()
    valid = hi.notna() & avg.notna() & close.notna() & volume.notna()
    obs = valid & (close > hi) & (close > close.shift(1)) & (volume > 0) & (volume >= VOL_MULT * avg)
    return valid, obs


def rows_for(close, volume, since: str) -> dict:
    valid, obs = observe(close, volume)
    out = {}
    for ts in close.index:
        d = ts.date().isoformat()
        if d < since:
            continue
        row, total = {"date": d}, 0
        for name, members in U.groups_on(d).items():
            cols = [t for t in members if t in close.columns]
            n = int(valid.loc[ts, cols].sum()) if cols else 0
            row[f"{name}_n"], row[f"{name}_obs"] = n, int(obs.loc[ts, cols].sum()) if cols else 0
            total += n
        if total >= MIN_VALID:
            out[d] = row
    return out


def main() -> None:
    full = "--full" in sys.argv
    existing = _common.load_rows_by_date(OUT)
    start = FULL_START if full or not existing else (date.today() - timedelta(days=RECENT_CAL)).isoformat()
    if full or not existing:
        tickers = sorted(U.all_tickers())
    else:
        tickers = set()
        d = date.fromisoformat(start)
        while d <= date.today():
            for members in U.groups_on(d.isoformat()).values():
                tickers |= members
            d += timedelta(days=7)
        tickers = sorted(tickers | set().union(*U.groups_on(date.today().isoformat()).values()))
    print(f"{len(existing)} existing rows · downloading {len(tickers)} tickers from {start}", flush=True)
    close, volume = download(tickers, start)
    fresh = rows_for(close, volume, "2013-01-01")
    if not full and existing:
        keep = sorted(fresh)[-RECOMPUTE:]
        fresh = {d: fresh[d] for d in keep}
    if not fresh:
        raise RuntimeError("no rows computed")
    merged = dict(existing)
    merged.update(fresh)
    data = [merged[d] for d in sorted(merged)]
    OUT.write_text(json.dumps({
        "source": "yfinance 個股日線（auto_adjust）＋ 維基百科 S&P 500／Nasdaq-100 歷史成分股，自算",
        "note": ("觀察股＝當天上漲、收盤創前 20 日新高、成交量 ≥ 2 倍 10 日均量的成分股（當時名單）。"
                 "qqq＝Nasdaq-100；voo5＝S&P 500 中前五大板塊（資訊科技、通訊服務、金融、醫療保健、非必需消費）；"
                 "soxx＝S&P 500 ∪ Nasdaq-100 中的半導體股（SOXX 歷史名單不公開，用此近似）。"
                 "<組>_n＝有資料的有效檔數（已下市者多半缺資料），<組>_obs＝觀察股數。"),
        "params": {"high_n": HIGH_N, "vol_n": VOL_N, "vol_mult": VOL_MULT, "top5": sorted(U.TOP5)},
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows ({data[0]['date']} → {data[-1]['date']}); +{len(fresh)} recomputed")


if __name__ == "__main__":
    main()
