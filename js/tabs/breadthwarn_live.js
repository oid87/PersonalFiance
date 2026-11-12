// 「盤中去槓桿壓力監測」區（#tab=breadthwarn 的一部分）：盤後回放、融資維持率情境、資料可靠性、本機快照。
// 公開網站只有交易所收盤後公布的每 5 秒統計；即時快照只在本機（data/local/，不進 repo）。
import { requestJSON } from '../utils/data.js';
import { PALETTE, mob, echartsBase } from '../utils/theme.js';
import { bindOnce } from '../utils/dom.js';
import * as L from './breadthwarn_live_calc.mjs';

const $ = id => document.getElementById('breadthwarn-' + id);
const fin = Number.isFinite;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sp = (x, d = 2) => (fin(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)}%`.replace('-', '−') : '—');
const p1 = (x, d = 1) => (fin(x) ? `${x.toFixed(d)}%`.replace('-', '−') : '—');
const dir = x => (fin(x) && x !== 0 ? (x > 0 ? 'breadthwarn-up' : 'breadthwarn-down') : '');
const REAL = '#58a6ff', EST = '#a371f7';
const TAG = { real: '<span class="breadthwarn-tag breadthwarn-tag--real">真實</span>', est: '<span class="breadthwarn-tag breadthwarn-tag--est">估計</span>', na: '<span class="breadthwarn-tag breadthwarn-tag--na">沒有</span>' };
const tile = (k, v, s, tag = '', na = false) => `<div class="breadthwarn-tile${na ? ' breadthwarn-tile--na' : ''}"><div class="breadthwarn-k">${k} ${tag}</div><div class="breadthwarn-v">${v}</div><div class="breadthwarn-s">${s}</div></div>`;
const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => (String(c).startsWith('<td') ? c : `<td>${c}</td>`)).join('')}</tr>`).join('')}</tbody></table>`;

let DOC = null, RES = null, LOCAL = null, ctx = null, charts = {}, day = null;

function verdict(s, q) {
  if (!fin(s.bp_min)) return '這一天沒有前幾日的基準可以比較。';
  if (s.bp_min <= 0.7) return `全市場累積委買量異常偏低：${s.bp_t} 只有平常同時段的 ${Math.round(s.bp_min * 100)}%。這是全市場合計，看不出是哪些股票沒有買盤。`;
  if (fin(q.lowChg) && q.lowChg > -2) return '當天最低沒有跌超過 2%（日資料），不判讀。';
  if (fin(s.vp) && s.vp >= 1.3) return `成交放大（全日是平常的 ${s.vp.toFixed(2)} 倍），全市場累積委買量沒有明顯偏低。個別股票仍可能鎖跌停，要看收盤跌停占比。`;
  return '全市場累積委買量與成交都接近平常，從全市場合計看不出異常；這不代表個別股票有買盤。';
}

function renderStatus() {
  const ds = Object.keys(DOC.days), last = ds.at(-1);
  const st = L.staleness(last, ctx.lastDate), utc = t => esc(String(t || '—').replace('T', ' ').replace('Z', ' UTC'));
  $('live-status').innerHTML = `<b>這一區是盤中歷史回放，不是即時行情。</b>歷史驗證的結果是：全市場的委託統計沒有可靠的提前預警能力，所以這裡只做觀察與紀錄，不是訊號。回放到 <b>${last}</b>。` +
    (st.stale ? `<span class="breadthwarn-hit">資料過期：比日線資料（${ctx.lastDate}）舊，排程可能沒有跑成功。</span>` : '') +
    (LOCAL ? ' 這台電腦上有本機快照，見本區下方。' : '');
  $('live-modes').innerHTML = table(['功能', '現在的狀態', '資料', '說明'], [
    ['歷史回放', '<b>已上線</b>', `${ds.length} 個交易日（最近 ${ds.length - (DOC.pinned || []).length} 天＋${(DOC.pinned || []).length} 個歷史危機日）`, '交易所收盤後才公布，當天傍晚更新；當時盤中拿不到這份資料'],
    ['當日盤中監測', LOCAL ? '只在這台電腦' : '<b>未啟用</b>', '需要有授權的即時行情', '公開網站沒有、也不會假裝有；程式寫好但沒有接上合法來源'],
    ['融資維持率情境模擬', '<b>已上線</b>', '你自己填的假設', '單一部位的試算，不是全市場真實的追繳或斷頭統計'],
  ].map(r => [...r.slice(0, 3), `<td class="breadthwarn-wrap">${r[3]}</td>`]));
  $('live-stamp').innerHTML = `<b>時間怎麼看：</b>行情時間＝圖上的 09:00–13:30（交易所每 5 秒委託成交統計，本站取每分鐘最後一筆）；可用時間＝交易所<b>收盤後</b>公布（分類：盤後公布，不是即時也不是延遲行情）；本站取得時間＝${utc(DOC.days[last]?.tf || DOC.updated)}（檔案更新於 ${utc(DOC.updated)}，規則版本 ${esc(DOC.ver || '—')}）。`;
}

function renderTiles() {
  const d = day, s = DOC.days[d].sum || {}, q = ctx.daily(d) || {};
  $('live-tiles').innerHTML = [
    tile('加權指數收盤漲跌', sp(q.chg), `${d.slice(5)}；當天最低 ${sp(q.lowChg)}（日資料，沒有盤中走勢）`, TAG.real),
    tile('距 252 日高點', fin(q.ddLow) ? p1(q.ddLow * 100) : '—', `以當日最低價；以收盤價是 ${fin(q.ddClose) ? p1(q.ddClose * 100) : '—'}`, TAG.real),
    tile('累積委買量最低', fin(s.bp_min) ? `${Math.round(s.bp_min * 100)}%` : '—', `${s.bp_t || ''} 全市場累積委買 ÷ 平常同時段`, TAG.real),
    tile('全日成交相對平常', fin(s.vp) ? `${s.vp.toFixed(2)} 倍` : '—', '成交金額 ÷ 前 20 日同時段中位數', TAG.real),
    tile('臺灣50 上漲比例', fin(q.adv50) ? p1(q.adv50, 0) : '—', '收盤時', TAG.real),
  ].join('') + `<p class="breadthwarn-note" style="grid-column:1/-1;margin:0">盤中的跌停家數、沒有買單的股票、融資集中股票的跌幅：需要即時的個股報價，公開網站沒有。這一天<b>收盤時</b>：上市股票有 ${fin(q.ld) ? p1(q.ld) : '—'} 跌停，有 ${fin(q.lock) ? p1(q.lock) : '—'} 鎖在跌停而且沒有買單。${fin(q.ld) && q.ld >= 3 && fin(s.bp_min) && s.bp_min > 0.7 ? '<b>這一天全市場累積委買量沒有偏低，但跌停的股票不少：全市場合計正常，不代表個股有人接。</b>' : ''}</p>`;
}

function fillDays() {
  const ds = Object.keys(DOC.days).reverse(), pin = new Set(DOC.pinned || []), lab = DOC.labels || {};
  const opt = d => { const s = DOC.days[d].sum || {}; const q = ctx.daily(d) || {}; return `<option value="${d}">${d}　收 ${sp(q.chg, 1)}　委買最低 ${fin(s.bp_min) ? Math.round(s.bp_min * 100) + '%' : '—'}</option>`; };
  $('live-day').innerHTML = ds.filter(d => !pin.has(d)).map(opt).join('') + `<optgroup label="歷史危機日">${ds.filter(d => pin.has(d)).map(opt).join('')}</optgroup>`;
  const groups = [...new Set(ds.filter(d => pin.has(d)).map(d => lab[d]))];
  const chgOf = d => ctx.daily(d)?.lowChg ?? 0, worst = k => ds.filter(d => lab[d] === k).sort((a, b) => chgOf(a) - chgOf(b))[0];
  $('live-jump').innerHTML = '<option value="">最近的交易日</option>' + ['2026-11-03', '2026-11-05', '2026-11-06'].filter(d => DOC.days[d]).map(d => `<option value="${d}">${d}</option>`).join('') +
    groups.map(k => `<option value="${worst(k)}">${esc(k)}（${worst(k)}）</option>`).join('');
  day = ds[0]; $('live-day').value = day;
}

const chart = key => charts[key] || (charts[key] = echarts.init($(key + '-chart')));
function drawDay() {
  const x = DOC.days[day]; if (!x) return;
  renderTiles();
  const ind = L.indicators(x), s = x.sum || {}, cov = L.coverage(x.bq), q = ctx.daily(day) || {}, m = mob(), Lf = m ? 44 : 60, R = m ? 14 : 28;
  const xs = Array.from({ length: L.MINUTES }, (_, i) => L.hhmm(i));
  const cut = a => a.map((v, i) => (i < 5 ? null : v));      // 開盤前 5 分鐘累積量太小，比值不穩，不畫
  const ax = { axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } } };
  const tops = ['2%', '53%'], ttl = (t, i) => ({ text: t, left: Lf, top: tops[i], textStyle: { color: PALETTE.muted, fontSize: 12, fontWeight: 'normal' } });
  const ln = (name, data, gi, color, extra = {}) => ({ type: 'line', name, data, symbol: 'none', connectNulls: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1.5, color }, itemStyle: { color }, ...extra });
  const rr = (a, d) => a.map(v => (fin(v) ? +v.toFixed(d) : null));
  $('live-daynote').innerHTML = `<b>${day}${DOC.labels?.[day] ? `（${esc(DOC.labels[day])}）` : ''}：</b>${fin(q.chg) ? `加權指數收盤 ${sp(q.chg)}，當天最低 ${sp(q.lowChg)}（日資料）。` : '這一天的指數日資料還沒更新。'}${verdict(s, q)}` +
    ` <span class="breadthwarn-dim">有資料 ${cov.have}／${L.MINUTES} 分鐘${cov.missing ? `，最長連續缺 ${cov.maxGap} 分鐘（留空）` : ''}。</span>`;
  chart('live').setOption(echartsBase({
    title: [ttl(m ? '相對平常的倍數' : '相對平常同時段的倍數（1＝一樣）', 0), ttl(m ? '累積委賣比委買多（%）' : '累積委賣比累積委買多多少（占兩者合計 %）', 1)],
    legend: [{ top: tops[0], right: R, data: ['累積委買', '成交金額'], textStyle: { color: PALETTE.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 }, { top: tops[1], right: R, data: ['當天', '前 20 日中位數'], textStyle: { color: PALETTE.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 }],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { trigger: 'axis' },
    grid: [{ left: Lf, right: R, top: '10%', height: '36%' }, { left: Lf, right: R, top: '61%', height: '30%' }],
    xAxis: [0, 1].map(gi => ({ type: 'category', data: xs, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 1, color: PALETTE.muted, fontSize: 11, interval: m ? 59 : 29 } })),
    yAxis: [{ type: 'value', gridIndex: 0, scale: true, ...ax }, { type: 'value', gridIndex: 1, scale: true, ...ax }],
    dataZoom: [],
    series: [
      ln('累積委買', rr(cut(ind.bp), 2), 0, REAL, { markLine: { symbol: 'none', silent: true, lineStyle: { color: PALETTE.muted, type: 'dashed', width: 1 }, label: { show: false }, data: [{ yAxis: 1 }] } }),
      ln('成交金額', rr(cut(ind.vp), 2), 0, EST, { lineStyle: { width: 1.5, color: EST, type: [6, 3] } }),
      ln('當天', rr(cut(ind.cimb), 1), 1, REAL),
      ln('前 20 日中位數', x.cb ? cut(x.cb) : [], 1, PALETTE.muted, { lineStyle: { width: 1, color: PALETTE.muted, type: 'dashed' } }),
    ],
  }), true);
}

function renderDaysTable() {
  const ds = Object.keys(DOC.days).filter(d => !(DOC.pinned || []).includes(d)).reverse().slice(0, 25);
  $('live-days').innerHTML = table(['日期', '收盤漲跌（日資料）', '當天最低（日資料）', '累積委買最低', '時間', '委賣偏離最大（百分點）', '成交倍數', '收盤時鎖跌停且無買單的股票占比', '融資日增減（當晚公布）'], ds.map(d => {
    const s = DOC.days[d].sum || {}, q = ctx.daily(d) || {};
    return [d.slice(5), `<td class="${dir(q.chg)}">${sp(q.chg)}</td>`, `<td class="${dir(q.lowChg)}">${sp(q.lowChg)}</td>`,
      fin(s.bp_min) ? `${Math.round(s.bp_min * 100)}%` : '—', s.bp_t || '—', fin(s.cdev_max) ? `${s.cdev_max > 0 ? '+' : ''}${s.cdev_max.toFixed(1)}` : '—', fin(s.vp) ? s.vp.toFixed(2) : '—', fin(q.lock) ? p1(q.lock) : '—', `<td class="breadthwarn-late">${fin(q.mg) ? `${q.mg > 0 ? '+' : ''}${Math.round(q.mg)} 億` : '—'}</td>`];
  }));
}

function renderResearch() {
  if (!RES) { $('live-research').innerHTML = '<p class="breadthwarn-note">驗證結果還沒有產生。</p>'; return; }
  $('live-research').innerHTML = `<ul>${(RES.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul><details class="breadthwarn-details"><summary>統計表（研究用 ${RES.n_days} 天；這頁能回放的是 ${Object.keys(DOC?.days || {}).length} 天，不是全部研究日）</summary><p class="breadthwarn-note">分辨力：0.5＝和亂猜一樣，1＝每次都分得出來，它不是發生機率。括號是和「只看指數」的差距、可能範圍、以及幾場危機裡有幾場變好；範圍包含 0 就代表沒有比較好。<span class="breadthwarn-swipe">表格可左右滑。</span></p>` +
    (RES.sections || []).map(s => `<p class="breadthwarn-note"><b>${esc(s.title)}</b>${s.note ? '　' + esc(s.note) : ''}</p><div class="table-scroll" tabindex="0">${table(s.head.map(esc), s.rows.map(r => r.map(esc)))}</div>`).join('') + '</details>';
}

function renderSim() {
  const ratio = Number($('sim-ratio').value), el = $('sim-m0');
  if (ratio) el.value = Math.round(L.initialMaint(ratio) * 100);
  const m0 = Number(el.value) / 100, drop = -Number($('sim-drop').value) / 100, thr = Number($('sim-thr').value), s = L.marginSim({ m0, drop, thr });
  $('sim-m0-v').textContent = `${(m0 * 100).toFixed(0)}%`; $('sim-drop-v').textContent = `${(-drop * 100).toFixed(0)}%`;
  const room = s.room >= 0 ? '已經低於門檻' : `再跌 ${(-s.room * 100).toFixed(1)}%`;
  $('sim-out').innerHTML = [
    tile('跌完之後的維持率', `<span class="${s.called ? 'breadthwarn-hit' : ''}">${(s.m1 * 100).toFixed(0)}%</span>`, s.called ? `低於 ${(thr * 100).toFixed(0)}%，會收到補繳通知` : `高於 ${(thr * 100).toFixed(0)}%`, TAG.est),
    tile('從現在算，離門檻', room, `門檻 ${(thr * 100).toFixed(0)}%`, TAG.est),
    tile('跌完之後還剩', s.called ? '0' : `${(-s.roomAfter * 100).toFixed(1)}%`, '再跌這麼多才碰門檻', TAG.est),
    tile('補回門檻要還', s.payCall.toFixed(1), `目前市值＝100；回到 166% 要還 ${s.payClear.toFixed(1)}`, TAG.est),
    tile('自有資金剩', s.equity.toFixed(1), `融資金額 ${s.loan.toFixed(1)}（不變）`, TAG.est),
  ].join('');
  $('sim-table').innerHTML = table(['股價再跌', '維持率', '離門檻', '補回門檻要還', '回到 166% 要還', '自有資金剩'], L.simTable(m0, [-0.03, -0.05, -0.1, -0.15, -0.2, -0.3], thr).map(r =>
    [`${(-r.drop * 100).toFixed(0)}%`, `<td class="${r.called ? 'breadthwarn-hit' : ''}">${(r.m1 * 100).toFixed(0)}%</td>`, r.called ? '已低於' : `${(-r.roomAfter * 100).toFixed(1)}%`, r.payCall.toFixed(1), r.payClear.toFixed(1), r.equity.toFixed(1)]));
}

function renderQuality() {
  const ds = Object.keys(DOC.days), miss = ds.reduce((a, d) => a + (DOC.days[d].sum?.missing || 0), 0);
  const rows = [
    ['加權指數盤中走勢（每 5 秒）', TAG.na, '收盤後', '證交所網站的盤後統計頁', '不行', '沒有開放資料授權，網站條款未經同意禁止自動下載與轉載；2026-11-12 起不抓、不顯示。這一區的指數漲跌改用每日收盤與最低（日資料）'],
    ['每 5 秒委託成交統計（累積委買、委賣、成交）', TAG.real, '收盤後', '政府資料開放平臺登錄的官方下載點（只給最新一天，漏掉的日子不回補）', '可以（開放資料授權，須標示來源）', `${ds.length} 天，缺漏 ${miss} 分鐘（${(miss / ds.length / L.MINUTES * 100).toFixed(2)}%）。全市場（上市）合計，不分個股。「累積委託」是開盤以來的累計，會因取消、改量而減少，也包含已成交的單；它不是當下委託簿上還沒成交的存量，更不是個股的買方深度`],
    ['相對平常同時段的倍數', TAG.est, '收盤後', '前 5–20 個交易日同一分鐘的中位數', '可以', '自己算的比值，不是交易所數字；不足 5 天就不算'],
    ['盤中跌停家數、有沒有買單、跌停委賣張數', TAG.na, '即時（交易所每 5 秒揭示）', '證交所／櫃買基本市況報導網站', '不行', '網站條款禁止自動擷取與轉載；對外展示盤中資訊（含彙總統計）要簽資訊使用契約'],
    ['臺灣50 成分股、台積電、0050、00631L 盤中', TAG.na, '即時', '同上', '不行', '同上；收盤後的日資料這頁其他區已經有'],
    ['台指期盤中', TAG.na, '即時', '期交所行情網站', '不確定', '沒有查到明確條款，比照處理'],
    ['融資集中股票的盤中跌幅', TAG.est, '即時＋前一日', '即時個股報價 × 前一日個股融資餘額', '不行（只能本機）', '是價格壓力代理，不是維持率，更不是爆倉率'],
    ['個股五檔、委託簿深度、買賣價差', TAG.na, '即時', '授權行情或券商 API', '不行', '富果、FinMind、券商 API 都禁止轉給第三人'],
    ['真實帳戶維持率、追繳與處分戶數', TAG.na, '—', '沒有公開來源', '—', '無法驗證任何「爆倉」估計'],
  ];
  $('live-attr').textContent = DOC.attribution ? `資料來源：${DOC.attribution}。本站把每 5 秒統計取每分鐘最後一筆、換算成相對平常同時段的倍數，屬於改作，數字不是交易所原始公布值。（條款查證日 2026-11-12）` : '';
  $('live-quality').innerHTML = table(['資料', '性質', '即時或延遲', '來源與更新', '能不能公開', '說明'], rows.map(r => [...r.slice(0, 5), `<td class="breadthwarn-wrap">${esc(r[5])}</td>`]));
}

function renderLocal() {
  if (!LOCAL?.snaps?.length) return;
  $('local').hidden = false;
  const sn = LOCAL.snaps, z = sn.at(-1), a = z.all || {}, age = Math.round((Date.now() - Date.parse(z.tf)) / 60000);
  $('local-status').innerHTML = `<b>${esc(LOCAL.date)}</b>　最後一筆：行情時間 ${esc(z.tq || '—')}，抓取時間 ${esc(z.tf.slice(11, 19))}（${age > 15 ? `<span class="breadthwarn-hit">${age} 分鐘前，不是最新</span>` : `${age} 分鐘前`}）。` +
    `今天 ${sn.length} 筆，預期 ${LOCAL.expected ?? '—'} 筆${LOCAL.missed?.length ? `，漏 ${LOCAL.missed.length} 筆（${esc(LOCAL.missed.slice(0, 6).join('、'))}）` : ''}。來源：${esc(LOCAL.src || '—')}；規則版本 ${esc(LOCAL.ver || '—')}。`;
  $('local-tiles').innerHTML = [
    tile('加權指數', sp(z.idx?.r), `台指期 ${sp(z.tx?.r)}`, TAG.real),
    tile('跌停家數占比', p1(a.ld_pct, 2), `${a.ld ?? '—'} 檔；接近跌停 ${a.near ?? '—'} 檔`, TAG.real),
    tile('跌停而且沒有買單', p1(a.lock_pct, 2), `${a.lock ?? '—'} 檔；跌停價掛賣 ${fin(a.queue) ? Math.round(a.queue).toLocaleString() : '—'} 張`, TAG.real),
    tile('碰過跌停又打開', `${a.reopen ?? '—'} 檔`, `今天碰過跌停 ${a.touched ?? '—'} 檔`, TAG.real),
    tile('上漲／下跌家數', `${p1(a.adv_pct, 0)}／${p1(a.dec_pct, 0)}`, `臺灣50：${p1(a.tw50_adv_pct, 0)}／${p1(a.tw50_dec_pct, 0)}`, TAG.real),
    tile('融資餘額加權跌幅', sp(a.mw_ret), `等權 ${sp(a.ew_ret)}；融資部位在跌停的比例 ${p1(a.mw_ld_pct)}`, TAG.est),
    tile('台積電', sp(z.s2330?.r), `成交 ${fin(z.s2330?.v) ? Math.round(z.s2330.v).toLocaleString() : '—'} 張`, TAG.real),
  ].join('');
  const xs = sn.map(s => s.tq || s.tf.slice(11, 16)), col = f => sn.map(s => f(s) ?? null), m = mob(), Lf = m ? 44 : 60, R = m ? 14 : 28;
  const ax = { axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } } };
  const tops = ['2%', '36%', '69%'], ttl = (t, i) => ({ text: t, left: Lf, top: tops[i], textStyle: { color: PALETTE.muted, fontSize: 12, fontWeight: 'normal' } });
  const ln = (name, data, gi, color, dash) => ({ type: 'line', name, data, symbol: 'circle', symbolSize: 5, connectNulls: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1.3, color, type: dash || 'solid' }, itemStyle: { color } });
  chart('local').setOption(echartsBase({
    title: [ttl('加權指數對前收（%）', 0), ttl('跌停占比與沒有買單的跌停占比（%）', 1), ttl('融資餘額加權跌幅與等權跌幅（%，估計）', 2)],
    legend: [{ top: tops[1], right: R, data: ['跌停', '沒有買單'], textStyle: { color: PALETTE.muted, fontSize: 11 } }, { top: tops[2], right: R, data: ['融資加權', '等權'], textStyle: { color: PALETTE.muted, fontSize: 11 } }],
    axisPointer: { link: [{ xAxisIndex: 'all' }] }, tooltip: { trigger: 'axis' },
    grid: [{ left: Lf, right: R, top: '8%', height: '23%' }, { left: Lf, right: R, top: '42%', height: '22%' }, { left: Lf, right: R, top: '75%', height: '18%' }],
    xAxis: [0, 1, 2].map(gi => ({ type: 'category', data: xs, gridIndex: gi, ...ax, splitLine: { show: false }, axisLabel: { show: gi === 2, color: PALETTE.muted, fontSize: 11, hideOverlap: true } })),
    yAxis: [0, 1, 2].map(gi => ({ type: 'value', gridIndex: gi, scale: gi !== 1, min: gi === 1 ? 0 : undefined, ...ax })),
    dataZoom: [],
    series: [ln('指數', col(s => s.idx?.r), 0, PALETTE.text), ln('跌停', col(s => s.all?.ld_pct), 1, REAL), ln('沒有買單', col(s => s.all?.lock_pct), 1, REAL, 'dashed'), ln('融資加權', col(s => s.all?.mw_ret), 2, EST), ln('等權', col(s => s.all?.ew_ret), 2, PALETTE.muted, 'dashed')],
  }), true);
  const sg = LOCAL.signals || [];
  $('local-signals').innerHTML = sg.length ? table(['行情時間', '抓取時間', '規則', '當時數值', '當時指數', '版本'], sg.map(g => [esc(g.tq), esc(g.tf.slice(11, 19)), esc(g.label), esc(g.value), sp(g.idx_r), esc(g.ver)])) : '<p class="breadthwarn-note">今天沒有規則成立。規則是事前固定的觀察門檻，不是驗證過的預警。</p>';
}

export async function init(context, c) {
  ctx = c;
  const o = { signal: context.signal }, opt = u => requestJSON(u, o).catch(() => null);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  [DOC, RES, LOCAL] = await Promise.all([opt('data/tw_intraday.json'), opt('data/tw_intraday_research.json'), isLocal ? requestJSON('data/local/tw_live.json', { ...o, force: true }).catch(() => null) : null]);
  if (bindOnce($('sim-ratio'))) {
    for (const id of ['sim-ratio', 'sim-thr']) $(id).addEventListener('change', renderSim);
    $('sim-m0').addEventListener('input', () => { $('sim-ratio').value = ''; renderSim(); });
    $('sim-drop').addEventListener('input', renderSim);
    $('live-day').addEventListener('change', e => { day = e.target.value; drawDay(); });
    $('live-jump').addEventListener('change', e => { day = e.target.value || Object.keys(DOC?.days || {}).at(-1); if (day) { $('live-day').value = day; drawDay(); } });
  }
  renderSim();
  if (!DOC?.days || !Object.keys(DOC.days).length) {
    $('live-status').innerHTML = '<b>資料不足：</b>盤中回放資料載入失敗或還沒有產生。這一區不顯示任何盤中數字。';
    $('live-tiles').innerHTML = ''; $('live-days').innerHTML = ''; $('live-quality').innerHTML = ''; renderResearch(); return;
  }
  renderStatus(); fillDays(); drawDay(); renderDaysTable(); renderResearch(); renderQuality(); renderLocal();
}
export const getCharts = () => Object.values(charts);
export function redraw() { for (const c of Object.values(charts)) c.dispose(); charts = {}; if (DOC?.days) { drawDay(); renderLocal(); } }
