// 極端狀態儀表板 — 每週一次的多重確認儀表板（描述性，不是買賣訊號）。
// 引擎：js/tabs/nonnormal_calc.mjs（與 scripts/research/backtest_nonnormal.mjs 共用）。
// 版面：等級橫幅 → 報價卡（最新值、日漲跌、近 6 個月走勢＋50／100 日均線，亮燈卡加紅框；點卡片開大圖；六個股市卡另列 50／100 日線下彎，不計分）→ 資金流向（現金為王，
// 與 cashking 頁共用 cashking_calc.mjs）→ 共振歷史圖 → 時間差 → 位階與分批（五格、水溫、三批，不計分）→ 轉機；
// 案例回測與閾值來源收在頁尾 <details>，打開才算。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { infoButton, initInfoPopovers } from '../utils/info_popover.js';
import { CK_ASSETS } from '../state.js';
import * as N from './nonnormal_calc.mjs';
import { computeCKWeekly, ckWeeklyCloses, ckWeekStart } from './cashking_calc.mjs';

const byId = id => document.getElementById('nonnormal-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const LEVEL_COLORS = ['#3fb950', '#e3b341', '#f0883e', '#ef4444'];
const REQUIRED = ['TWII', 'SPX', 'VIX'];
const CHECK_KEY = 'nonnormal-checklist-v1';
const SVG = 'http://www.w3.org/2000/svg';
const MAS = [50, 100];
const DOUBLE_TAP_MS = 500;

const HELP = {
  level: '0–1 個亮：常態（單一訊號視為雜訊）｜2–3：留意｜≥4 且橫跨 ≥2 組：警戒｜≥6 且三組都亮：高度警戒。每週五評估，本週未結束時用最新資料日。',
  downturn: '卡片下方「50MA／100MA」：均線下彎＝今天的均線值低於前一個交易日。日期＝從近半年均線高點開始下彎的那天，「連 N 日」＝目前連續下彎幾個交易日（中間翻上一天就重算）。兩條同時下彎連續 ≥ 5 個交易日標「持續」（5 日門檻取自回測樣本）。只是預警，不計入上方亮燈數與等級。歷史上短暫下彎（5 日內翻回）多半是雜訊，連續較久才常伴隨較深的回落（2010 起 SOXX／QQQ／VOO／道瓊回測，13 個案例，門檻取自同一批樣本）。',
  leadlag: '櫃買先跌破、加權未破：先提高警覺。加權破、櫃買抗跌：中小型股開始有信心。',
  stance: '大跌時用來判斷「跌多深、到第幾批」，平常大多是空的。五格：定位＝加權水溫是不是極冷；位置＝加權離 5 年線 3% 以內或跌破；壓力＝融資維持率（上市／上櫃取低者）近 30 日低於 150%；情緒＝VIX 近 30 日盤中最高 ≥ 30、近 22 個交易日無觀察類股 ≥ 3 天、或近 30 日有一天跌停 ≥ 300 家（任一）；外部＝費半／那斯達克／S&P 500／韓股至少 2 個轉弱，或護盤基金進場。亮 1 格提高警覺，3–4 格才算強烈訊號。水溫：10 日、10 週、10 月三條均線的方向＋價格離 10 月線多遠。兩端用各市場自己的歷史：過熱線＝當時以前離 10 月線最遠的 5%（95% 分位），三線上揚且站上＝過熱；極冷線＝低於 10 月線最深的 15%（15% 分位），三線下彎且跌破＝極冷（兩者校準成各約占 5% 的時間）。中間：±3% 內＝盤整；站上且 10 月線上揚＝偏熱；跌破或 10 月線下彎＝偏冷。2／5／10 年線用月線 24／60／120 個月均線，收盤不高於均線 3% 就算「到」。三批是給指數的分批節奏（20／30／50，越跌越買、最後一批最大）：每批的條件逐項列出，可判斷的條件有 ≥ 75% 成立＝到位、≥ 50%＝接近。歷史上條件很少全部同時成立。',
  tempchart: '每週一筆（各市場該週最後一個交易日）。上：實線＝價格，橘色虛線＝10 月線（最近 10 個月的月底收盤平均，這個月用最新收盤代替，所以月中只會小幅移動、換月時才明顯跳一格；可以當 40 週線看：2003 起加權、S&P 500、韓股兩者平均只差約 0.7%，±3% 分區約 96% 的日子相同），底色＝當週水溫。中：價格離 10 月線多少 %。紅色虛線＝過熱線、藍色虛線＝極冷線，用該市場「當時以前」的歷史分位算，所以會隨時間移動；灰帶＝±3% 盤整。站到線外還要三條均線同方向才算過熱／極冷，所以線外側的顏色和上方底色偶爾不一致。下：六個市場的水溫，看是不是一起變冷。上方按鈕切換市場與期間，也可以拖拉下方滑桿。',
  cash: '現金為王（izaax，同「現金為王」頁）：4 或 8 週內黃金、比特幣、美債 TLT、QQQ 全部下跌，且恐懼貪婪低點 < 25。逃往黃金：其他都跌、只有黃金漲，且恐懼貪婪 < 25。同一期間誰漲最多＝資金往哪裡去。',
};

// 報價卡：[序列, 名稱, 對應訊號, 格式]。格式 px＝價格、yield＝殖利率（漲跌用 bp）、ratio＝百分比（漲跌用百分點）、score＝0–100 分數（漲跌用點）、
// count＝家數、days＝天數（這兩種不畫均線）。
const CARD_GROUPS = [
  { group: 'A', title: '國際股市', cards: [['SOX', '費半', 'sox'], ['NDX', '那斯達克', 'ndx'], ['SPX', 'S&P 500', 'spx'], ['KOSPI', '韓股', 'kospi']] },
  { group: 'B', title: '金融市場', cards: [['US10Y', '美債 10Y', 'us10y', 'yield'], ['DXY', '美元指數', 'dxy'], ['GOLD', '黃金', 'gold'], ['OIL', '布蘭特原油', 'oil'], ['VIX', 'VIX', 'vix'], ['VXN', 'VXN'], ['FG', '恐懼貪婪', null, 'score'], ['BTC', '比特幣']] },
  { group: 'C', title: '台股內部', cards: [['TWII', '加權'], ['TWOII', '櫃買', 'otc'], ['MARGIN', '上市融資維持率', 'margin', 'ratio'], ['MARGIN_OTC', '上櫃融資維持率', 'margin', 'ratio'], ['BREADTH_PCT', '台股市場廣度', 'breadth', 'ratio'], ['LIMIT_DOWN', '跌停家數', null, 'count'], ['NO_OBS', '無觀察類股', null, 'days']] },
  { group: null, title: '參考（不計分）', cards: [['N225', '日經 225'], ['HSI', '恆生'], ['SSE', '上證'], ['STOXX50E', '歐股 50'], ['US2Y', '美債 2Y', null, 'yield'], ['US_BREADTH', '美股市場廣度', null, 'ratio']] },
];
// 卡片上的英文代號（實際用的標的；指標類用通用簡稱）
const TICKERS = { SOX: 'SOXX', NDX: 'QQQ', SPX: 'VOO', KOSPI: 'KOSPI', US10Y: 'US10Y', DXY: 'DXY', GOLD: 'GC=F', OIL: 'BZ=F', VIX: 'VIX', VXN: 'VXN',
  FG: 'F&G', BTC: 'BTC', TWII: 'TAIEX', TWOII: 'TPEX', MARGIN: 'TWSE', MARGIN_OTC: 'TPEX', BREADTH_PCT: 'TW Breadth', US_BREADTH: 'SPY', LIMIT_DOWN: 'TWSE+TPEx', NO_OBS: 'TWSE+TPEx',
  N225: 'N225', HSI: 'HSI', SSE: 'SSE', STOXX50E: 'SX5E', US2Y: 'US2Y' };
const CARD_BY_SERIES = new Map(CARD_GROUPS.flatMap(g => g.cards.map(c => [c[0], c])));
// 點卡片的大圖左欄：為什麼把這張圖放進儀表板（本專案整理，用自己的話寫）
const REASONS = {
  SOX: '台股權重最大的是半導體。費半是電子股的領先指標，急跌常在隔天反映到台股。',
  NDX: '美國科技股的資金風向。台股電子供應鏈的終端需求和評價跟著它走。',
  SPX: '全球風險偏好的基準。大跌時外資通常同步減碼新興市場，台股也在其中。',
  KOSPI: '韓股和台股一樣是出口、半導體權重高的市場。韓股先轉弱而台股還沒跌，常是提前警訊。',
  US10Y: '全球資產定價的折現率。短時間快速上升會壓縮科技股估值。',
  DXY: '美元走強＝資金回流美國，新興市場的外資賣壓跟著增加。',
  GOLD: '要分兩種：恐慌型急漲（同時 VIX 偏高）是避險需求；通膨型的緩漲不算風險訊號。',
  OIL: '雙面訊號：急漲推升通膨與成本，急跌可能代表需求轉弱。',
  VIX: '美股的恐慌溫度計。20 以上開始不安、30–40 恐慌，也是轉機觀察的工具。',
  VXN: '那斯達克版的 VIX，看科技股的恐慌程度，比 VIX 更貼近台股電子股。',
  FG: 'CNN 恐懼貪婪指數，0 極度恐懼～100 極度貪婪，用 7 個美股指標合成。低於 25 是「現金為王」判斷用的恐慌門檻。',
  BTC: '投機資金與流動性的溫度計，也是「現金為王」判斷的四檔之一。',
  TWII: '大盤本身，用來對照櫃買和廣度：加權撐住、其他先破，才看得出誰先轉弱。',
  TWOII: '中小型股、散戶與融資比重高，常比加權先轉弱。櫃買先破線、加權還沒破時要提高警覺。',
  MARGIN: '散戶槓桿的壓力表。越低代表越多人接近追繳，跌到斷頭區時反而常是低點附近。',
  MARGIN_OTC: '上櫃散戶融資比重更高、波動更大，常比上市先出事。本站 2026-08-24 起才有資料。',
  BREADTH_PCT: '台股偏多家數占比（偏多／偏多＋偏空）。指數上漲但多數個股不漲＝廣度收窄，上漲只靠少數權值股撐著。',
  LIMIT_DOWN: '上市＋上櫃股票當天收在跌停的家數。平常個位數到幾十家；幾百家以上代表恐慌性賣壓，2025-04-07 有 1,702 家。只顯示，不計分；會用在下方「情緒」那一格。',
  NO_OBS: '近 22 個交易日（約一個月）中，盤面完全沒有「觀察類股」的天數。觀察類股看的是個股的「第一根且帶大量」：當天上漲、收盤創近 20 日新高、成交量 ≥ 2 倍 10 日均量（且達全市場日均量的萬分之 2，約 1,000 張）。全市場（上市＋上櫃）這類股票的比例落在過去一年最低 4%＝無觀察類股日。不看族群、也不是只看 0050。算法與 2013 起的回測見「過往觀察」頁。整天找不到代表市場沒有新的強勢股；1 天提高注意、3 天以上可開始分批、5 天以上極度恐慌。',
  US_BREADTH: 'S&P 500（SPY）成分股中，股價站上 200 日線的比例。低於 50% 代表多數美股已轉弱，可對照台股廣度看是不是全球一起收窄。',
  N225: '第三層以後的市場，用來確認是不是全球同步轉弱。',
  HSI: '中港資金與中國景氣的溫度計，用來確認是不是全球同步轉弱。',
  SSE: '中國內需與政策的溫度計，用來確認是不是全球同步轉弱。',
  STOXX50E: '歐洲大型股，用來確認是不是全球同步轉弱。',
  US2Y: '和 10Y 比較看殖利率曲線：2Y 高於 10Y（倒掛）是長循環訊號，只註記不計分。',
};
// 大圖的參考線（訊號門檻）
const REF_LINES = { vix: [20, 30], margin: [150, 130], breadth: [50], FG: [25, 75], US_BREADTH: [50], LIMIT_DOWN: [N.NO_OBS.limitDownExtreme], NO_OBS: [N.NO_OBS.start, 5] };   // 訊號 id，或不計分卡片的序列 id
// 資金流向：現金為王的 4 檔（state.js CK_ASSETS）＋ SPY 只顯示
const CASH_LABELS = { GLD: '黃金（GLD）', BTC: '比特幣', TLT: '美債（TLT）', QQQ: 'QQQ', SPY: 'SPY' };
const CASH_ASSETS = [...CK_ASSETS, { key: 'SPY', color: '#a371f7', file: 'data/SPY.json', displayOnly: true }];

let ctx = null, loadedAt = 0, missing = [], weeks = [], charts = [], rangeKey = '3y', generation = 0;
let ck = null, cashWin = 4, detail = null;   // ck = { raw, rows }；charts[0] 共振史、[1] 大圖、[2] 資金流向、[3] 水溫走勢

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function table(id, headers, rows) {
  const t = node('table', null, { class: 'info-table' }), thead = node('thead'), htr = node('tr'), body = node('tbody');
  for (const h of headers) htr.append(node('th', h));
  thead.append(htr);
  for (const row of rows) {
    const tr = node('tr');
    row.forEach((v, i) => { const cell = node(i === 0 ? 'th' : 'td'); if (v instanceof Node) cell.append(v); else cell.textContent = v ?? '—'; tr.append(cell); });
    body.append(tr);
  }
  t.append(thead, body);
  byId(id).replaceChildren(t);
}

// ── data ────────────────────────────────────────────────────────────────
async function load(context = {}) {
  const files = [...N.SERIES.map(s => [s.id, s.file]), ...Object.entries(N.EXTRA_FILES)];
  const got = await Promise.all(files.map(async ([key, file]) => {
    try { return [key, (await requestJSON('data/' + file, { signal: context.signal }))?.data || []]; } catch (e) {
      if (context.signal?.aborted || REQUIRED.includes(key)) throw e;
      missing.push(file); return [key, []];
    }
  }));
  const ckGot = await loadCash(context);
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  ctx = N.buildContext(Object.fromEntries(got));
  ck = ckGot;
  if (!ctx.lastDate) throw new Error('沒有可用的加權／S&P 500 資料');
  weeks = N.history(ctx, '2007-08-03');
  return true;
}

/** 現金為王的資料：與 cashking.js 同樣的清理（close > 0、F&G 有數值）。任一缺檔 → null（面板顯示無資料）。 */
async function loadCash(context) {
  try {
    const files = [...CASH_ASSETS.map(a => [a.key, a.file]), ['F&G', 'data/fear_greed.json']];
    const raw = Object.fromEntries(await Promise.all(files.map(async ([key, file]) => {
      const rows = (await requestJSON(file, { signal: context.signal }))?.data || [];
      return [key, key === 'F&G'
        ? rows.filter(r => typeof r?.date === 'string' && Number.isFinite(r.value)).map(r => [r.date, r.value])
        : rows.filter(r => typeof r?.date === 'string' && Number.isFinite(r.close) && r.close > 0).map(r => [r.date, r.close])];
    })));
    return { raw, rows: computeCKWeekly(raw, CK_ASSETS, '2014-10-01') };
  } catch (e) {
    if (context.signal?.aborted) throw e;
    missing.push('現金為王資料');
    return null;
  }
}

// ── banner ──────────────────────────────────────────────────────────────
function renderSummary(now, prev) {
  const name = id => N.SIGNALS.find(s => s.id === id).short;
  const added = prev ? now.lit.filter(id => !prev.lit.includes(id)) : [], removed = prev ? prev.lit.filter(id => !now.lit.includes(id)) : [];
  const parts = [`${now.count}/${now.available} 亮・${now.groups} 組`];
  if (now.available < N.SIGNALS.length / 2) parts.push(`⚠ 只有 ${now.available} 個可評估`);
  if (prev) parts.push(`上週 ${N.LEVELS[prev.level].label}（${prev.count}）${added.length ? ` +${added.map(name).join('、')}` : ''}${removed.length ? ` −${removed.map(name).join('、')}` : ''}`);
  const el = node('div', null, { class: 'nonnormal-banner' });
  el.style.borderColor = LEVEL_COLORS[now.level];
  const lv = node('span', N.LEVELS[now.level].label, { class: 'nonnormal-banner-level' });
  lv.style.color = LEVEL_COLORS[now.level];
  el.append(lv, node('span', parts.join('｜'), { class: 'nonnormal-banner-sub' }), infoButton(HELP.level, '說明：等級'));
  byId('summary').replaceChildren(el);
}

// ── quote cards ─────────────────────────────────────────────────────────
const signed = (x, d) => `${x > 0 ? '+' : ''}${x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pxDigits = v => (Math.abs(v) >= 10000 ? 0 : 2);
function fmtValue(v, kind) {
  if (kind === 'yield') return v.toFixed(2) + '%';
  if (kind === 'ratio') return v.toFixed(1) + '%';
  if (kind === 'score') return v.toFixed(0);
  if (kind === 'count') return `${v.toLocaleString('en-US')} 家`;
  if (kind === 'days') return `${v} 天`;
  return v.toLocaleString('en-US', { minimumFractionDigits: pxDigits(v), maximumFractionDigits: pxDigits(v) });
}
/** Day/week change text: price → "+12.3 +0.45%"; yield → "+3bp"; ratio → "+1.2"（百分點）; score → "-7.4"（點）. pctOnly drops the absolute part. */
function fmtChange(abs, rel, kind, ref, pctOnly = false) {
  if (!finite(abs)) return '—';
  if (kind === 'yield') return `${signed(Math.round(abs * 100), 0)}bp`;
  if (kind === 'ratio' || kind === 'score') return signed(abs, 1);
  if (kind === 'count' || kind === 'days') return signed(abs, 0);
  const p = finite(rel) ? signed(rel * 100, 2) + '%' : '';
  return pctOnly ? p || '—' : `${signed(abs, pxDigits(ref))} ${p}`.trim();
}
const NO_MA = new Set(['count', 'days']);
const dirClass = x => (!finite(x) || x === 0 ? 'nonnormal-flat' : x > 0 ? 'nonnormal-up' : 'nonnormal-down');

function sparkline(q, noMa = false) {
  const W = 120, H = 40, n = q.close.length;
  const vals = [...q.close, ...(noMa ? [] : MAS.flatMap(k => q.ma[k]))].filter(finite);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // x 依日期：資料比 6 個月短（例如上櫃維持率 2026-08-24 起）時只畫在右側，不拉滿整個寬度
  const t0 = Date.parse(q.from), t1 = Date.parse(q.dates.at(-1)), span = t1 - t0 || 1;
  const x = i => ((Date.parse(q.dates[i]) - t0) / span) * W, y = v => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  const path = arr => {
    let d = '', pen = false;
    arr.forEach((v, i) => { if (!finite(v)) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'nonnormal-spark');
  svg.setAttribute('aria-hidden', 'true');
  const line = path(q.close);
  const add = (cls, d) => { if (!d) return; const p = document.createElementNS(SVG, 'path'); p.setAttribute('class', cls); p.setAttribute('d', d); svg.append(p); };
  add('area', line && `${line}L${x(n - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`);
  if (!noMa) { add('ma100', path(q.ma[100])); add('ma50', path(q.ma[50])); }
  add('px', line);
  return svg;
}

function quoteCard([id, name, sigId, kind = 'px'], now) {
  const q = N.quote(ctx.s[id], now.date, { mas: MAS });
  const sig = sigId ? now.signals.find(s => s.id === sigId) : null;
  let state = sig?.state || null;
  if (sigId === 'margin' && state === 'on' && !(q && !q.stale && q.last < N.P.margin[1])) state = 'off';   // 只把低於 150% 的那個市場標亮
  const usable = q && !q.stale;
  const el = node('article', null, { class: `nonnormal-q${state === 'on' ? ' nonnormal-q--on' : ''}${!usable ? ' nonnormal-q--na' : ''}`, 'data-series': id, tabindex: '0', role: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${name}：開啟大圖與說明` });
  if (sigId) el.dataset.signal = sigId;
  el.title = '點兩下：大圖與說明';
  const head = node('div', null, { class: 'nonnormal-q-head' });
  const title = node('span', null, { class: 'nonnormal-q-title' });
  title.append(node('span', name, { class: 'nonnormal-q-name' }), node('span', TICKERS[id] || '', { class: 'nonnormal-q-tk' }));
  head.append(title, node('span', 'ⓘ', { class: 'nonnormal-q-hint', 'aria-hidden': 'true' }));
  if (state === 'on') head.append(node('span', '亮', { class: 'nonnormal-q-flag' }));
  else if (sig && state === 'na') head.append(node('span', '無資料', { class: 'nonnormal-q-flag nonnormal-q-flag--na' }));
  el.append(head);
  if (!q) { el.append(node('div', '—', { class: 'nonnormal-q-val' }), node('p', sig?.reason || '尚無資料', { class: 'nonnormal-q-foot' })); return el; }
  el.append(node('div', fmtValue(q.last, kind), { class: 'nonnormal-q-val ' + dirClass(q.chg) }),
    node('div', fmtChange(q.chg, q.chgPct, kind, q.last), { class: 'nonnormal-q-chg ' + dirClass(q.chg) }),
    sparkline(q, NO_MA.has(kind)));
  const foot = node('p', null, { class: 'nonnormal-q-foot' });
  foot.append(q.stale ? `資料停在 ${q.date}` : `週 ${fmtChange(q.w1, q.w1Pct, kind, q.last, true)}`);
  if (state === 'on' && sig.tags.length) foot.append('・', node('b', sig.tags.join('・')));
  el.append(foot);
  if (DOWNTURN_IDS.has(id) && !q.stale) { const dt = downturnLine(N.maDownturn(ctx.s[id], now.date)); if (dt) el.append(dt); }
  return el;
}

// ── 均線下彎（六個股市卡，不計分）────────────────────────────────────────
const DOWNTURN_IDS = new Set(N.DOWNTURN.markets.map(m => m[0]));
const md = date => { const [, mo, da] = date.split('-'); return `${+mo}/${+da}`; };
function downturnLine(r) {
  if (!r || r.stale) return null;
  const el = node('div', null, { class: 'nonnormal-q-dt' });
  for (const k of N.DOWNTURN.mas) {
    const m = r.ma[k], row = node('span', null, { class: 'nonnormal-q-dt-row' });
    row.append(node('span', `${k}MA`, { class: 'nonnormal-q-dt-k' }), ' ');
    if (m.run > 0) {
      const v = node('span', null, { class: 'nonnormal-dt-on' });   // 兩段各自不斷行，窄卡只在中間換行
      v.append(node('span', `↓${md(m.fromHigh?.date || m.since)}起`), ' ', node('span', `連${m.run}日`));
      row.append(v);
    } else row.append('未下彎');
    el.append(row);
  }
  if (r.sustained) el.append(node('span', `兩線同彎 ${r.bothRun} 日・持續`, { class: 'nonnormal-dt-sus' }));
  return el;
}
/** 大圖左欄的下彎說明：起跌日（近半年均線高點後一天）與目前連續天數分開寫。 */
function downturnText(r) {
  if (!r || r.stale) return null;
  const lines = N.DOWNTURN.mas.map(k => {
    const m = r.ma[k];
    if (m.run === 0) return `${k}MA 未下彎`;
    const from = m.fromHigh?.date || m.since;
    return `${k}MA ${md(from)} 起跌・連 ${m.run} 日${from === m.since ? '' : `（${md(m.since)} 起；中間曾翻上）`}`;
  });
  if (r.bothRun > 0) lines.push(`兩線同彎 ${r.bothRun} 日${r.sustained ? '・持續' : ''}`);
  return lines;
}

function renderCards(now) {
  const legend = node('span', null, { class: 'nonnormal-legend' });
  legend.append(node('span', '點兩下卡片：大圖與說明', { class: 'nonnormal-legend-hint' }), node('span', '近 6 個月'));
  for (const [cls, text] of [['px', '收盤'], ['ma50', '50MA'], ['ma100', '100MA']]) { const s = node('span'); s.append(node('i', null, { class: 'nonnormal-key--' + cls }), text); legend.append(s); }
  byId('cards').replaceChildren(...CARD_GROUPS.flatMap(({ group, title, cards }, gi) => {
    const head = node('div', null, { class: 'nonnormal-group-head' });
    const h = node('h3', title);
    if (group) {
      const sig = now.signals.filter(s => s.group === group);
      h.append(node('span', `${sig.filter(s => s.state === 'on').length}/${sig.length} 亮`, { class: 'nonnormal-group-count' }));
    }
    if (cards.some(c => DOWNTURN_IDS.has(c[0]))) h.append(' ', infoButton(HELP.downturn, '說明：均線下彎'));
    head.append(h);
    if (gi === 0) head.append(legend);
    const grid = node('div', null, { class: 'nonnormal-cards' });
    grid.append(...cards.map(c => quoteCard(c, now)));
    return [head, grid];
  }));
}

// ── detail dialog（點卡片：同樣半年，但用完整座標與 tooltip 看精確值）────────
const valueFmt = (kind, ref) => v => (!finite(v) ? '—' : kind === 'yield' ? v.toFixed(2) + '%' : kind === 'ratio' ? v.toFixed(1) + '%' : kind === 'score' ? v.toFixed(1)
  : NO_MA.has(kind) ? Math.round(v).toLocaleString('en-US')
  : v.toLocaleString('en-US', { minimumFractionDigits: pxDigits(ref), maximumFractionDigits: pxDigits(ref) }));
function openDetail(def) {
  detail = def;
  const dlg = byId('dialog');
  if (!dlg.open) dlg.showModal();
  drawDetail();
}
function drawDetail() {
  const dlg = byId('dialog');
  if (!detail || !dlg.open || !ctx) return;
  const [id, name, sigId, kind = 'px'] = detail, now = weeks.at(-1);
  const q = N.quote(ctx.s[id], now.date, { mas: MAS }), sig = sigId ? now.signals.find(x => x.id === sigId) : null;
  byId('dialog-title').replaceChildren(name, TICKERS[id] ? node('small', ` ${TICKERS[id]}`, { class: 'nonnormal-dialog-tk' }) : '');
  const sub = byId('dialog-sub');
  sub.replaceChildren();
  if (q) {
    sub.append(node('b', fmtValue(q.last, kind), { class: dirClass(q.chg) }), ' ', node('span', fmtChange(q.chg, q.chgPct, kind, q.last), { class: dirClass(q.chg) }), node('span', `　${q.date}`, { class: 'nonnormal-flat' }));
  } else sub.textContent = '尚無資料';
  const state = renderWhy(id, sigId, sig);
  sub.append(' ', node('span', state[0], { class: 'nonnormal-why-state nonnormal-why-state--' + state[1] }));
  if (!q) { charts[1]?.clear(); return; }
  if (!charts[1]) charts[1] = echarts.init(byId('dialog-chart'), isLight() ? null : 'dark');
  const fmt = valueFmt(kind, q.last);
  const lines = (REF_LINES[sigId] || REF_LINES[id] || []).map(v => ({ yAxis: v, label: { formatter: fmt(v), color: PALETTE.muted, fontSize: 11 } }));
  // 六個股市：在對應均線上標起跌日（近半年高點後一天）
  const dt = DOWNTURN_IDS.has(id) ? N.maDownturn(ctx.s[id], now.date) : null;
  const turn = (k, color) => {
    const date = dt && !dt.stale && dt.ma[k].run > 0 ? (dt.ma[k].fromHigh?.date || dt.ma[k].since) : null;
    return date && q.dates.includes(date) ? { silent: true, symbol: 'none', lineStyle: { type: 'dotted', color, width: 1.2 },
      label: { formatter: `${k}MA 起跌 ${md(date)}`, color, fontSize: 11, position: k === 50 ? 'insideEndTop' : 'insideStartTop' }, data: [{ xAxis: date }] } : undefined;
  };
  const line = (name, data, color, width, extra = {}) => ({ name, type: 'line', data, showSymbol: false, connectNulls: false, lineStyle: { width, color }, itemStyle: { color }, ...extra });
  chartOption(1, {
    animation: false,
    legend: { top: 0, right: 0, textStyle: { color: PALETTE.muted, fontSize: 12 }, data: NO_MA.has(kind) ? [] : ['收盤', '50MA', '100MA'] },
    grid: { left: 8, right: 16, top: 30, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: fmt },
    xAxis: { type: 'category', data: q.dates, boundaryGap: false, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => v.slice(5) } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: fmt }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [
      line('收盤', q.close, PALETTE.text, 1.6, { areaStyle: { opacity: 0.06 }, markLine: lines.length ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#ef4444' }, data: lines } : undefined }),
      ...(NO_MA.has(kind) ? [] : [line('50MA', q.ma[50], '#e3b341', 1.2, { markLine: turn(50, '#e3b341') }), line('100MA', q.ma[100], '#58a6ff', 1.2, { markLine: turn(100, '#58a6ff') })]),
    ],
  });
}
/** 大圖左欄：為什麼看這個、怎麼算亮燈、現在的數值。回傳狀態 [文字, class] 給標題列顯示。 */
function renderWhy(id, sigId, sig) {
  const def = sigId ? N.SIGNALS.find(x => x.id === sigId) : null, why = byId('dialog-why');
  const state = !def ? ['只顯示，不計分', 'ref'] : sig?.state === 'on' ? ['亮燈', 'on'] : sig?.state === 'na' ? ['無資料', 'na'] : ['未亮', 'off'];
  const sec = (title, ...kids) => { const el = node('section'); el.append(node('h4', title), ...kids); return el; };
  const parts = [sec('為什麼看這個', node('p', REASONS[id] || '—'))];
  if (sig?.text || sig?.reason) parts.push(sec('現在', node('p', sig.text || sig.reason)));
  const dt = DOWNTURN_IDS.has(id) && downturnText(N.maDownturn(ctx.s[id], weeks.at(-1).date));
  if (dt) { const el = sec('均線下彎（不計分）', node('p', dt.join('｜'))); el.className = 'nonnormal-why-dt'; parts.push(el); }
  if (def) {
    const ul = node('ul', null, { class: 'nonnormal-why-list' });
    for (const [text] of def.thresholds) ul.append(node('li', text));
    parts.splice(1, 0, sec('怎麼算亮燈', node('p', def.rule), ul));
  }
  why.replaceChildren(...parts);
  return state;
}
function chartOption(i, option) {
  charts[i].setOption(echartsBase(option), { notMerge: true });
  charts[i].resize();
}

// ── 資金流向（現金為王）──────────────────────────────────────────────────
const CASH_WINDOWS = { 1: 'weekRets', 4: 'cum4Rets', 8: 'cum8Rets' };
/** Returns of each cash asset over the last k weeks, on the same Monday-keyed weekly closes as the cashking page. */
function cashReturns(k) {
  const rows = ck.rows, last = rows.at(-1), base = rows.at(-1 - k);
  const out = CK_ASSETS.map(a => ({ key: a.key, color: a.color, ret: last[CASH_WINDOWS[k]][a.key] }));
  const spy = ckWeeklyCloses(ck.raw.SPY), a = spy[last.w], b = base ? spy[base.w] : null;
  out.push({ key: 'SPY', color: CASH_ASSETS.at(-1).color, ret: a && b ? a / b - 1 : null });
  return out.sort((x, y) => (y.ret ?? -Infinity) - (x.ret ?? -Infinity));
}
/** 10Y 殖利率在 TLT 同一段期間（基準週最後交易日 → 最新週最後交易日）的變化（bp）。10Y 比 TLT 晚一天公布時，到 10Y 最新一天為止。 */
function tenYearBp(k) {
  const rows = ck.rows, y10 = ctx.s.US10Y, base = rows.at(-1 - k);
  if (!base || !y10?.dates?.length) return null;
  const dayOf = {};
  for (const [d] of ck.raw.TLT || []) dayOf[ckWeekStart(d)] = d;
  const from = dayOf[base.w], to = dayOf[rows.at(-1).w];
  if (!from || !to) return null;
  const i = N.indexLE(y10, to), j = N.indexLE(y10, from);
  if (i < 0 || j < 0 || i <= j) return null;
  return { bp: Math.round((y10.close[i] - y10.close[j]) * 100), asOf: y10.dates[i], lag: y10.dates[i] < to };
}
function cashState(win) {
  const last = ck.rows.at(-1), n = CK_ASSETS.length, rets = last[win === 8 ? 'cum8Rets' : 'cum4Rets'];
  const down = last[win === 8 ? 'cum8Down' : 'cum4Down'], fg = last[win === 8 ? 'fgMin8w' : 'fgMin4w'], fear = fg != null && fg < 25;
  const ups = CK_ASSETS.filter(a => rets[a.key] > 0).map(a => CASH_LABELS[a.key]);
  const badge = down === n && fear ? ['現金為王', 'king'] : last[win === 8 ? 'ftg8w' : 'ftg4w'] && fear ? ['逃往黃金', 'gold'] : null;
  return { text: `${win} 週：${down}/${n} 跌${ups.length && ups.length < n ? `，只有${ups.join('、')}漲` : ''}｜恐懼貪婪低點 ${fg != null ? fg.toFixed(0) : '—'}`, badge };
}
function renderCash() {
  const host = byId('cash-state');
  if (!ck?.rows?.length) { host.textContent = '現金為王資料無法載入'; byId('cash-rank').replaceChildren(); return; }
  host.replaceChildren(...[4, 8].map(win => {
    const st = cashState(win), el = node('div', null, { class: 'nonnormal-cash-pill' });
    el.append(node('span', st.badge ? st.badge[0] : '未觸發', { class: 'nonnormal-cash-badge' + (st.badge ? ' nonnormal-cash-badge--' + st.badge[1] : '') }), node('span', st.text));
    return el;
  }));
  const rets = cashReturns(cashWin), max = Math.max(...rets.map(r => Math.abs(r.ret ?? 0)), 1e-9);
  const y10 = tenYearBp(cashWin);
  byId('cash-rank').replaceChildren(...rets.map(r => {
    const row = node('div', null, { class: 'nonnormal-rank-row' }), bar = node('span', null, { class: 'nonnormal-rank-bar' });
    bar.style.width = `${(Math.abs(r.ret ?? 0) / max) * 50}%`;   // 中線＝0：漲往右、跌往左
    bar.style[r.ret < 0 ? 'right' : 'left'] = '50%';
    bar.style.background = r.color;
    const label = node('span', CASH_LABELS[r.key], { class: 'nonnormal-rank-label' });
    const track = node('span', null, { class: 'nonnormal-rank-track' });
    track.append(bar);
    row.append(label, track, node('span', finite(r.ret) ? signed(r.ret * 100, 1) + '%' : '—', { class: 'nonnormal-rank-val ' + dirClass(r.ret) }));
    if (r.key === 'TLT' && y10) row.append(node('small', `同期 10Y 殖利率 ${signed(y10.bp, 0)}bp${y10.lag ? `（10Y 資料到 ${y10.asOf.slice(5).replace('-', '/')}）` : ''}`, {
      class: 'nonnormal-rank-note', title: '1bp＝0.01 個百分點；殖利率跌＝債券漲。TLT 是 20 年以上長債，和 10Y 不會完全同步。' }));
    return row;
  }));
  drawCash();
}
function drawCash() {
  if (!ck?.raw) return;
  if (!charts[2]) charts[2] = echarts.init(byId('cash-chart'), isLight() ? null : 'dark');
  const end = weeks.at(-1).date, from = new Date(Date.parse(end) - 183 * 86400000).toISOString().slice(0, 10);
  const series = CASH_ASSETS.map(a => {
    const rows = (ck.raw[a.key] || []).filter(([d]) => d >= from && d <= end);
    const base = rows[0]?.[1];
    return { name: CASH_LABELS[a.key], type: 'line', showSymbol: false, data: base ? rows.map(([d, c]) => [d, +((c / base - 1) * 100).toFixed(2)]) : [],
      lineStyle: { width: a.displayOnly ? 1.2 : 1.6, color: a.color, type: a.displayOnly ? 'dashed' : 'solid' }, itemStyle: { color: a.color } };
  });
  series[0].markLine = { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: PALETTE.muted, type: 'dotted' }, data: [{ yAxis: 0 }] };
  chartOption(2, {
    animation: false,
    legend: { type: mob() ? 'scroll' : 'plain', top: 0, textStyle: { color: PALETTE.muted, fontSize: 12 } },
    grid: { left: mob() ? 44 : 52, right: 12, top: 32, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—') },
    xAxis: { type: 'time', axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: '{MM}-{dd}' }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => `${v}%` }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series,
  });
}

// ── chart ───────────────────────────────────────────────────────────────
const RANGES = { '1y': 52, '3y': 156, '5y': 260, '2013': '2013-06-07', all: null };
let twClose = [], lastFit = null;   // lastFit：上次套用的 y 範圍與 x 刻度間距，沒變就不重畫
/** 共振歷史的 x 軸每季一格（第一季標年份、其他標 Q2／Q3／Q4，並畫分隔線）。可見範圍太長放不下時，改成每半年或每年一格（step＝幾季一格）。 */
function quarterAxis(show, step) {
  const q = d => (+d.slice(5, 7) + 2) / 3;
  const at = i => {
    const d = weeks[i]?.date, p = weeks[i - 1]?.date;
    return !!d && !!p && d.slice(5, 7) !== p.slice(5, 7) && [1, 4, 7, 10].includes(+d.slice(5, 7)) && (q(d) - 1) % Math.min(step, 4) === 0 && (step <= 4 || +d.slice(0, 4) % (step / 4) === 0);
  };
  return {
    axisLabel: { color: PALETTE.muted, fontSize: 12, show, interval: at, formatter: d => (step >= 4 || q(d) === 1 ? d.slice(0, 4) : `Q${q(d)}`) },
    splitLine: { show: !show, interval: at, lineStyle: { color: PALETTE.grid, type: 'dashed' } },
  };
}
function chart() {
  if (!charts[0]) { charts[0] = echarts.init(byId('chart'), isLight() ? null : 'dark'); charts[0].on('datazoom', fitIndexAxis); }
  return charts[0];
}
function drawChart() {
  const dates = weeks.map(w => w.date), tw = ctx.s.TWII;
  twClose = dates.map(d => { const f = N.at(tw, d); return f && !f.stale ? f.close : null; });
  const heat = [];
  weeks.forEach((w, x) => w.signals.forEach((s, y) => heat.push([x, y, s.state === 'on' ? 1 : s.state === 'off' ? 0 : -1])));
  const L = mob() ? 62 : 76, R = mob() ? 10 : 24;
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: dates, boundaryGap: true, axisLine: { lineStyle: { color: PALETTE.muted } },
    axisTick: { show: false }, ...quarterAxis(show, 1) });
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, nameTextStyle: { color: PALETTE.muted, fontSize: 11 }, axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const caseMarks = N.CASES.map(c => ({ xAxis: dates.find(d => d >= c.event), label: { formatter: c.id, color: PALETTE.muted, fontSize: 11 } })).filter(m => m.xAxis);
  const option = echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(params) {
        const i = params?.[0]?.dataIndex, w = weeks[i]; if (!w) return '';
        const lit = w.signals.filter(s => s.state === 'on').map(s => N.SIGNALS.find(d => d.id === s.id).short);
        return [`<b>${w.date}</b>｜加權 ${finite(twClose[i]) ? twClose[i].toFixed(0) : '—'}`,
          `<b style="color:${LEVEL_COLORS[w.level]}">${N.LEVELS[w.level].label}</b> ${w.count}/${w.available}`, lit.join('、') || '—'].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 16, height: '30%' }, { left: L, right: R, top: '38%', height: '14%' }, { left: L, right: R, top: '56%', height: '34%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    // 加權的範圍與刻度由 fitIndexAxis() 依可見區間設定；刻度用 markLine 畫，axis 本身不標
    yAxis: [yAxis(0, '加權', { min: v => v.min * 0.9, max: v => v.max * 1.1, axisLabel: { show: false }, splitLine: { show: false } }),
      yAxis(1, '亮燈數', { min: 0, max: N.SIGNALS.length, interval: 2 }),
      { type: 'category', gridIndex: 2, data: N.SIGNALS.map(s => s.short), inverse: true, axisLabel: { color: PALETTE.muted, fontSize: mob() ? 11 : 12 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } }],
    visualMap: { show: false, type: 'piecewise', seriesIndex: 2, dimension: 2, pieces: [{ value: 1, color: '#ef4444' }, { value: 0, color: PALETTE.grid }, { value: -1, color: 'rgba(128,128,128,0.08)' }] },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: twClose, showSymbol: false, connectNulls: true, lineStyle: { width: 1.2, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: PALETTE.muted }, data: caseMarks } },
      { name: '亮燈數', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barCategoryGap: '10%', data: weeks.map(w => ({ value: w.count, itemStyle: { color: LEVEL_COLORS[w.level] } })) },
      { name: '各訊號', type: 'heatmap', xAxisIndex: 2, yAxisIndex: 2, data: heat, itemStyle: { borderColor: PALETTE.cellBorder, borderWidth: 0.3 }, emphasis: { disabled: true } },
      { id: 'twii-ticks', name: '加權刻度', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [], silent: true, markLine: { silent: true, symbol: 'none', animation: false, z: 1, data: [] } },   // markLine 預設 z 5 會蓋在線上
    ],
  });
  chart().setOption(option, { notMerge: true });
  lastFit = null;
  applyRange();
}
function applyRange() {
  const ch = charts[0]; if (!ch || !weeks.length) return;
  const dates = weeks.map(w => w.date), key = RANGES[rangeKey];
  const start = typeof key === 'number' ? dates[Math.max(0, dates.length - key)] : key ? dates.find(x => x >= key) : dates[0];
  ch.dispatchAction({ type: 'dataZoom', startValue: start, endValue: dates.at(-1) });
  fitIndexAxis();
}
/** 加權的 y 軸跟著可見區間：最低 −10%～最高 +10%；刻度只標在可見的最低～最高之間（0／20／40／60／80／100%）。 */
function fitIndexAxis() {
  const ch = charts[0]; if (!ch || !twClose.length) return;
  const z = ch.getOption().dataZoom?.[0] || {}, idx = v => (typeof v === 'number' ? v : weeks.findIndex(w => w.date === v));
  const a = Math.max(0, idx(z.startValue ?? 0)), b = Math.min(twClose.length - 1, idx(z.endValue ?? twClose.length - 1));
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i <= b; i++) if (finite(twClose[i])) { lo = Math.min(lo, twClose[i]); hi = Math.max(hi, twClose[i]); }
  if (!(hi > lo)) return;
  const ticks = [0, 1, 2, 3, 4, 5].map(k => lo + ((hi - lo) * k) / 5);
  const width = ch.getWidth() - (mob() ? 72 : 100), label = mob() ? 30 : 44;   // 每格至少要放得下「2024」
  const step = [1, 2, 4, 8, 16].find(k => width / ((b - a + 1) / 13 / k) >= label) || 16;
  // 拖拉 slider 時每一格都會觸發 datazoom；可見的最高／最低與刻度間距常常沒變，這時不重畫（省一次整張圖的重繪）
  const prev = lastFit;
  if (prev && prev.lo === lo && prev.hi === hi && prev.step === step) return;
  lastFit = { lo, hi, step };
  ch.setOption({
    ...(prev?.step === step ? {} : { xAxis: [0, 1, 2].map(i => quarterAxis(i === 2, step)) }),
    ...(prev && prev.lo === lo && prev.hi === hi ? {} : { yAxis: [{ min: lo * 0.9, max: hi * 1.1 }], series: [{ id: 'twii-ticks', markLine: { data: ticks.map(v => ({ yAxis: v, lineStyle: { type: 'solid', width: 1, color: PALETTE.grid },
      label: { position: 'start', formatter: Math.round(v).toLocaleString('en-US'), color: PALETTE.muted, fontSize: mob() ? 11 : 12 } })) } }] }),
  });
}

// ── lead-lag ────────────────────────────────────────────────────────────
function renderLeadLag(d) {
  const st = since => (since ? `破（${since.slice(5)}）` : '線上');
  table('leadlag', ['均線', '櫃買', '加權', ''], N.leadLag(ctx, d).map(r => [r.label, st(r.otcBelowSince), st(r.twiiBelowSince), r.note]));
}

// ── stance: five boxes, water temperature, batches ───────────────────────
const ARROW = x => (x > 0 ? '↑' : x < 0 ? '↓' : '→');
const arrows = dir => { const el = node('span', null, { class: 'nonnormal-dirs' }); for (const [k, v] of [['日', dir.d], ['週', dir.w], ['月', dir.m]]) el.append(node('span', k + ARROW(v), { class: dirClass(v) })); return el; };
const pctTxt = (x, d = 0) => (finite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const BOX_HINT = { pos: '加權的水溫是不是「極冷」', depth: '加權離 5 年線（月線 60 個月均線）3% 以內或已跌破', press: '上市、上櫃融資維持率取較低者，近 30 日最低低於 150%',
  mood: `任一成立：VIX 近 30 日盤中最高 ≥ 30；近 22 個交易日無觀察類股 ≥ ${N.NO_OBS.start} 天；近 30 日有一天跌停 ≥ ${N.NO_OBS.limitDownExtreme} 家`, ext: '費半、那斯達克、S&P 500、韓股至少 2 個轉弱，或護盤基金進場' };
const BATCH_STATE = { on: ['到位', 'nonnormal-why-state--on'], near: ['接近', 'nonnormal-why-state--near'], off: ['未到', ''] };
function renderStance(d) {
  const st = N.stance(ctx, d);
  const head = node('div', null, { class: 'nonnormal-boxes-head' });
  head.append(node('b', `亮 ${st.lit}/5 格`), node('span', st.verdict, { class: 'nonnormal-why-state' + (st.lit >= 3 ? ' nonnormal-why-state--on' : st.lit ? ' nonnormal-why-state--near' : '') }),
    node('span', '亮 1 格提高警覺，亮 3–4 格才算強烈訊號', { class: 'nonnormal-boxes-note' }));
  const grid = node('div', null, { class: 'nonnormal-boxes' });
  for (const b of st.boxes) {
    const el = node('div', null, { class: 'nonnormal-box' + (b.lit ? ' nonnormal-box--on' : b.lit === null ? ' nonnormal-box--na' : ''), title: BOX_HINT[b.key] });
    const k = node('div', null, { class: 'nonnormal-box-k' });
    k.append(node('span', b.lit ? '●' : '○', { class: 'nonnormal-box-dot', 'aria-hidden': 'true' }), node('span', b.label, { class: 'nonnormal-box-name' }), node('small', b.what));
    el.append(k, node('div', b.text, { class: 'nonnormal-box-v' }));
    grid.append(el);
  }
  byId('boxes').replaceChildren(head, grid, node('p', '水溫由熱到冷：過熱 → 偏熱 → 盤整 → 偏冷 → 極冷。極冷＝大跌後可以開始分批的位置；過熱＝漲過頭。均線方向：日／週／月＝10 日、10 週、10 月線，↑ 上揚、↓ 下彎。「離…線」＝現在價格比那條線高（+）或低（−）多少，紅字＝已到或跌破。「過熱／極冷線」＝這個市場自己的歷史上離 10 月線最遠的 5%／最深的 15%，三條均線同方向且越過才算過熱／極冷。手機可左右滑動表格。', { class: 'nonnormal-temp-note' }));

  const zone = t => { const z = N.ZONES[t.zone]; return node('span', z.label, { class: `nonnormal-zone nonnormal-zone--${z.id}`, title: z.desc }); };
  const dist = l => { const el = node('span', pctTxt(l.gap)); if (l.touch) el.className = 'nonnormal-touch'; return el; };
  table('temp', ['市場', '水溫', '均線方向', '離 10 月線', '過熱／極冷線', '離 2 年線', '離 5 年線', '離 10 年線', '離一年高點'], st.temps.map(t => {
    if (t.missing || t.stale) return [t.label, t.stale ? `資料停在 ${t.date}` : '資料不足', '', '', '', '', '', '', ''];
    return [t.label, zone(t), arrows(t.dir), pctTxt(t.gap, 1), `${pctTxt(t.hot, 0)}／${pctTxt(t.cold, 0)}`, ...t.long.map(dist), pctTxt(t.dd1y, 1)];
  }));

  byId('batches').replaceChildren(...st.batches.map(b => {
    const card = node('article', null, { class: 'ui-card nonnormal-card nonnormal-batch' + (b.state === 'on' ? ' nonnormal-batch--on' : '') });
    const h = node('h4', `${b.label}（${b.weight}%）`), [txt, cls] = BATCH_STATE[b.state];
    h.append(' ', node('span', `${txt} ${b.met}/${b.available}`, { class: 'nonnormal-why-state ' + cls }));
    const ul = node('ul', null, { class: 'nonnormal-batch-list' });
    for (const c of b.conds) ul.append(node('li', `${c.ok === null ? '－' : c.ok ? '✓' : '✗'} ${c.text}`, { class: c.ok ? 'nonnormal-ok' : c.ok === null ? 'nonnormal-na' : '' }));
    card.append(h, ul);
    return card;
  }));
  const parts = [st.vix && `VIX 近 30 日盤中最高 ${st.vix.value.toFixed(1)}（${st.vix.date}）`, st.margin && `融資維持率近 30 日最低 ${st.margin.market} ${st.margin.value.toFixed(1)}%（${st.margin.date}）`];
  byId('batch-note').textContent = `指數的分批節奏：越跌越買、最後一批最大，每批都要比上一批更極端才放。${parts.filter(Boolean).join('；')}。`;
}

// ── water-temperature history ───────────────────────────────────────────
const ZONE_COLORS = ['#ef4444', '#f0883e', '#8b949e', '#58a6ff', '#1f6feb'];   // 與 .nonnormal-zone--* 同色
const TEMP_RANGES = { '3y': 156, '5y': 260, '10y': 520, all: null };
const NEAR = N.STANCE.nearGap * 100;   // 盤整帶 ±3%
let tempHist = null, tempMarket = 'TWII', tempRange = '5y';
const tempHistory = () => (tempHist?.ctx === ctx ? tempHist : (tempHist = { ctx, ...N.temperatureHistory(ctx) }));
const tempMarketOf = h => h.markets.find(x => x.id === tempMarket) || h.markets[0];
function drawTemp(keepWindow = false) {
  const h = tempHistory();
  if (!h.dates.length) return;
  const prev = keepWindow && charts[3] ? charts[3].getOption()?.dataZoom?.[0] : null;   // 切換市場時保留目前看的期間
  if (!charts[3]) charts[3] = echarts.init(byId('temp-chart'), isLight() ? null : 'dark');
  const m = tempMarketOf(h), rows = m.rows, num = (r, k, f = 1) => (r && finite(r[k]) ? +(r[k] * f).toFixed(2) : null);
  const L = mob() ? 52 : 64, R = mob() ? 10 : 24;
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: h.dates, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { show, color: PALETTE.muted, fontSize: 12, formatter: d => d.slice(0, 7) }, splitLine: { show: false } });
  const yAxis = (gridIndex, extra = {}) => ({ type: 'value', gridIndex, scale: true, axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const zoneOf = r => (r ? N.ZONES[r.zone] : null);
  const heat = [];
  h.markets.forEach((mk, y) => mk.rows.forEach((r, x) => heat.push([x, y, r ? r.zone : -1])));
  chartOption(3, {
    animation: false,
    legend: { top: 0, right: R, itemWidth: 22, textStyle: { color: PALETTE.muted, fontSize: 12 }, data: [m.label, '10 月線（虛線）', '過熱線', '極冷線'] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(params) {
        const i = params?.[0]?.dataIndex, r = rows[i];
        if (i == null) return '';
        const head = r ? `<b>${h.dates[i]}</b>｜${m.label}${r.carried ? `（休市，沿用 ${r.date}）` : ''} ${r.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}・10 月線 ${r.ma10m.toLocaleString('en-US', { maximumFractionDigits: 0 })}・離 ${pctTxt(r.gap, 1)}（過熱線 ${pctTxt(r.hot, 0)}／極冷線 ${pctTxt(r.cold, 0)}）`
          : `<b>${h.dates[i]}</b>｜${m.label} 無資料`;
        const all = h.markets.map(mk => { const z = zoneOf(mk.rows[i]); return `${mk.label} <b style="color:${z ? ZONE_COLORS[mk.rows[i].zone] : PALETTE.muted}">${z ? z.label : '—'}</b>`; });
        return [head, all.join('　')].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 30, height: '38%' }, { left: L, right: R, top: '50%', height: '22%' }, { left: L, right: R, top: '76%', height: '14%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [yAxis(0, { name: m.label, nameTextStyle: { color: PALETTE.muted, fontSize: 11 } }),
      { type: 'value', gridIndex: 0, min: 0, max: 1, show: false },
      yAxis(1, { scale: false, name: '離 10 月線', nameTextStyle: { color: PALETTE.muted, fontSize: 11 }, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => `${v}%` },
        min: v => Math.floor(v.min) - 2, max: v => Math.ceil(v.max) + 2 }),
      { type: 'category', gridIndex: 2, data: h.markets.map(mk => mk.label), inverse: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { interval: 0, color: PALETTE.muted, fontSize: mob() ? 11 : 12, formatter: v => (v === m.label ? `▶ ${v}` : v) } }],
    visualMap: { show: false, type: 'piecewise', seriesIndex: 4, dimension: 2, pieces: [...ZONE_COLORS.map((color, value) => ({ value, color })), { value: -1, color: 'rgba(128,128,128,0.06)' }] },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { name: '水溫底色', type: 'bar', xAxisIndex: 0, yAxisIndex: 1, silent: true, barCategoryGap: 0, z: 0, tooltip: { show: false },
        data: rows.map(r => (r ? { value: 1, itemStyle: { color: ZONE_COLORS[r.zone], opacity: 0.22 } } : null)) },
      { name: m.label, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => num(r, 'close')), showSymbol: false, lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: '10 月線（虛線）', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => num(r, 'ma10m')), showSymbol: false, lineStyle: { width: 1.2, type: 'dashed', color: '#d29922' }, itemStyle: { color: '#d29922' } },
      { name: '離 10 月線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'gap', 100)), showSymbol: false, lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markArea: { silent: true, data: [[{ yAxis: -NEAR, itemStyle: { color: ZONE_COLORS[2], opacity: 0.16 } }, { yAxis: NEAR }]] },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dotted', width: 1, color: PALETTE.muted },
          data: [{ yAxis: NEAR, label: { formatter: `±${NEAR}% 盤整`, position: 'insideStartTop', color: PALETTE.muted, fontSize: 11 } }, { yAxis: -NEAR, label: { show: false } }] } },
      { name: '各市場水溫', type: 'heatmap', xAxisIndex: 2, yAxisIndex: 3, data: heat, itemStyle: { borderWidth: 0 }, emphasis: { disabled: true } },
      // 過熱線／極冷線：該市場「當時以前」離 10 月線的歷史分位，會隨時間變動；線外側上色
      { name: '過熱線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'hot', 100)), showSymbol: false, z: 1,
        lineStyle: { width: 1.2, type: 'dashed', color: ZONE_COLORS[0] }, itemStyle: { color: ZONE_COLORS[0] }, areaStyle: { origin: 'end', color: ZONE_COLORS[0], opacity: 0.12 } },
      { name: '極冷線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'cold', 100)), showSymbol: false, z: 1,
        lineStyle: { width: 1.2, type: 'dashed', color: ZONE_COLORS[4] }, itemStyle: { color: ZONE_COLORS[4] }, areaStyle: { origin: 'start', color: ZONE_COLORS[4], opacity: 0.12 } },
    ],
  });
  if (prev && prev.startValue != null) charts[3].dispatchAction({ type: 'dataZoom', startValue: prev.startValue, endValue: prev.endValue });
  else applyTempRange();
}
function applyTempRange() {
  const ch = charts[3], h = tempHist;
  if (!ch || !h?.dates.length) return;
  const first = Math.max(0, tempMarketOf(h).rows.findIndex(Boolean)), key = TEMP_RANGES[tempRange];
  const start = key ? Math.max(first, h.dates.length - key) : first;
  ch.dispatchAction({ type: 'dataZoom', startValue: start, endValue: h.dates.length - 1 });
}
function renderTempLegend() {
  byId('temp-legend').replaceChildren(...N.ZONES.map(z => node('span', z.label, { class: `nonnormal-zone nonnormal-zone--${z.id}`, title: z.desc })));
}

// ── turnaround ──────────────────────────────────────────────────────────
function readChecks() { try { return JSON.parse(localStorage.getItem(CHECK_KEY) || '{}') || {}; } catch { return {}; } }
function writeChecks(v) { try { localStorage.setItem(CHECK_KEY, JSON.stringify(v)); } catch { /* private mode: keep in memory only */ } }
function ladder(title, items, current) {
  const el = node('article', null, { class: 'ui-card nonnormal-card' });
  const ol = node('ol', null, { class: 'nonnormal-ladder' });
  items.forEach((t, i) => ol.append(node('li', t, { class: i === current ? 'nonnormal-current' : '' })));
  el.append(node('h4', title), ol);
  return el;
}
function renderTurn(d) {
  const t = N.turnaround(ctx, d), checks = readChecks(), m = t.margin;
  const times = i => (i > 0 && N.VIX_ZONES[i - 1].max >= 40 ? `（2000 起盤中 ${N.vixEpisodes(ctx, N.VIX_ZONES[i - 1].max)} 次）` : '');
  const vix = ladder(`VIX ${t.vix ? t.vix.value.toFixed(1) : '無資料'}`, N.VIX_ZONES.map((z, i) => `${z.label}・${z.action}${times(i)}`), t.vix?.zone ?? -1);
  const mTitle = m ? ['融資維持率', finite(m.listed) && `上市 ${m.listed.toFixed(1)}%`, finite(m.otc) && `上櫃 ${m.otc.toFixed(1)}%`].filter(Boolean).join(' ') : '融資維持率 無資料';
  const mg = ladder(mTitle, N.MARGIN_TIERS.map(x => x.label), m?.tier ?? -1);
  const no = t.noObs, ldNow = N.at(ctx.s.LIMIT_DOWN, d);
  const obs = ladder(no ? `無觀察類股 近 22 個交易日 ${no.count} 天${no.streak ? `（連續 ${no.streak} 天）` : ''}` : '無觀察類股 無資料', N.NO_OBS_TIERS.map(x => x.label), no?.tier ?? -1);
  if (ldNow && !ldNow.stale) obs.append(node('p', `${ldNow.date} 跌停 ${ldNow.close.toLocaleString('en-US')} 家（上市＋上櫃）`, { class: 'nonnormal-turn-note' }));
  const box = node('article', null, { class: 'ui-card nonnormal-card' });
  const item = (key, text, auto) => {
    const label = node('label', null, { class: 'nonnormal-check' }), input = node('input', null, { type: 'checkbox', 'data-check': key });
    if (auto != null) { input.checked = !!auto; input.disabled = true; } else input.checked = !!checks[key];
    label.append(input, ' ' + text + (auto != null ? '（自動）' : ''));
    return label;
  };
  box.append(node('h4', '轉機三訊號'),
    item('exhaust', '賣壓衰竭'), item('asym', `不對稱機會${t.asymmetricHint ? '（VIX ≥ 30）' : ''}`), item('policy', '政策止血'),
    node('h4', '多燈同亮'),
    item('mispriced', '族群被錯殺'), item('buyback', '公司派低點買回'), item('margin140', '融資維持率 < 140%', t.marginBelow140), item('noLeaders', `連續多日無觀察類股${no ? `（近 22 日 ≥ ${N.NO_OBS.start} 天）` : ''}`, no ? no.count >= N.NO_OBS.start : null));
  byId('turn').replaceChildren(vix, mg, obs, box);
}

// ── collapsed: cases + sources ──────────────────────────────────────────
function dots(c) {
  const wrap = node('span', null, { class: 'nonnormal-dots' });
  for (const w of c.weeks) {
    const s = node('span', null, { class: 'nonnormal-dot' + (w.date >= c.event ? ' nonnormal-dot--after' : ''), title: `${w.date} ${N.LEVELS[w.level].label} ${w.count}/${w.available}` });
    s.style.background = LEVEL_COLORS[w.level];
    wrap.append(s);
  }
  return wrap;
}
function renderCases() {
  table('cases', ['案例', '事件', '事件前一週', '結果', '每週等級（淡＝事件後）'], N.CASES.map(c => {
    const r = N.caseResult(ctx, c), lb = r.lastBefore, ew = r.weeks.find(w => w.date >= c.event);
    const verdict = r.runStart ? `提前 ${r.leadWeeks} 週` : ew && ew.level >= 2 ? '當週才亮，沒有提前' : '沒有達到警戒';
    return [c.label, `${c.event} ${c.eventText}`, lb ? `${N.LEVELS[lb.level].label} ${lb.count}/${lb.available}` : '—', verdict, dots(r)];
  }));
  const b = N.baseRates(ctx, '2013-06-07'), rate = x => (finite(x) ? `${(x * 100).toFixed(0)}%` : '—');
  byId('base').textContent = `2013 起：警戒以上占 ${rate((b.share[2] + b.share[3]) / b.weeks)} 的週；之後 13 週跌 ≥ 10% 的比例 ${rate(b.hitAlert)}（所有週 ${rate(b.hitAll)}）。`;
}
function renderSources() {
  table('sources', ['訊號', '亮燈條件', '細節'], N.SIGNALS.map(def => {
    const ul = node('span', null, { class: 'nonnormal-src' });
    for (const [text] of def.thresholds) ul.append(node('span', text, { class: 'nonnormal-src-item' }));
    return [def.label, def.rule, ul];
  }));
  const items = [
    '均線 100／200／400 日；急跌／急漲＝20 個交易日內的高低點。費半用 ^SOX，原油用布蘭特。',
    '融資維持率為本站計算（含 ETF）：上市 2004 起；上櫃 2026-08-24 起（TPEx 融資餘額）。廣度為多空家數近似，2024-04 起。',
    '卡片：近 6 個月收盤與 50／100 日均線，紅漲綠跌；亮燈的卡片加紅框。',
  ];
  if (missing.length) items.unshift(`載入失敗：${missing.join('、')}`);
  byId('notes').replaceChildren(...items.map(t => node('li', t)));
}

function renderAll() {
  const ticket = ++generation;
  setTimeout(() => {
    if (ticket !== generation) return;
    try {
      const now = weeks.at(-1), prev = weeks.at(-2) || null;
      const running = new Date(Date.parse(now.date)).getUTCDay() !== 5;
      const last = id => ctx.s[id]?.dates?.at(-1);
      byId('asof').textContent = `${now.date}${running ? '（本週至今）' : ''}・美股收盤 ${last('SPX')}、台股收盤 ${last('TWII')}・每日 06:00（美股收盤後）、18:00（台股收盤後）自動更新`;
      renderSummary(now, prev); renderCards(now); renderCash(); drawChart(); renderLeadLag(now.date); renderStance(now.date); renderTempLegend(); drawTemp(true); renderTurn(now.date);
      drawDetail();
      if (byId('cases-details').open) renderCases();
      if (byId('sources-details').open) renderSources();
      byId('status').textContent = missing.length ? `部分資料載入失敗：${missing.join('、')}` : '';
    } catch (e) { byId('status').textContent = '計算失敗：' + e.message; }
  }, 0);
}
function wire() {
  if (!bindOnce(byId('range'))) return;
  chipPicker(byId('range'), 'nonnormal-range', key => { rangeKey = key; applyRange(); });
  chipPicker(byId('temp-market'), 'nonnormal-temp-market', key => { tempMarket = key; if (ctx) drawTemp(true); });
  chipPicker(byId('temp-range'), 'nonnormal-temp-range', key => { tempRange = key; applyTempRange(); });
  chipPicker(byId('cash-range'), 'nonnormal-cash', key => { cashWin = Number(key); if (ck) renderCash(); });
  // 開大圖：0.5 秒內在同一張卡上點兩下（滑鼠、觸控相同）。捲動頁面時瀏覽器會送 pointercancel、或手指移動超過門檻，都不算點擊。
  // 鍵盤 Enter／Space 與輔助技術的點擊（click.detail === 0）直接開。
  const cards = byId('cards'), cardOf = e => e.target.closest?.('.nonnormal-q');
  const open = el => { const def = el && CARD_BY_SERIES.get(el.dataset.series); if (def && ctx) openDetail(def); };
  let down = null, lastTap = null;
  cards.addEventListener('pointerdown', e => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: e.timeStamp, el: cardOf(e) }; });
  cards.addEventListener('pointercancel', () => { down = null; lastTap = null; });
  cards.addEventListener('pointerup', e => {
    const d = down; down = null;
    if (!d?.el || cardOf(e) !== d.el || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || e.timeStamp - d.t > DOUBLE_TAP_MS) { lastTap = null; return; }
    if (lastTap && lastTap.el === d.el && e.timeStamp - lastTap.t <= DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null; e.preventDefault(); open(d.el);
    } else lastTap = { el: d.el, t: e.timeStamp, x: e.clientX, y: e.clientY };
  });
  cards.addEventListener('click', e => { if (e.detail === 0) open(cardOf(e)); });
  cards.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(cardOf(e)); } });
  const dlg = byId('dialog');
  dlg.querySelector('.nonnormal-dialog-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // 點背景關閉
  dlg.addEventListener('close', () => { detail = null; });
  byId('turn').addEventListener('change', e => {
    const key = e.target?.dataset?.check;
    if (!key || e.target.disabled) return;
    const v = readChecks(); v[key] = e.target.checked; writeChecks(v);
  });
  const lazy = (id, fn) => byId(id).addEventListener('toggle', e => { if (e.target.open && ctx) { try { fn(); } catch (err) { byId('status').textContent = '計算失敗：' + err.message; } } });
  lazy('cases-details', renderCases);
  lazy('sources-details', renderSources);
  for (const h of document.querySelectorAll('#tab-nonnormal [data-help]')) h.append(' ', infoButton(HELP[h.dataset.help], '說明：' + h.dataset.help));
}

export async function activate(context = {}) {
  initInfoPopovers();
  if (ctx && Date.now() - loadedAt < 300_000) { resize(); return; }
  missing = [];
  const fresh = await load(context);
  if (fresh === false) return;
  loadedAt = Date.now();
  wire(); renderAll();
}
export function getCharts() { return charts.filter(Boolean); }
export function resize() { getCharts().forEach(c => c.resize()); }
export function onThemeChange() {
  if (!ctx) return;
  return preserveChartState(getCharts, () => { charts.forEach(c => c?.dispose()); charts = []; drawChart(); drawCash(); drawDetail(); drawTemp(); });
}
