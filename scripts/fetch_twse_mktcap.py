"""上市(TWSE)大盤總市值 — 真實逐檔計算(股本週更 + 市值日出)，取代 K(t) 線性插值估算。

背景：舊版 compute_taiwan_margin_mktcap.py 用「TWSE 月訊 PDF 月底市值錨點 + K(t) 線性
插值 × TAIEX 收盤」估算每日上市總市值，月中誤差最大。本腳本改用真實逐檔計算：
每日市值 = Σ(最近一次股本快照的股數 × 當日收盤)。兩腳本先並存，不互相取代。

設計（已定案）：股本週更、市值日出 —— 股本(發行股數)是低頻事件(增資/減資/可轉債
轉換)，一週抓一次快照就夠；收盤是日頻。風格照抄 fetch_tpex_margin.py(櫃買版同一件事)。

資料源(均實測確認，2026-08-04)
  1. 逐檔發行股數(僅「現在」快照，無歷史/日期參數)：
     GET https://openapi.twse.com.tw/v1/opendata/t187ap03_L
     → JSON array，每筆一家上市公司，欄位「公司代號」「已發行普通股數或TDR原股發行股數」。
     用「已發行普通股數」直接就是股數，不用實收資本額/面額反推(面額非10元/特別股會
     失真的問題因此不存在 —— 這欄位本身就是普通股股數)。⚠️ 這個 API 沒有歷史查詢
     參數，只回「現在」這份股本快照，**無法回補歷史股本**(見下方「已知限制」)。
     實測 2026-08-04：1093 家公司，2330(台積電) 已發行普通股數=25,932,370,067股。

  2. 逐檔收盤價(**有歷史**，可帶 date 參數回溯)：
     GET https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=YYYYMMDD&type=ALLBUT0999
     → {stat:'OK', date:'YYYYMMDD', tables:[...]}；tables[8]
     (title 含「每日收盤行情」) 欄位 ['證券代號','證券名稱',...,'收盤價',...]。
     非交易日/超出範圍回 {stat:'很抱歉，沒有符合條件的資料!'}(無 date 欄)，
     或極早期回 {stat:'查詢日期小於93年2月11日...'}；一律用 stat=='OK' and date==查詢日
     判斷成功，不可只看 HTTP 200。
     ⚠️ tables 陣列裡「每日收盤行情」的 index 並非恆定為 8(視當天有無某些統計區塊
     而變動)，程式用 title 內含關鍵字比對定位，不寫死 index。

     交叉驗證(2026-08-04 實測，見下方「已知限制」段落)：以 2026-07-31 收盤 × 股本
     快照算出全市場(排除00開頭ETF/受益證券)市值 ≈141.9兆元；同日用既有
     taiwan_mktcap_anchors.json 最近錨點(2026-06-30, 150.51兆) × TWII 收盤反推的
     K(t) 外推值 ≈140.7兆元 —— 兩者差 <1%，交叉驗證吻合。此結果遠高於 spec 原先
     假設的「90~110兆」量級，但那是舊有(較早期)市場水準的印象，非本次驗證基準；
     本腳本以 taiwan_mktcap_anchors.json 最新錨點的比對結果為準。

  3. ETF 判定：代號以「00」開頭(如 0050、00679B)。t187ap03_L 本身只列「公司」
     (股票發行人)不含 ETF，故股數表已天然不含 ETF；但 MI_INDEX 收盤表含 ETF，
     join 後只有普通股代號會 matched，ETF 代號在 shares 找不到、自然被排除 ——
     因此 mktcap_yi 與 mktcap_exetf_yi 在本腳本實際上會相等(shares 來源已排除
     ETF)，仍保留兩欄位以維持與 tpex_margin.json 的 schema 一致性/未來擴充彈性。

已知限制 —— 股本快照無法回補歷史，早期市值會失真
  t187ap03_L 沒有日期參數，每次呼叫只拿得到「現在」的股本。若拿現在股本去套用在
  歷史久遠的收盤價上，會因為當年股本較小(增資前)而高估當年市值。因此：
    - TWSE_MC_FLOOR 預設只設「今天往前 30 天」，不嘗試回補更久遠的歷史 —— 那些
      日子的股本快照(若真要算)只能用「最早一份快照」往前套，失真程度隨時間拉長
      而增加，不划算也不誠實。
    - 隨著本腳本每天執行，股本快照會逐週累積，未來的市值計算精度會隨快照增加而
      提升；歷史缺口需要另外的資料源(如逐年財報)才能真正回補，本腳本不處理。
    - 任一日期若「該日期之前」沒有任何快照(即所有快照都晚於該日期)，一律跳過該
      日不輸出，**嚴禁用晚於該日的快照計算(未來函數)**。

每次執行：股本快照最多 1 次 request(同一 ISO 週已有快照則跳過)，收盤價每個待補
交易日 1 次 request，keep-alive session + 禮貌間隔 + 重試，idempotent 合併 →
可重跑/續傳。回補用 stride 分層(32→16→8→4→2→1)，理由與寫法同 fetch_tpex_margin.py。

Output:
  data/twse_shares_snapshots.json — {snapshots:[{date, shares:{code: 股數}}]}，一週最多一筆
  data/twse_mktcap.json — {source, note, updated,
    data:[{date, mktcap_yi, mktcap_exetf_yi, n, n_etf, shares_snapshot_date}]}
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SHARES_OUT = ROOT / "data" / "twse_shares_snapshots.json"
OUT = ROOT / "data" / "twse_mktcap.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "Referer": "https://www.twse.com.tw/"}
SHARES_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
CLOSE_URL = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
SHARES_FIELD = "已發行普通股數或TDR原股發行股數"

# ⚠️ 股本快照無法回補歷史(見 docstring)，預設 FLOOR 只抓最近 30 天，不嘗試往回估。
FLOOR = os.environ.get("TWSE_MC_FLOOR", (date.today() - timedelta(days=30)).isoformat())
CEIL = os.environ.get("TWSE_MC_CEIL", "")  # 空 = today
MAX_DAYS = int(os.environ.get("TWSE_MC_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("TWSE_MC_SLEEP", "0.5"))
ONLY = [d for d in os.environ.get("TWSE_MC_ONLY", "").split(",") if d]  # 指定日期驗證用

SESS = requests.Session()

# 門檻：防殘缺/異常回應被永久收錄成快照或市值列 —— 沒通過就跳過該次，等下次重試。
MIN_SHARES_RATIO = 0.9  # 新股本快照檔數 ≥ 最近一份舊快照檔數的 90%
MIN_SHARES_FIRST = 800  # 尚無任何舊快照時，新快照至少要有的檔數
MIN_MATCH_RATIO = 0.9  # 逐日市值配對到的檔數 ≥ 所用股本快照檔數的 90%


def is_etf(code: str) -> bool:
    return str(code).strip().startswith("00")


def num(s):
    try:
        return float(str(s).replace(",", "").replace(" ", ""))
    except Exception:
        return None


def get_json(url, params, tries=4):
    for i in range(tries):
        try:
            r = SESS.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                time.sleep(3 + 4 * i)
                continue
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def fetch_shares() -> dict[str, float] | None:
    """逐檔已發行普通股數快照(僅「現在」，無歷史)。回傳 {code: shares}。"""
    j = get_json(SHARES_URL, {})
    if not isinstance(j, list) or not j:
        return None
    shares = {}
    for r in j:
        code = str(r.get("公司代號", "")).strip()
        sh = num(r.get(SHARES_FIELD))
        if code and sh:
            shares[code] = sh
    return shares or None


def load_snapshots() -> list[dict]:
    if not SHARES_OUT.exists():
        return []
    try:
        return json.loads(SHARES_OUT.read_text()).get("snapshots", [])
    except Exception:
        return []


def save_snapshots(snapshots: list[dict]) -> None:
    snapshots = sorted(snapshots, key=lambda s: s["date"])
    SHARES_OUT.write_text(json.dumps({
        "source": "TWSE OpenAPI t187ap03_L(上市公司基本資料, 已發行普通股數或TDR原股發行股數)",
        "note": ("逐檔股本快照，僅「現在」值(API 無歷史查詢參數)。一週最多一筆(依 ISO 週去重)，"
                 "供 fetch_twse_mktcap.py 依日期就近取用(嚴禁使用晚於目標日期的快照)。"),
        "updated": date.today().isoformat(),
        "snapshots": snapshots,
    }, ensure_ascii=False) + "\n")


def ensure_weekly_snapshot() -> list[dict]:
    """若本 ISO 週尚無快照，抓一份新的並附加；回傳目前所有快照(已排序)。"""
    snapshots = load_snapshots()
    today = date.today()
    this_week = today.isocalendar()[:2]
    have_this_week = any(
        date.fromisoformat(s["date"]).isocalendar()[:2] == this_week for s in snapshots
    )
    if not have_this_week:
        shares = fetch_shares()
        if shares:
            if snapshots:
                prev = max(snapshots, key=lambda s: s["date"])
                min_ok = MIN_SHARES_RATIO * len(prev["shares"])
            else:
                min_ok = MIN_SHARES_FIRST
            if len(shares) < min_ok:
                print(f"  [shares] new snapshot only {len(shares)} codes (< {min_ok:.0f} required), "
                      f"rejecting — reusing latest cached snapshot", flush=True)
            else:
                snapshots.append({"date": today.isoformat(), "shares": shares})
                save_snapshots(snapshots)
                print(f"  [shares] new weekly snapshot {today.isoformat()}: {len(shares)} codes", flush=True)
        else:
            print("  [shares] fetch failed, no snapshot added this run", flush=True)
    return sorted(snapshots, key=lambda s: s["date"])


def snapshot_for(target_date: str, snapshots: list[dict]) -> dict | None:
    """回傳「該日期之前(含當天)最近一次」快照；找不到(所有快照都晚於該日)回 None。
    嚴禁使用晚於 target_date 的快照(未來函數)。"""
    candidates = [s for s in snapshots if s["date"] <= target_date]
    if not candidates:
        return None
    return max(candidates, key=lambda s: s["date"])


def find_close_table(tables: list[dict]) -> dict | None:
    """『每日收盤行情』表；index 不固定，用 title 關鍵字比對定位。"""
    for t in tables:
        if "收盤行情" in (t.get("title") or ""):
            return t
    return None


def fetch_close(d_iso: str) -> dict[str, float] | None:
    """逐檔收盤價。回傳 {code: close}；查無資料回 None。"""
    j = get_json(CLOSE_URL, {"response": "json", "date": d_iso.replace("-", ""), "type": "ALLBUT0999"})
    if not j or j.get("stat") != "OK" or j.get("date") != d_iso.replace("-", ""):
        return None
    tbl = find_close_table(j.get("tables") or [])
    if not tbl:
        return None
    fields = tbl.get("fields") or []
    try:
        ci = fields.index("證券代號")
        pi = fields.index("收盤價")
    except ValueError:
        return None
    closes = {}
    for r in tbl.get("data", []):
        if len(r) <= max(ci, pi):
            continue
        code = str(r[ci]).strip()
        c = num(r[pi])
        if code and c is not None:
            closes[code] = c
    return closes or None


def fetch_day(d_iso: str, snapshots: list[dict]) -> dict | None:
    snap = snapshot_for(d_iso, snapshots)
    if snap is None:
        return None  # 該日之前無任何股本快照，嚴禁用未來快照，直接跳過
    closes = fetch_close(d_iso)
    if not closes:
        return None
    shares = snap["shares"]
    caps = {c: closes[c] * shares[c] for c in closes if c in shares}
    if len(caps) < MIN_MATCH_RATIO * len(shares):
        print(f"  [mktcap] {d_iso}: matched {len(caps)}/{len(shares)} codes "
              f"(< {MIN_MATCH_RATIO:.0%} of snapshot), skipping this day", flush=True)
        return None
    mktcap = sum(caps.values())
    mktcap_exetf = sum(v for c, v in caps.items() if not is_etf(c))
    n_etf = sum(1 for c in caps if is_etf(c))
    return {
        "date": d_iso,
        "mktcap_yi": round(mktcap / 1e8, 1),
        "mktcap_exetf_yi": round(mktcap_exetf / 1e8, 1),
        "n": len(caps),
        "n_etf": n_etf,
        "shares_snapshot_date": snap["date"],
    }


def missing_trading_days(have: set[str]) -> list[str]:
    """[FLOOR, CEIL] 內尚未抓過的平日，依 stride 分層排序(32→16→8→4→2→1)，
    寫法/理由同 fetch_tpex_margin.py。"""
    days = []
    d = date.fromisoformat(CEIL) if CEIL else date.today()
    floor = date.fromisoformat(FLOOR)
    while d >= floor:
        if d.weekday() < 5 and d.isoformat() not in have:
            days.append(d.isoformat())
        d -= timedelta(days=1)
    out, taken = [], set()
    for stride in (32, 16, 8, 4, 2, 1):
        for i, iso in enumerate(days):
            if i % stride == 0 and iso not in taken:
                taken.add(iso)
                out.append(iso)
    return out


def save(by_date: dict) -> None:
    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": ("TWSE OpenAPI t187ap03_L(逐檔已發行普通股數,僅現在快照) × "
                   "www/exchangeReport/MI_INDEX(逐檔收盤價,可回溯)"),
        "note": ("每日市值 = Σ(該日期之前最近一次股本快照的股數 × 當日收盤)，即「股本週更、"
                 "市值日出」。shares_snapshot_date 標明該列使用的股本快照日期。"
                 "t187ap03_L 無歷史查詢參數，股本快照無法回補久遠歷史，故本腳本預設只抓最近"
                 "(TWSE_MC_FLOOR，預設今天往前 30 天)，不產生用「未來股本套用過去收盤」的"
                 "失真歷史值(嚴禁使用晚於目標日期的快照)。"
                 "mktcap_yi/mktcap_exetf_yi：t187ap03_L 本身只列公司(不含 ETF)，故兩欄實際"
                 "相等；exetf 欄位保留是為了與 tpex_margin.json schema 一致。"
                 "交叉驗證(2026-08-04)：本法算得全市場≈141.9兆，與 "
                 "taiwan_mktcap_anchors.json 最新錨點(2026-06-30, 150.51兆)外推 TWII K(t) "
                 "≈140.7兆，差 <1%。與舊版 K(t) 插值估算(taiwan_margin_mktcap.json)並存，"
                 "互不取代。"),
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")


def main() -> None:
    by_date = {}
    if OUT.exists():
        try:
            by_date = {r["date"]: r for r in json.loads(OUT.read_text()).get("data", [])}
        except Exception:
            by_date = {}

    snapshots = ensure_weekly_snapshot()
    if not snapshots:
        print("no shares snapshot available (fetch failed and none cached); aborting", flush=True)
        return

    todo = ONLY if ONLY else missing_trading_days(set(by_date))[:MAX_DAYS]
    print(f"{len(by_date)} existing · {len(todo)} days to fetch "
          f"(cap {MAX_DAYS}, floor {FLOOR}, ceil {CEIL or 'today'}, "
          f"{len(snapshots)} shares snapshots)", flush=True)

    done = skipped = 0
    for d in todo:
        res = fetch_day(d, snapshots)
        if res:
            by_date[d] = res
            done += 1
            if done % 20 == 0:
                save(by_date)
                print(f"  ...{done} fetched · {d} mktcap_exetf_yi={res['mktcap_exetf_yi']} (saved)", flush=True)
        else:
            skipped += 1
        time.sleep(SLEEP)

    save(by_date)
    data = sorted(by_date.values(), key=lambda r: r["date"])
    if data:
        print(f"Wrote {len(data)} rows ({data[0]['date']}..{data[-1]['date']}); "
              f"+{done} new, {skipped} skipped this run "
              f"(latest mktcap_exetf_yi={data[-1]['mktcap_exetf_yi']}, "
              f"snapshot={data[-1]['shares_snapshot_date']})", flush=True)
    else:
        print(f"Wrote 0 rows; +{done} new, {skipped} skipped this run", flush=True)


if __name__ == "__main__":
    main()
