// 市場廣度與流動性預警 — 臺灣50／上市／上櫃「站上均線比例」的水準、下降速度、加速度，能不能在大跌前提早示警；
// 以及大盤回撤 −20% 之後，等廣度修復再買 00631L 有沒有比較好。
// 版面：今天的狀態 → 研究結論 → 參數 → 預警成績方塊 → 指標比較表 → 四格時間軸 → 預警事件表＋單一事件前後走勢
//       → 00631L 修復進場比較 → 2026/10–11 專題（圖＋壓力時間軸＋逐日表）→ 資料品質 → 口徑與限制。
// V2：今天的流動性壓力、模型比較（只看大盤 vs 加廣度／跌停／融資）、跌停降溫與融資放緩買法、資料真實／代理標示。
// 計算：js/tabs/breadthwarn_calc.mjs（沿用 panicentry_calc.mjs）；資料：data/tw_breadth_warn.json（廣度、跌停、lock、mg）、data/panic_entry.json、
//       data/taiwan_margin_total{,_early}.json（上市融資餘額）、data/tw_breadth_warn_models.json（離線研究的模型比較結果）。
import { echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import * as Live from './breadthwarn_live.js';
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
const CASE_MARKS = [['2026-10-15', '10/15'], ['2026-10-20', '10/20'], ['2026-10-28', '10/28'], ['2026-10-30', '10/30'], ['2026-11-03', '11/3'], ['2026-11-05', '11/5'], ['2026-11-06', '11/6']];
// 資料性質標籤：真實（交易所公布）與代理（由價量推算）用不同顏色與線型，不混用
const TAG = { real: '<span class="breadthwarn-tag breadthwarn-tag--real">真實</span>', proxy: '<span class="breadthwarn-tag breadthwarn-tag--proxy">代理</span>', est: '<span class="breadthwarn-tag breadthwarn-tag--est">估計</span>', na: '<span class="breadthwarn-tag breadthwarn-tag--na">無資料</span>' };
const REAL = BLUE, PROXY = ORANGE;

let D = null, Bx = null, MG = null, MGx = null, FLOW = null, MODELS = null, BMETA = null, loadedAt = 0, cache = {}, charts = {}, last = null;

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
  const recent = lastSig != null && i - lastSig <= 5, sc = stress().score[i], scAll = stress().score, scPr = W.rollPct(scAll.slice(Math.max(0, i - 1259), i + 1), 1260, 250).at(-1), scTxt = finite(sc) ? `流動性壓力分數 <b>${Math.round(sc * 100)}</b>（0–100，越高代表跌停、融資減少、廣度惡化越嚴重${finite(scPr) ? `；比過去 5 年 ${Math.round(scPr * 100)}% 的日子都高` : ''}）` : '';
  byId('now').innerHTML = `<b>${esc(D.date[i])}</b>　廣度預警：<b class="${ok[i] || recent ? 'breadthwarn-hit' : ''}">${ok[i] ? '今天亮燈' : recent ? '這幾天剛亮過，今天沒亮' : '沒有亮燈'}</b>（條件：${esc(condLabel(c))}）` +
    (lastSig != null && lastSig !== i ? `；最近一次亮是 ${esc(D.date[lastSig])}（${i - lastSig} 個交易日前）` : '') +
    (wave != null && wave !== lastSig ? `，這一波從 ${esc(D.date[wave])} 開始` : '') + '。' + (scTxt ? `<br>${scTxt}。這兩個數字描述的是「現在壓力多大」，下面的回測顯示它們不能預測接下來會不會再跌。` : '') +
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

// ── 今天的流動性壓力 ─────────────────────────────────────────────────────
const stress = () => W.stressScore(Bx, MGx || { chg5: D.date.map(() => null) }, cache);
function lastWith(arr, i) { let j = i; while (j > 0 && arr[j] == null) j--; return arr[j] == null ? null : j; }
function renderLiq() {
  const i = lastIdx(), t = Bx.twse, o = Bx.tpex, S = stress(), mj = MGx ? lastWith(MGx.bal, i) : null;
  const T = (k, tag, v, sub = '', cls = '') => `<div class="breadthwarn-tile"><div class="breadthwarn-k">${k} ${tag}</div><div class="breadthwarn-v ${cls}">${v}</div><div class="breadthwarn-s">${sub}</div></div>`;
  const pr = (arr, x) => { const r = W.rollPct(arr.slice(Math.max(0, i - 1259), i + 1), 1260, 250).at(-1); return finite(r) ? `近 5 年裡高於 ${Math.round(r * 100)}% 的日子` : ''; };
  const lk = lastWith(t.lock, i), lko = lastWith(o.lock, i), f = FLOW, fj = f ? lastWith(f.sell, i) : null;
  const sc = S.score[i];
  byId('liq').innerHTML = [
    T('跌停家數占比', TAG.proxy, `${f1(t.ld[i])}%`, `上市；上櫃 ${f1(o.ld[i])}%。${pr(t.ld)}`),
    T('近 5 日曾跌停的股票', TAG.proxy, `${f1(t.ld5u[i])}%`, `上市，同一檔只算一次；上櫃 ${f1(o.ld5u[i])}%`),
    T('低量跌停', TAG.proxy, `${f1(t.ldq[i])}%`, '跌停而且成交量不到平常一半（上市）'),
    T('收盤沒有買單的跌停', lk != null ? TAG.real : TAG.na, lk != null ? `${f1(t.lock[lk])}%` : '—', lk != null ? `交易所行情，${D.date[lk].slice(5)}；上櫃 ${lko != null ? f1(o.lock[lko]) + '%' : '—'}` : '官方行情還沒取得'),
    T('融資餘額單日變化', mj != null ? TAG.real : TAG.na, mj != null && finite(MGx.amt1[mj]) ? `${MGx.amt1[mj] > 0 ? '+' : '−'}${Math.abs(Math.round(MGx.amt1[mj])).toLocaleString()} 億` : '—', mj != null ? `上市，${D.date[mj].slice(5)} 當晚公布（${sf1(MGx.chg1[mj])}%）` : '', mj != null ? dir(MGx.amt1[mj]) : ''),
    T('融資餘額 5 日變化', mj != null ? TAG.real : TAG.na, mj != null ? `${sf1(MGx.chg5[mj])}%` : '—', mj != null ? `10 日 ${sf1(MGx.chg10[mj])}%` : '', mj != null ? dir(MGx.chg5[mj]) : ''),
    T('融資賣出＋現金償還', fj != null ? TAG.real : TAG.na, fj != null ? `${Math.round(f.sell[fj] + f.repay[fj]).toLocaleString()} 億` : '—', fj != null ? `${D.date[fj].slice(5)}；同日融資買進 ${Math.round(f.buy[fj]).toLocaleString()} 億` : '買賣與償還明細還沒取得'),
    T('廣度惡化（臺灣50，10 日）', TAG.proxy, `${sf1(W.delta(Bx.tw50.a60, 10)[i])} 點`, '站上 60 日線比例的變化', dir(W.delta(Bx.tw50.a60, 10)[i])),
    T('流動性壓力分數', TAG.proxy, finite(sc) ? Math.round(sc * 100) : '—', '0–100，越高壓力越大；跌停、低量跌停、融資減少、廣度惡化、下跌成交值五項和過去 5 年相比的平均排名'),
  ].join('');
}

// ── 歷史預警比較：只看大盤 vs 加上廣度／跌停／融資（離線研究結果）────────────
function renderModels() {
  const host = byId('models');
  if (!MODELS) { host.innerHTML = '<p class="breadthwarn-note">模型比較結果載入失敗。</p>'; return; }
  const key = `${val('mscheme')}|${val('mtarget')}`, rows = MODELS.models[key] || {}, base = rows['M0 只有大盤'];
  const two = x => (finite(x) ? x.toFixed(2) : '—');
  host.innerHTML = `<table><thead><tr><th>用什麼資訊</th><th>比「只有大盤」好嗎</th><th>分辨力（0.5＝丟銅板）</th><th>排序準確度</th><th>警報後真的發生</th><th>誤報率</th><th>每年警報</th><th>事前有警報的場數</th></tr></thead><tbody>${Object.entries(rows).map(([k, r]) => {
    if (!r) return `<tr class="breadthwarn-thin"><td>${esc(k)}</td><td colspan="7">樣本不足，無法判定</td></tr>`;
    const v = r.vs_m0, verdict = !v ? (k === 'M0 只有大盤' ? '基準' : '—') : v.d_pr[0] > 0 && v.d_auc[0] > 0 ? '<b>較好</b>' : v.d_pr[1] < 0 && v.d_auc[1] < 0 ? '較差' : '分不出來';
    return `<tr class="${k === 'M0 只有大盤' ? 'breadthwarn-base' : ''}"><td>${esc(k)}</td><td>${verdict}${v ? `<span class="breadthwarn-dim">（${v.d_auc[0] > 0 ? '+' : ''}${v.d_auc[0].toFixed(2)}～${v.d_auc[1] > 0 ? '+' : ''}${v.d_auc[1].toFixed(2)}）</span>` : ''}</td><td>${two(r.auc)}</td><td>${two(r.pr)}<span class="breadthwarn-dim">（亂猜 ${two(r.base)}）</span></td><td>${r.tp}／${r.alerts} 次</td><td>${pct(r.fpr, 0)}</td><td>${f1(r.per_year)}</td><td>${Math.round((r.recall || 0) * r.episodes)}／${r.episodes}</td></tr>`;
  }).join('')}</tbody></table>`;
  const sk = `${val('mtarget')}|${val('mscheme') === 'walk' ? '2010-2026' : '2004-2011'}`, single = MODELS.single[sk];
  byId('single').innerHTML = single ? `<table><thead><tr><th>單一指標（不訓練）</th><th>分辨力</th><th>排序準確度</th></tr></thead><tbody>${Object.entries(single).sort((a, b) => (b[1].auc || 0) - (a[1].auc || 0)).map(([k, r]) => `<tr class="${k === '回撤深度' ? 'breadthwarn-base' : ''}"><td>${esc(k)}</td><td>${two(r.auc)}</td><td>${two(r.pr)}</td></tr>`).join('')}</tbody></table>` : '<p class="breadthwarn-note">這個目標沒有單一指標比較。</p>';
  byId('modelnote').textContent = base ? `測試期 ${val('mscheme') === 'walk' ? '2010–2026（每年只用該年以前的資料訓練）' : '2004-07～2011（用 2012 年以後的資料訓練，專看 2008 與 2011）'}，共 ${base.n.toLocaleString()} 個交易日，其中 ${base.pos} 天之後真的發生（${pct(base.base, 0)}）。警報＝模型分數落在訓練期最高的 5%，同一波 20 日內只算一次；警報次數很少，所以只列次數不列百分比。「事前有警報的場數」只算發生前 ${val('mtarget').split('_')[1]} 日內，和上面「大跌前 40 日內亮過燈」的算法不同，不能直接比。` : '這個組合的樣本不足。';
}

// ── 資料品質 ─────────────────────────────────────────────────────────────
function renderQuality() {
  const m = BMETA || {}, nby = m.n_by_year || {}, blocks = m.official_blocks || {}, n50 = m.tw50_n_by_year || {};
  const span = arr => { let a = arr.findIndex(x => x != null), b = arr.length - 1; while (b > a && arr[b] == null) b--; return a < 0 ? '—' : `${D.date[a]}～${D.date[b]}`; };
  const cnt = arr => arr.filter(x => x != null).length;
  const blk = u => (blocks[u] || []).map(x => `${x[0]}～${x[1]}`).join('、') || '—';
  const rows = [
    ['臺灣50 成分股名單', TAG.real, `${m.tw50_verified_from || '—'} 起`, '每次異動逐筆還原，和證交所當時公布的完整名單逐檔相同。當天名單內有價格的檔數中位：' + ['2008', '2011', '2015', '2026'].map(y => `${y} 年 ${n50[y] ?? '—'}`).join('、')],
    ['臺灣50 成分股名單（更早）', TAG.est, `${m.tw50_pit_from || '—'}～${m.tw50_verified_from || '—'}`, m.tw50_early_note || '只有次級來源'],
    ['上市／上櫃股價（現存股票）', TAG.real, '2004-01 起', `Yahoo 還原收盤。有效檔數中位：上市 2008 年 ${nby.twse?.['2008'] ?? '—'}、2026 年 ${nby.twse?.['2026'] ?? '—'}；上櫃 2008 年 ${nby.tpex?.['2008'] ?? '—'}、2026 年 ${nby.tpex?.['2026'] ?? '—'}`],
    ['已下市櫃股票', TAG.real, '2004-01 起', m.delisted_note || 'FinMind 原始價（未還原）'],
    ['官方每日行情（當時全部掛牌股票）', TAG.real, `上市 ${blk('twse')}；上櫃 ${blk('tpex')}`, `這些區段的範圍是當時真正掛牌的股票，沒有倖存者偏誤；補進前兩項都沒有的股票：上市 ${m.official_added?.twse ?? '—'} 檔、上櫃 ${m.official_added?.tpex ?? '—'} 檔。其他年度仍可能缺少已下市櫃股票`],
    ['跌停、低量跌停、量比、下跌成交值、集中度', TAG.proxy, '2004-01 起', '由收盤報酬與成交量推算，不是委託簿'],
    ['收盤沒有買單的跌停', TAG.real, `上市 ${span(Bx.twse.lock)}（${cnt(Bx.twse.lock)} 天）`, '交易所收盤行情的「最後揭示買價」空白；只有抓過官方行情的日子才有'],
    ['上市融資餘額、張數', TAG.real, MGx ? span(MGx.bal) : '—', '當晚公布，隔天才能用'],
    ['融資買進／賣出／現金償還', FLOW && cnt(FLOW.sell) ? TAG.real : TAG.na, FLOW ? span(FLOW.sell) : '—', FLOW ? `${cnt(FLOW.sell)} 天` : '還沒取得'],
    ['整戶擔保維持率', TAG.est, '—', '只有用個股融資餘額與股價重建的估計（見「台股融資警報」頁），這頁沒有使用'],
    ['追繳戶數、處分（斷頭）戶數', TAG.na, '—', '交易所與券商都沒有公開的每日歷史資料，無法驗證'],
    ['委託簿深度、未成交委賣', TAG.na, '—', '沒有免費的歷史資料'],
  ];
  byId('quality').innerHTML = `<table><thead><tr><th>資料</th><th>性質</th><th>期間</th><th>說明</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="breadthwarn-wrap">${esc(r[3])}</td></tr>`).join('')}</tbody></table>`;
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
    return `<tr class="${idx === 0 ? 'breadthwarn-base' : e.n < 5 ? 'breadthwarn-thin' : ''}"><td>${nm ? `<b>${nm}</b>：` : ''}${esc(condLabel(k))}${k.nearHigh ? `<span class="breadthwarn-dim">（指數距高點 ${k.nearHigh * 100}% 內）</span>` : ''}</td><td>${pct(e.precision, 0)}</td><td>${pct(e.base, 0)}</td><td>${finite(e.lift) ? e.lift.toFixed(1) : '—'}</td><td>${e.n}</td><td>${f1(e.perYear)}</td><td>${e.nEp ? Math.round(e.recall * e.nEp) : 0}／${e.nEp}</td><td>${pct(e.chanceRecall, 0)}</td><td>${finite(e.leadMed) ? Math.round(e.leadMed) : '—'}</td><td>${pct(e.fwdMed)}</td></tr>`;
  });
  byId('cmp').innerHTML = `<table><thead><tr><th>預警條件</th><th>命中率</th><th>隨便挑一天</th><th>比隨便猜準幾倍</th><th>次數</th><th>每年</th><th>大跌前亮過燈</th><th>燈亂擺也有</th><th>提前日數中位</th><th>之後最低點中位</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
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
    title: [ttl('加權指數收盤', tops[0], L), ttl(m ? '站上 60 日線（%）' : '站上 60 日線的比例（%）', tops[1], L), ttl('創 20 日新低的股票占比（%）', tops[2], L), ttl('跌停家數占比（%，上市＋上櫃，代理）', tops[3], L)],
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
      { type: 'bar', name: '跌停占比', data: sl(ld).map(x => (x == null ? null : +x.toFixed(2))), xAxisIndex: 3, yAxisIndex: 3, barMaxWidth: 10, itemStyle: { color: PROXY, borderRadius: [3, 3, 0, 0] } },
    ],
  }), true);
  const sig = W.warnDays(D, Bx, { kind: 'speed', uni: 'tw50', ma: 60, N: 10, thr: 30 }, cache), key = new Set(CASE_MARKS.map(x => x[0])), d5 = W.delta(Bx.tw50.a60, 5), d10 = W.delta(Bx.tw50.a60, 10);
  const S = stress().score, lk = lockAll(), t = Bx.twse, x1 = v => (finite(v) ? v.toFixed(1) : '—'), x2 = v => (finite(v) ? v.toFixed(2) : '—');
  const rows = []; for (let i = D.date.findIndex(d => d >= '2026-10-01'); i >= 0 && i <= b; i++) {
    const g = MGx?.bal[i], ga = MGx?.amt1[i];
    rows.push(`<tr class="${key.has(D.date[i]) ? 'breadthwarn-base' : ''}"><td>${D.date[i].slice(5)}</td><td>${Math.round(D.tw_c[i]).toLocaleString()}</td><td class="${dir(D.tw_c[i] / D.tw_c[i - 1] - 1)}">${spct(D.tw_c[i] / D.tw_c[i - 1] - 1)}</td><td>${pct(dd()[i])}</td><td>${pct(D.tw_l[i] > 0 ? (1 + dd()[i]) * D.tw_c[i] / D.tw_l[i] - 1 : null)}</td><td>${f1(Bx.tw50.a20[i])}</td><td>${f1(Bx.tw50.a60[i])}</td><td class="${dir(d5[i])}">${sf1(d5[i])}</td><td class="${dir(d10[i])}">${sf1(d10[i])}</td><td>${f1(t.a60[i])}</td><td>${f1(Bx.tpex.a60[i])}</td><td>${f1(t.nl20[i])}</td><td>${x1(ld[i])}</td><td>${x1(t.ld5u[i])}</td><td>${x1(lk[i])}</td><td>${x2(t.ldvr[i])}</td><td>${x2(t.volr[i])}</td><td>${x1(t.dnv[i])}</td><td>${x1(t.top10[i])}</td><td>${finite(S[i]) ? Math.round(S[i] * 100) : '—'}</td><td>${sig[i] ? '●' : ''}</td><td class="breadthwarn-late">${finite(g) ? Math.round(g).toLocaleString() : '—'}</td><td class="breadthwarn-late ${dir(ga)}">${finite(ga) ? sf1(ga).replace(/\.\d/, '') : '—'}</td><td class="breadthwarn-late ${dir(MGx?.chg5[i])}">${sf1(MGx?.chg5[i])}</td><td class="breadthwarn-late">${FLOW && finite(FLOW.sell[i]) ? Math.round(FLOW.sell[i] + FLOW.repay[i]).toLocaleString() : '—'}</td><td class="breadthwarn-late">${FLOW && finite(FLOW.buy[i]) ? Math.round(FLOW.buy[i]).toLocaleString() : '—'}</td></tr>`);
  }
  byId('casetable').innerHTML = `<table><thead><tr><th></th><th colspan="20">當天收盤後就知道</th><th colspan="5" class="breadthwarn-late">當晚公布，隔天才能用</th></tr><tr><th>日期</th><th>加權收盤</th><th>收盤漲跌</th><th>最低價距高點</th><th>收盤價距高點</th><th>臺灣50 20日線</th><th>臺灣50 60日線</th><th>5 日變化</th><th>10 日變化</th><th>上市 60日線</th><th>上櫃 60日線</th><th>上市新低</th><th>跌停占比</th><th>近5日曾跌停</th><th>無買單跌停</th><th>跌停股量比</th><th>全體量比</th><th>下跌成交值占比</th><th>前10大成交占比</th><th>壓力分數</th><th>廣度預警</th><th class="breadthwarn-late">融資餘額（億）</th><th class="breadthwarn-late">日增減</th><th class="breadthwarn-late">5 日 %</th><th class="breadthwarn-late">融資賣出＋現償（億）</th><th class="breadthwarn-late">融資買進（億）</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  drawCaseLiq(xs, sl, marks);
}
const lockAll = () => cache.lockAll || (cache.lockAll = D.date.map((_, i) => { const a = Bx.twse.lock[i], b = Bx.tpex.lock[i], na = Bx.twse.n[i], nb = Bx.tpex.n[i]; return a == null || b == null ? null : (a * na + b * nb) / (na + nb); }));
function drawCaseLiq(xs, sl, marks) {
  const ax = AX(), m = mob(), L = m ? 50 : 58, R = m ? 12 : 18, tops = ['1%', '27%', '52%', '77%'], r2 = a => a.map(x => (x == null ? null : +x.toFixed(2)));
  chart('caseliq').setOption(echartsBase({
    title: [ttl(m ? '跌停占比（%）' : '跌停占比（%，上市＋上櫃）：橘柱＝代理，藍點線＝收盤沒有買單（交易所行情）', tops[0], L), ttl('上市融資餘額日增減（億元，交易所公布；當晚才知道）', tops[1], L), ttl('流動性壓力分數（0–100，代理）', tops[2], L), ttl('成交值前 10 大占全部成交值（%，上市，代理）', tops[3], L)],
    legend: { top: tops[0], right: R, data: ['跌停占比（代理）', '收盤沒有買單的跌停（真實）'], textStyle: { color: PALETTE.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8, show: !m },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: '7%', height: '15%' }, { left: L, right: R, top: '33%', height: '14%' }, { left: L, right: R, top: '58%', height: '14%' }, { left: L, right: R, top: '83%', height: '10%' }],
    xAxis: [0, 1, 2, 3].map(gi => ({ type: 'category', data: xs, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 3, color: PALETTE.muted, fontSize: 11, hideOverlap: true, formatter: v => String(v).slice(5) } })),
    yAxis: [{ type: 'value', gridIndex: 0, min: 0, splitNumber: 3, ...ax }, { type: 'value', gridIndex: 1, scale: true, splitNumber: 3, ...ax }, { type: 'value', gridIndex: 2, min: 0, max: 100, splitNumber: 2, ...ax }, { type: 'value', gridIndex: 3, scale: true, splitNumber: 2, ...ax }],
    dataZoom: [],
    series: [
      { type: 'bar', name: '跌停占比（代理）', data: r2(sl(ldAll())), xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 10, itemStyle: { color: PROXY, borderRadius: [3, 3, 0, 0] }, markLine: { symbol: 'none', silent: true, lineStyle: { color: PALETTE.muted, width: 1, type: 'dashed' }, label: { color: PALETTE.muted, fontSize: 11 }, data: marks } },
      line('收盤沒有買單的跌停（真實）', r2(sl(lockAll())), 0, REAL, { symbol: 'circle', symbolSize: 5, connectNulls: false }),
      { type: 'bar', name: '融資日增減', data: sl(MGx ? MGx.amt1 : D.date.map(() => null)).map(x => (x == null ? null : Math.round(x))), xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, itemStyle: { color: REAL, borderRadius: 2 } },
      line('壓力分數', sl(stress().score).map(x => (x == null ? null : Math.round(x * 100))), 2, PROXY, { lineStyle: { width: 1.6, color: PROXY, type: 'dashed' }, areaStyle: { opacity: 0.1 } }),
      line('前 10 大成交占比', r2(sl(Bx.twse.top10)), 3, PROXY, { lineStyle: { width: 1.3, color: PROXY, type: 'dashed' } }),
    ],
  }), true);
}
function drawAll() { drawMain(); drawEvent(); drawCase(); }

// ── D 事件表 ─────────────────────────────────────────────────────────────
function renderEvents() {
  const { e, o, c } = last, y = W.labels(D, o.target, o.H, cache), fw = W.forward(D, o.H, cache), s = W.metric(D, Bx, c, cache);
  const lead = new Map(e.episodes.filter(x => x.first != null).map(x => [x.first, x]));
  const evs = [...e.events].reverse();
  byId('events').innerHTML = `<table><thead><tr><th>預警日</th><th>指標值</th><th>當天指數距高點</th><th>之後 ${o.H} 日最低</th><th>結果</th><th>附近的大跌發生日（從前波高點算起，和「結果」的算法不同）</th></tr></thead><tbody>${evs.map(i => {
    const hit = y[i], L = lead.get(i);
    return `<tr><td>${D.date[i]}</td><td>${c.kind === 'level' ? f1(s[i]) + '%' : sf1(s[i])}</td><td>${pct(dd()[i])}</td><td>${pct(fw.fwdMin[i])}</td><td class="${hit ? 'breadthwarn-hit' : ''}">${hit == null ? '還沒滿期' : hit ? '命中' : '誤報'}</td><td>${L ? `${L.lead} 日後（${D.date[L.onset]}）` : '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
  const sel = byId('ev'), keep = sel.value;
  sel.innerHTML = evs.map(i => `<option value="${i}">${D.date[i]}　${y[i] == null ? '還沒滿期' : y[i] ? '命中' : '誤報'}</option>`).join('');
  if (evs.includes(Number(keep))) sel.value = keep;
}

// ── E 00631L 修復進場 ────────────────────────────────────────────────────
function renderRepair() {
  const asset = val('rasset'), H = Number(val('rh')), thr = -Number(val('rdd')) / 100, grp = val('rgroup'), cap = val('rbasis') === 'cap';
  const from = D.date.findIndex(d => d >= (asset === 'lev' ? '2014-11-03' : '2004-07-01'));
  const keys = grp === 'all' ? Object.keys(W.REPAIRS) : ['A', ...W.REPAIR_GROUPS[grp].filter(k => k !== 'A')];
  const { ev, rows } = W.repairCompare(D, Bx, { ddThr: thr, uni: val('uni'), H, asset, from, MGx, rules: keys }, cache);
  const base = W.repairSummary(rows.A), half = k => k[0] === 'F';
  const G = s => (cap ? { n: s.capN, win: s.capWin, median: s.capMedian, mean: s.capMean, maeMed: s.capMaeMed, maeP90: s.capMaeP90, maeWorst: s.capMaeWorst, worst: s.capWorst } : s), b0 = G(base);
  byId('repair').innerHTML = `<table><thead><tr><th>買法</th><th>報酬中位</th><th>中途最深 中位</th><th>中途最深 最差</th><th>上漲機率</th><th>平均報酬</th><th>最差報酬</th><th>中途最深 最差一成</th><th>算進去的次數</th><th>沒等到訊號</th><th>等待日中位</th><th>進場價比直接買（正＝買貴了）</th><th>中途最高 中位</th><th>回本日中位</th></tr></thead><tbody>${keys.map(k => {
    const s = W.repairSummary(rows[k]), g = G(s);
    return `<tr class="${k === 'A' ? 'breadthwarn-base' : ''}"><td>${esc(W.REPAIRS[k].replace(/（[A-Z]\d?）/g, ''))}</td><td class="${dir(g.median)}">${spct(g.median)}</td><td>${pct(g.maeMed)}${k !== 'A' && finite(g.maeMed) ? `<span class="breadthwarn-dim">（${sf1((g.maeMed - b0.maeMed) * 100)}）</span>` : ''}</td><td>${pct(g.maeWorst)}${k !== 'A' && finite(g.maeWorst) ? `<span class="breadthwarn-dim">（${sf1((g.maeWorst - b0.maeWorst) * 100)}）</span>` : ''}</td><td>${pct(g.win, 0)}</td><td>${spct(g.mean)}</td><td>${pct(g.worst)}</td><td>${pct(g.maeP90)}</td><td>${g.n}／${s.nEv}</td><td>${k === 'A' ? '—' : s.noConfirm}</td><td>${k === 'A' ? '0' : finite(s.waitMed) ? Math.round(s.waitMed) : '—'}</td><td>${k === 'A' || half(k) ? '—' : spct(s.missedMed)}</td><td>${cap ? '—' : pct(s.mfeMed)}</td><td>${cap ? '—' : finite(s.recMed) ? Math.round(s.recMed) : '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
  const nm = { lev: '00631L', sim: '模擬正二', e50: '0050' }[asset];
  byId('repairnote').textContent = `${nm}，回撤 ≤ −${val('rdd')}% 的事件 ${ev.length} 次（同一波 60 日內只算一次），每種買法都用同一批事件。` +
    (cap ? `算法：從事件隔天起固定看 ${H} 個交易日，等待期間和沒買的部分算現金（報酬 0），沒等到訊號的事件也算進去。` : `算法：從各自的進場日起持有 ${H} 個交易日，沒等到訊號的事件不在統計內（看「沒等到訊號」欄）。`) +
    `等超過 60 個交易日沒等到就不買。跌停用上市跌停占比，融資用上市融資餘額（當晚公布，隔天開盤才買）。括號＝和「直接買」相比，中途跌得比較淺（＋）或比較深（−）幾個百分點。「算進去的次數」少於事件數，是因為最近的事件還沒滿期。`;
  const R1 = x => (cap ? x.cap : x.t);
  byId('repairev').innerHTML = `<table><thead><tr><th>事件日</th>${keys.map(k => `<th>${esc(W.REPAIRS[k].replace(/（[A-Z]\d?）/g, ''))}：進場日</th><th>報酬</th><th>中途最深</th>`).join('')}</tr></thead><tbody>${ev.map((i, n) => `<tr><td>${D.date[i]}</td>${keys.map(k => { const x = rows[k][n], r = R1(x); return x.t ? `<td>${x.t.entryDate.slice(2)}</td><td class="${dir(r.complete ? r.ret : null)}">${r.complete ? spct(r.ret, 0) : '未滿'}</td><td>${pct(r.mae, 0)}</td>` : `<td colspan="3">${cap && x.cap?.complete ? '沒等到（現金 0%）' : '還沒等到'}</td>`; }).join('')}</tr>`).reverse().join('')}</tbody></table>`;
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
  
  if (e.n < 10) w.push(`只有 ${e.n} 次預警，命中率的誤差很大。`);
  byId('warn').innerHTML = w.map(esc).join('<br>');
  byId('setup').textContent = `目前設定：${condLabel(c)}${c.nearHigh ? `，而且指數距高點在 ${c.nearHigh * 100}% 以內` : ''}；看之後 ${o.H} 個交易日內是否${W.TARGETS[o.target].label}；同一波 ${o.cooldown} 日內只算一次；2004-07 起。`;
  renderNow(); renderLiq(); renderTiles(); renderCompare(); renderModels(); renderEvents(); renderRepair(); renderQuality(); drawAll();
}
function wire() {
  if (!bindOnce(byId('params'))) return;
  byId('params').addEventListener('input', ev => { if (ev.target.id === 'breadthwarn-kind') syncThr(true); recompute(); });
  byId('rparams').addEventListener('input', renderRepair);
  byId('ev').addEventListener('input', drawEvent);
  byId('mparams').addEventListener('input', renderModels);
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (D && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const o = { signal: context.signal };
    const opt = u => requestJSON(u, o).catch(() => null);
    const [raw, B, mg, mg0, models] = await Promise.all([requestJSON('data/panic_entry.json', o), requestJSON('data/tw_breadth_warn.json', o), opt('data/taiwan_margin_total.json'), opt('data/taiwan_margin_total_early.json'), opt('data/tw_breadth_warn_models.json')]);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!raw?.date?.length || !B?.date?.length) throw new Error('廣度或價格資料是空的');
    // 以兩份資料都有的最後一天為準
    const lastDay = raw.date.at(-1) < B.date.at(-1) ? raw.date.at(-1) : B.date.at(-1), cut = raw.date.findIndex(d => d > lastDay);
    if (cut > 0) for (const k of Object.keys(raw)) if (Array.isArray(raw[k]) && raw[k].length === raw.date.length && k !== 'date') raw[k] = raw[k].slice(0, cut);
    if (cut > 0) raw.date = raw.date.slice(0, cut);
    D = P.prepare(raw); Bx = W.attach(D, B); cache = {};
    MG = mg?.data ? new Map(mg.data.filter(r => finite(r.margin_money)).map(r => [r.date, r.margin_money])) : null;
    MGx = mg?.data ? W.attachMargin(D, [...(mg0?.data || []), ...mg.data]) : null;
    const pos = new Map(B.date.map((d, i) => [d, i])), col = f => (B.mg?.[f] ? D.date.map(d => { const i = pos.get(d); return i == null ? null : B.mg[f][i]; }) : null);
    FLOW = B.mg?.sell ? { buy: col('buy'), sell: col('sell'), repay: col('repay'), obal: col('o_bal') } : null;
    MODELS = models?.models ? models : null; BMETA = B.meta || null;
    byId('asof').textContent = `資料到 ${D.date.at(-1)}（廣度更新 ${B.updated || '—'}）${MG ? '' : '；融資資料載入失敗，第四格空白'}`;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); syncThr(false); recompute();
  const at = new Map(D.date.map((d, i) => [d, i]));
  await Live.init(context, { lastDate: D.date.at(-1), daily: d => { const i = at.get(d); return i == null ? null : { ddLow: dd()[i], ddClose: D.tw_l[i] > 0 ? (1 + dd()[i]) * D.tw_c[i] / D.tw_l[i] - 1 : null, ld: ldAll()[i], lock: lockAll()[i], adv50: Bx.tw50.adv[i], mg: MGx?.amt1[i] }; } });
}
export function getCharts() { return [...Object.values(charts), ...Live.getCharts()]; }
export function resize() { for (const c of getCharts()) c.resize(); }
export function onThemeChange() {
  if (!last) return;
  return preserveChartState(getCharts, () => {
    for (const c of Object.values(charts)) c.dispose();
    charts = {};
    drawAll(); Live.redraw();
  });
}
