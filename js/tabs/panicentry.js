// 恐慌進場回測 — 加權指數從近一年盤中高點回撤到門檻後，買 0050／00631L／模擬正二的歷史結果；
// 可再加美國波動率（VIX／VXN／VXSMH）、台積電跌幅、國安基金等條件，和「只看回撤」同期間比較。
// 版面：現在的狀態一句話 → 研究結論 → 參數 → 統計方塊 → 同期間策略比較表 → 三格時間軸（大盤、回撤、波動率）
//       → 各事件報酬／中途最大跌幅 → 事件明細 → 口徑與限制。
// 計算：js/tabs/panicentry_calc.mjs；資料：data/panic_entry.json（scripts/fetch_panic_entry.py）。
import { echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import * as C from './panicentry_calc.mjs';

const byId = id => document.getElementById('panicentry-' + id);
const val = id => byId(id).value;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950', ORANGE = '#f0883e', BLUE = '#58a6ff';
const pct = (x, d = 1) => (finite(x) ? `${(x * 100).toFixed(d)}%`.replace('-', '−') : '—');
const spct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`.replace('-', '−') : '—');
const dpt = x => (finite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '—');
const f1 = x => (finite(x) ? x.toFixed(1) : '—');
const dir = x => (!finite(x) ? '' : x >= 0 ? 'panicentry-up' : 'panicentry-down');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const SETS = { vix: ['vix'], vxn: ['vxn'], vxsmh: ['vxsmh'], smhrv: ['smhrv'], tw: ['tw'], 'vxn+smhrv': ['vxn', 'smhrv'], 'vxn+vxsmh': ['vxn', 'vxsmh'] };
const VNAME = { vix: 'VIX', vxn: 'VXN', vxsmh: 'VXSMH', smhrv: 'SMH 實現波動', tw: 'TWVIX' };
const ABS_DEF = { vix: 30, vxn: 35, vxsmh: 50, smhrv: 50, tw: 40 };
const ASSET = { sim: '模擬正二', lev: '00631L', e50: '0050' };
const LEV_FROM = '2014-11-03';

let D = null, loadedAt = 0, cache = {}, baseCache = {}, charts = {}, last = null;

function volMode() { const vk = val('vk'), m = val('vmode'); return m === 'abs' && vk && SETS[vk].length > 1 ? 'p252' : m; }
function syncThr(reset) {
  const s = byId('vthr');
  if (volMode() === 'abs') { s.min = 0; s.max = 90; s.step = 1; if (reset) s.value = ABS_DEF[val('vk')] ?? 30; }
  else { s.min = 80; s.max = 99.5; s.step = 0.5; if (reset) s.value = 95; }
}
function cond() {
  const c = { ddMode: 'i252' }, dd = Number(val('dd'));
  if (dd > 0) c.dd = dd;
  const vk = val('vk'), m = volMode();
  if (vk) { c.vols = SETS[vk].map(k => ({ k, mode: m, thr: Number(val('vthr')) })); if (val('sig') !== 'first') c.sigType = val('sig'); }
  const t = val('tsm'); if (t === 'limit' || t === 'reopen') c.tsmMode = t; else if (t) c.tsm = Number(t);
  if (val('nsf')) c.nsf = true;
  if (val('asset') === 'lev') c.from = LEV_FROM;
  // 期間起點推到所選波動率指標第一天有值，讓基準與策略同期間
  for (const v of c.vols || []) { const s = C.volMetric(D, v.k, v.mode, cache), i = s.findIndex(x => x != null); if (i >= 0 && (!c.from || c.from < D.date[i])) c.from = D.date[i]; }
  return c;
}
const opts = () => ({ asset: val('asset'), entry: val('entry'), H: Number(val('h')), cooldown: Number(val('cd')) });

// ── 現在的狀態 ───────────────────────────────────────────────────────────
function renderNow() {
  const dd = cache.dd_i252 || (cache.dd_i252 = C.drawdown(D, 'i252')), n = D.date.length, i = n - 1;
  const thr = Number(val('dd')) || 20;
  const ev = C.events(C.signalDays(D, { dd: thr, ddMode: 'i252' }, cache), 60), li = ev.at(-1);
  const hit = dd[i] <= -thr / 100, H = Number(val('h'));
  const parts = [`<b>${esc(D.date[i])}</b>　距近一年盤中高點 <b class="${hit ? 'panicentry-hit' : ''}">${pct(dd[i])}</b>（門檻 −${thr}%，今天${hit ? '在門檻以下' : '沒有跌破'}）`];
  if (li != null) {
    const o = li + 1 < n ? D.lev_o[li + 1] : null, cur = D.lev_c[i], held = i - li;
    const since = finite(o) && finite(cur) ? cur / o - 1 : null;
    parts.push(`上一次訊號：<b>${esc(D.date[li])}</b>（當天回撤 ${pct(dd[li])}）` + (since != null ? `；隔天開盤買 00631L，${held <= H ? `持有中第 ${held}／${H} 天` : `已過 ${held} 個交易日`}，目前 <span class="${dir(since)}">${spct(since)}</span>` : ''));
  }
  const vx = [['VIX', D.us_vix], ['VXN', D.us_vxn], ['VXSMH', D.us_vxsmh], ['TWVIX', D.vix_c]].map(([nm, a]) => `${nm} ${f1(a[i])}`).join('・');
  parts.push(`<span class="panicentry-dim">波動率（美國為前一晚收盤）：${vx}</span>`);
  byId('now').innerHTML = parts.join('<br>');
}

// ── 統計方塊 ─────────────────────────────────────────────────────────────
function renderTiles(r, bs, p) {
  const s = r.stats, pend = r.trades.length - (s.n || 0);
  const worstDate = r.trades.filter(t => t.complete).sort((a, b) => a.ret - b.ret)[0]?.date ?? '—';
  const T = (k, v, sub = '') => `<div class="panicentry-tile"><div class="panicentry-k">${k}</div><div class="panicentry-v">${v}</div><div class="panicentry-s">${sub}</div></div>`;
  byId('tiles').innerHTML = [
    T('完整事件數', s.n || 0, pend ? `另有 ${pend} 次還沒滿持有期` : `符合天數 ${r.days}`),
    T('上漲機率', pct(s.win), s.n ? `樣本少，真實機率大概落在 ${pct(s.ci[0], 0)}–${pct(s.ci[1], 0)}` : ''),
    T('報酬中位數', spct(s.median), `平均 ${spct(s.mean)}`),
    T('最差／最好', spct(s.worst), `最差那次 ${worstDate}；最好 ${spct(s.best)}`),
    T('中途最深跌幅 中位', pct(s.maeMed), `最差一成 ${pct(s.maeP90)}；最差 ${pct(s.maeWorst)}`),
    T('回本天數 中位', s.recMed ?? '—', `持有期內沒回本 ${s.notRec ?? 0} 次`),
    T('對照：不挑日子，每天都買', spct(bs.mean), `平均報酬；上漲機率 ${pct(bs.win)}，中位 ${spct(bs.median)}`),
    T('隨機買也做得到的機率', p == null ? '—' : pct(p, 0), '隨機挑同樣次數的日子，平均不輸這個策略的比例；低於 5% 才算不像運氣'),
  ].join('');
}

// ── 同期間比較 ───────────────────────────────────────────────────────────
function renderCompare() {
  const o = opts(), m = val('vmode'), pm = m === 'abs' ? 'p252' : m, thr = Number(val('vthr')), sig = val('sig'), dd = Number(val('dd'));
  const list = [['只看回撤', []], ['＋VXN', ['vxn']], ['＋VIX', ['vix']], ['＋SMH 實現波動', ['smhrv']], ['＋VXN＋SMH 實現波動', ['vxn', 'smhrv']], ['＋VIX＋VXN＋SMH 實現波動', ['vix', 'vxn', 'smhrv']]];
  let base = null; const rows = [];
  for (const [name, keys] of list) {
    const useAbs = m === 'abs' && keys.length === 1, pthr = m === 'abs' || !val('vk') ? 95 : thr;
    const c = { ddMode: 'i252', valid: ['vix', 'vxn', 'smhrv'].map(k => ({ k, mode: pm })), vols: keys.map(k => ({ k, mode: useAbs ? 'abs' : pm, thr: useAbs ? ABS_DEF[k] : pthr })) };
    if (dd > 0) c.dd = dd;
    if (o.asset === 'lev') c.from = LEV_FROM;
    if (keys.length && sig !== 'first') c.sigType = sig;
    const r = C.run(D, c, o, cache), s = r.stats; if (!keys.length) base = s;
    const d = (a, b) => (s.n && base?.n && keys.length ? dpt(a - b) : '—');
    const pend = r.trades.length - (s.n || 0);
    const lab = esc(name) + (keys.length ? `<span class="panicentry-dim">（${useAbs ? '≥' + ABS_DEF[keys[0]] : '百分位≥' + pthr}）</span>` : '');
    rows.push(`<tr class="${!keys.length ? 'panicentry-base' : (s.n || 0) < 5 ? 'panicentry-thin' : ''}"><td>${lab}</td><td>${s.n || 0}${pend ? `（另 ${pend} 次未滿期）` : ''}</td><td>${pct(s.win)}</td><td>${s.n ? `${pct(s.ci[0], 0)}–${pct(s.ci[1], 0)}` : '—'}</td><td>${spct(s.median)}</td><td>${spct(s.mean)}</td><td>${pct(s.maeMed)}</td><td>${pct(s.maeP90)}</td><td>${d(s.win, base.win)}</td><td>${d(s.median, base.median)}</td><td>${d(s.maeMed, base.maeMed)}</td></tr>`);
  }
  byId('cmp').innerHTML = `<table><thead><tr><th>策略</th><th>完整事件</th><th>上漲機率</th><th>95% 區間</th><th>報酬中位</th><th>平均</th><th>中途最深 中位</th><th>最差一成</th><th>上漲機率差（百分點）</th><th>報酬中位差</th><th>中途跌幅差（正＝跌較淺）</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// ── 圖 ───────────────────────────────────────────────────────────────────
function chart(key) {
  const el = byId(key + '-chart');
  if (!charts[key]) charts[key] = echarts.init(el);
  return charts[key];
}
function drawMain() {
  const { c, r } = last, start = Math.max(0, D.date.findIndex(d => d >= (c.from || D.date[0])));
  const dates = D.date.slice(start), dd = (cache.dd_i252 || C.drawdown(D, 'i252')).slice(start).map(x => +(x * 100).toFixed(2));
  const vk = (c.vols && c.vols[0].k) || 'vxn', vm = c.vols ? c.vols[0].mode : 'abs';
  const vs = C.volMetric(D, vk, vm, cache).slice(start).map(x => (x == null ? null : +x.toFixed(2)));
  const marks = r.ev.filter(i => i >= start).map(i => ({ xAxis: D.date[i] }));
  const m = mob(), L = m ? 58 : 64, Rr = m ? 14 : 20;
  const ax = { axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } } };
  const name = (t, gi) => ({ text: t, left: L, top: ['1%', '49%', '73%'][gi], textStyle: { color: PALETTE.muted, fontSize: 12, fontWeight: 'normal' } });
  chart('main').setOption(echartsBase({
    title: [name('加權指數（對數）｜橘線＝訊號日', 0), name('距近一年盤中高點的回撤（%）', 1), name(`${VNAME[vk]}${vm === 'abs' ? '' : `｜過去 ${vm.slice(1)} 日百分位`}`, 2)],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: Rr, top: '6%', height: '38%' }, { left: L, right: Rr, top: '54%', height: '14%' }, { left: L, right: Rr, top: '78%', height: '12%' }],
    xAxis: [0, 1, 2].map(gi => ({ type: 'category', data: dates, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 2, color: PALETTE.muted, fontSize: 11, hideOverlap: true, formatter: v => String(v).slice(0, 7) } })),
    yAxis: [{ type: 'log', gridIndex: 0, min: 'dataMin', ...ax }, { type: 'value', gridIndex: 1, max: 0, ...ax }, { type: 'value', gridIndex: 2, scale: true, ...ax }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'none' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 18, bottom: 6 }],
    series: [
      { type: 'line', name: '加權收盤', data: D.tw_c.slice(start), symbol: 'none', xAxisIndex: 0, yAxisIndex: 0, lineStyle: { width: 1.4, color: BLUE }, itemStyle: { color: BLUE },
        markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: ORANGE, width: 1, type: 'solid' }, data: marks } },
      { type: 'line', name: '回撤', data: dd, symbol: 'none', xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1, color: PALETTE.muted }, itemStyle: { color: PALETTE.muted }, areaStyle: { opacity: 0.15 },
        markLine: c.dd ? { symbol: 'none', silent: true, lineStyle: { color: ORANGE, type: 'dashed' }, label: { color: PALETTE.muted, formatter: `−${c.dd}%` }, data: [{ yAxis: -c.dd }] } : undefined },
      { type: 'line', name: VNAME[vk], data: vs, symbol: 'none', connectNulls: false, xAxisIndex: 2, yAxisIndex: 2, lineStyle: { width: 1.2, color: ORANGE }, itemStyle: { color: ORANGE },
        markLine: c.vols ? { symbol: 'none', silent: true, lineStyle: { color: PALETTE.muted, type: 'dashed' }, label: { color: PALETTE.muted }, data: [{ yAxis: c.vols[0].thr }] } : undefined },
    ],
  }), true);
}
function bars(key, vals, label) {
  const tr = last.r.trades, m = mob();
  chart(key).setOption(echartsBase({
    grid: { left: mob() ? 44 : 54, right: 12, top: 14, bottom: 64 },
    tooltip: { trigger: 'axis', formatter: ps => { const t = tr[ps[0].dataIndex]; return `${t.date}${t.complete ? '' : '（還沒滿持有期）'}<br>${label} ${ps[0].value == null ? '—' : ps[0].value.toFixed(1) + '%'}`; } },
    xAxis: { type: 'category', data: tr.map(t => t.date.slice(0, 7)), axisLabel: { color: PALETTE.muted, rotate: 60, fontSize: 10, interval: m ? 'auto' : 0, hideOverlap: true } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [{ type: 'bar', name: label, barMaxWidth: 18, data: vals.map((v, k) => ({ value: v == null ? null : +(v * 100).toFixed(2), itemStyle: { color: v >= 0 ? RED : GREEN, opacity: tr[k].complete ? 1 : 0.35, borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })) }],
  }), true);
}
function drawAll() {
  drawMain();
  bars('ret', last.r.trades.map(t => t.ret), `${last.o.H} 日報酬`);
  bars('mae', last.r.trades.map(t => t.mae), '中途最深跌幅');
}

// ── 事件表 ───────────────────────────────────────────────────────────────
function renderEvents() {
  const { r, o } = last, dd = cache.dd_i252;
  const rows = r.trades.map(t => {
    const i = t.i, rc = C.recoverDays(D, i, o.asset, o.entry === 'split' ? 'open' : o.entry);
    return `<tr><td>${t.date}</td><td>${t.entryDate}</td><td>${pct(dd[i])}</td><td>${f1(D.us_vix[i])}</td><td>${f1(D.us_vxn[i])}</td><td>${f1(D.us_vxsmh[i])}</td><td>${f1(D.vix_c[i])}</td><td>${spct(D.tsm_ret[i])}</td><td class="${dir(t.complete ? t.ret : null)}">${t.complete ? spct(t.ret) : `未滿 ${spct(t.ret)}`}</td><td>${pct(t.mae)}</td><td>${spct(t.mfe)}</td><td>${rc ? (rc.days ?? '還沒回本') : '—'}</td></tr>`;
  });
  byId('events').innerHTML = `<table><thead><tr><th>訊號日</th><th>進場日</th><th>當天回撤</th><th>VIX</th><th>VXN</th><th>VXSMH</th><th>TWVIX</th><th>台積電當天</th><th>${o.H} 日報酬</th><th>中途最深跌幅</th><th>中途最高漲幅</th><th>回本交易日（不限期）</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function recompute() {
  byId('ddv').textContent = Number(val('dd')) ? `−${val('dd')}%` : '不限';
  const vm = volMode();
  byId('vthr').disabled = !val('vk'); byId('sig').disabled = !val('vk'); byId('vmode').disabled = !val('vk');
  byId('vthrv').textContent = val('vk') ? (vm === 'abs' ? val('vthr') : `第 ${val('vthr')} 百分位`) : '（先選指數）';
  const c = cond(), o = opts(), keys = (c.vols || []).map(v => v.k), w = [];
  if (val('vk') && val('vmode') === 'abs' && vm !== 'abs') w.push('兩個指數的組合不能共用一個絕對數值門檻，已改用過去 252 日百分位。');
  if (keys.length) w.push(`有波動率條件，期間從 ${c.from} 起（指標第一天有值的日子）。` + (keys.includes('vxsmh') ? 'VXSMH 只有 2025-09 起，樣本極少。' : '') + (keys.includes('tw') ? 'TWVIX 只有 2026-08 起的官方資料，樣本極少。' : ''));
  if (o.entry === 'close' && (keys.includes('tw') || c.nsf)) w.push('收盤進場搭配 TWVIX 或國安基金條件會用到收盤後才知道的資訊，請改用隔天開盤。');
  const r = C.run(D, c, o, cache), s = r.stats;
  if (s.n && s.n < 10) w.push(`只有 ${s.n} 個完整事件，上漲機率與平均的誤差很大，請看 95% 信賴區間。`);
  byId('warn').innerHTML = w.map(esc).join('<br>');
  const from = c.from || (o.asset === 'lev' ? LEV_FROM : null), bk = [o.asset, o.entry, o.H, from || ''].join('|');
  const base = baseCache[bk] || (baseCache[bk] = C.baseline(D, o.asset, o.entry, o.H, from));
  last = { c, o, r };
  byId('setup').textContent = `目前設定：${ASSET[o.asset]}，回撤 ${c.dd ? '−' + c.dd + '%' : '不限'}${keys.length ? '，加 ' + keys.map(k => VNAME[k]).join('＋') : ''}，持有 ${o.H} 個交易日，期間 ${from || D.date[0]} 起。淡色長條＝還沒滿持有期。`;
  renderNow(); renderTiles(r, C.summarize(base), s.n ? C.permTest(base, s.mean, s.n, o.cooldown, 1500) : null);
  renderCompare(); drawAll(); renderEvents();
}

function wire() {
  if (!bindOnce(byId('params'))) return;
  byId('params').addEventListener('input', e => { if (e.target.id === 'panicentry-vk' || e.target.id === 'panicentry-vmode') syncThr(true); recompute(); });
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (D && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const raw = await requestJSON('data/panic_entry.json', { signal: context.signal });
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!raw?.date?.length) throw new Error('data/panic_entry.json 沒有資料');
    D = C.prepare(raw); cache = {}; baseCache = {};
    byId('asof').textContent = `資料到 ${D.date.at(-1)}（更新 ${raw.updated || '—'}）`;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); syncThr(true); recompute();
}
export function getCharts() { return Object.values(charts); }
export function resize() { for (const c of Object.values(charts)) c.resize(); }
export function onThemeChange() {
  if (!last) return;
  return preserveChartState(getCharts, () => {
    for (const c of Object.values(charts)) c.dispose();
    charts = {};
    drawAll();
  });
}
