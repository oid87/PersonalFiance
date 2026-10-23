// 極端狀態儀表板 — 每週一次的多重確認儀表板（描述性，不是買賣訊號）。
// 引擎：js/tabs/nonnormal_calc.mjs（與 scripts/research/backtest_nonnormal.mjs 共用）。
// 版面：等級橫幅 → 報價卡（最新值、日漲跌、近 6 個月走勢＋50／100 日均線，亮燈卡加紅框；點卡片開大圖）→ 資金流向（現金為王，
// 與 cashking 頁共用 cashking_calc.mjs）→ 共振歷史圖 → 時間差 → 轉機；
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
  leadlag: '櫃買先跌破、加權未破：先提高警覺。加權破、櫃買抗跌：中小型股開始有信心。',
  cash: '現金為王（izaax，同「現金為王」頁）：4 或 8 週內黃金、比特幣、美債 TLT、QQQ 全部下跌，且恐懼貪婪低點 < 25。逃往黃金：其他都跌、只有黃金漲，且恐懼貪婪 < 25。同一期間誰漲最多＝資金往哪裡去。',
};

// 報價卡：[序列, 名稱, 對應訊號, 格式]。格式 px＝價格、yield＝殖利率（漲跌用 bp）、ratio＝百分比（漲跌用百分點）、score＝0–100 分數（漲跌用點）。
const CARD_GROUPS = [
  { group: 'A', title: '國際股市', cards: [['SOX', '費半', 'sox'], ['NDX', '那斯達克 100', 'ndx'], ['SPX', 'S&P 500', 'spx'], ['KOSPI', '韓股', 'kospi']] },
  { group: 'B', title: '金融市場', cards: [['US10Y', '美債 10Y', 'us10y', 'yield'], ['DXY', '美元指數', 'dxy'], ['GOLD', '黃金', 'gold'], ['OIL', '布蘭特原油', 'oil'], ['VIX', 'VIX', 'vix'], ['VXN', 'VXN'], ['FG', '恐懼貪婪', null, 'score'], ['BTC', '比特幣']] },
  { group: 'C', title: '台股內部', cards: [['TWII', '加權'], ['TWOII', '櫃買', 'otc'], ['MARGIN', '上市融資維持率', 'margin', 'ratio'], ['MARGIN_OTC', '上櫃融資維持率', 'margin', 'ratio'], ['BREADTH_PCT', '偏多家數占比', 'breadth', 'ratio']] },
  { group: null, title: '參考（不計分）', cards: [['N225', '日經 225'], ['HSI', '恆生'], ['SSE', '上證'], ['STOXX50E', '歐股 50'], ['US2Y', '美債 2Y', null, 'yield']] },
];
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
  BREADTH_PCT: '指數上漲但多數個股不漲＝廣度收窄，上漲只靠少數權值股撐著。',
  N225: '第三層以後的市場，用來確認是不是全球同步轉弱。',
  HSI: '中港資金與中國景氣的溫度計，用來確認是不是全球同步轉弱。',
  SSE: '中國內需與政策的溫度計，用來確認是不是全球同步轉弱。',
  STOXX50E: '歐洲大型股，用來確認是不是全球同步轉弱。',
  US2Y: '和 10Y 比較看殖利率曲線：2Y 高於 10Y（倒掛）是長循環訊號，只註記不計分。',
};
// 大圖的參考線（訊號門檻）
const REF_LINES = { vix: [20, 30], margin: [150, 130], breadth: [50], FG: [25, 75] };   // 訊號 id，或不計分卡片的序列 id
// 資金流向：現金為王的 4 檔（state.js CK_ASSETS）＋ SPY 只顯示
const CASH_LABELS = { GLD: '黃金（GLD）', BTC: '比特幣', TLT: '美債（TLT）', QQQ: 'QQQ', SPY: 'SPY' };
const CASH_ASSETS = [...CK_ASSETS, { key: 'SPY', color: '#a371f7', file: 'data/SPY.json', displayOnly: true }];

let ctx = null, loadedAt = 0, missing = [], weeks = [], charts = [], rangeKey = '3y', generation = 0;
let ck = null, cashWin = 4, detail = null;   // ck = { raw, rows }；charts[0] 共振史、[1] 大圖、[2] 資金流向

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
  return v.toLocaleString('en-US', { minimumFractionDigits: pxDigits(v), maximumFractionDigits: pxDigits(v) });
}
/** Day/week change text: price → "+12.3 +0.45%"; yield → "+3bp"; ratio → "+1.2"（百分點）; score → "-7.4"（點）. pctOnly drops the absolute part. */
function fmtChange(abs, rel, kind, ref, pctOnly = false) {
  if (!finite(abs)) return '—';
  if (kind === 'yield') return `${signed(Math.round(abs * 100), 0)}bp`;
  if (kind === 'ratio' || kind === 'score') return signed(abs, 1);
  const p = finite(rel) ? signed(rel * 100, 2) + '%' : '';
  return pctOnly ? p || '—' : `${signed(abs, pxDigits(ref))} ${p}`.trim();
}
const dirClass = x => (!finite(x) || x === 0 ? 'nonnormal-flat' : x > 0 ? 'nonnormal-up' : 'nonnormal-down');

function sparkline(q) {
  const W = 120, H = 40, n = q.close.length;
  const vals = [...q.close, ...MAS.flatMap(k => q.ma[k])].filter(finite);
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
  add('ma100', path(q.ma[100]));
  add('ma50', path(q.ma[50]));
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
  head.append(node('span', name, { class: 'nonnormal-q-name' }), node('span', 'ⓘ', { class: 'nonnormal-q-hint', 'aria-hidden': 'true' }));
  if (state === 'on') head.append(node('span', '亮', { class: 'nonnormal-q-flag' }));
  else if (sig && state === 'na') head.append(node('span', '無資料', { class: 'nonnormal-q-flag nonnormal-q-flag--na' }));
  el.append(head);
  if (!q) { el.append(node('div', '—', { class: 'nonnormal-q-val' }), node('p', sig?.reason || '尚無資料', { class: 'nonnormal-q-foot' })); return el; }
  el.append(node('div', fmtValue(q.last, kind), { class: 'nonnormal-q-val ' + dirClass(q.chg) }),
    node('div', fmtChange(q.chg, q.chgPct, kind, q.last), { class: 'nonnormal-q-chg ' + dirClass(q.chg) }),
    sparkline(q));
  const foot = node('p', null, { class: 'nonnormal-q-foot' });
  foot.append(q.stale ? `資料停在 ${q.date}` : `週 ${fmtChange(q.w1, q.w1Pct, kind, q.last, true)}`);
  if (state === 'on' && sig.tags.length) foot.append('・', node('b', sig.tags.join('・')));
  el.append(foot);
  return el;
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
    head.append(h);
    if (gi === 0) head.append(legend);
    const grid = node('div', null, { class: 'nonnormal-cards' });
    grid.append(...cards.map(c => quoteCard(c, now)));
    return [head, grid];
  }));
}

// ── detail dialog（點卡片：同樣半年，但用完整座標與 tooltip 看精確值）────────
const valueFmt = (kind, ref) => v => (!finite(v) ? '—' : kind === 'yield' ? v.toFixed(2) + '%' : kind === 'ratio' ? v.toFixed(1) + '%' : kind === 'score' ? v.toFixed(1)
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
  byId('dialog-title').textContent = name;
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
  const lines = (REF_LINES[sigId] || REF_LINES[id] || []).map(v => ({ yAxis: v, label: { formatter: fmt(v), color: PALETTE.muted, fontSize: 10 } }));
  const line = (name, data, color, width, extra = {}) => ({ name, type: 'line', data, showSymbol: false, connectNulls: false, lineStyle: { width, color }, itemStyle: { color }, ...extra });
  chartOption(1, {
    animation: false,
    legend: { top: 0, right: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['收盤', '50MA', '100MA'] },
    grid: { left: mob() ? 50 : 64, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: fmt },
    xAxis: { type: 'category', data: q.dates, boundaryGap: false, axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: v => v.slice(5) } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: fmt }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [
      line('收盤', q.close, PALETTE.text, 1.6, { areaStyle: { opacity: 0.06 }, markLine: lines.length ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#ef4444' }, data: lines } : undefined }),
      line('50MA', q.ma[50], '#e3b341', 1.2),
      line('100MA', q.ma[100], '#58a6ff', 1.2),
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
    legend: { type: mob() ? 'scroll' : 'plain', top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    grid: { left: mob() ? 44 : 52, right: 12, top: 32, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—') },
    xAxis: { type: 'time', axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: '{MM}-{dd}' }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: v => `${v}%` }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series,
  });
}

// ── chart ───────────────────────────────────────────────────────────────
const RANGES = { '1y': 52, '3y': 156, '5y': 260, '2013': '2013-06-07', all: null };
let twClose = [];
/** 共振歷史的 x 軸每季一格（第一季標年份、其他標 Q2／Q3／Q4，並畫分隔線）。可見範圍太長放不下時，改成每半年或每年一格（step＝幾季一格）。 */
function quarterAxis(show, step) {
  const q = d => (+d.slice(5, 7) + 2) / 3;
  const at = i => {
    const d = weeks[i]?.date, p = weeks[i - 1]?.date;
    return !!d && !!p && d.slice(5, 7) !== p.slice(5, 7) && [1, 4, 7, 10].includes(+d.slice(5, 7)) && (q(d) - 1) % Math.min(step, 4) === 0 && (step <= 4 || +d.slice(0, 4) % (step / 4) === 0);
  };
  return {
    axisLabel: { color: PALETTE.muted, fontSize: 11, show, interval: at, formatter: d => (step >= 4 || q(d) === 1 ? d.slice(0, 4) : `Q${q(d)}`) },
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
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const caseMarks = N.CASES.map(c => ({ xAxis: dates.find(d => d >= c.event), label: { formatter: c.id, color: PALETTE.muted, fontSize: 10 } })).filter(m => m.xAxis);
  const option = echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 },
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
      { type: 'category', gridIndex: 2, data: N.SIGNALS.map(s => s.short), inverse: true, axisLabel: { color: PALETTE.muted, fontSize: mob() ? 10 : 11 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } }],
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
  ch.setOption({
    xAxis: [0, 1, 2].map(i => quarterAxis(i === 2, step)),
    yAxis: [{ min: lo * 0.9, max: hi * 1.1 }],
    series: [{ id: 'twii-ticks', markLine: { data: ticks.map(v => ({ yAxis: v, lineStyle: { type: 'solid', width: 1, color: PALETTE.grid },
      label: { position: 'start', formatter: Math.round(v).toLocaleString('en-US'), color: PALETTE.muted, fontSize: mob() ? 10 : 11 } })) } }],
  });
}

// ── lead-lag ────────────────────────────────────────────────────────────
function renderLeadLag(d) {
  const st = since => (since ? `破（${since.slice(5)}）` : '線上');
  table('leadlag', ['均線', '櫃買', '加權', ''], N.leadLag(ctx, d).map(r => [r.label, st(r.otcBelowSince), st(r.twiiBelowSince), r.note]));
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
  const vix = ladder(`VIX ${t.vix ? t.vix.value.toFixed(1) : '無資料'}`, N.VIX_ZONES.map(z => `${z.label}・${z.action}`), t.vix?.zone ?? -1);
  const mTitle = m ? ['融資維持率', finite(m.listed) && `上市 ${m.listed.toFixed(1)}%`, finite(m.otc) && `上櫃 ${m.otc.toFixed(1)}%`].filter(Boolean).join(' ') : '融資維持率 無資料';
  const mg = ladder(mTitle, N.MARGIN_TIERS.map(x => x.label), m?.tier ?? -1);
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
    item('mispriced', '族群被錯殺'), item('buyback', '公司派低點買回'), item('margin140', '融資維持率 < 140%', t.marginBelow140), item('noLeaders', '連續多日無觀察類股'));
  byId('turn').replaceChildren(vix, mg, box);
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
      byId('asof').textContent = `${now.date}${running ? '（本週至今）' : ''}`;
      renderSummary(now, prev); renderCards(now); renderCash(); drawChart(); renderLeadLag(now.date); renderTurn(now.date);
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
  return preserveChartState(getCharts, () => { charts.forEach(c => c?.dispose()); charts = []; drawChart(); drawCash(); drawDetail(); });
}
