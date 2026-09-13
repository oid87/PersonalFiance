"""Fetch Taiwan / Japan / Korea annual real GDP growth rates → data/tw_jp_kr_gdp_growth.json

⚠️ 三國計算口徑不同,不是同一種算法(見下方 NOTE 與各 fetch_* 函式說明),
比較時務必留意——這不是三個「官方年增率」的並排比較,而是「三種方法各自
逼近年增率」的並排比較。

Sources:
  台灣 — DGBAS(行政院主計總處)官方 XML,national accounts common-use series
         https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230514/na8101a1a.xml
         欄位「經濟成長率(%)」,TYPE=原始值,FREQ=Y——DGBAS 官方直接發布的年增率,
         不需要我們自己計算。
  日本 — FRED JPNRGDPEXP(Real GDP, Billions of Chained 2015 Yen,季頻,SA)
         https://fred.stlouisfed.org/graph/fredgraph.csv?id=JPNRGDPEXP
         這是 GDP **水準值**,不是成長率。做法:同一年份的四季水準值取平均
         代表該年度水準(平滑單季雜訊),年增率 = (今年平均/去年平均 - 1) * 100。
         只有一年 4 季全部到齊才計算(避免用不完整年份的平均值失真)。
  南韓 — FRED NAEXKP01KRQ657S(Growth rate over previous period, real GDP,
         季比季 QoQ,已季調,單位:%)
         https://fred.stlouisfed.org/graph/fredgraph.csv?id=NAEXKP01KRQ657S
         這不是年增率,是逐季 QoQ 成長率。做法:把同一年份 4 季的 QoQ 複合
         成年增率近似值:(1+q1)*(1+q2)*(1+q3)*(1+q4) - 1(每季 QoQ 先除以
         100 轉小數,複合後再乘 100 轉回百分比)。只有一年 4 季全部到齊才計算。
         注意:原本以為的 KORRGDPEXP 這個 FRED series ID 不存在,已改用
         NAEXKP01KRQ657S。

台灣 DGBAS 網站已知陷阱(2026-09 實測確認):
  用 `requests.get(url, verify=True)`(預設)或 `verify=certifi.where()` 皆會
  遇到 SSLError: certificate verify failed / unable to get local issuer
  certificate——即使用最新 certifi 憑證包也一樣。用 `curl` 直接下載此 URL
  也需要加 `-k` 才過,可見是該政府網站本身的 TLS chain 有問題,不是本機
  憑證庫太舊。因此這裡退而求其次用 `verify=False`,這是已知取捨、不是隨意
  關閉 SSL 驗證,並用 urllib3.disable_warnings 避免洗版 InsecureRequestWarning。

Output data/tw_jp_kr_gdp_growth.json, idempotent merge by year (新覆舊):
  {updated, note,
   data: [{year, tw, jp, kr}, ...]}   # 年度實質GDP成長率(%),年升序
"""
from __future__ import annotations

import csv
import io
import json
import xml.etree.ElementTree as ET
from collections import OrderedDict
from datetime import date
from pathlib import Path

import requests
import urllib3

# 政府網站(ws.dgbas.gov.tw)TLS chain 有問題,已於 2026-09 實測確認(curl 也需要
# -k 才過),verify=False 是已知取捨,非隨意關閉 SSL 驗證。關掉對應的 warning 洗版。
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "tw_jp_kr_gdp_growth.json"

UA = {"User-Agent": "PersonalFiance/1.0"}

DGBAS_URL = "https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230514/na8101a1a.xml"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"

NOTE = (
    "台灣經濟成長率為DGBAS官方直接發布之年增率;日本為FRED JPNRGDPEXP之GDP水準值"
    "自算年增率;南韓為FRED NAEXKP01KRQ657S之季比季(QoQ)成長率複合估算之年增率"
    "近似值,非官方直接發布之年增率——三國計算方式不完全相同,比較時請留意。"
    "日本作法:同年4季GDP水準值(Billions of Chained 2015 Yen)取平均代表該年度"
    "水準,再算年增率;南韓作法:同年4季QoQ成長率以(1+q1)(1+q2)(1+q3)(1+q4)-1"
    "複合估算年增率。兩者皆須一年4季資料齊全才計算,故最新年份若季度未到齊會"
    "暫缺。"
)


def fetch_taiwan_growth() -> "OrderedDict[int, float]":
    """DGBAS「經濟成長率(%)」,TYPE=原始值、FREQ=Y,官方直接發布的年增率。"""
    try:
        resp = requests.get(DGBAS_URL, timeout=30, headers=UA)
        resp.raise_for_status()
    except requests.exceptions.SSLError:
        # 已知陷阱:此政府網站 TLS chain 有問題,curl 也需要 -k。verify=False
        # 是刻意的已知取捨,見檔頭說明。
        resp = requests.get(DGBAS_URL, timeout=30, headers=UA, verify=False)
        resp.raise_for_status()

    root = ET.fromstring(resp.content)
    out: "OrderedDict[int, float]" = OrderedDict()
    for obs in root.findall("Obs"):
        if obs.findtext("Item") != "經濟成長率(%)":
            continue
        if obs.findtext("FREQ") != "Y":
            continue
        if obs.findtext("TYPE") != "原始值":
            continue
        year_s = (obs.findtext("TIME_PERIOD") or "").strip()
        val_s = (obs.findtext("Item_VALUE") or "").strip()
        if not year_s or not val_s:
            continue
        try:
            out[int(year_s)] = float(val_s)
        except ValueError:
            continue
    return OrderedDict(sorted(out.items()))


def fetch_fred_series(series_id: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-DD: value} for one FRED series, skipping missing ('.') obs."""
    resp = requests.get(FRED_URL.format(sid=series_id), timeout=30, headers=UA)
    resp.raise_for_status()
    by_date: "OrderedDict[str, float]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or "").strip()
        v = (row.get(series_id) or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            by_date[d] = float(v)
        except ValueError:
            continue
    return by_date


def group_by_year(by_date: "OrderedDict[str, float]") -> "dict[int, dict[str, float]]":
    """{year: {'01': v, '04': v, '07': v, '10': v}} — quarter start month -> value."""
    out: "dict[int, dict[str, float]]" = {}
    for d, v in by_date.items():
        y, m, _ = d.split("-")
        out.setdefault(int(y), {})[m] = v
    return out


def fetch_japan_growth() -> "OrderedDict[int, float]":
    """FRED JPNRGDPEXP(GDP水準值,季頻)-> 年度平均水準 -> YoY年增率(%)。"""
    levels = fetch_fred_series("JPNRGDPEXP")
    by_year = group_by_year(levels)
    quarters = ("01", "04", "07", "10")
    annual: "OrderedDict[int, float]" = OrderedDict()
    for y in sorted(by_year):
        q = by_year[y]
        if all(m in q for m in quarters):
            annual[y] = sum(q[m] for m in quarters) / 4.0

    growth: "OrderedDict[int, float]" = OrderedDict()
    years = sorted(annual)
    for y in years:
        if (y - 1) in annual:
            growth[y] = (annual[y] / annual[y - 1] - 1) * 100
    return growth


def fetch_korea_growth() -> "OrderedDict[int, float]":
    """FRED NAEXKP01KRQ657S(QoQ%,季調)-> 同年4季複合估算年增率(%)近似值。"""
    qoq = fetch_fred_series("NAEXKP01KRQ657S")
    by_year = group_by_year(qoq)
    quarters = ("01", "04", "07", "10")
    growth: "OrderedDict[int, float]" = OrderedDict()
    for y in sorted(by_year):
        q = by_year[y]
        if not all(m in q for m in quarters):
            continue
        compounded = 1.0
        for m in quarters:
            compounded *= (1 + q[m] / 100.0)
        growth[y] = (compounded - 1) * 100
    return growth


def load_existing() -> "OrderedDict[int, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["year"], r) for r in payload.get("data", []) if r.get("year"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing()

    fresh: "OrderedDict[int, dict]" = OrderedDict()
    try:
        tw = fetch_taiwan_growth()
        print(f"  [TW] {len(tw)} years, latest {max(tw)}={tw[max(tw)]}")
    except Exception as exc:
        print(f"  [TW] FAILED ({exc})")
        tw = OrderedDict()

    try:
        jp = fetch_japan_growth()
        print(f"  [JP] {len(jp)} years, latest {max(jp)}={jp[max(jp)]:.2f}" if jp else "  [JP] 0 years")
    except Exception as exc:
        print(f"  [JP] FAILED ({exc})")
        jp = OrderedDict()

    try:
        kr = fetch_korea_growth()
        print(f"  [KR] {len(kr)} years, latest {max(kr)}={kr[max(kr)]:.2f}" if kr else "  [KR] 0 years")
    except Exception as exc:
        print(f"  [KR] FAILED ({exc})")
        kr = OrderedDict()

    all_years = sorted(set(tw) | set(jp) | set(kr))
    for y in all_years:
        fresh[y] = {
            "year": y,
            "tw": tw.get(y),
            "jp": round(jp[y], 2) if y in jp else None,
            "kr": round(kr[y], 2) if y in kr else None,
        }

    if not fresh and not existing:
        raise RuntimeError("no TW/JP/KR GDP growth data available (fresh fetch failed and no existing data)")

    merged = OrderedDict(existing)
    merged.update(fresh)  # 新覆舊(idempotent,依 year)
    data = [merged[y] for y in sorted(merged)]

    payload = {
        "updated": date.today().isoformat(),
        "note": NOTE,
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} years")


if __name__ == "__main__":
    main()
