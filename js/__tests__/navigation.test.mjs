import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CATEGORIES, NAV_ITEMS, normalizeSearch, searchNavigation } from '../navigation-catalog.mjs';

// Frozen id/label contract from the navigation before the regrouping.
const ORIGINAL_LABELS = {
  "sentiment": "複合情緒",
  "aaii": "散戶情緒",
  "twsent": "台股情緒",
  "bullbear": "牛熊",
  "naaim": "經理人曝險",
  "taifex_foreign_oi": "外資未平倉",
  "twchips": "台股籌碼",
  "umich": "消費者信心",
  "flows": "資金脈衝",
  "banini": "反指標(8zz)",
  "putcall": "Put/Call",
  "flowradar": "資金雷達",
  "liquidity": "流動性×槓桿",
  "marginheat": "融資熱度",
  "breadth": "市場廣度",
  "fsi": "金融壓力",
  "nfci": "金融狀況",
  "emfsi": "新興市場壓力",
  "stressdash": "壓力總覽",
  "twstress": "台股壓力",
  "vixskew": "VIX-SKEW",
  "vxnvix": "VXN-VIX價差",
  "inflation": "通膨預期",
  "credit": "信用",
  "net_liquidity": "淨流動性",
  "usdliq": "美元流動性",
  "margincost": "美國融資成本",
  "marginglobal": "全球融資餘額",
  "yield_curve": "殖利率曲線",
  "vix_term": "VIX期限結構",
  "vixseason": "VIX十年季節性",
  "real_rates": "實質利率",
  "money_market": "貨幣市場",
  "central_banks": "全球央行資產",
  "infl_nowcast": "通膨Nowcast",
  "cpi": "CPI 分項",
  "trend": "趨勢",
  "pentagram": "五線譜",
  "macro": "宏觀",
  "usmacro": "美國總經",
  "twcrash": "台股歷史股災",
  "valuation": "估值",
  "fwdpe": "Forward P/E 自建",
  "position": "位階",
  "struct": "結構判讀",
  "relstrength": "NDX相對強度",
  "mag7spy": "七巨頭相對強度",
  "marginmap": "融資斷頭地圖",
  "kelly": "凱利上限",
  "madev": "乖離率",
  "twcycle": "景氣燈號",
  "tools": "工具箱",
  "corr": "相關係數",
  "sector": "產業輪動",
  "twsectorflow": "外資板塊流向",
  "cashking": "現金為王",
  "earnings": "財報日",
  "wave": "波浪理論",
  "elecseason": "選舉週期季節性",
  "leverage": "槓桿模擬",
  "levvol": "波動率倍數",
  "wkrev": "週K反轉",
  "qqqmacd": "MACD死叉",
  "marginpeak": "融資峰值",
  "marginconc": "融資集中度",
  "vvixregime": "VVIX波動象限",
  "roc4": "ROC4急漲急跌",
  "gdp_productivity_decomp": "美國GDP拆解",
  "semi_vs_spx_pe": "半導體估值",
  "tw_jp_kr_gdp": "台日韓GDP對照",
  "sox_vs_tw_semi_pe": "半導體估值(全球vs台灣)",
  "marketstructure": "市場結構"
};

const ids = query => searchNavigation(query).map(item => item.id);

test('all original screens occur once with unchanged labels', () => {
  assert.equal(CATEGORIES.length, 8);
  assert.equal(NAV_ITEMS.length, 72);
  assert.equal(new Set(NAV_ITEMS.map(item => item.id)).size, 72);
  assert.deepEqual(Object.fromEntries(NAV_ITEMS.map(item => [item.id, item.label])), ORIGINAL_LABELS);
  assert.deepEqual(ids(''), NAV_ITEMS.map(item => item.id));
  for (const item of NAV_ITEMS) {
    assert.equal(existsSync(new URL('../' + item.modulePath.replace(/^\.\//, ''), import.meta.url)), true, item.id);
    assert.match(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
      new RegExp('id="tab-' + item.id + '"'), item.id);
  }
});

test('search handles names, ids, category context, aliases, case and spaces', () => {
  assert.equal(normalizeSearch('  FSI  GDP '), 'fsi gdp');
  for (const [query, expected] of [
    ['FSI', 'fsi'], ['NFCI', 'nfci'], ['CPI', 'cpi'], ['GDP', 'gdp_productivity_decomp'],
    ['AAII', 'aaii'], ['NAAIM', 'naaim'], ['VIX', 'vixskew'], ['MACD', 'qqqmacd'],
    ['P/E', 'fwdpe'], ['P/E', 'valuation'], ['台灣', 'twsent'], ['台股', 'twchips'],
    ['台股', 'marginheat'], ['台股', 'marginpeak'], ['台股', 'marginconc'],
    ['台股', 'marginmap'], ['融資', 'marginheat'],
    ['  美 國  GDP ', 'gdp_productivity_decomp'],
  ]) assert.ok(ids(query).includes(expected), query);
  assert.equal(ids('P/E 台灣').includes('sox_vs_tw_semi_pe'), true);
  assert.deepEqual(ids('no-such-screen'), []);
  assert.equal(new Set(ids('融資')).size, ids('融資').length);
});
