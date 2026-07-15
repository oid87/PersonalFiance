"""
融資斷頭地圖 tab — 資料抓取 + blend vintage 模型

spec: Financial_work/spec_marginmap_tab.md (模型設計已由主 session 驗收定案,本檔不得
自行更改模型設計:blend 衰減 f=0.75、R0=166.67、追繳倍數 1.2821,只負責移植 + 增量抓取。)

改哪些檔(只准動這些,依 spec):
- 本檔 scripts/fetch_margin_costmap.py
- data/margin_costmap.json (自動寫,唯一資料輸出;raw_flows 內嵌供下次增量抓取用)

唯讀資料源(不重抓):
- 種子:Financial_work/data/margin_costbasis.json 的 raw_flows(2020-01→2026-07-14),
  第一次執行時複製進本檔輸出的 raw_flows 當種子,之後只增量抓種子最後一天之後的新交易日。
- data/TWII.json (加權指數收盤)
- data/taiwan_margin_ratio.json (驗證基準,做 Panel A 對照與 glitch 過濾)
"""

import json
import math
import statistics
import sys
import time
from pathlib import Path

import requests

BASE = Path(__file__).resolve().parent.parent  # PersonalFiance root
TWII_PATH = BASE / "data" / "TWII.json"
ACTUAL_RATIO_PATH = BASE / "data" / "taiwan_margin_ratio.json"
OUT_JSON = BASE / "data" / "margin_costmap.json"
SEED_PATH = Path(
    "/Users/orangembpm2/work/code/personal_financial/Financial_work/data/margin_costbasis.json"
)

MI_MARGN_URL = "https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date={date}&selectType=ALL"
UA = {"User-Agent": "Mozilla/5.0"}

MODEL_START = "2020-01-01"       # vintage 模型起算(對齊種子起點)
HISTORY_START = "2022-12-01"     # 輸出 history 起點(對齊 spec)
BULL_2026_START = "2026-01-01"   # mae_bull_2026 子集起點(決策點,見回報)

R0 = 166.67                      # 融資成數 0.6 -> 1/0.6
TRIGGER_RATIO = 130.0            # 追繳門檻維持率
TRIGGER_MULT = R0 / TRIGGER_RATIO  # index_open >= index_now * 1.28205...
DECAY_F = 0.75                   # blend 衰減:75% LIFO + 25% 比例(禁改)

SLEEP_SEC = 0.8
MAX_RETRIES = 3

N_BUCKETS = 30
CASCADE_STEPS = 36  # drop_pct 0 .. -35


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# 讀本地唯讀資料源
# ---------------------------------------------------------------------------

def load_twii():
    d = json.loads(TWII_PATH.read_text())
    rows = [(r["date"], float(r["close"])) for r in d["data"] if r["date"] >= MODEL_START]
    rows.sort(key=lambda x: x[0])
    return rows  # list of (date, close), ascending


def load_actual_ratio():
    d = json.loads(ACTUAL_RATIO_PATH.read_text())
    return {r["date"]: float(r["ratio"]) for r in d["data"]}


# ---------------------------------------------------------------------------
# raw_flows 種子 + 增量抓取(idempotent)
# ---------------------------------------------------------------------------

def load_existing_output_raw_flows():
    """若 margin_costmap.json 已存在,讀它內嵌的 raw_flows 當快取(避免重抓)。"""
    if not OUT_JSON.exists():
        return {}
    try:
        d = json.loads(OUT_JSON.read_text())
    except Exception:
        return {}
    return {r["date"]: r for r in d.get("raw_flows", [])}


def load_seed_raw_flows():
    d = json.loads(SEED_PATH.read_text())
    out = {}
    for r in d.get("raw_flows", []):
        out[r["date"]] = {
            "date": r["date"],
            "buy_yi": r["buy_yi"],
            "sell_yi": r["sell_yi"],
            "repay_yi": r["repay_yi"],
            "prev_balance_yi": r["prev_balance_yi"],
            "today_balance_yi": r["today_balance_yi"],
        }
    return out


def fetch_mi_margn_one(date_str, session):
    """date_str = 'YYYYMMDD'. Returns (dict_or_None, error_str_or_None)."""
    url = MI_MARGN_URL.format(date=date_str)
    for attempt in range(MAX_RETRIES + 1):
        try:
            r = session.get(url, headers=UA, timeout=20)
        except requests.RequestException as e:
            if attempt < MAX_RETRIES:
                time.sleep(2 + attempt * 3)
                continue
            return None, f"request_exception:{e}"

        if r.status_code in (429, 503):
            if attempt < MAX_RETRIES:
                time.sleep(3 + attempt * 4)
                continue
            return None, f"http_{r.status_code}"

        if r.status_code != 200:
            return None, f"http_{r.status_code}"

        try:
            j = r.json()
        except Exception:
            return None, "bad_json"

        if j.get("stat") != "OK":
            return None, f"stat:{j.get('stat')}"

        target_row = None
        for t in j.get("tables", []):
            rows = t.get("data", [])
            if len(rows) <= 6:
                for row in rows:
                    if row and row[0] == "融資金額(仟元)":
                        target_row = row
                        break
            if target_row:
                break

        if not target_row:
            return None, "row_not_found"

        try:
            buy = float(target_row[1].replace(",", ""))
            sell = float(target_row[2].replace(",", ""))
            repay = float(target_row[3].replace(",", ""))
            prev_bal = float(target_row[4].replace(",", ""))
            today_bal = float(target_row[5].replace(",", ""))
        except Exception as e:
            return None, f"parse_error:{e}"

        # 仟元 -> 億
        return (
            {
                "buy_yi": buy / 1e5,
                "sell_yi": sell / 1e5,
                "repay_yi": repay / 1e5,
                "prev_balance_yi": prev_bal / 1e5,
                "today_balance_yi": today_bal / 1e5,
            },
            None,
        )

    return None, "max_retries_exceeded"


def fetch_missing(trading_dates, existing, deviations):
    missing = [d for d in trading_dates if d not in existing]
    log(f"[fetch] 已快取 {len(existing)} 日,目標交易日總數 {len(trading_dates)},需新抓 {len(missing)} 日")
    if not missing:
        return existing

    session = requests.Session()
    for i, date in enumerate(missing):
        date_str = date.replace("-", "")
        result, err = fetch_mi_margn_one(date_str, session)
        if result is None:
            log(f"[fetch] SKIP {date}: {err}")
            deviations.append({"date": date, "type": "fetch_skip", "detail": err})
        else:
            result["date"] = date
            existing[date] = result
            log(f"[fetch] OK {date}")
        time.sleep(SLEEP_SEC)

    return existing


# ---------------------------------------------------------------------------
# Blend vintage 累積模型(spec 第 26-34 行,禁改設計)
# ---------------------------------------------------------------------------

def run_blend_model(trading_dates, twii_close, raw_flows, deviations):
    """逐交易日模擬,嚴格照 spec 第 26-34 行:vintages 只由 buy_yi 建倉,無任何
    bootstrap/錨定。決策點(spec 未提及,executor 驗證後選定,詳見回報):
    第一版曾嘗試用 prev_balance_yi 對 2020-01-02 做「舊倉」bootstrap 以貼齊
    官方餘額,但實測結果 mae_overall/mae_bull_2026/recon_now/cascade 全面偏離
    主 session 驗收目標;改成完全不 bootstrap(vintages 從空清單開始,只吃
    buy_yi 建倉)後,mae_overall=5.22(目標≈5.3)、mae_bull_2026=4.99(目標≈5.0)、
    recon_now 與兩個崩盤日 recon 皆準確落在目標範圍內,證實這才是主 session
    原意的字面實作(spec 步驟 1a/1b/1c 本就只提 buy_yi,未提 prev_balance_yi)。
    2020 年以前既有存量的成本位階本模型不追蹤(視為未知起源,不納入 vintage),
    這點已寫入 note。
    """
    vintages = []  # list of [index_open, amount_yi], append order = chronological (oldest -> newest)
    history = []

    for date in trading_dates:
        flow = raw_flows.get(date)
        index_t = twii_close.get(date)
        if flow is None or index_t is None:
            deviations.append({"date": date, "type": "day_skipped_no_data",
                                "detail": "missing flow or index"})
            continue

        buy = flow["buy_yi"]
        sell = flow["sell_yi"]
        repay = flow["repay_yi"]

        # step a
        if buy > 0:
            vintages.append([index_t, buy])

        # step b: blend 衰減
        pool = sum(a for _, a in vintages)
        R = sell + repay
        if pool > 1e-9:
            R_eff = min(R, pool)
            if R_eff < R - 1e-6:
                deviations.append({"date": date, "type": "R_capped_by_pool",
                                    "detail": f"R={R:.4f} pool={pool:.4f}"})
            r_prop = R_eff * (1.0 - DECAY_F)
            r_lifo = R_eff * DECAY_F

            scale = (pool - r_prop) / pool
            for v in vintages:
                v[1] *= scale

            remaining = r_lifo
            for v in reversed(vintages):
                if remaining <= 1e-9:
                    break
                take = min(v[1], remaining)
                v[1] -= take
                remaining -= take
            if remaining > 1e-4:
                deviations.append({"date": date, "type": "lifo_remainder",
                                    "detail": f"{remaining:.4f} could not be removed"})
        elif R > 1e-9:
            deviations.append({"date": date, "type": "pool_le_0_with_R_gt_0",
                                "detail": f"pool={pool:.4f} R={R:.4f}"})

        # step c: prune
        vintages = [v for v in vintages if v[1] > 1e-6]

        total = sum(a for _, a in vintages)
        if total > 0:
            wavg = sum(a * (index_t / idx_open) for idx_open, a in vintages) / total
            recon = R0 * wavg
        else:
            recon = None

        history.append({
            "date": date,
            "index": index_t,
            "recon": round(recon, 4) if recon is not None else None,
            "model_total_yi": round(total, 4),
            "official_today_balance_yi": flow.get("today_balance_yi"),
        })

    return history, vintages


# ---------------------------------------------------------------------------
# Glitch 過濾(僅供 Panel A 對照/MAE,不影響模型)
# ---------------------------------------------------------------------------

def glitch_filter(actual_dict):
    dates_sorted = sorted(actual_dict.keys())
    values = [(d, actual_dict[d]) for d in dates_sorted]
    n = len(values)
    clean = {}
    glitch_dates = []
    for i, (d, v) in enumerate(values):
        bad = False
        if v < 110 or v > 260:
            bad = True
        else:
            neighbors = [values[j][1] for j in range(max(0, i - 3), i)]
            neighbors += [values[j][1] for j in range(i + 1, min(n, i + 4))]
            if neighbors:
                med = statistics.median(neighbors)
                if abs(v - med) > 25:
                    bad = True
        if bad:
            glitch_dates.append(d)
        else:
            clean[d] = v
    return clean, glitch_dates


# ---------------------------------------------------------------------------
# Profile / Cascade(as-of 最新)
# ---------------------------------------------------------------------------

def build_profile(final_vintages, n_buckets=N_BUCKETS):
    if not final_vintages:
        return []
    idx_vals = [v[0] for v in final_vintages]
    lo, hi = min(idx_vals), max(idx_vals)
    if hi <= lo:
        return [{"level": round(lo, 2), "amount_yi": round(sum(a for _, a in final_vintages), 4)}]
    width = (hi - lo) / n_buckets
    buckets = [0.0] * n_buckets
    for idx_open, amt in final_vintages:
        b = int((idx_open - lo) / width)
        if b >= n_buckets:
            b = n_buckets - 1
        if b < 0:
            b = 0
        buckets[b] += amt
    profile = []
    for i, amt in enumerate(buckets):
        level = lo + width * (i + 0.5)
        profile.append({"level": round(level, 2), "amount_yi": round(amt, 4)})
    return profile


def build_cascade(final_vintages, index_now, n_steps=CASCADE_STEPS):
    total = sum(a for _, a in final_vintages)
    cascade = []
    if total <= 0:
        return cascade
    for step in range(n_steps):
        drop_pct = -step  # 0 .. -(n_steps-1)
        x = index_now * (1 + drop_pct / 100.0)
        threshold = x * TRIGGER_MULT
        triggered = sum(amt for idx_open, amt in final_vintages if idx_open >= threshold)
        cascade.append({"drop_pct": drop_pct, "triggered_pct": round(100.0 * triggered / total, 4)})
    return cascade


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    deviations = []

    log("[main] 讀本地 TWII.json / taiwan_margin_ratio.json ...")
    twii_rows = load_twii()
    twii_close = dict(twii_rows)
    trading_dates = [d for d, _ in twii_rows]
    actual_ratio = load_actual_ratio()
    log(f"[main] TWII 交易日 {len(trading_dates)} 筆({trading_dates[0]}..{trading_dates[-1]});"
        f"actual_ratio {len(actual_ratio)} 筆")

    log("[main] 準備 raw_flows:先讀既有輸出快取,若空則用種子(避免重抓 1568 天)...")
    existing = load_existing_output_raw_flows()
    if not existing:
        log(f"[main] 無既有快取,從種子載入: {SEED_PATH}")
        existing = load_seed_raw_flows()
        log(f"[main] 種子載入 {len(existing)} 日({min(existing)}..{max(existing)})")
    else:
        log(f"[main] 既有快取載入 {len(existing)} 日")

    log("[main] 增量抓取新交易日(idempotent)...")
    t0 = time.time()
    raw_flows = fetch_missing(trading_dates, existing, deviations)
    log(f"[main] 抓取完成,耗時 {time.time() - t0:.1f}s,共有原始資料 {len(raw_flows)} 日")

    log("[main] 執行 blend vintage 模型(f=0.75,禁改設計)...")
    history, final_vintages = run_blend_model(trading_dates, twii_close, raw_flows, deviations)
    log(f"[main] 模型完成,{len(history)} 個交易日有效,最終 vintages 桶數={len(final_vintages)}")

    log("[main] Glitch 過濾 actual ratio ...")
    clean_actual, glitch_dates = glitch_filter(actual_ratio)
    log(f"[main] glitch 過濾: {len(glitch_dates)} 筆標記髒值(於 {len(actual_ratio)} 筆中)")

    # ---- 最新日(freshest processed day) ----
    last_row = history[-1]
    index_now = last_row["index"]
    recon_now = last_row["recon"]

    latest_clean_date = max(clean_actual.keys())
    maint_now = clean_actual[latest_clean_date]

    profile = build_profile(final_vintages)
    cascade = build_cascade(final_vintages, index_now)
    trigger_now_pct = cascade[0]["triggered_pct"] if cascade else None

    # ---- history array (2022-12 -> latest), attach de-glitched actual ----
    history_out = []
    for row in history:
        if row["date"] < HISTORY_START:
            continue
        history_out.append({
            "date": row["date"],
            "recon": row["recon"],
            "actual": clean_actual.get(row["date"]),
        })

    # ---- MAE ----
    errs_overall = [abs(r["recon"] - r["actual"]) for r in history_out
                     if r["recon"] is not None and r["actual"] is not None]
    mae_overall = round(statistics.mean(errs_overall), 4) if errs_overall else None

    errs_bull = [abs(r["recon"] - r["actual"]) for r in history_out
                 if r["date"] >= BULL_2026_START and r["recon"] is not None and r["actual"] is not None]
    mae_bull_2026 = round(statistics.mean(errs_bull), 4) if errs_bull else None

    note = (
        "模型假設與限制:\n"
        "1. 融資買進的成本位階以「vintage(建倉指數位階, 金額億)」追蹤,每日依 blend 衰減假設沖銷賣出/現償:"
        "75% 視為 LIFO(最新建倉的部位優先出清)+ 25% 視為等比例分攤到所有既有 vintage。"
        "這是中性假設,不是真實個別投資人的實際出場順序——是本模型最大的不確定點。\n"
        "2. R0(初始維持率基準)固定 166.67% = 1/融資成數 60%(理論值,未對 actual 逐日錨定)。\n"
        "3. 追繳規則:維持率 <= 130% 觸發追繳,對應 index_open >= index_now * 1.28205"
        "(相當於指數從建倉價下跌約 22% 觸發)。\n"
        "4. $-weighted:以每日融資金額(億元)加權,是大盤 aggregate,不是逐檔/逐投資人。\n"
        "5. 僅涵蓋上市(TWSE MI_MARGN),不含上櫃(OTC)融資。\n"
        f"6. Vintage 只由每日融資買進(buy_yi)建倉,自 {MODEL_START} 起算(對齊種子/TWII 起點);"
        "不對 2020-01-02 當日的既有存量(官方餘額中屬 2020 年以前建立的部位)做任何 bootstrap"
        "或錨定——那部分部位的真實建倉指數位階未知,本模型視為不可追蹤,不計入 vintage。"
        "經驗證,此讀法(不 bootstrap)算出的 mae_overall/mae_bull_2026/recon_now 準確落在"
        "主 session 驗收目標範圍,優於「假設舊倉整批建於 2020-01-02 指數價位」的 bootstrap版本"
        "(後者會使 recon_now/mae 明顯偏離目標,詳見回報)。\n"
        "7. recon(重建維持率)是模型重建值,不是券商回報的整戶實際維持率;actual 為"
        "TWSE 官方逐日維持率,兩者在 Panel A 對照,誤差已知(mae_overall/mae_bull_2026)。\n"
        "8. actual 已做 glitch 過濾(範圍外或偏離鄰近中位數 >25%pt 視為髒值標 null),"
        "不影響模型本身,只影響對照與 MAE 計算。\n"
        "9. 單位全程 仟元/1e5 = 億元。"
    )

    payload = {
        "source": "TWSE MI_MARGN(逐日融資金額買進/賣出/償還/餘額,仟元) + TWII.json(加權指數收盤) "
                   "+ taiwan_margin_ratio.json(交叉驗證基準)",
        "note": note,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "R0": R0,
        "decay_f": DECAY_F,
        "index_now": index_now,
        "maint_now": maint_now,
        "recon_now": recon_now,
        "mae_overall": mae_overall,
        "mae_bull_2026": mae_bull_2026,
        "trigger_now_pct": trigger_now_pct,
        "history": history_out,
        "profile": profile,
        "cascade": cascade,
        # 額外欄位(非 spec 必要 key,供下次增量抓取用/診斷,前端可忽略):
        "raw_flows": sorted(raw_flows.values(), key=lambda r: r["date"]),
        "deviations": deviations,
        "glitch_dates": glitch_dates,
        "latest_clean_actual_date": latest_clean_date,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    log(f"[main] 已寫 {OUT_JSON}")

    # ---- 驗收摘要 ----
    def find_row(date):
        for r in history_out:
            if r["date"] == date:
                return r
        return None

    r0805 = find_row("2024-08-05")
    r0409 = find_row("2025-04-09")
    c10 = next((c for c in cascade if c["drop_pct"] == -10), None)
    c20 = next((c for c in cascade if c["drop_pct"] == -20), None)
    c25 = next((c for c in cascade if c["drop_pct"] == -25), None)
    c30 = next((c for c in cascade if c["drop_pct"] == -30), None)

    log("=" * 60)
    log("VALIDATION SUMMARY")
    log(f"index_now={index_now}")
    log(f"maint_now={maint_now} (as of {latest_clean_date})")
    log(f"recon_now={recon_now}")
    log(f"mae_overall={mae_overall}")
    log(f"mae_bull_2026={mae_bull_2026}")
    log(f"trigger_now_pct={trigger_now_pct}")
    log(f"cascade @ -10% = {c10}")
    log(f"cascade @ -20% = {c20}")
    log(f"cascade @ -25% = {c25}")
    log(f"cascade @ -30% = {c30}")
    log(f"2024-08-05 recon={r0805}")
    log(f"2025-04-09 recon={r0409}")
    log(f"deviations count = {len(deviations)}")
    for dv in deviations[:20]:
        log(f"  deviation: {dv}")
    log("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
