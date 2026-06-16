"""Fetch top-10 holdings (symbol + weight) for the 11 SPDR sector ETFs from yfinance,
merge with a hand-maintained 代號→(中文名, 說明) dictionary, and write
data/sector_holdings.json for the 產業輪動 tab popup.

Design: weights + membership auto-update (yfinance); 中文名/說明 come from DESC keyed by
ticker — so as long as a stock stays in the sector, its description carries over. When a
NEW symbol enters a top-10 it's flagged in the log with a placeholder so we can add a line.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "sector_holdings.json"

ETFS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "XLC"]

# 代號 → (中文名, 一句說明)。新股進榜時於此補一行即可。
DESC: dict[str, tuple[str, str]] = {
    # XLK 科技
    "NVDA": ("輝達", "AI 加速晶片(GPU)龍頭"), "AAPL": ("蘋果", "iPhone／消費電子"),
    "MSFT": ("微軟", "軟體／雲端 Azure"), "MU": ("美光", "記憶體 DRAM／HBM"),
    "AVGO": ("博通", "網通／客製 AI 晶片"), "AMD": ("超微", "CPU／GPU(對打 Intel/NVDA)"),
    "INTC": ("英特爾", "CPU／晶圓代工"), "CSCO": ("思科", "網路設備"),
    "LRCX": ("科林研發", "半導體製程設備"), "ORCL": ("甲骨文", "資料庫／雲端"),
    "QCOM": ("高通", "手機晶片"), "TXN": ("德州儀器", "類比晶片"),
    "IBM": ("IBM", "企業軟體／顧問"), "ADBE": ("Adobe", "創意／文件軟體"),
    "CRM": ("Salesforce", "雲端 CRM 軟體"), "NOW": ("ServiceNow", "企業工作流軟體"),
    "PLTR": ("Palantir", "資料分析／AI 軟體"), "AMAT": ("應用材料", "半導體設備"),
    # XLF 金融
    "BRK-B": ("波克夏", "巴菲特控股集團"), "JPM": ("摩根大通", "美國最大銀行"),
    "V": ("Visa", "全球支付網路"), "MA": ("萬事達", "全球支付網路"),
    "BAC": ("美國銀行", "大型商業銀行"), "GS": ("高盛", "投資銀行"),
    "MS": ("摩根士丹利", "投行／財富管理"), "WFC": ("富國銀行", "商業銀行"),
    "C": ("花旗", "全球銀行"), "AXP": ("美國運通", "信用卡／支付"),
    "SPGI": ("標普全球", "信評／指數"), "BLK": ("貝萊德", "最大資產管理"),
    "SCHW": ("嘉信理財", "證券經紀"),
    # XLV 醫療
    "LLY": ("禮來", "減肥／糖尿病藥(GLP-1)龍頭"), "JNJ": ("嬌生", "製藥／醫療器材"),
    "ABBV": ("艾伯維", "製藥(免疫／美容)"), "UNH": ("聯合健康", "最大醫療保險商"),
    "MRK": ("默克", "製藥(癌症藥 Keytruda)"), "TMO": ("賽默飛", "生技儀器／試劑"),
    "AMGN": ("安進", "生物製藥"), "GILD": ("吉利德", "抗病毒藥"),
    "ISRG": ("直覺手術", "手術機器人(達文西)"), "PFE": ("輝瑞", "製藥"),
    "ABT": ("亞培", "醫材／診斷"), "DHR": ("丹納赫", "生技儀器"),
    "BMY": ("必治妥", "製藥"), "BSX": ("波士頓科學", "醫療器材"),
    # XLE 能源
    "XOM": ("埃克森美孚", "綜合石油巨頭"), "CVX": ("雪佛龍", "綜合石油"),
    "COP": ("康菲", "油氣探勘生產"), "SLB": ("斯倫貝謝", "油田服務龍頭"),
    "WMB": ("威廉斯", "天然氣管線"), "VLO": ("瓦萊羅", "煉油"),
    "MPC": ("馬拉松石油", "煉油"), "EOG": ("EOG", "頁岩油氣探勘"),
    "PSX": ("菲利普斯66", "煉油／化工"), "BKR": ("貝克休斯", "油田服務／設備"),
    "OKE": ("ONEOK", "天然氣管線"), "KMI": ("金德摩根", "天然氣管線"),
    # XLI 工業
    "CAT": ("卡特彼勒", "重型機械設備"), "GE": ("GE 航太", "航空引擎"),
    "GEV": ("GE Vernova", "電力／電網設備"), "RTX": ("雷神", "國防／航太"),
    "BA": ("波音", "民航機製造"), "UNP": ("聯合太平洋", "鐵路貨運"),
    "ETN": ("伊頓", "電力管理設備"), "HON": ("漢威聯合", "工業自動化／航太"),
    "UBER": ("Uber", "叫車／外送平台"), "DE": ("強鹿", "農用機械"),
    "LMT": ("洛克希德馬丁", "國防航太"), "ADP": ("ADP", "薪資／人資服務"),
    "TT": ("特靈", "空調設備"), "PH": ("派克漢尼汾", "工業零件"),
    # XLY 非必需消費
    "AMZN": ("亞馬遜", "電商／雲端 AWS"), "TSLA": ("特斯拉", "電動車"),
    "HD": ("家得寶", "居家修繕零售"), "TJX": ("TJX", "折扣服飾零售"),
    "MCD": ("麥當勞", "速食連鎖"), "BKNG": ("Booking", "線上訂房旅遊"),
    "LOW": ("勞氏", "居家修繕零售"), "SBUX": ("星巴克", "咖啡連鎖"),
    "MAR": ("萬豪", "飯店集團"), "GM": ("通用汽車", "汽車製造"),
    "NKE": ("Nike", "運動用品"), "ORLY": ("奧萊利", "汽車零件零售"),
    # XLP 必需消費
    "WMT": ("沃爾瑪", "零售龍頭"), "COST": ("好市多", "會員制量販"),
    "PG": ("寶僑", "日用消費品"), "KO": ("可口可樂", "飲料"),
    "PM": ("菲利普莫里斯", "菸草(國際)"), "MDLZ": ("億滋", "零食(餅乾巧克力)"),
    "MO": ("奧馳亞", "菸草(美國)"), "CL": ("高露潔", "日用品／牙膏"),
    "PEP": ("百事", "飲料／零食"), "MNST": ("怪獸飲料", "能量飲料"),
    "KMB": ("金百利", "紙品／日用"), "TGT": ("Target", "量販零售"),
    # XLU 公用
    "NEE": ("NextEra", "再生能源電力龍頭"), "SO": ("南方電力", "區域電力公司"),
    "DUK": ("杜克能源", "區域電力公司"), "CEG": ("Constellation", "核電龍頭(AI 供電)"),
    "AEP": ("美國電力", "區域電力公司"), "SRE": ("Sempra", "電力／天然氣"),
    "D": ("Dominion", "區域電力公司"), "VST": ("Vistra", "電力(含核電)"),
    "ETR": ("Entergy", "區域電力公司"), "XEL": ("Xcel", "區域電力公司"),
    "PEG": ("PSEG", "區域電力公司"), "PCG": ("PG&E", "加州電力"),
    # XLRE 不動產
    "WELL": ("Welltower", "醫療／長照 REIT"), "PLD": ("Prologis", "物流倉儲 REIT"),
    "EQIX": ("Equinix", "資料中心 REIT"), "AMT": ("美國電塔", "通訊基地台 REIT"),
    "SPG": ("Simon", "購物中心 REIT"), "DLR": ("Digital Realty", "資料中心 REIT"),
    "PSA": ("Public Storage", "自助倉儲 REIT"), "VTR": ("Ventas", "醫療／長照 REIT"),
    "CCI": ("Crown Castle", "通訊塔 REIT"), "O": ("Realty Income", "月配息零售 REIT"),
    "EXR": ("Extra Space", "自助倉儲 REIT"), "AVB": ("AvalonBay", "公寓住宅 REIT"),
    # XLB 材料
    "LIN": ("林德", "工業氣體龍頭"), "NEM": ("紐蒙特", "黃金礦業"),
    "NUE": ("紐柯", "鋼鐵"), "FCX": ("自由港", "銅礦"),
    "VMC": ("火神材料", "建材砂石"), "CRH": ("CRH", "建材／水泥"),
    "APD": ("空氣產品", "工業氣體"), "STLD": ("鋼動力", "鋼鐵"),
    "CTVA": ("科迪華", "農業種子／農化"), "SHW": ("宣偉", "塗料／油漆"),
    "ECL": ("藝康", "水處理／清潔"), "MLM": ("馬丁瑪麗埃塔", "建材砂石"),
    # XLC 通訊
    "META": ("Meta", "社群(FB／IG)／廣告"), "GOOGL": ("谷歌 A", "搜尋／YouTube／雲端"),
    "GOOG": ("谷歌 C", "同 Alphabet(無投票權)"), "TTWO": ("Take-Two", "遊戲(GTA／2K)"),
    "LYV": ("Live Nation", "演唱會／票務"), "SATS": ("EchoStar", "衛星通訊(Dish)"),
    "DIS": ("迪士尼", "媒體／娛樂／串流"), "WBD": ("華納兄弟探索", "媒體／串流(HBO)"),
    "EA": ("美商藝電", "遊戲(戰地／模擬市民)"), "OMC": ("宏盟", "廣告代理集團"),
    "NFLX": ("Netflix", "串流影音"), "T": ("AT&T", "電信"),
    "VZ": ("Verizon", "電信"), "TMUS": ("T-Mobile", "電信"),
    "CMCSA": ("康卡斯特", "有線電視／寬頻"),
}


def fetch_top10(etf: str) -> list[dict]:
    th = yf.Ticker(etf).funds_data.top_holdings
    if th is None or th.empty:
        raise RuntimeError("no holdings")
    out = []
    for sym, row in th.head(10).iterrows():
        sym = str(sym).upper()
        w = round(float(row.get("Holding Percent", 0)) * 100, 1)
        zh, desc = DESC.get(sym, (str(row.get("Name", sym))[:18], ""))
        if sym not in DESC:
            print(f"  ⚠ {etf}: NEW holding {sym} ({row.get('Name','')}) — 請於 DESC 補中文名/說明")
        out.append({"sym": sym, "w": w, "zh": zh, "desc": desc})
    return out


def main() -> None:
    data = {}
    for etf in ETFS:
        try:
            data[etf] = fetch_top10(etf)
            print(f"  {etf}: {len(data[etf])} holdings")
        except Exception as e:
            print(f"  {etf}: failed ({e}) — skipped")
    if not data:
        print("No data fetched — aborting.")
        return
    OUT.write_text(json.dumps({"updated": date.today().isoformat(), "data": data},
                              ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {len(data)} sectors -> {OUT.name}")


if __name__ == "__main__":
    main()
