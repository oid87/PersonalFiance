"""台股個股融資集中度 + 清算天數 — 移植自沙盒 Financial_work/margin_concentration.py.

抄「台日韓融資槓桿全景」文的集中度維度:清算天數 = 融資部位張數 / 日均成交量張數,
量化「融資有多擠、失火時門有多寬」。既有融資 tab(marginheat)只有大盤總量,缺個股
集中度,本腳本補上。

輸出:
  1. 個股融資集中度榜(前 N,預設 20):融資市值(億)、佔全市場融資%、佔該股市值%
     (best-effort)、清算天數、中文股名。
  2. 集中度時序:前十大(依當日融資市值排序,逐日重新排名,非固定股票清單)佔全市場
     融資比重的歷史序列 + 當前值在資料可得全期的 rolling 百分位。
  3. data/margin_concentration.json + stdout 榜單表格。

⚠️ 已知方法論限制(倖存者偏誤變體,務必寫進 note 且不得隱藏):
  候選池是「今日」的台灣50 + 人工整理中小型清單,套用到 2005~今的歷史序列上做「前十大」
  篩選。這代表歷史上曾經是融資大戶、但今日已跌出候選池(下市/市值萎縮/改名下櫃)的個股
  不會被納入歷史前十大計算,歷史序列因此會**低估**真實的歷史集中度,尤其早期年份。這不是
  「真實歷史前十大」,是「今日候選池回溯」的近似值。百分位數字要在此限制下解讀。

⚠️ 分子分母口徑對齊(見 ASSUMED_LOAN_RATIO 註解):FinMind 個股融資 dataset 只有張數
  無金額欄位,官方全市場 MarginPurchaseMoney 是「放款金額」(≈市值*融資成數)非市值,
  與分子(市值)直接相除會把佔比灌約 1/成數 倍。已除以 ASSUMED_LOAN_RATIO=0.6 換算回
  市值基準對齊。「佔全市場%」絕對水位仍受此假設影響(best-effort,非精算);清算天數與
  集中度百分位（相對排序）不受此假設影響,為可信主指標。此為用戶 2026-07-14 拍板的誠實
  標注,不追分母精準度。

資料源:直接呼叫 FinMind REST(本腳本是產品 repo 版,無 lab.py 可 import):
  個股融資餘額:TaiwanStockMarginPurchaseShortSale(data_id=stock_id, start_date=...)
               欄位 MarginPurchaseTodayBalance(張)
  個股價量:    TaiwanStockPrice(data_id=stock_id, start_date=...)
               欄位 close、Trading_Volume(股)
  全市場融資:  TaiwanStockTotalMarginPurchaseShortSale(name=='MarginPurchaseMoney' 的
               TodayBalance,元)即時抓,失敗 fallback data/taiwan_margin_total.json
               (margin_money 欄位,億元,同 fetch_taiwan_margin_total.py 產出)。
  股票中文名:  TaiwanStockInfo(bulk 一次抓,本地過濾候選池 stock_id)。

已定案決策(spec_marginconc_tab.md):
  - 清算天數 = 融資今日餘額(張) / 近20日日均成交量(張)。
  - 百分位窗口:資料可得全期(個股融資約 2005+),不硬湊。
  - 金額單位:億元 NTD;張數保留原始。
  - 百分位用 rolling rank(window 設大於樣本長度 = 等效 expanding,純 trailing 無未來函數)。

不做:不接台美日韓其他市場、不追全市場上千檔分母。
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
OUT_PATH = DATA / "margin_concentration.json"
FALLBACK_TOTAL_MARGIN = DATA / "taiwan_margin_total.json"

API = "https://api.finmindtrade.com/api/v4/data"

TOP_N = 20
MARGIN_START = "2005-01-01"
SLEEP_SEC = 0.3
VOL_WINDOW = 20
FETCH_TIMEOUT_SEC = 60
FETCH_RETRIES = 3
FETCH_BACKOFF_SEC = 3.0

# ⚠️ 分子分母單位對齊,見檔頭說明。台股上市普通股一般融資成數 60%(個股別成數/實際加權
# 平均成數無免費逐日資料可得,以此為 best-effort 近似)。
ASSUMED_LOAN_RATIO = 0.6

# ── 候選池 A:臺灣50 指數成分(50 檔) ────────────────────────────────────
# 來源:PersonalFiance/scripts/fetch_breadth_tw50.py 的 TW50_FALLBACK
#       (zh.wikipedia.org/wiki/臺灣50指數 2026-07-09 抓取快照,已去 .TW 後綴)
TW50_POOL = [
    "2345", "3661", "3017", "6919", "5871", "2412", "2308", "2383",
    "4904", "6505", "2881", "2207", "2883", "3008", "2454", "1303",
    "4938", "2382", "5876", "5880", "2330", "1216", "2615", "6669",
    "2609", "2395", "3711", "2357", "2882", "2002", "2891", "2884",
    "2603", "2892", "1301", "2317", "2880", "2059", "2301", "2886",
    "3034", "2912", "2379", "2890", "3045", "2887", "2303", "3231",
    "2327", "2885",
]

# ── 候選池 B:人工整理中小型流動性/融資熱門補充清單(44 檔) ──────────────
# ⚠️ 非官方指數成分清單!臺灣中型100指數無獨立 Wikipedia 條目、FinMind
# TaiwanStockInfo 不含資本額/市值欄位,無法免費抓到真正「市值前120大」排序,
# 本清單是研究者依常識人工整理已知高流動性 IC 設計/記憶體/生技/航運/面板/被動
# 元件等中小型股,2026-07-14 整理,已逐檔驗證 FinMind stock_id 存在,但不保證
# 涵蓋真正市值/融資前120大 — 這是本腳本候選池覆蓋度的已知降級點。
SUPPLEMENT_POOL = [
    "1795", "2313", "2337", "2344", "2408", "2409", "2449", "2451",
    "2606", "3006", "3010", "3035", "3037", "3105", "3138", "3443",
    "3481", "3529", "3576", "3593", "3653", "3679", "4142", "4171",
    "4919", "4966", "5269", "5347", "5608", "6188", "6244", "6414",
    "6415", "6462", "6469", "6510", "6531", "6533", "6547", "8016",
    "8046", "8069", "8299", "8996",
]

CANDIDATES = sorted(set(TW50_POOL) | set(SUPPLEMENT_POOL))

# best-effort 寫死對照(TaiwanStockInfo 抓不到時的降級保底,涵蓋常見前段班個股)
NAME_FALLBACK = {
    "2330": "台積電", "2454": "聯發科", "2317": "鴻海", "2308": "台達電",
    "2882": "國泰金", "2881": "富邦金", "2891": "中信金", "2886": "兆豐金",
    "2884": "玉山金", "2892": "第一金", "2880": "華南金", "2883": "開發金",
    "1301": "台塑", "1303": "南亞", "1216": "統一", "2412": "中華電",
    "3711": "日月光投控", "2382": "廣達", "2357": "華碩", "2303": "聯電",
    "2379": "瑞昱", "3034": "聯詠", "3008": "大立光", "2207": "和泰車",
    "5880": "合庫金", "2887": "台新金", "2609": "陽明", "2615": "萬海",
    "2603": "長榮", "2002": "中鋼", "6505": "台塑化", "2395": "研華",
    "3045": "台灣大", "2890": "永豐金", "2912": "統一超", "3231": "緯創",
    "5871": "中租-KY", "6669": "緯穎", "3661": "世芯-KY", "3017": "奇鋐",
    "6919": "康霈*", "4938": "和碩", "5876": "上海商銀", "2327": "國巨",
    "2885": "元大金", "2345": "智邦", "6244": "茂迪", "2449": "京元電子",
    "3529": "力旺", "8299": "群聯", "3037": "欣興", "2451": "創見",
}


def get_token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""  # anonymous (低額度,可能仍可用)


# ─────────────────────────────────────────────────────────────────────────
# FinMind 抓取(重試 3 次 + backoff,timeout 拉到 60s)—— 個股融資/價量這段易因
# 資料量大(2005+ 逐日)在預設 30s 內 ReadTimeout(沙盒版實測台積電等大檔皆中)。
# ─────────────────────────────────────────────────────────────────────────
def finmind_retry(dataset: str, token: str, **params) -> pd.DataFrame:
    p = {"dataset": dataset}
    if token:
        p["token"] = token
    p.update(params)
    last_err: Exception | None = None
    for attempt in range(FETCH_RETRIES):
        try:
            r = requests.get(API, params=p, timeout=FETCH_TIMEOUT_SEC)
            r.raise_for_status()
            data = r.json().get("data", [])
            return pd.DataFrame(data)
        except Exception as e:
            last_err = e
            if attempt < FETCH_RETRIES - 1:
                time.sleep(FETCH_BACKOFF_SEC * (attempt + 1))
    raise last_err


def rolling_pct_rank(s: pd.Series, window: int, min_periods: int) -> pd.Series:
    return s.rolling(window, min_periods=min_periods).rank(pct=True) * 100


# ─────────────────────────────────────────────────────────────────────────
# 全市場融資總額(元 → 億元,放款金額基準),同 fetch_taiwan_margin_total.py pattern
# ─────────────────────────────────────────────────────────────────────────
def fetch_total_market_margin(token: str) -> tuple[pd.Series, str]:
    try:
        df = finmind_retry(
            "TaiwanStockTotalMarginPurchaseShortSale", token, start_date=MARGIN_START,
        )
        if df.empty:
            raise RuntimeError("FinMind 回傳空資料")
        df = df[df["name"] == "MarginPurchaseMoney"]
        if df.empty:
            raise RuntimeError("無 name=='MarginPurchaseMoney' 列")
        df["date"] = pd.to_datetime(df["date"])
        s = df.set_index("date")["TodayBalance"].astype(float) / 1e8  # 元 → 億元
        s = s.sort_index()
        return s, "FinMind TaiwanStockTotalMarginPurchaseShortSale(即時抓取)"
    except Exception as e:
        print(f"[全市場融資] FinMind 即時抓取失敗({e}),fallback 本地快取 {FALLBACK_TOTAL_MARGIN.name}")
        if not FALLBACK_TOTAL_MARGIN.exists():
            raise RuntimeError(f"全市場融資:FinMind 失敗且無本地快取 — {e}")
        d = json.loads(FALLBACK_TOTAL_MARGIN.read_text())
        df = pd.DataFrame(d["data"])
        df["date"] = pd.to_datetime(df["date"])
        s = df.set_index("date")["margin_money"].astype(float).dropna().sort_index()
        return s, f"本地快取 {FALLBACK_TOTAL_MARGIN.name}(updated={d.get('updated')}) — FinMind 即時抓取失敗: {e}"


# ─────────────────────────────────────────────────────────────────────────
# 中文股名(bulk 一次抓 TaiwanStockInfo,本地過濾候選池)
# ─────────────────────────────────────────────────────────────────────────
def fetch_stock_names(token: str, candidates: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    try:
        df = finmind_retry("TaiwanStockInfo", token)
        if not df.empty:
            cand_set = set(candidates)
            for _, row in df.iterrows():
                sid = str(row.get("stock_id", "")).strip()
                if sid in cand_set and sid not in names:
                    nm = str(row.get("stock_name", "")).strip()
                    if nm:
                        names[sid] = nm
    except Exception as e:
        print(f"[股名] TaiwanStockInfo 抓取失敗({e}),改用寫死對照表 NAME_FALLBACK")
    for sid in candidates:
        if sid not in names and sid in NAME_FALLBACK:
            names[sid] = NAME_FALLBACK[sid]
    return names


# ─────────────────────────────────────────────────────────────────────────
# 單檔融資 + 價量
# ─────────────────────────────────────────────────────────────────────────
def fetch_one(stock_id: str, token: str) -> tuple[pd.DataFrame | None, str | None]:
    try:
        m = finmind_retry(
            "TaiwanStockMarginPurchaseShortSale", token,
            data_id=stock_id, start_date=MARGIN_START,
        )
        if m.empty:
            return None, "融資資料集空"
        m["date"] = pd.to_datetime(m["date"])
        m = m.set_index("date")["MarginPurchaseTodayBalance"].astype(float)  # 張

        p = finmind_retry("TaiwanStockPrice", token, data_id=stock_id, start_date=MARGIN_START)
        if p.empty:
            return None, "價量資料集空"
        p["date"] = pd.to_datetime(p["date"])
        p = p.set_index("date")
        close = p["close"].astype(float)
        vol_lots = p["Trading_Volume"].astype(float) / 1000.0  # 股 → 張

        df = pd.DataFrame({"balance_lots": m, "close": close, "vol_lots": vol_lots}).dropna(
            subset=["balance_lots", "close"]
        )
        if df.empty:
            return None, "融資與價格日期對不上"
        df["money_yi"] = df["balance_lots"] * 1000.0 * df["close"] / 1e8  # 億元
        df["avg_vol20_lots"] = df["vol_lots"].rolling(VOL_WINDOW, min_periods=5).mean()
        df["clearance_days"] = df["balance_lots"] / df["avg_vol20_lots"]
        return df, None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


# ─────────────────────────────────────────────────────────────────────────
# best-effort 流通股數(僅對最終榜單前 N 檔做,失敗留 null)
# ─────────────────────────────────────────────────────────────────────────
def fetch_shares_outstanding(stock_id: str, token: str) -> float | None:
    try:
        bs = finmind_retry("TaiwanStockBalanceSheet", token, data_id=stock_id, start_date="2024-01-01")
        if bs.empty:
            return None
        cap = bs[bs["origin_name"] == "股本合計"].copy()
        if cap.empty:
            return None
        cap = cap[cap["value"] > 1e6]  # 濾掉同名但單位不同(每股面額類)的重複列
        if cap.empty:
            return None
        cap["date"] = pd.to_datetime(cap["date"])
        latest_capital = cap.sort_values("date").iloc[-1]["value"]  # 元
        return float(latest_capital) / 10.0  # 面額 10 元 → 股數
    except Exception:
        return None


def main():
    as_of = datetime.today().strftime("%Y-%m-%d")
    token = get_token()
    print(f"=== fetch_margin_concentration.py — as_of {as_of} ===")
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    print(f"候選池:TW50 {len(TW50_POOL)} 檔 + 補充清單 {len(SUPPLEMENT_POOL)} 檔,去重後共 {len(CANDIDATES)} 檔\n")

    total_margin_loan, total_source = fetch_total_market_margin(token)
    # 分子分母口徑對齊:官方 MarginPurchaseMoney 是「放款金額」(≈市值*融資成數),
    # 個股分子 margin_money_yi 是「市值」,除以 ASSUMED_LOAN_RATIO 換算回市值基準。
    total_margin = total_margin_loan / ASSUMED_LOAN_RATIO
    print(f"[全市場融資] {total_source}")
    print(f"[全市場融資] 放款金額換算市值基準:除以假設融資成數 {ASSUMED_LOAN_RATIO}(best-effort)")
    print(f"[全市場融資] 起點 {total_margin.index.min().date()}, 最新 {total_margin.index.max().date()} = {total_margin.iloc[-1]:.1f} 億元(市值基準,放款金額={total_margin_loan.iloc[-1]:.1f} 億元)\n")

    names = fetch_stock_names(token, CANDIDATES)
    print(f"[股名] 取得 {len(names)}/{len(CANDIDATES)} 檔中文名\n")

    panel: dict[str, pd.DataFrame] = {}
    failures: dict[str, str] = {}
    for i, sid in enumerate(CANDIDATES):
        df, err = fetch_one(sid, token)
        if err:
            failures[sid] = err
            print(f"  [{i+1}/{len(CANDIDATES)}] {sid} 失敗: {err}")
        else:
            panel[sid] = df
        time.sleep(SLEEP_SEC)

    print(f"\n成功抓取 {len(panel)}/{len(CANDIDATES)} 檔,失敗 {len(failures)} 檔")
    if failures:
        print(f"失敗清單: {failures}\n")

    if not panel:
        raise RuntimeError("所有候選股票融資資料皆抓取失敗,無法繼續")

    # ── 建 wide panel(date x stock_id, 融資市值億元)───────────────────
    money_wide = pd.DataFrame({sid: df["money_yi"] for sid, df in panel.items()})
    money_wide = money_wide.sort_index()

    # ── 逐日前十大(依當日融資市值排序,非固定名單)佔全市場融資% ──────
    def top10_sum(row):
        vals = row.dropna()
        if len(vals) < 3:
            return np.nan
        return vals.nlargest(min(10, len(vals))).sum()

    top10_money = money_wide.apply(top10_sum, axis=1)

    # 對齊全市場融資(以個股 panel 日期為主,全市場序列 reindex 用 ffill 對齊到最近交易日,純 trailing)
    total_aligned = total_margin.reindex(top10_money.index, method="ffill")
    top10_pct = (top10_money / total_aligned) * 100
    top10_pct = top10_pct.dropna()

    # ── rolling 百分位(window 遠大於樣本長度 = 等效 expanding,純 trailing)──
    pct_rank_series = rolling_pct_rank(top10_pct, window=len(top10_pct) + 10, min_periods=120)

    series_start = top10_pct.index.min()
    n_samples = len(top10_pct)
    current_top10_pct = float(top10_pct.iloc[-1])
    current_percentile = float(pct_rank_series.iloc[-1]) if not pd.isna(pct_rank_series.iloc[-1]) else None

    print("=== 集中度時序 ===")
    print(f"前十大佔全市場融資% 起點: {series_start.date()}, 樣本數: {n_samples}")
    print(f"當前值 (as_of {top10_pct.index[-1].date()}): {current_top10_pct:.2f}%")
    if current_percentile is not None:
        print(f"當前值在全期({n_samples} 個樣本)的 rolling 百分位: {current_percentile:.1f}%")
    else:
        print("當前值百分位: N/A(樣本不足 min_periods)")

    if not (20 <= current_top10_pct <= 30):
        print(f"⚠️ 「前十大佔全市場融資%」= {current_top10_pct:.2f}%,偏離原文 20~30% 參考區間,請自查候選池覆蓋度/資料日期。")

    # ── 當前榜單(最新一天,依融資市值排序取前 TOP_N)───────────────────
    latest_date = money_wide.index.max()
    latest_row = money_wide.loc[latest_date].dropna().sort_values(ascending=False)
    top_list = latest_row.head(TOP_N)

    leaderboard = []
    total_money_latest = float(total_aligned.loc[latest_date]) if latest_date in total_aligned.index else None
    for sid, money in top_list.items():
        df = panel[sid]
        if latest_date not in df.index:
            row = df.iloc[-1]
            row_date = df.index[-1]
        else:
            row = df.loc[latest_date]
            row_date = latest_date
        clearance = row.get("clearance_days")
        pct_of_market = (money / total_money_latest * 100) if total_money_latest else None
        leaderboard.append({
            "stock_id": sid,
            "name": names.get(sid),
            "date": str(row_date.date()),
            "margin_money_yi": round(float(money), 2),
            "pct_of_total_market_margin": round(float(pct_of_market), 3) if pct_of_market is not None else None,
            "close": round(float(row["close"]), 2),
            "balance_lots": round(float(row["balance_lots"]), 0),
            "avg_vol20_lots": round(float(row["avg_vol20_lots"]), 1) if not pd.isna(row.get("avg_vol20_lots")) else None,
            "clearance_days": round(float(clearance), 2) if clearance is not None and not pd.isna(clearance) else None,
            "pct_of_own_market_cap": None,  # 下面 best-effort 補
            "shares_outstanding": None,
        })

    # ── best-effort 市值% (僅前 N 檔) ──────────────────────────────────
    print("\n=== best-effort 個股流通股數/市值% (僅前 N 檔) ===")
    for item in leaderboard:
        sid = item["stock_id"]
        shares = fetch_shares_outstanding(sid, token)
        time.sleep(SLEEP_SEC)
        if shares is None:
            print(f"  {sid}: 流通股數取不到,pct_of_own_market_cap 留 null")
            continue
        mcap_yi = shares * item["close"] / 1e8
        item["shares_outstanding"] = round(shares, 0)
        if mcap_yi > 0:
            item["pct_of_own_market_cap"] = round(item["margin_money_yi"] / mcap_yi * 100, 3)

    top10_sum_pct = sum(x["pct_of_total_market_margin"] for x in leaderboard[:10] if x["pct_of_total_market_margin"] is not None)
    print(f"\n=== 榜單前十大合計佔全市場融資%: {top10_sum_pct:.2f}% (對照集中度時序當前值 {current_top10_pct:.2f}%,兩者算法一致應接近) ===\n")

    # ── stdout 表格 ─────────────────────────────────────────────────────
    print(f"{'排名':<4}{'代號':<8}{'名稱':<10}{'融資市值(億)':<14}{'佔全市場%':<12}{'佔自身市值%':<14}{'清算天數':<10}{'收盤價':<10}")
    for i, item in enumerate(leaderboard, 1):
        mcap_pct = f"{item['pct_of_own_market_cap']:.2f}" if item["pct_of_own_market_cap"] is not None else "N/A"
        clr = f"{item['clearance_days']:.2f}" if item["clearance_days"] is not None else "N/A"
        pct_mkt = f"{item['pct_of_total_market_margin']:.2f}" if item["pct_of_total_market_margin"] is not None else "N/A"
        nm = item["name"] or "N/A"
        print(f"{i:<4}{item['stock_id']:<8}{nm:<10}{item['margin_money_yi']:<14.1f}{pct_mkt:<12}{mcap_pct:<14}{clr:<10}{item['close']:<10.1f}")

    # ── JSON 輸出 ────────────────────────────────────────────────────────
    time_series = [
        {"date": str(d.date()), "top10_pct_of_market": round(float(v), 3),
         "percentile": round(float(pct_rank_series.loc[d]), 1) if not pd.isna(pct_rank_series.loc[d]) else None}
        for d, v in top10_pct.items()
    ]

    out = {
        "as_of": as_of,
        "latest_data_date": str(latest_date.date()),
        "assumed_loan_ratio": ASSUMED_LOAN_RATIO,
        "denominator_basis": "market_value (=official MarginPurchaseMoney loan_amount / assumed_loan_ratio)",
        "note": (
            "個股融資餘額=FinMind TaiwanStockMarginPurchaseShortSale(張),"
            "融資市值=餘額(張)*1000*close/1e8(億元)。全市場融資=" + total_source + "。"
            "⚠️分子分母口徑對齊:FinMind個股融資dataset僅有張數無金額欄位,官方全市場"
            "MarginPurchaseMoney是『放款金額』(≈市值*融資成數)非市值,與分子(市值)直接"
            "相除會把佔比灌約1/成數倍。"
            "已將全市場分母除以ASSUMED_LOAN_RATIO=" + str(ASSUMED_LOAN_RATIO) +
            "(台股上市普通股一般融資成數,個股逐日實際成數無免費資料,best-effort近似)"
            "換算回市值基準,使分子分母口徑一致。"
            "候選池=TW50(50檔,來源zh.wikipedia.org/wiki/臺灣50指數 2026-07-09快照)"
            " + 人工整理中小型補充清單(44檔,2026-07-14整理,非官方指數成分,"
            "不保證涵蓋真正市值前120大),去重後共" + str(len(CANDIDATES)) + "檔。"
            "⚠️已知限制:歷史時序用『今日候選池』回溯篩選逐日前十大,不是『當時真正全市場前十大』,"
            "早期年份集中度可能被低估(候選池外的歷史融資大戶未被納入)。"
            "清算天數=融資今日餘額(張)/近20日日均成交量(張)。"
            "百分位=rolling rank(window>=樣本長度,純trailing,無未來函數)。"
            "個股流通股數(pct_of_own_market_cap)為best-effort:"
            "FinMind TaiwanStockBalanceSheet『股本合計』/10元面額,取不到留null。"
            "⚠️『佔全市場%』絕對水位受分母口徑影響(比部位市值口徑高約1.5x的best-effort近似),"
            "清算天數與集中度百分位(相對排序)不受此假設影響,為可信主指標。"
        ),
        "candidate_pool_size": len(CANDIDATES),
        "candidate_pool_fetched_ok": len(panel),
        "candidate_pool_failures": failures,
        "total_market_margin_source": total_source,
        "total_market_margin_start": str(total_margin.index.min().date()),
        "leaderboard": leaderboard,
        "leaderboard_top10_sum_pct_of_market": round(top10_sum_pct, 3),
        "concentration_series": {
            "start_date": str(series_start.date()),
            "n_samples": n_samples,
            "current_value_pct": round(current_top10_pct, 3),
            "current_percentile": round(current_percentile, 1) if current_percentile is not None else None,
            "data": time_series,
        },
    }

    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n寫入 {OUT_PATH} ({OUT_PATH.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
