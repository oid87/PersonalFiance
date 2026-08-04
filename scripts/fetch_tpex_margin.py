"""櫃買(TPEx/上櫃)大盤融資餘額 / 總市值 / 融資維持率 — 比照 fetch_margin_ratio_mm.py 風格。

背景：TWSE(上市)已有 fetch_margin_ratio_mm.py 重建維持率(擔保品市值 ÷ 融資金額)。
本腳本補上 TPEx(上櫃)版本，但**分母(市場總計融資金額)找不到公開資料源**，見下方
「已知限制」— ratio_all/ratio_exetf/margin_yi 一律輸出 null，不自行捏造或用張數推估。

資料源(均實測確認)
  1. 逐檔融資融券餘額(有歷史，回溯至少到 2010；本腳本預設 floor 對齊到 2011-01-01
     ，理由見下)：
     GET https://www.tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD&response=json
     → {date:'YYYYMMDD', stat:'ok', tables:[{title:'上櫃股票融資融券餘額', fields:[...],
        data:[[...]]}]}；欄位用 fields.index('代號')/('資餘額')/('券餘額') 定位
        (注意 '前資餘額(張)' 也含子字串「資餘額」，不可用 in 比對，須用 index() 精確比對)。
     若查詢日超出範圍/非交易日，回傳的 date 會靜默 fallback 成「今天」而不是報錯 —
     必須自行比對 date 欄位是否等於查詢日，不符就視為失敗。
  2. 逐檔收盤價 + 發行股數(**有歷史**，實測回溯上限剛好卡在 2011-01-01；2010-12-31
     及更早一律靜默 fallback 回今天，行為與來源 1 相同)：
     GET https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php
         ?l=zh-tw&d=<ROC yyy/mm/dd>&se=EW&s=0,asc,0
     → {date:'yyy/mm/dd'(ROC), stat:'ok', tables:[{fields:['代號','名稱','收盤 ',...,
        '發行股數 ',...], data:[[...]]}]}
     欄位名稱含前後空白('收盤 '、' 成交金額(元)')，用 f.strip()=='收盤' / '發行股數' in f
     定位，不用 in 比對容易誤中其他欄。
     市值(mktcap) = 收盤 × 發行股數，與 openapi tpex_daily_market_value 的
     MarketValue(單位=百萬元) 交叉驗證吻合(2026-08-04 信驊 5274：本式算得 6445.36 億，
     openapi MarketValue=644535(百萬)→6445.35 億，差 <0.01% 為四捨五入)。
     用這個逐日歷史源直接算 mktcap，不再需要 openapi tpex_daily_market_value(它只有
     今日快照、無日期參數)。

     ⚠️ mktcap 務必分「含 ETF」/「排除 ETF」兩種口徑，否則會嚴重失真：上櫃掛牌的
     ETF(00 開頭，多為債券 ETF，如 00679B 元大美債20年)規模達數兆，且其規模變動
     跟「上櫃股市」本身漲跌無關，混在一起會把股市總市值嚴重灌水、污染趨勢。實測
     2026-08-04：全部(含ETF) mktcap_yi=129,680.8 億，其中 ETF 部分 28,158.9 億
     (2.82 兆，佔 22%)，排除 ETF 後 mktcap_exetf_yi=101,522.0 億。同日 openapi
     tpex_daily_market_value 全部個股加總 ≈101,940 億，與 mktcap_exetf_yi 吻合
     (差 0.4%，來自個股樣本差異如當日暫停交易/新增下市)，證實官方「上櫃個股市值」
     口徑本身就不含 ETF。因此 mktcap_yi(含ETF)與 mktcap_exetf_yi(排除ETF)兩欄並存，
     **代表「櫃買市場整體資金/個股市值」時應優先看 mktcap_exetf_yi**，mktcap_yi 只
     用於想額外了解 ETF 規模時參考。

已知限制 —— 市場總計融資金額(分母)找不到，ratio_*/margin_yi 一律 null
  嘗試過的路徑與結果：
    a. https://www.tpex.org.tw/openapi/swagger.json 全掃 — 有 tpex_mainboard_margin_balance
       (逐檔)、tpex_margin_trading_marginspot(上櫃信用交易餘額概況表)，但後者是「本月
       平均、依券商排名」的月報，不是「當日、市場加總」的金額。沒有任何 path 提供
       市場當日融資金額(元)加總。
    b. www.tpex.org.tw/www/zh-tw/margin/{balance,ratio,marginspot,margin_bal,...} 逐一嘗試
       ——僅 balance(逐檔)、ratio(月度券商排名，同 a)回 200，其餘皆 302(路徑不存在)。
       balance 回應只有 1 個 table(逐檔)，不像 TWSE MI_MARGN 同一次呼叫還內含市場加總
       table。
    c. FinMind dataset 列表 — 有 TaiwanStockTotalMarginPurchaseShortSale，但實測其
       MarginPurchaseMoney 數值與本地既有 data/taiwan_margin_ratio_mm.json 的 TWSE(上市)
       margin_yi 完全吻合(2026-07-28：FinMind 545,534,811,000 元 vs 本地 TWSE 5455.3億元)
       ——證實這是 TWSE 上市専用資料，並非 OTC，且 data_id 參數對此 dataset 無效(給
       TWO/OTC/ALL 都回同一組數字)。FinMind 沒有 OTC 版本的市場融資金額 dataset。
       TaiwanTotalExchangeMarginMaintenance 需付費(free tier 400)，未能驗證但依其
       單一 dataset 命名推測也是市場總計(可能仍是 TWSE)，非免費故未採用。
  結論：找不到，不推算。collateral_*_yi(擔保品市值，來源1×來源2)、mktcap_yi(來源2
  獨立算)照常輸出；margin_yi/ratio_all/ratio_exetf 固定為 null。

floor 為何對齊 2011-01-01：來源2(收盤價)是算 collateral/mktcap 的必要輸入，其歷史
回溯上限就是 2011-01-01；早於此日只能拿到來源1的 margin_lots/short_lots(collateral/
mktcap/ratio/margin_yi 皆 null)。預設 TPEX_FLOOR 對齊到「完整計算」的最早日期，避免
預設回補跑出一堆只有兩個數字的空洞列；真要更早的 margin_lots-only 歷史可自行調低
TPEX_FLOOR。

每交易日 2 個 TPEx request，keep-alive session + 禮貌間隔 + 重試，idempotent 合併 →
可重跑/續傳。回補用 stride 分層(32→16→8→4→2→1)，理由與寫法同 fetch_margin_ratio_mm.py。

Output: data/tpex_margin.json
        {source, note, updated, data:[{date, margin_lots, short_lots, collateral_all_yi,
                                        collateral_exetf_yi, margin_yi, ratio_all,
                                        ratio_exetf, mktcap_yi, mktcap_exetf_yi, n, n_etf}]}
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tpex_margin.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "Referer": "https://www.tpex.org.tw/"}
BALANCE_URL = "https://www.tpex.org.tw/www/zh-tw/margin/balance"
CLOSE_URL = "https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php"
FLOOR = os.environ.get("TPEX_FLOOR", "2011-01-01")
CEIL = os.environ.get("TPEX_CEIL", "")  # 空 = today
MAX_DAYS = int(os.environ.get("TPEX_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("TPEX_SLEEP", "0.5"))
ONLY = [d for d in os.environ.get("TPEX_ONLY", "").split(",") if d]  # 指定日期驗證用

SESS = requests.Session()  # keep-alive：省掉每個 request 的 TCP+TLS handshake


def is_etf(code: str) -> bool:
    """非普通股（ETF/ETN/受益憑證）：代號以 00 開頭。上櫃代號也有 00679B 這種帶英文
    尾碼的(債券ETF)，startswith("00") 一樣判為 True，判定邏輯不受影響。"""
    return str(code).strip().startswith("00")


def num(s):
    try:
        return float(str(s).replace(",", "").replace(" ", ""))
    except Exception:
        return None


def roc_date(d_iso: str) -> str:
    """'2026-08-04' -> '115/08/04'（民國年，月日維持 2 位數，年不補零，與實測行為一致）。"""
    y, m, dd = d_iso.split("-")
    return f"{int(y) - 1911}/{m}/{dd}"


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


def fetch_balance(d_iso):
    """逐檔融資/融券餘額(張)。回傳 (lots, shorts) dict，key=代號；查無資料回 None。"""
    j = get_json(BALANCE_URL, {"date": d_iso.replace("-", "/"), "response": "json"})
    if not j or j.get("stat") != "ok" or not j.get("tables"):
        return None
    if j.get("date") != d_iso.replace("-", ""):
        return None  # 查詢日超出範圍時會靜默 fallback 回今天，date 不符即判失敗
    tbl = j["tables"][0]
    fields = tbl.get("fields") or []
    try:
        ci, li, si = fields.index("代號"), fields.index("資餘額"), fields.index("券餘額")
    except ValueError:
        return None
    lots, shorts = {}, {}
    for r in tbl.get("data", []):
        if len(r) <= max(ci, li, si):
            continue
        code = str(r[ci]).strip()
        if not code:
            continue
        v, s = num(r[li]), num(r[si])
        if v is not None:
            lots[code] = v
        if s is not None:
            shorts[code] = s
    return (lots, shorts) if lots else None


def fetch_close(d_iso):
    """逐檔收盤價 + 發行股數。回傳 (closes, shares) dict，key=代號；查無資料回 None。"""
    roc = roc_date(d_iso)
    j = get_json(CLOSE_URL, {"l": "zh-tw", "d": roc, "se": "EW", "s": "0,asc,0"})
    if not j or j.get("stat") != "ok" or not j.get("tables"):
        return None
    tbl = j["tables"][0]
    if tbl.get("date") != roc:
        return None  # 超出回溯上限(2011-01-01 前)時同樣會靜默 fallback 回今天
    fields = tbl.get("fields") or []
    try:
        ci = next(i for i, f in enumerate(fields) if f.strip() == "代號")
        pi = next(i for i, f in enumerate(fields) if f.strip() == "收盤")
        si = next(i for i, f in enumerate(fields) if "發行股數" in f)
    except StopIteration:
        return None
    closes, shares = {}, {}
    for r in tbl.get("data", []):
        if len(r) <= max(ci, pi, si):
            continue
        code = str(r[ci]).strip()
        if not code:
            continue
        c, sh = num(r[pi]), num(r[si])
        if c is not None:
            closes[code] = c
        if sh is not None:
            shares[code] = sh
    return (closes, shares) if closes else None


def fetch_day(d_iso):
    bal = fetch_balance(d_iso)
    if not bal:
        return None
    lots, shorts = bal
    row = {
        "date": d_iso,
        "margin_lots": int(round(sum(lots.values()))),
        "short_lots": int(round(sum(shorts.values()))),
        "collateral_all_yi": None,
        "collateral_exetf_yi": None,
        "margin_yi": None,   # 分母(市場總計融資金額)找不到公開資料源，見 docstring
        "ratio_all": None,   # 同上，無分母無法算
        "ratio_exetf": None,  # 同上
        "mktcap_yi": None,
        "mktcap_exetf_yi": None,  # 排除 ETF(00開頭)的口徑，對應官方「上櫃個股市值」，預設應看這個
        "n": None,
        "n_etf": None,
    }

    time.sleep(SLEEP)
    close = fetch_close(d_iso)
    if not close:
        return row  # 早於 2011-01-01 或當日收盤源查無資料 → 只有 margin_lots/short_lots

    closes, shares = close
    caps = {c: closes[c] * shares[c] for c in closes if c in shares}
    mktcap = sum(caps.values())
    if mktcap:
        row["mktcap_yi"] = round(mktcap / 1e8, 1)
        mktcap_exetf = sum(v for c, v in caps.items() if not is_etf(c))
        row["mktcap_exetf_yi"] = round(mktcap_exetf / 1e8, 1)

    matched = [c for c in lots if c in closes and closes[c]]
    if len(matched) >= 0.5 * len(lots):  # coverage guard，同 fetch_margin_ratio_mm.py
        coll_all = sum(lots[c] * closes[c] * 1000.0 for c in matched)
        etfs = [c for c in matched if is_etf(c)]
        coll_etf = sum(lots[c] * closes[c] * 1000.0 for c in etfs)
        row["collateral_all_yi"] = round(coll_all / 1e8, 1)
        row["collateral_exetf_yi"] = round((coll_all - coll_etf) / 1e8, 1)
        row["n"] = len(matched)
        row["n_etf"] = len(etfs)
    return row


def missing_trading_days(have):
    """[FLOOR, CEIL] 內尚未抓過的平日，依 stride 分層排序(32→16→8→4→2→1)，寫法/理由
    同 fetch_margin_ratio_mm.py：任一中途點停下，樣本都均勻散佈全區間。"""
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


def save(by_date):
    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": ("TPEx www/zh-tw/margin/balance(逐檔融資融券餘額) × "
                   "web/stock/aftertrading/otc_quotes_no1430(逐檔收盤+發行股數,回溯至2011-01-01)"),
        "note": ("市場總計融資金額(分母)找不到 TPEx 公開資料源(openapi swagger 全掃、"
                 "www/margin 下多路徑嘗試、FinMind 皆已排除，詳見腳本 docstring) → "
                 "margin_yi/ratio_all/ratio_exetf 固定為 null，不自行捏造或用張數推估。"
                 "collateral_*_yi=擔保品市值(資餘額張×收盤×1000)，皆為完整計算，"
                 "2011-01-01 前因無逐日收盤史料只有 margin_lots/short_lots。"
                 "mktcap_yi=全市場市值(收盤×發行股數，含ETF)；上櫃掛牌ETF(00開頭)多為"
                 "債券ETF、規模達數兆且與股市漲跌無關，混入會嚴重灌水並污染趨勢，故另給"
                 "mktcap_exetf_yi(排除ETF)——這才對應官方 openapi tpex_daily_market_value "
                 "的「上櫃個股市值」口徑(2026-08-04 實測：mktcap_exetf_yi=101,522億 vs "
                 "openapi 加總≈101,940億，差0.4%屬個股樣本差異；含ETF口徑則高達129,681億)。"
                 "**代表櫃買市場整體個股市值/資金時請用 mktcap_exetf_yi，不要用 mktcap_yi**。"
                 "ETF判定=代號以00開頭(含00679B等債券ETF)。"),
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")


def main():
    by_date = {}
    if OUT.exists():
        try:
            by_date = {r["date"]: r for r in json.loads(OUT.read_text()).get("data", [])}
        except Exception:
            by_date = {}
    todo = ONLY if ONLY else missing_trading_days(set(by_date))[:MAX_DAYS]
    print(f"{len(by_date)} existing · {len(todo)} days to fetch "
          f"(cap {MAX_DAYS}, floor {FLOOR}, ceil {CEIL or 'today'})", flush=True)

    done = skipped = 0
    for d in todo:
        res = fetch_day(d)
        if res:
            by_date[d] = res
            done += 1
            if done % 20 == 0:
                save(by_date)
                print(f"  ...{done} fetched · {d} margin_lots={res['margin_lots']} "
                      f"mktcap_exetf_yi={res['mktcap_exetf_yi']} (saved)", flush=True)
        else:
            skipped += 1
        time.sleep(SLEEP)

    save(by_date)
    data = sorted(by_date.values(), key=lambda r: r["date"])
    if data:
        print(f"Wrote {len(data)} rows ({data[0]['date']}..{data[-1]['date']}); "
              f"+{done} new, {skipped} skipped this run", flush=True)


if __name__ == "__main__":
    main()
