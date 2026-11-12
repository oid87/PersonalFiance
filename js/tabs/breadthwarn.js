// 市場廣度與流動性預警 — 臺灣50／上市／上櫃「站上均線比例」的水準、下降速度、加速度，能不能在大跌前提早示警；
// 以及大盤回撤 −20% 之後，等廣度修復再買 00631L 有沒有比較好。
// 版面：今天的狀態 → 研究結論 → 參數 → 預警成績方塊 → 指標比較表 → 四格時間軸 → 預警事件表＋單一事件前後走勢
//       → 00631L 修復進場比較 → 2026/10–11 專題（圖＋逐日表）→ 口徑與限制。
// 計算：js/tabs/breadthwarn_calc.mjs（沿用 panicentry_calc.mjs）；資料：data/tw_breadth_warn.json、data/panic_entry.json、data/taiwan_margin_total.json。
import { echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import * as P from './panicentry_calc.mjs';
import * as W from './breadthwarn_calc.mjs';

const byId = id => document.getElementById('breadthwarn-' + id);
const val = id => byId(id).value;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950', ORANGE = '#f0883e', BLUE = '#58a6ff', PURPLE = '#a371f7';
const UCOL = { tw50: BLUE, twse: ORANGE, tpex: PURPLE };
const pct = (x, d = 1) => (finite(x) ? `${(x * 100).toFixed(d)}%`.replace('-', '−') : '—');
const spct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`.replace('-', '−') : '—');
const f1 = x => (finite(x) ? x.toFixed(1).replace('-', '−') : '—');
const sf1 = x => (finite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)}`.replace('-', '−') : '—');
const dir = x => (!finite(x) ? '' : x >= 0 ? 'breadthwarn-up' : 'breadthwarn-down');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const KIND = { speed: '下降速度', level: '絕對值', accel: '加速度' };
const CASE_FROM = '2026-09-15', CASE_TO = '2026-11-30';
const CASE_MARKS = [['2026-10-15', '10/15'], ['2026-10-28', '10/28'], ['2026-11-03', '11/3'], ['2026-11-05', '11/5 示警'], ['2026-11-06', '11/6']];

let D = null, Bx = null, MG = null, loadedAt = 0, cache = {}, charts = {}, last = null;

const cond = () => ({ kind: val('kind'), uni: val('uni'), ma: Number(val('ma')), N: Number(val('n')), thr: Number(val('thr')), nearHigh: val('near') ? Number(val('near')) / 100 : null });
const opts = () => ({ target: val('target'), H: Number(val('h')), cooldown: Number(val('cd')), from: Math.max(0, D.date.findIndex(d => d >= '2004-07-01')) });
function condLabel(c) {
  const u = W.UNIS[c.uni];
  if (c.kind === 'idxret') return `對照：加權指數 ${c.N} 日跌 ≥ ${c.thr}%`;
  if (c.kind === 'level') return `${u} 站上 ${c.ma} 日線的比例 ≤ ${c.thr}%`;
  if (c.kind === 'speed') return `${u} 站上 ${c.ma} 日線的比例，${c.N} 日內降 ≥ ${c.thr} 點`;
  return `${u} ${c.ma} 日線比例：近 5 日比前 5 日多降 ≥ ${c.thr} 點`;
}
const dd = () => cache.dd || (cache.dd = P.drawdown(D, 'i252'));
const ldAll = () => cache.ldAll || (cache.ldAll = D.date.map((_, i) => { const a = Bx.twse.ld[i], b = Bx.tpex.ld[i], na = Bx.twse.n[i], nb = Bx.tpex.n[i]; return a == null ? null : b == null ? a : (a * na + b * nb) / (na + nb); }));
function lastIdx() { let i = D.date.length - 1; while (i > 0 && Bx.tw50.a20[i] == null) i--; return i; }

// ── A 今天的狀態 ─────────────────────────────────────────────────────────
function renderNow() {
  const i = lastIdx(), b = Bx.tw50, d5 = W.delta(b.a60, 5)[i], d10 = W.delta(b.a60, 10)[i], c = cond(), ok = last.ok;
  let lastSig = null; for (let j = i; j >= 0; j--) if (ok[j]) { lastSig = j; break; }
  const e = last.e, o = last.o, wave = e.events.filter(x => lastSig != null && x <= lastSig).at(-1);
  const T = (k, v, sub = '', cls = '') => `<div class="breadthwarn-tile"><div class="breadthwarn-k">${k}</div><div class="breadthwarn-v ${cls}">${v}</div><div class="breadthwarn-s">${sub}</div></div>`;
  byId('now').innerHTML = `<b>${esc(D.date[i])}</b>　目前設定的預警（${esc(condLabel(c))}）今天<b class="${ok[i] ? 'breadthwarn-hit' : ''}">${ok[i] ? '成立' : '沒有成立'}</b>` +
    (lastSig != null && lastSig !== i ? `；最近一次成立是 ${esc(D.date[lastSig])}（${i - lastSig} 個交易日前）` : '') +
    (wave != null && wave !== lastSig ? `，這一波從 ${esc(D.date[wave])} 開始亮（下面的表每一波只列第一天）` : '') + '。' +
    `<br><span class="breadthwarn-dim">這個燈單獨看的參考價值：過去亮 ${e.n} 次，之後 ${o.H} 日內${W.TARGETS[o.target].label}的有 ${e.tp} 次（${pct(e.precision, 0)}）；隨便挑一天是 ${pct(e.base, 0)}。</span>`;
  byId('nowtiles').innerHTML = [
    T('臺灣50 站上 20 日線', f1(b.a20[i]) + '%', `上市 ${f1(Bx.twse.a20[i])}%・上櫃 ${f1(Bx.tpex.a20[i])}%`),
    T('臺灣50 站上 60 日線', f1(b.a60[i]) + '%', `上市 ${f1(Bx.twse.a60[i])}%・上櫃 ${f1(Bx.tpex.a60[i])}%`),
    T('5 日變化（60 日線比例）', sf1(d5) + ' 個百分點', '負＝站上的股票變少', dir(d5)),
    T('10 日變化（60 日線比例）', sf1(d10) + ' 個百分點', `上市 ${sf1(W.delta(Bx.twse.a60, 10)[i])}・上櫃 ${sf1(W.delta(Bx.tpex.a60, 10)[i])}`, dir(d10)),
    T('大盤距近一年高點', pct(dd()[i]), '盤中最低 ÷ 盤中最高'),
    T('上市股票創 20 日新低的比例', f1(Bx.twse.nl20[i]) + '%', `上櫃 ${f1(Bx.tpex.nl20[i])}%・臺灣50 ${f1(b.nl20[i])}%`),
    T('跌停家數占比', f1(ldAll()[i]) + '%', `上市＋上櫃；跌停而且成交量不到平常一半的（上市）${f1(Bx.twse.ldq[i])}%`),
  ].join('');
}

// ── 預警成績 ─────────────────────────────────────────────────────────────
function renderTiles() {
  const e = last.e, o = last.o, tg = W.TARGETS[o.target].label;
  const T = (k, v, sub = '') => `<div class="breadthwarn-tile"><div class="breadthwarn-k">${k}</div><div class="breadthwarn-v">${v}</div><div class="breadthwarn-s">${sub}</div></div>`;
  const caught = e.nEp ? Math.round(e.recall * e.nEp) : 0;
  byId('tiles').innerHTML = [
    T('預警次數', e.n, `平均一年 ${f1(e.perYear)} 次${e.pending ? `；另 ${e.pending} 次還沒滿 ${o.H} 日` : ''}`),
    T(`之後 ${o.H} 日內${tg}`, pct(e.precision, 0), e.n ? `${e.tp}／${e.n} 次；樣本誤差範圍 ${pct(e.ci[0], 0)}–${pct(e.ci[1], 0)}` : ''),
    T('對照：隨便挑一天', pct(e.base, 0), `同期間任一天之後 ${o.H} 日內發生的比例${finite(e.lift) ? `；預警是它的 ${e.lift.toFixed(1)} 倍` : ''}`),
    T('大跌前 40 日內亮過燈', `${caught}／${e.nEp} 場`, `看起來多，但同樣多的燈亂擺在任意日子，也有 ${finite(e.chanceRecall) ? Math.round(e.chanceRecall * e.nEp) : '—'}／${e.nEp} 場`),
    T('提前天數 中位', finite(e.leadMed) ? Math.round(e.leadMed) : '—', '第一次預警到大跌發生日（交易日）'),
    T(`預警後 ${o.H} 日最低點 中位`, pct(e.fwdMed), `最差一成 ${pct(e.fwdP10)}；最差 ${pct(e.fwdWorst)}`),
    T('誤報：沒事的日子裡亮燈的比例', pct(e.fpr), `所有日子有 ${pct(e.sigShare)} 處於預警狀態`),
  ].join('');
}
function renderCompare() {
  const c = cond(), o = last.o;
  const list = [['目前設定', c], ...['tw50', 'twse', 'tpex'].filter(u => u !== c.uni).map(u => [null, { ...c, uni: u }]),
    ...['speed', 'level', 'accel'].filter(k => k !== c.kind).map(k => [null, { ...c, kind: k, nearHigh: c.nearHigh, thr: k === 'level' ? 30 : k === 'speed' ? 30 : 30, N: k === 'accel' ? 5 : c.N }]),
    [null, { kind: 'idxret', N: 5, thr: 5 }], [null, { kind: 'idxret', N: 10, thr: 7 }]];
  const rows = list.map(([nm, k], idx) => {
    const e = W.evaluate(D, W.warnDays(D, Bx, k, cache), o, cache);
    return `<tr class="${idx === 0 ? 'breadthwarn-base' : e.n < 5 ? 'breadthwarn-thin' : ''}"><td>${nm ? `<b>${nm}</b>：` : ''}${esc(condLabel(k))}${k.nearHigh ? `<span class="breadthwarn-dim">（指數距高點 ${k.nearHigh * 100}% 內）</span>` : ''}</td><td>${e.n}</td><td>${f1(e.perYear)}</td><td>${pct(e.precision, 0)}</td><td>${pct(e.base, 0)}</td><td>${finite(e.lift) ? e.lift.toFixed(1) : '—'}</td><td>${e.nEp ? Math.round(e.recall * e.nEp) : 0}／${e.nEp}</td><td>${pct(e.chanceRecall, 0)}</td><td>${finite(e.leadMed) ? Math.round(e.leadMed) : '—'}</td><td>${pct(e.fwdMed)}</td></tr>`;
  });
  byId('cmp').innerHTML = `<table><thead><tr><th>預警條件</th><th>次數</th><th>每年</th><th>命中率</th><th>隨便挑一天</th><th>比隨便猜準幾倍</th><th>大跌前亮過燈</th><th>燈亂擺也有</th><th>提前日數中位</th><th>之後最低點中位</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// ── 圖 ───────────────────────────────────────────────────────────────────
function chart(key) { if (!charts[key]) charts[key] = echarts.init(byId(key + '-chart')); return charts[key]; }
const AX = () => ({ axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } } });
const ttl = (t, top, L) => ({ text: t, left: L, top, textStyle: { color: PALETTE.muted, fontSize: 12, fontWeight: 'normal' } });
const line = (name, data, gi, color, extra = {}) => ({ type: 'line', name, data, symbol: 'none', connectNulls: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1.3, color }, itemStyle: { color }, ...extra });
function drawMain() {
  const { c, o, e } = last, s0 = o.from, dates = D.date.slice(s0), m = mob(), L = m ? 52 : 60, R = m ? 12 : 18, ax = AX();
  const sp = W.metric(D, Bx, c.kind === 'level' ? { ...c, kind: 'speed' } : c, cache).slice(s0);
  const mg = D.date.map((d, i) => { const a = MG?.get(d), b = MG?.get(D.date[i - 10]); return a && b ? +((a / b - 1) * 100).toFixed(2) : null; }).slice(s0);
  const tops = ['1%', '37%', '58%', '79%'], z0 = Math.max(0, dates.length - 735);   // 預設顯示最近約 3 年，拉桿可看全部
  chart('main').setOption(echartsBase({
    title: [ttl('加權指數｜橘線＝預警日（每一波第一天）', tops[0], L), ttl(m ? `站上 ${c.ma} 日線（%）` : `站上 ${c.ma} 日線的比例（%）`, tops[1], L), ttl(c.kind === 'accel' ? `加速度（近 5 日變化 − 前 5 日變化，點）｜${W.UNIS[c.uni]}` : `${c.N} 日變化（點）｜${W.UNIS[c.uni]}`, tops[2], L), ttl('融資餘額 10 日變化（%）', tops[3], L)],
    legend: { top: tops[1], right: R, data: Object.values(W.UNIS), textStyle: { color: PALETTE.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: '5%', height: '28%' }, { left: L, right: R, top: '41%', height: '13%' }, { left: L, right: R, top: '62%', height: '13%' }, { left: L, right: R, top: '83%', height: '9%' }],
    xAxis: [0, 1, 2, 3].map(gi => ({ type: 'category', data: dates, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 3, color: PALETTE.muted, fontSize: 11, hideOverlap: true, formatter: v => String(v).slice(0, 7) } })),
    yAxis: [{ type: 'value', gridIndex: 0, scale: true, ...ax }, { type: 'value', gridIndex: 1, min: 0, max: 100, splitNumber: 2, ...ax }, { type: 'value', gridIndex: 2, scale: true, splitNumber: 3, ...ax }, { type: 'value', gridIndex: 3, scale: true, splitNumber: 2, ...ax }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2, 3], filterMode: 'none', startValue: z0 }, { type: 'slider', xAxisIndex: [0, 1, 2, 3], height: 18, bottom: 6, startValue: z0 }],
    series: [
      line('加權收盤', D.tw_c.slice(s0), 0, PALETTE.muted, { markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: ORANGE, width: 1, type: 'solid', opacity: 0.7 }, data: e.events.map(i => ({ xAxis: D.date[i] })) } }),
      ...Object.keys(W.UNIS).map(u => line(W.UNIS[u], Bx[u]['a' + c.ma].slice(s0), 1, UCOL[u], { lineStyle: { width: u === c.uni ? 1.6 : 1, color: UCOL[u], opacity: u === c.uni ? 1 : 0.55 },
        markLine: u === c.uni && c.kind === 'level' ? { symbol: 'none', silent: true, lineStyle: { color: PALETTE.muted, type: 'dashed' }, label: { color: PALETTE.muted, formatter: `${c.thr}%` }, data: [{ yAxis: c.thr }] } : undefined })),
      line(c.kind === 'accel' ? '加速度' : `${c.N} 日變化`, sp, 2, UCOL[c.uni], { areaStyle: { opacity: 0.12 }, markLine: c.kind !== 'level' ? { symbol: 'none', silent: true, lineStyle: { color: PALETTE.muted, type: 'dashed' }, label: { color: PALETTE.muted, position: 'insideEndTop', formatter: `門檻 −${c.thr}` }, data: [{ yAxis: -c.thr }] } : undefined }),
      line('融資餘額 10 日變化', mg, 3, PALETTE.muted, { areaStyle: { opacity: 0.12 } }),
    ],
  }), true);
}
function drawEvent() {
  const i = Number(val('ev')), c = last.c, ax = AX(), m = mob(), L = m ? 46 : 54;
  if (!Number.isFinite(i) || !val('ev')) { chart('ev').clear(); return; }
  const a = Math.max(0, i - 30), b = Math.min(D.date.length - 1, i + 60), xs = [], px = [], br = [];
  for (let j = a; j <= b; j++) { xs.push(D.date[j]); px.push(+((D.tw_c[j] / D.tw_c[i] - 1) * 100).toFixed(2)); br.push(Bx[c.uni]['a' + c.ma][j]); }
  chart('ev').setOption(echartsBase({
    title: [ttl('加權指數：相對預警日收盤（%）', '1%', L), ttl(`${W.UNIS[c.uni]} 站上 ${c.ma} 日線的比例（%）`, '56%', L)],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: 14, top: '9%', height: '40%' }, { left: L, right: 14, top: '64%', height: '24%' }],
    xAxis: [0, 1].map(gi => ({ type: 'category', data: xs, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 1, color: PALETTE.muted, fontSize: 11, hideOverlap: true, formatter: v => String(v).slice(5) } })),
    yAxis: [{ type: 'value', gridIndex: 0, scale: true, ...ax }, { type: 'value', gridIndex: 1, min: 0, max: 100, ...ax }],
    dataZoom: [],
    series: [line('加權指數', px, 0, PALETTE.muted, { markLine: { symbol: 'none', silent: true, lineStyle: { color: ORANGE, width: 1.5, type: 'solid' }, label: { color: PALETTE.muted, formatter: '預警日' }, data: [{ xAxis: D.date[i] }] } }),
      line('廣度', br, 1, UCOL[c.uni], { areaStyle: { opacity: 0.12 } })],
  }), true);
}
function drawCase() {
  const a = D.date.findIndex(d => d >= CASE_FROM); let b = D.date.length - 1; while (b > a && D.date[b] > CASE_TO) b--;
  if (a < 0) return;
  const xs = D.date.slice(a, b + 1), sl = arr => arr.slice(a, b + 1), ax = AX(), m = mob(), L = m ? 50 : 58, R = m ? 12 : 18, ld = ldAll();
  const marks = CASE_MARKS.filter(([d]) => xs.includes(d)).map(([d, t]) => ({ xAxis: d, label: { formatter: t } }));
  const tops = ['1%', '30%', '54%', '78%'];
  chart('case').setOption(echartsBase({
    title: [ttl('加權指數收盤', tops[0], L), ttl(m ? '站上 60 日線（%）' : '站上 60 日線的比例（%）', tops[1], L), ttl('創 20 日新低的股票占比（%）', tops[2], L), ttl('跌停家數占比（%，上市＋上櫃）', tops[3], L)],
    legend: { top: tops[1], right: R, data: Object.values(W.UNIS), textStyle: { color: PALETTE.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: '6%', height: '19%' }, { left: L, right: R, top: '35%', height: '15%' }, { left: L, right: R, top: '59%', height: '15%' }, { left: L, right: R, top: '83%', height: '10%' }],
    xAxis: [0, 1, 2, 3].map(gi => ({ type: 'category', data: xs, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 3, color: PALETTE.muted, fontSize: 11, hideOverlap: true, formatter: v => String(v).slice(5) } })),
    yAxis: [{ type: 'value', gridIndex: 0, scale: true, ...ax }, { type: 'value', gridIndex: 1, min: 0, max: 100, ...ax }, { type: 'value', gridIndex: 2, min: 0, ...ax }, { type: 'value', gridIndex: 3, min: 0, ...ax }],
    dataZoom: [],
    series: [
      line('加權收盤', sl(D.tw_c).map(x => Math.round(x)), 0, PALETTE.muted, { markLine: { symbol: 'none', silent: true, lineStyle: { color: ORANGE, width: 1, type: 'dashed' }, label: { color: PALETTE.muted, fontSize: 11 }, data: marks } }),
      ...Object.keys(W.UNIS).map(u => line(W.UNIS[u], sl(Bx[u].a60), 1, UCOL[u])),
      ...Object.keys(W.UNIS).map(u => line(W.UNIS[u], sl(Bx[u].nl20), 2, UCOL[u])),
      { type: 'bar', name: '跌停占比', data: sl(ld).map(x => (x == null ? null : +x.toFixed(2))), xAxisIndex: 3, yAxisIndex: 3, barMaxWidth: 10, itemStyle: { color: GREEN, borderRadius: [3, 3, 0, 0] } },
    ],
  }), true);
  const sig = W.warnDays(D, Bx, { kind: 'speed', uni: 'tw50', ma: 60, N: 10, thr: 30 }, cache), key = new Set(CASE_MARKS.map(x => x[0])), d5 = W.delta(Bx.tw50.a60, 5), d10 = W.delta(Bx.tw50.a60, 10);
  const rows = []; for (let i = D.date.findIndex(d => d >= '2026-10-01'); i >= 0 && i <= b; i++) {
    const g = MG?.get(D.date[i]), gp = MG?.get(D.date[i - 1]);
    rows.push(`<tr class="${key.has(D.date[i]) ? 'breadthwarn-base' : ''}"><td>${D.date[i].slice(5)}</td><td>${Math.round(D.tw_c[i]).toLocaleString()}</td><td>${pct(dd()[i])}</td><td>${f1(Bx.tw50.a20[i])}</td><td>${f1(Bx.tw50.a60[i])}</td><td class="${dir(d5[i])}">${sf1(d5[i])}</td><td class="${dir(d10[i])}">${sf1(d10[i])}</td><td>${f1(Bx.twse.a60[i])}</td><td>${f1(Bx.tpex.a60[i])}</td><td>${f1(Bx.twse.nl20[i])}</td><td>${f1(Bx.tpex.nl20[i])}</td><td>${f1(ld[i])}</td><td>${finite(Bx.twse.volr[i]) ? Bx.twse.volr[i].toFixed(2) : '—'}</td><td>${g ? Math.round(g).toLocaleString() : '—'}</td><td class="${dir(g && gp ? g - gp : null)}">${g && gp ? sf1(g - gp).replace(/\.\d/, '') : '—'}</td><td>${sig[i] ? '●' : ''}</td></tr>`);
  }
  byId('casetable').innerHTML = `<table><thead><tr><th>日期</th><th>加權收盤</th><th>距高點</th><th>臺灣50 20日線</th><th>臺灣50 60日線</th><th>5 日變化</th><th>10 日變化</th><th>上市 60日線</th><th>上櫃 60日線</th><th>上市新低</th><th>上櫃新低</th><th>跌停占比</th><th>量比</th><th>融資餘額（億）</th><th>日增減</th><th>預警</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function drawAll() { drawMain(); drawEvent(); drawCase(); }

// ── D 事件表 ─────────────────────────────────────────────────────────────
function renderEvents() {
  const { e, o, c } = last, y = W.labels(D, o.target, o.H, cache), fw = W.forward(D, o.H, cache), s = W.metric(D, Bx, c, cache);
  const lead = new Map(e.episodes.filter(x => x.first != null).map(x => [x.first, x]));
  const evs = [...e.events].reverse();
  byId('events').innerHTML = `<table><thead><tr><th>預警日</th><th>指標值</th><th>當天指數距高點</th><th>之後 ${o.H} 日最低</th><th>結果</th><th>之後的大跌發生日</th></tr></thead><tbody>${evs.map(i => {
    const hit = y[i], L = lead.get(i);
    return `<tr><td>${D.date[i]}</td><td>${c.kind === 'level' ? f1(s[i]) + '%' : sf1(s[i])}</td><td>${pct(dd()[i])}</td><td>${pct(fw.fwdMin[i])}</td><td class="${hit ? 'breadthwarn-hit' : ''}">${hit == null ? '還沒滿期' : hit ? '命中' : '誤報'}</td><td>${L ? `${L.lead} 日後（${D.date[L.onset]}）` : '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
  const sel = byId('ev'), keep = sel.value;
  sel.innerHTML = evs.map(i => `<option value="${i}">${D.date[i]}　${y[i] == null ? '還沒滿期' : y[i] ? '命中' : '誤報'}</option>`).join('');
  if (evs.includes(Number(keep))) sel.value = keep;
}

// ── E 00631L 修復進場 ────────────────────────────────────────────────────
function renderRepair() {
  const asset = val('rasset'), H = Number(val('rh')), thr = -Number(val('rdd')) / 100;
  const from = D.date.findIndex(d => d >= (asset === 'lev' ? '2014-11-03' : '2004-07-01'));
  const { ev, rows } = W.repairCompare(D, Bx, { ddThr: thr, uni: val('uni'), H, asset, from }, cache);
  const base = W.repairSummary(rows.A);
  byId('repair').innerHTML = `<table><thead><tr><th>買法</th><th>完整／事件</th><th>沒等到訊號</th><th>上漲機率</th><th>報酬中位</th><th>平均</th><th>中途最深 中位</th><th>最差一成</th><th>最差</th><th>等待日中位</th><th>進場價比直接買（負＝較便宜）</th></tr></thead><tbody>${Object.keys(W.REPAIRS).map(k => {
    const s = W.repairSummary(rows[k]);
    return `<tr class="${k === 'A' ? 'breadthwarn-base' : ''}"><td>${k}　${esc(W.REPAIRS[k])}</td><td>${s.n}／${s.nEv}</td><td>${k === 'A' ? '—' : s.noConfirm}</td><td>${pct(s.win, 0)}</td><td class="${dir(s.median)}">${spct(s.median)}</td><td>${spct(s.mean)}</td><td>${pct(s.maeMed)}${k !== 'A' && finite(s.maeMed) ? `<span class="breadthwarn-dim">（${sf1((s.maeMed - base.maeMed) * 100)}）</span>` : ''}</td><td>${pct(s.maeP90)}</td><td>${pct(s.maeWorst)}</td><td>${k === 'A' ? '0' : finite(s.waitMed) ? Math.round(s.waitMed) : '—'}</td><td>${k === 'A' || k === 'F' ? '—' : spct(s.missedMed)}</td></tr>`;
  }).join('')}</tbody></table>`;
  byId('repairnote').textContent = `${asset === 'lev' ? '00631L' : '模擬正二'}，回撤 ≤ −${val('rdd')}% 的事件 ${ev.length} 次（同一波 60 日內只算一次），每種買法都用同一批事件；持有 ${H} 個交易日，從各自的進場日起算。廣度＝${W.UNIS[val('uni')]}站上 20 日線的比例。括號是中途最深跌幅比「直接買」淺（＋）或深（−）幾個百分點。`;
  byId('repairev').innerHTML = `<table><thead><tr><th>事件日</th>${Object.keys(W.REPAIRS).map(k => `<th>${k} 進場日</th><th>報酬</th><th>中途最深</th>`).join('')}</tr></thead><tbody>${ev.map((i, n) => `<tr><td>${D.date[i]}</td>${Object.keys(W.REPAIRS).map(k => { const x = rows[k][n]; return x.t ? `<td>${x.t.entryDate.slice(2)}</td><td class="${dir(x.t.complete ? x.t.ret : null)}">${x.t.complete ? spct(x.t.ret, 0) : '未滿'}</td><td>${pct(x.t.mae, 0)}</td>` : '<td colspan="3">還沒等到</td>'; }).join('')}</tr>`).reverse().join('')}</tbody></table>`;
}

function syncThr(reset) {
  const s = byId('thr'), k = val('kind');
  if (k === 'level') { s.min = 5; s.max = 60; if (reset) s.value = 30; } else { s.min = 5; s.max = 70; if (reset) s.value = 30; }
  byId('n').disabled = k !== 'speed';
}
function recompute() {
  const c = cond(), o = opts();
  byId('thrv').textContent = c.kind === 'level' ? `比例 ≤ ${c.thr}%` : `下降 ≥ ${c.thr} 個百分點`;
  const ok = W.warnDays(D, Bx, c, cache), e = W.evaluate(D, ok, o, cache);
  last = { c, o, ok, e };
  const w = [];
  if (c.uni === 'tpex') w.push('上櫃 2008-07 以前檔數不足，從那之後才有訊號。');
  if (c.uni === 'tw50') w.push('臺灣50 在 2012-12-24 以前沿用 2012 年底的成分股名單（不是當時真正的名單），那段結果偏樂觀。');
  if (e.n < 10) w.push(`只有 ${e.n} 次預警，命中率的誤差很大。`);
  byId('warn').innerHTML = w.map(esc).join('<br>');
  byId('setup').textContent = `目前設定：${condLabel(c)}${c.nearHigh ? `，而且指數距高點在 ${c.nearHigh * 100}% 以內` : ''}；看之後 ${o.H} 個交易日內是否${W.TARGETS[o.target].label}；同一波 ${o.cooldown} 日內只算一次；2004-07 起。`;
  renderNow(); renderTiles(); renderCompare(); renderEvents(); renderRepair(); drawAll();
}
function wire() {
  if (!bindOnce(byId('params'))) return;
  byId('params').addEventListener('input', ev => { if (ev.target.id === 'breadthwarn-kind') syncThr(true); recompute(); });
  byId('rparams').addEventListener('input', renderRepair);
  byId('ev').addEventListener('input', drawEvent);
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (D && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const o = { signal: context.signal };
    const [raw, B, mg] = await Promise.all([requestJSON('data/panic_entry.json', o), requestJSON('data/tw_breadth_warn.json', o), requestJSON('data/taiwan_margin_total.json', o).catch(() => null)]);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!raw?.date?.length || !B?.date?.length) throw new Error('廣度或價格資料是空的');
    // 以兩份資料都有的最後一天為準
    const lastDay = raw.date.at(-1) < B.date.at(-1) ? raw.date.at(-1) : B.date.at(-1), cut = raw.date.findIndex(d => d > lastDay);
    if (cut > 0) for (const k of Object.keys(raw)) if (Array.isArray(raw[k]) && raw[k].length === raw.date.length && k !== 'date') raw[k] = raw[k].slice(0, cut);
    if (cut > 0) raw.date = raw.date.slice(0, cut);
    D = P.prepare(raw); Bx = W.attach(D, B); cache = {};
    MG = mg?.data ? new Map(mg.data.filter(r => finite(r.margin_money)).map(r => [r.date, r.margin_money])) : null;
    byId('asof').textContent = `資料到 ${D.date.at(-1)}（廣度更新 ${B.updated || '—'}）${MG ? '' : '；融資資料載入失敗，第四格空白'}`;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); syncThr(false); recompute();
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
