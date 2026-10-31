// 導覽三層：分類 → 頁 → 視圖。每個視圖就是原本的一個分頁（id、模組與 #tab-<id> section 都不變），
// 同一頁的視圖在頁頂的切換列切換；舊的 #tab=<id> 網址與收藏會打開所屬頁的那個視圖。
// 2026-10-28 依重複盤點把 81 個分頁收成 34 頁，另加「每日總覽」當首頁。
// （原註記的 Financial_work/navigation-groups.json 不在這台機器上，順序與名稱以本檔為準。）
const view = (id, label) => ({ id, label });
export const CATEGORIES = [
  { id: 'home', label: '每日總覽', pages: [
    { id: 'p-overview', label: '每日總覽', views: [view('overview', '每日總覽')] },
  ] },
  { id: 'trend', label: '走勢與技術', pages: [
    { id: 'p-tech', label: '技術分析工作台', views: [
      view('trend', '趨勢'), view('pentagram', '五線譜'), view('position', '位階'),
      view('madev', '乖離率'), view('struct', '結構判讀')] },
    { id: 'p-relstrength', label: '相對強度', views: [
      view('relstrength', 'NDX相對強度'), view('mag7spy', '七巨頭相對強度')] },
    { id: 'p-breadth', label: '市場廣度', views: [
      view('breadth', '市場廣度'), view('twbreadthls', '台股多空家數')] },
  ] },
  { id: 'macro', label: '總經與景氣', pages: [
    { id: 'p-cycle', label: '景氣', views: [view('twcycle', '景氣燈號'), view('macro', '宏觀')] },
    { id: 'p-growth', label: '經濟成長', views: [
      view('usmacro', '美國總經'), view('gdp_productivity_decomp', '美國GDP拆解'),
      view('tw_jp_kr_gdp', '台日韓GDP對照'), view('umich', '消費者信心')] },
    { id: 'p-inflation', label: '通膨', views: [
      view('cpi', 'CPI 分項'), view('infl_nowcast', '通膨Nowcast'), view('inflation', '通膨預期')] },
  ] },
  { id: 'liquidity', label: '利率與流動性', pages: [
    { id: 'p-usdliq', label: '美元流動性', views: [
      view('usdliq', '美元流動性'), view('net_liquidity', '淨流動性'), view('money_market', '貨幣市場')] },
    { id: 'p-globalliq', label: '全球流動性', views: [
      view('central_banks', '全球央行資產'), view('liquidity', '流動性×槓桿')] },
    { id: 'p-rates', label: '利率', views: [
      view('yield_curve', '殖利率曲線'), view('real_rates', '實質利率')] },
  ] },
  { id: 'sentiment', label: '情緒與曝險', pages: [
    { id: 'p-sentiment', label: '情緒總分', views: [view('sentiment', '複合情緒'), view('bullbear', '牛熊')] },
    { id: 'p-positioning', label: '散戶與機構部位', views: [
      view('aaii', '散戶情緒'), view('naaim', '經理人曝險'), view('putcall', 'Put/Call'),
      view('marketstructure', '市場結構')] },
    { id: 'p-twsent', label: '台股情緒', views: [view('twsent', '台股情緒')] },
    { id: 'p-contrarian', label: '反指標', views: [view('banini', '反指標(8zz)')] },
  ] },
  { id: 'risk', label: '波動與風險', pages: [
    { id: 'p-extreme', label: '極端狀態', views: [
      view('nonnormal', '極端狀態儀表板'), view('nonnormalhist', '過往觀察')] },
    { id: 'p-usalert', label: '美股警報', views: [
      view('usrisk', '美股風險觀察'), view('uscap', '美股恐慌拋售警報'),
      view('qqqpanic', 'QQQ恐慌背離回測')] },
    { id: 'p-twmarginalert', label: '台股融資警報', views: [view('marginalert', '台股融資去槓桿警報')] },
    { id: 'p-stress', label: '金融壓力', views: [
      view('stressdash', '壓力總覽'), view('fsi', '金融壓力'), view('nfci', '金融狀況'),
      view('emfsi', '新興市場壓力'), view('twstress', '台股壓力')] },
    { id: 'p-credit', label: '信用', views: [view('credit', '信用')] },
    { id: 'p-vol', label: '波動率', views: [
      view('vixskew', 'VIX-SKEW'), view('vix_term', 'VIX期限結構'),
      view('vvixregime', 'VVIX波動象限'), view('vxnvix', 'VXN-VIX價差')] },
  ] },
  { id: 'flows', label: '籌碼與融資', pages: [
    { id: 'p-radar', label: '美股短線雷達', views: [
      view('flowradar', '資金雷達'), view('qqqradar', 'QQQ短線雷達')] },
    { id: 'p-flows', label: '資金脈衝', views: [view('flows', '資金脈衝')] },
    { id: 'p-twinst', label: '台股法人籌碼', views: [
      view('twchips', '台股籌碼'), view('twforeign', '外資買賣超'),
      view('taifex_foreign_oi', '外資未平倉'), view('twsectorflow', '外資板塊流向')] },
    { id: 'p-twmargin', label: '台股融資', views: [
      view('marginheat', '融資熱度'), view('marginmap', '融資斷頭地圖'), view('marginconc', '融資集中度')] },
    { id: 'p-usmargin', label: '美股與全球融資', views: [
      view('marginpeak', '融資峰值'), view('margincost', '美國融資成本'), view('marginglobal', '全球融資餘額')] },
  ] },
  { id: 'valuation', label: '估值與產業', pages: [
    { id: 'p-valuation', label: '估值', views: [
      view('valuation', '估值'), view('fwdpe', 'Forward P/E 自建'), view('semi_vs_spx_pe', '半導體估值'),
      view('sox_vs_tw_semi_pe', '半導體估值(全球vs台灣)'), view('trendonify_pe', 'Trendonify PE')] },
    { id: 'p-sector', label: '產業輪動', views: [view('sector', '產業輪動')] },
    { id: 'p-earnings', label: '財報日', views: [view('earnings', '財報日')] },
  ] },
  { id: 'strategy', label: '策略與工具', pages: [
    { id: 'p-cashking', label: '現金為王', views: [view('cashking', '現金為王')] },
    { id: 'p-leverage', label: '槓桿工具', views: [
      view('leverage', '槓桿模擬'), view('levvol', '波動率倍數'), view('kelly', '凱利上限')] },
    { id: 'p-signals', label: '訊號回測', views: [
      view('wkrev', '週K反轉'), view('qqqmacd', 'MACD死叉'), view('roc4', 'ROC4急漲急跌')] },
    { id: 'p-season', label: '季節性', views: [
      view('vixseason', 'VIX十年季節性'), view('elecseason', '選舉週期季節性')] },
    { id: 'p-history', label: '歷史對照', views: [view('twcrash', '台股歷史股災'), view('wave', '波浪理論')] },
    { id: 'p-corr', label: '相關係數', views: [view('corr', '相關係數')] },
    { id: 'p-tools', label: '工具箱', views: [view('tools', '工具箱')] },
  ] },
];

export const DEFAULT_TAB = 'overview';

const ALIASES = {
  overview: ['首頁', '總覽', '今日', '警報', '燈號', 'home'],
  usrisk: ["美股去槓桿", "US risk", "CFTC", "FINRA", "科技壓力"],
  nonnormal: ["極端", "極端狀態", "共振", "多重確認", "台股", "費半", "櫃買", "VIX"],
  nonnormalhist: ["過往觀察", "回測", "跌停", "跌停家數", "無觀察", "觀察類股", "極端狀態"],
  uscap: ["US Capitulation", "恐慌", "拋售", "Put/Call", "VIX", "VXN", "止穩", "capitulation"],
  qqqpanic: ["恐慌背離", "盤中急跌", "Fear & Greed", "F&G", "回測", "再破底", "panic divergence"],
  fsi: ['FSI'], nfci: ['NFCI'], cpi: ['CPI'],
  gdp_productivity_decomp: ['GDP'], tw_jp_kr_gdp: ['GDP', '台灣'],
  aaii: ['AAII'], naaim: ['NAAIM'], vixskew: ['VIX'],
  vix_term: ['VIX'], vvixregime: ['VIX'], vxnvix: ['VIX'],
  qqqmacd: ['MACD'], valuation: ['P/E', 'PE'], fwdpe: ['P/E', 'PE'],
  semi_vs_spx_pe: ['P/E', 'PE'], sox_vs_tw_semi_pe: ['P/E', 'PE', '台灣'],
  twsent: ['台灣', '台股'], twstress: ['台灣', '台股'],
  twchips: ['台灣', '台股'], twsectorflow: ['台灣', '台股'],
  twforeign: ['台灣', '台股', '外資', '買賣超', '三大法人'],
  twbreadthls: ['台灣', '台股', '多空', '家數', '紫線', 'breadth'],
  twcycle: ['台灣', '台股'], twcrash: ['台灣', '台股'],
  taifex_foreign_oi: ['台灣', '台股'], marginheat: ['融資', '台灣', '台股'],
  marginpeak: ['融資', '台灣', '台股'], marginconc: ['融資', '台灣', '台股'],
  marginmap: ['融資', '台灣', '台股'],
  marginalert: ['融資', '台灣', '台股', '回測', '去槓桿'],
  margincost: ['融資'], marginglobal: ['融資'],
  qqqradar: ['VXN', '籌碼'],
};

// Keep the sole id-to-file exception beside the labels and categories.
const MODULE_FILE = { twsent: 'twsentiment' };
export const PAGES = CATEGORIES.flatMap(category =>
  category.pages.map(page => ({ ...page, categoryId: category.id, categoryLabel: category.label })));
export const NAV_ITEMS = PAGES.flatMap(page =>
  page.views.map(tab => ({ ...tab, pageId: page.id, pageLabel: page.label,
    categoryId: page.categoryId, categoryLabel: page.categoryLabel,
    modulePath: `./tabs/${MODULE_FILE[tab.id] || tab.id}.js` })));

// 搜尋與清單顯示用：多視圖的頁顯示「頁｜視圖」，視圖名與頁名相同時只顯示一次。
export function itemTitle(item) {
  return item.pageLabel && item.pageLabel !== item.label ? item.pageLabel + '｜' + item.label : item.label;
}

function failedDependency(error, rootURL) {
  const url = String(error?.message || error).match(/(?:https?:\/\/|file:\/\/)[^\s)'"`]+/)?.[0];
  if (!url) return false;
  try { return new URL(url).pathname !== rootURL.pathname; }
  catch { return false; }
}

export function createModuleLoader(item, importer = url => import(url)) {
  const rootURL = new URL(item.modulePath, import.meta.url);
  let loaded = null;
  let pending = null;
  let failures = 0;
  let reloadRequired = false;
  const load = () => {
    if (loaded) return Promise.resolve(loaded);
    if (reloadRequired) return Promise.reject(new Error('模組載入未恢復，請重新載入頁面後再試。'));
    if (pending) return pending;
    const url = new URL(rootURL);
    if (failures) url.searchParams.set('lazyRetry', String(failures));
    pending = Promise.resolve().then(() => importer(url.href)).then(module => {
      loaded = module;
      return module;
    }).catch(error => {
      failures++;
      reloadRequired = failedDependency(error, rootURL) || failures >= 2;
      throw new Error(reloadRequired
        ? `模組或依賴載入失敗，請重新載入頁面後再試：${error.message || error}`
        : `模組載入失敗，請按重試：${error.message || error}`, { cause: error });
    }).finally(() => { pending = null; });
    return pending;
  };
  load.needsReload = () => reloadRequired;
  return load;
}

export function registryEntries() {
  return NAV_ITEMS.map(item => ({ id: item.id, load: createModuleLoader(item) }));
}

export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function searchNavigation(query) {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  if (!words.length) return NAV_ITEMS;
  return NAV_ITEMS.filter(item => {
    const corpus = normalizeSearch([
      item.label, item.id, item.pageLabel, item.categoryLabel, ...(ALIASES[item.id] || []),
    ].join(' '));
    return words.every(word => corpus.includes(word));
  });
}
