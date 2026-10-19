// US Capitulation Alert — reproducible backtest. Usage:
//   node scripts/research/backtest_us_capitulation.mjs --out docs/research/us-capitulation-alert-backtest.md --json docs/research/us-capitulation-alert-backtest.json
// Descriptive research only. No parameter in this file was fitted; sensitivity tables are exploration, not validation.
import { writeFileSync } from 'node:fs';
import { loadRaw } from './_uscap_load.mjs';
import * as U from '../../js/tabs/uscap_calc.mjs';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const ds = U.buildDataset(loadRaw());
const ASSETS = ['SPY', 'QQQ'];
const { num, sg } = U.fmt;
const H = U.DEFAULTS.horizons;
const md = [];
const out = s => md.push(s);
const table = (head, rows) => { out(`| ${head.join(' | ')} |`); out(`|${head.map(() => '---').join('|')}|`); for (const r of rows) out(`| ${r.join(' | ')} |`); out(''); };
const pct = (x, d = 1) => (Number.isFinite(x) ? `${x.toFixed(d)}%` : '—');
const frames = Object.fromEntries(ASSETS.map(a => [a, U.buildFrame(ds, a)]));
const cfg = U.DEFAULTS;
const asOf = ds.lastDate;
const json = { generated_for: asOf, params: cfg, assets: {} };

out('# US Capitulation Alert — 回測報告（Phase A，不含 Down Volume）');
out('');
out(`資料截止：${asOf}。由 \`scripts/research/backtest_us_capitulation.mjs\` 產生，引擎 \`js/tabs/uscap_calc.mjs\`；Python 獨立複核 \`scripts/research/verify_us_capitulation.py\`。純描述性研究：不產生買賣指令、不修改任何正式交易條件。`);
out('');

// ── 1. coverage ──────────────────────────────────────────────────────────
out('## 1. 實際使用的資料與覆蓋');
const span = m => { const k = [...m.keys()].sort(); return k.length ? `${k[0]} ～ ${k.at(-1)}（${k.length} 筆）` : '—'; };
const dayRange = rows => (rows?.length ? `${rows[0].date} ～ ${rows.at(-1).date}（${rows.length} 筆）` : '—');
table(['項目', '覆蓋', '口徑／限制'], [
  ['SPY / QQQ 日線（OHLC）', `${dayRange(ds.prices.SPY)}／${dayRange(ds.prices.QQQ)}`, '價格報酬，不含股息與成本；SPY 2026-10-16 的 OHLC 自相矛盾，該日被排除並使含該日的視窗標為 badPrice'],
  ['VIX', span(ds.vix), 'CBOE 收盤'],
  ['VXN', span(ds.vxn), 'CBOE 收盤；2001-01-23 前無資料，QQQ 的波動指標退回 VIX'],
  ['VIX9D / VIX3M（現貨）', `${span(ds.vix9d)}／${span(ds.vix3m)}`, '現貨波動率期限結構，不是 VIX 期貨期限結構'],
  ['Equity Put/Call（成交量）', span(ds.pcr), '2019-10-05 前為 CBOE 交易所口徑、之後為 OCC 19 家交易所加總，水準不連續（2019 平均 0.645 → 2019-10~2020-06 平均 0.827）。百分位只用同一口徑段內的過去資料，段內至少 126 筆才有效，因此 2019-10-05 起約半年的 PCR 判斷為 unavailable（含 2020-03）。Put 成交量不等於新增空單'],
  ['SPXA50R / NDXA50R', `${span(ds.breadthSpx)}／${span(ds.breadthNdx)}`, '用現任成分股回填，有倖存者偏差；只顯示、不進任何模型或回測'],
  ['CFTC TFF（槓桿基金）', ds.cftc?.history ? '2019-01 ～ 最新（2019–2021 為研究回補）' : '2022 ～ 最新', '週資料；Tuesday as-of，週五 15:30 ET 才公開。只在公布日之後使用；槓桿基金空單含避險與套利，不等於方向性看空'],
  ['FINRA Margin Debt', span(new Map(ds.finra.map(r => [r.date, 1]))), '月資料、第三方轉載；公布日假設月底＋25 天（非官方日曆）；不插值成日資料'],
  ['HYG / HY OAS', `${dayRange(ds.hyg)}／${span(ds.oas)}`, 'HYG 是價格代理；HY OAS 只有約近 3 年，沒有 FRED key 無法補更早'],
  ['NYSE / Nasdaq Down Volume、Up Volume', '**unavailable**', '沒有合格來源（見 us-capitulation-alert.md 的來源調查）；不以 SPY/QQQ 成交量代替。Model C、D 與 Stage C 的 90% Up Volume 條件因此不可評估'],
]);

// ── 2. parameters ────────────────────────────────────────────────────────
out('## 2. 固定參數（事前定案，沒有針對任何樣本調整）');
out('');
table(['參數', '值', '說明'], [
  ['Stage A 波動極端', `VIX ≥ ${cfg.vix} 或 VXN ≥ ${cfg.vxn}`, '來自需求清單的候選門檻；VXN 取 35 是因 VXN 結構上比 VIX 高約 1.2 倍（35/30≈1.17）。其他門檻見敏感度表'],
  ['PCR 極端', `Equity PCR 的 ${cfg.pcrAvg} 日均 ≥ 同口徑段內過去 ${cfg.pcrWindow} 日（約 2 年）的第 ${cfg.pcrPct} 百分位`, '不含當日；至少 126 筆。5 年窗與 P90/P99 見變體表'],
  ['回撤閘門', `收盤距 ${cfg.lookback} 日最高收盤 ≥ ${cfg.gate}%`, '與 usrisk 頁相同；同一天已發生的價格變化，不是底部預測'],
  ['事件冷卻', `${cfg.cooldown} 個交易日`, '固定從第一個被接受的訊號起算；與既有 usrisk 引擎同定義。「首次觸發」＝每一波下跌（回撤 ≥8% 進入、<3% 結束）的第一個事件'],
  ['進場與視窗', '訊號日收盤後才知道 → 下一交易日開盤；視窗含進場日', `報酬＝第 h 日收盤 / 進場開盤 − 1；h ∈ {${H.join(', ')}}；MAE＝視窗最低價 / 進場價 − 1（≤0）；MFE＝視窗最高價 / 進場價 − 1（≥0）`],
  ['Stage C 止穩確認', `Stage A 事件後 ${cfg.confirmWindow} 個交易日內，同時滿足三項`, `① 近 ${cfg.noNewLowDays} 日沒有創事件後新低收盤；② 波動指標 ≤ 事件後高點的 ${cfg.volRetreat * 100}%（SPY 用 VIX、QQQ 用 VXN）；③ 收盤站上 ${cfg.maDays} 日均線。只用當日以前的資料`],
  ['Stage C 失敗辨識', '確認日之後收盤跌破 Stage A 事件到確認日之間的最低收盤', '回報距離確認日的交易日數與到那天為止相對進場開盤的損失'],
  ['最低點距離', `進場後 ${cfg.troughWindow} 個交易日內的最低價`, '回報距進場的交易日數與相對進場開盤的百分比；視窗不足者不計'],
]);
out('Model C、D（Down Volume）不可評估；Model E′ 以 Model B ＋ 止穩確認代替 Model D ＋ 止穩確認。');
out('');

// ── 3. model comparison ──────────────────────────────────────────────────
const modelRows = (res, key) => res.map(x => {
  const s = x[key];
  return [x.label, x.triggerDays ?? '', x.baseCount ?? '', x.stabilize ? x.confirmedCount : '—', ...H.map(h => (s?.by[h].n ? `${sg(s.by[h].median)} / ${sg(s.by[h].mean)}` : '—')),
    ...H.slice(0, 5).map(h => (s?.by[h].n ? `${pct(s.by[h].win, 0)}（n=${s.by[h].n}）` : '—'))];
});
const headRet = ['模型', '觸發日數', '事件數(冷卻)', '有止穩確認', ...H.map(h => `${h}日 中位/平均 %`), ...H.map(h => `${h}日 勝率`)];
const stat2 = (s, h) => (s?.by[h].n ? `${sg(s.by[h].maeMedian)} (P10 ${sg(s.by[h].maeP10)}) / ${sg(s.by[h].mfeMedian)} (P90 ${sg(s.by[h].mfeP90)})` : '—');
out('## 3. 模型比較（2000–最新，全樣本）');
out('');
out('「事件」＝冷卻 10 日後的獨立事件（連續數日同一波只算一次）。「觸發日」是同一條件成立的所有日期，彼此高度重疊，不是獨立樣本。止穩模型的事件日＝確認日（進場從確認日隔天開盤）。');
out('');
for (const asset of ASSETS) {
  const f = frames[asset];
  const res = Object.values(U.runModels(f)).filter(x => !x.unavailable);
  const base = U.baselines(f);
  json.assets[asset] = { models: {} };
  out(`### ${asset}`);
  out('');
  const rows = modelRows(res, 'stats');
  rows.push(['（基準）只有回撤閘門', '', base.drawdownEvents, '', ...H.map(h => (base.drawdownOnly.by[h].n ? `${sg(base.drawdownOnly.by[h].median)} / ${sg(base.drawdownOnly.by[h].mean)}` : '—')), ...H.slice(0, 5).map(h => (base.drawdownOnly.by[h].n ? `${pct(base.drawdownOnly.by[h].win, 0)}（n=${base.drawdownOnly.by[h].n}）` : '—'))]);
  rows.push(['（基準）所有交易日', base.eligibleDays, '', '', ...H.map(h => `${sg(base.allDays.by[h].median)} / ${sg(base.allDays.by[h].mean)}`), ...H.slice(0, 5).map(h => `${pct(base.allDays.by[h].win, 0)}`)]);
  table(headRet, rows);
  // Fairness check: Model B can only fire where put/call is evaluable (2007-05 onward, not 2019-10..2020-04), so compare it with Model A on the same days.
  {
    const pcrOnly = d => (d.pcrExt === null ? null : U.stageA(d, cfg));
    const aStar = U.modelEvents(f, { id: 'A*', base: 'A', stabilize: false }, { pred: pcrOnly });
    const asStar = U.modelEvents(f, { id: 'A*S', base: 'A', stabilize: true }, { pred: pcrOnly });
    aStar.label = 'A*：VIX/VXN 極端（只算 PCR 可評估的日子）'; asStar.label = 'A*′：A* ＋ 止穩確認';
    const bRes = res.find(x => x.model === 'B');
    out('**公平比較：Model B 只能在 Put/Call 可評估的日子觸發，因此另列「只算同樣日子」的 Model A**');
    out('');
    table(headRet, modelRows([aStar, bRes, asStar], 'stats'));
    json.assets[asset].fair = { aStar: aStar.baseCount, aStarTrigger: aStar.triggerDays };
  }
  out('**MAE / MFE（中位數，括號為較差的 P10 ／ 較好的 P90）**');
  out('');
  table(['模型', ...H.map(h => `${h}日 MAE / MFE %`)], [...res.map(x => [x.label, ...H.map(h => stat2(x.stats, h))]),
    ['（基準）只有回撤閘門', ...H.map(h => stat2(base.drawdownOnly, h))]]);
  out('**再破低、最低點距離、誤報描述**（再破低＝進場後 20 日內最低價跌破訊號日低點［止穩模型為事件到確認日的最低價］；最低點＝進場後 60 日內最低價）');
  out('');
  table(['模型', '事件數', '20 日內再破低', '60 日最低價低於訊號低點', '最低點距進場 中位(日)', '最低點距進場 中位(%)', '20 日報酬<0', '60 日 MAE 差於 -10%'], res.map(x => {
    const evs = x.confirmed.filter(e => e.out);
    const c20 = evs.map(e => e.out.h[20]).filter(h => h?.status === 'complete'), c60 = evs.map(e => e.out.h[60]).filter(h => h?.status === 'complete');
    return [x.label, evs.length, `${pct(x.stats.rebreakRate, 0)}（n=${x.stats.rebreakN}）`, pct(x.stats.trough.newLowRate, 0), num(x.stats.trough.medianDays, 0), pct(x.stats.trough.medianPct),
      c20.length ? pct(c20.filter(h => h.ret < 0).length / c20.length * 100, 0) : '—', c60.length ? pct(c60.filter(h => h.mae <= -10).length / c60.length * 100, 0) : '—'];
  }));
  out('**每一波下跌的首次觸發日（wave-first，與冷卻事件分開統計）**');
  out('');
  table(['模型', '波數', ...H.slice(0, 4).map(h => `${h}日 中位/平均 %`), '60 日 MAE 中位', '60 日 MFE 中位'], res.map(x => [x.label, x.waveFirst.length,
    ...H.slice(0, 4).map(h => (x.waveStats.by[h].n ? `${sg(x.waveStats.by[h].median)} / ${sg(x.waveStats.by[h].mean)}（n=${x.waveStats.by[h].n}）` : '—')),
    x.waveStats.by[60].n ? sg(x.waveStats.by[60].maeMedian) : '—', x.waveStats.by[60].n ? sg(x.waveStats.by[60].mfeMedian) : '—']));
  for (const x of res) json.assets[asset].models[x.model] = { triggerDays: x.triggerDays, base: x.baseCount, confirmed: x.confirmedCount, events: x.confirmed.map(e => ({ panic: f.days[e.panicIdx].date, date: f.days[e.index].date, out: e.out && { entryDate: e.out.entryDate, entry: e.out.entry, h: e.out.h } })) };
}

// ── 4. periods ───────────────────────────────────────────────────────────
out('## 4. 各市場環境的穩定性（事件數很少，僅為描述）');
out('');
out('所有參數都是事前固定、沒有對任何區間調整，因此各區間對「參數」而言都是樣本外；但 2020 年之後的區間在先前的 usrisk 研究已被看過，2000–2019 是這次才第一次用到的資料。PCR 的有效資料自 2007-05 起，故 2000–2002 的 Model B/E′ 不可評估。');
out('');
for (const asset of ASSETS) {
  const f = frames[asset];
  out(`### ${asset}`);
  out('');
  const rows = [];
  for (const [name, from, to] of U.PERIODS) {
    const r = U.runModels(f, { from, to });
    const cell = id => { const x = r[id]; const s = x.stats; return x.baseCount === 0 ? '0' : `${x.confirmedCount}｜20日 ${s.by[20].n ? sg(s.by[20].median) : '—'}｜60日 ${s.by[60].n ? sg(s.by[60].median) : '—'}｜MAE60 ${s.by[60].n ? sg(s.by[60].maeMedian) : '—'}`; };
    rows.push([name, cell('A'), cell('B'), cell('AS'), cell('E')]);
  }
  table(['區間', 'A：事件｜20日｜60日｜60日MAE（中位 %）', 'B', 'A′（A＋止穩）', 'E′（B＋止穩）'], rows);
}

// ── 5. sensitivity ───────────────────────────────────────────────────────
out('## 5. 敏感度（探索，不用來挑門檻）');
out('');
out('每列都套用同一個回撤閘門、10 日冷卻與下一開盤進場。這些表只回答「換門檻結果大不大」，不是樣本外驗證；不能因為某列看起來好就改主設定。');
out('');
for (const asset of ASSETS) {
  out(`### ${asset}`);
  out('');
  const rows = U.runSensitivity(frames[asset]).map(r => [r.group, r.label, r.triggerDays, r.events, r.stats.by[20].n ? sg(r.stats.by[20].median) : '—', r.stats.by[60].n ? sg(r.stats.by[60].median) : '—', r.stats.by[60].n ? sg(r.stats.by[60].maeMedian) : '—', r.stats.by[60].n ? pct(r.stats.by[60].win, 0) : '—']);
  table(['類別', '條件（皆含回撤閘門）', '觸發日', '事件數', '20日中位 %', '60日中位 %', '60日 MAE 中位', '60日勝率'], rows);
  out('**PCR 百分位 / 窗口變體（Model B 結構：VIX/VXN 極端 ＋ PCR 極端）**');
  out('');
  table(['條件', '觸發日', '事件數', '20日中位 %', '60日中位 %', '60日 MAE 中位'], U.runPcrVariants(ds, asset).map(r => [r.label, r.triggerDays, r.events, r.stats.by[20].n ? sg(r.stats.by[20].median) : '—', r.stats.by[60].n ? sg(r.stats.by[60].median) : '—', r.stats.by[60].n ? sg(r.stats.by[60].maeMedian) : '—']));
}

// ── 6. divergence ────────────────────────────────────────────────────────
out('## 6. 波動率背離（價格創 60 日收盤新低，但波動指標沒有同步創 60 日新高）');
out('');
out('窗口固定為前 60 個交易日、只用當日以前的資料，不使用事後確認的波段低點。比較背離日與「創新低但波動指標也創新高」的日子（同一回撤閘門）。');
out('');
for (const asset of ASSETS) {
  const f = frames[asset];
  const groups = { 背離: [], 同步創高: [] };
  for (const d of f.days) {
    if (!(d.ok && Number.isFinite(d.dd) && d.dd >= cfg.gate)) continue;
    const v = U.volDivergence(f.days, d.i, cfg);
    if (v?.newLow) (v.diverged ? groups.背離 : groups.同步創高).push(d.i);
  }
  const rows = Object.entries(groups).map(([k, idx]) => {
    const picked = []; let last = -Infinity; for (const i of idx) if (i - last >= cfg.cooldown) { picked.push(i); last = i; }
    const outs = picked.map(i => U.outcomeAt(f.days, i, cfg));
    const get = h => outs.map(o => o.h[h]).filter(x => x?.status === 'complete');
    const md_ = (a, key) => { const v = a.map(x => x[key]).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
    return [asset, k, idx.length, picked.length, get(20).length ? sg(md_(get(20), 'ret')) : '—', get(60).length ? sg(md_(get(60), 'ret')) : '—', get(60).length ? sg(md_(get(60), 'mae')) : '—'];
  });
  table(['標的', '類型', '日數', '事件(冷卻)', '20日中位 %', '60日中位 %', '60日 MAE 中位'], rows);
}

// ── 7. 2022 stress test ──────────────────────────────────────────────────
out('## 7. 2022 壓力測試（持續性熊市）');
out('');
out('2022 年沒有被用來調整任何參數。下列列出**所有**符合條件的日期，不挑最低點附近的訊號。');
out('');
const Y = ['2022-01-01', '2022-12-31'];
for (const asset of ASSETS) {
  const f = frames[asset], days22 = f.days.filter(d => d.date >= Y[0] && d.date <= Y[1]);
  out(`### 7.${asset === 'SPY' ? 1 : 2} ${asset}`);
  out('');
  const conds = {
    'VIX ≥ 30': d => d.vix >= cfg.vix, 'VXN ≥ 35': d => d.vxn >= cfg.vxn, 'PCR5 ≥ P95': d => d.pcrExt === true,
    '回撤 ≥ 8%': d => d.dd >= cfg.gate, 'Stage A（VIX/VXN ＋ 回撤）': d => U.stageA(d, cfg) === true, 'Model B（A ＋ PCR）': d => U.stageB(d, cfg) === true,
    'SPXA50R < 20%（非 PIT，僅供參考）': d => (ds.breadthSpx.get(d.date) ?? 100) < 20, 'NDXA50R < 20%（非 PIT，僅供參考）': d => (ds.breadthNdx.get(d.date) ?? 100) < 20,
  };
  out('**每月符合條件的交易日數**');
  out('');
  const months = [...new Set(days22.map(d => d.date.slice(0, 7)))];
  table(['條件', ...months.map(m => m.slice(5)), '全年'], Object.entries(conds).map(([k, fn]) => [k, ...months.map(m => days22.filter(d => d.date.startsWith(m) && fn(d)).length || ''), days22.filter(fn).length]));
  out('**所有符合日期**');
  out('');
  for (const [k, fn] of Object.entries(conds)) { const l = days22.filter(fn).map(d => d.date.slice(5)); out(`- ${k}（${l.length}）：${l.length ? l.join('、') : '無'}`); }
  out('');
  const unavailable = days22.filter(d => d.pcrExt === null).length;
  out(`PCR 判斷在 2022 年有 ${days22.length - unavailable}/${days22.length} 個交易日可評估（其餘為 unavailable，不當成未觸發）。`);
  out('');
  const { rows: ev } = U.eventRows(f, ds, { from: Y[0], to: Y[1] });
  json.assets[asset].y2022 = ev.map(r => ({ date: r.date, confirm: r.confirm?.date ?? null, lag: r.confirm?.lag ?? null }));
  out('**Stage A 事件（VIX/VXN ＋ 回撤閘門，冷卻 10 日）逐筆**');
  out('');
  out('「PCR」欄標 ✓ 表示當日同時構成 Model B；「再破低」＝進場後 60 日內最低價低於訊號日低點。Stage B 欄僅為背景：CFTC 槓桿基金淨部位占未平倉量（歷史百分位，2019 起）與 FINRA 最近一期月變動（公布後才可見）。');
  out('');
  table(['日期', '收盤', '回撤', 'VIX', 'VXN', 'PCR5', 'Model B', 'SPXA50R*', 'NDXA50R*', '5日', '20日', '60日', '60日 MAE', '60日再破低', '最低點(日,%)', 'Stage C 確認（延遲）', 'Stage B 背景'],
    ev.map(r => {
      const h = k => (r.out.h[k]?.status === 'complete' ? sg(r.out.h[k].ret) : '—');
      const ctx = r.context ? `ES ${pct(r.context.cftcES?.ratio)}(P${num(r.context.cftcES?.rank, 0)})；NQ ${pct(r.context.cftcNQ?.ratio)}(P${num(r.context.cftcNQ?.rank, 0)})；FINRA ${r.context.finra ? `${r.context.finra.month} 月 ${sg(r.context.finra.mom)}%` : '—'}` : '—';
      return [r.date, num(r.close, 2), pct(r.dd), num(r.vix), num(r.vxn), Number.isFinite(r.pcr) ? r.pcr.toFixed(3) : 'unavailable', r.modelB ? '✓' : '', num(r.breadthSpx, 0), num(r.breadthNdx, 0), h(5), h(20), h(60),
        r.out.h[60]?.status === 'complete' ? sg(r.out.h[60].mae) : '—', r.out.trough ? (r.out.trough.newLow ? '是' : '否') : '—', r.out.trough ? `${r.out.trough.days}日, ${sg(r.out.trough.pct)}%` : '—',
        r.confirm ? `${r.confirm.date}（+${r.confirm.lag}）` : '40 日內未確認', ctx];
    }));
  out('*SPXA50R／NDXA50R 為現任成分股回填，僅供參考，未進模型。');
  out('');
  out('**Stage C 確認後的結果與失敗辨識**');
  out('');
  const cf = ev.filter(r => r.confirm);
  table(['Stage A 日', 'Stage C 確認日', '延遲(日)', '確認價', '確認後 5/20/60 日報酬 %', '60 日 MAE', '失敗（跌破 A→C 最低收盤）', '失敗時損失'], cf.map(r => {
    const o = r.confirm.out, h = k => (o?.h[k]?.status === 'complete' ? sg(o.h[k].ret) : '—'), inv = r.confirm.invalid;
    return [r.date, r.confirm.date, r.confirm.lag, num(r.confirm.close, 2), `${h(5)} / ${h(20)} / ${h(60)}`, o?.h[60]?.status === 'complete' ? sg(o.h[60].mae) : '—', inv ? `是，確認後第 ${inv.days} 日` : '否（60 日內）', inv ? `${sg(inv.lossAtInvalidation)}%` : ''];
  }));
  // summary answers
  const n = ev.length, nB = ev.filter(r => r.modelB).length;
  const S = U.episodeSummary(ev), dates = l => (l.length ? `（${l.map(d => d.slice(5)).join('、')}）` : '');
  out(`**${asset} 2022 重點答案**`);
  out('');
  out(`1. 全年 Stage A 事件 ${n} 件（觸發日 ${days22.filter(d => U.stageA(d, cfg) === true).length} 天）；其中同時構成 Model B 的 ${nB} 件。每件事件後 60 日內最低價都低於訊號日當天的最低價是「下殺仍在延續」的常態，不拿來區分好壞；改以事件後 60 日 MAE 分級（分級門檻是描述用的任意切點，不是模型參數）。`);
  out(`2. 事件後 60 日 MAE 差於 -10%（市場繼續明顯下殺，多為熊市中繼反彈後的再下跌）：${S.deep.length}/${n} 件${dates(S.deep)}。`);
  out(`3. MAE 介於 -5% ～ -10%：${S.mid.length}/${n} 件${dates(S.mid)}。`);
  out(`4. MAE 淺於 -5%（後續跌幅相對有限）：${S.shallow.length}/${n} 件${dates(S.shallow)}。`);
  out(`5. Stage A 到 Stage C 確認的延遲：${S.confirmed}/${n} 件有確認，延遲中位數 ${S.lagMedian ?? '—'} 個交易日（範圍 ${S.lagMin ?? '—'}～${S.lagMax ?? '—'}）。確認後 60 日報酬為負的有 ${S.confirmedNegative60}/${S.confirmed} 件。`);
  out(`6. Stage C 確認後 60 日內收盤再跌破 A→C 最低收盤（模型自己辨識為失敗）：${S.failed.length}/${S.confirmed} 件${S.failed.length ? `；辨識時損失（相對進場開盤）${S.failed.map(f => `${f.confirmDate.slice(5)} ${sg(f.loss)}%（第 ${f.days} 日）`).join('、')}` : ''}。辨識時點是跌破當日收盤，已經承受該段損失，不是事前預警。`);
  out('');
  json.assets[asset].y2022mae = { deep: S.deep.length, mid: S.mid.length, shallow: S.shallow.length };
  json.assets[asset].y2022summary = { events: n, modelB: nB, confirmed: S.confirmed, failed: S.failed.length };
}

// ── 8. stabilization strength (exploration) ──────────────────────────────
out('## 8. 止穩條件強度比較（探索；2022 同時在樣本內，不能宣稱驗證）');
out('');
out('只改 Stage C 的參數，其餘不變。欄位為 Model A 的 Stage A 事件經不同止穩條件確認後的結果。');
out('');
for (const asset of ASSETS) {
  out(`### ${asset}`);
  out('');
  const rows = [];
  const variants = [['主設定：5 日無新低、波動 ≤80%、站上 10MA', {}], ['無新低 10 日', { noNewLowDays: 10 }], ['波動 ≤70%', { volRetreat: 0.7 }], ['站上 20MA', { maDays: 20 }], ['無新低 10 日＋波動 ≤70%', { noNewLowDays: 10, volRetreat: 0.7 }]];
  for (const [label, p] of variants) {
    const f = U.buildFrame(ds, asset, p);
    for (const [pn, from, to] of [['全樣本', undefined, undefined], ['2022', Y[0], Y[1]]]) {
      const r = U.modelEvents(f, U.MODELS.find(m => m.id === 'AS'), { from, to }), s = r.stats;
      const lag = r.confirmed.map(e => e.conf.lag).sort((a, b) => a - b);
      rows.push([label, pn, r.baseCount, r.confirmedCount, lag.length ? lag[Math.floor((lag.length - 1) / 2)] : '—', s.by[20].n ? sg(s.by[20].median) : '—', s.by[60].n ? sg(s.by[60].median) : '—', s.by[60].n ? sg(s.by[60].maeMedian) : '—', s.trough.newLowRate == null ? '—' : pct(s.trough.newLowRate, 0)]);
    }
  }
  table(['止穩條件', '區間', 'A 事件', '確認數', '延遲中位(日)', '20日中位 %', '60日中位 %', '60日 MAE 中位', '60日再破低'], rows);
}

// ── 9. Stage B: margin debt ─────────────────────────────────────────────
out('## 9. FINRA Margin Debt 與主要修正（背景，月資料）');
out('');
out('Margin Debt 月資料不插值；下表只描述「融資餘額與價格低點的先後」。公布日假設月底＋25 天，因此下表的「何時可知」是估計。');
out('');
{
  const f = frames.SPY, waves = U.findWaves(f.days, cfg).filter(w => w.maxDd >= 10);
  const fin = ds.finra.filter(r => Number.isFinite(r.margin_balance)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const monthOf = d => `${d.slice(0, 7)}-01`;
  const rows = waves.map(w => {
    const startM = monthOf(w.startDate), troughM = monthOf(w.troughDate);
    const preIdx = fin.findIndex(r => r.date >= startM);
    if (preIdx < 12 || preIdx < 0) return null;
    const pre = fin.slice(preIdx - 12, preIdx + 1), peak = pre.reduce((a, b) => (b.margin_balance > a.margin_balance ? b : a));
    const after = fin.filter(r => r.date >= peak.date && r.date <= monthOf(new Date(Date.parse(w.troughDate) + 180 * 86400000).toISOString().slice(0, 10)));
    if (!after.length) return null;
    const lo = after.reduce((a, b) => (b.margin_balance < a.margin_balance ? b : a));
    const dm = (Date.parse(lo.date) - Date.parse(troughM)) / (30.44 * 86400000);
    return [`${w.startDate} → ${w.troughDate}`, pct(-w.maxDd), `${peak.date.slice(0, 7)}（${(peak.margin_balance / 1000).toFixed(0)}B）`, `${lo.date.slice(0, 7)}（${(lo.margin_balance / 1000).toFixed(0)}B）`, pct((lo.margin_balance / peak.margin_balance - 1) * 100), `${dm >= 0 ? '+' : ''}${dm.toFixed(0)}`];
  }).filter(Boolean);
  table(['SPY 修正波段（回撤 ≥10%）', '最大回撤', '融資餘額高點月（前 12 月內）', '融資餘額低點月（價格低點後 6 個月內）', '高→低', '融資低點月 − 價格低點月（月）'], rows);
  out('正值表示融資餘額低點比價格低點晚；月資料加上約 25 天公布延遲，無法在價格低點當下得知。');
  out('');
}

// ── 9b. Sensitive tier ──────────────────────────────────────────────────
out('## 9b. 敏感層（VXN ≥ 30 ＋ 回撤閘門，不要求 VIX）— 非主設定');
out('');
out('這個門檻是看到 2026-07-29 案例（QQQ：VXN 30.8、VIX 只有 20.7）後才提出的，屬事後觀察到的情境，沒有樣本外驗證；只獨立標示，不混入主模型。下表列 2023 年以來的敏感層事件，與主設定 A 對照。');
out('');
for (const asset of ASSETS) {
  const f = frames[asset], S = U.MODELS.find(m => m.id === 'S'), A = U.MODELS.find(m => m.id === 'A');
  const sEv = U.modelEvents(f, S, { from: '2023-01-01' }).confirmed, aDates = new Set(U.modelEvents(f, A, { from: '2023-01-01' }).confirmed.map(e => f.days[e.index].date));
  out(`### ${asset}`);
  out('');
  table(['日期（警報日）', '收盤', '回撤', 'VIX', 'VXN', '同時是主設定 A', '進場（隔日開盤）', '5日 %', '20日 %', '60日 %', '60日 MAE %'], sEv.map(e => {
    const d = f.days[e.index], o = e.out, h = k => (o.h[k]?.status === 'complete' ? sg(o.h[k].ret) : '—');
    return [d.date, num(d.close, 2), pct(d.dd), num(d.vix), num(d.vxn), aDates.has(d.date) ? '是' : '否（只有敏感層）', o.entryDate ? `${o.entryDate} ${num(o.entry, 2)}` : '—', h(5), h(20), h(60), o.h[60]?.status === 'complete' ? sg(o.h[60].mae) : '—'];
  }));
  const oct = f.days.filter(d => d.date >= '2023-10-01' && d.date <= '2023-11-15');
  out(`2023-10 檢查（${asset}）：期間 VXN 最高 ${num(Math.max(...oct.map(d => d.vxn ?? 0)))}、VIX 最高 ${num(Math.max(...oct.map(d => d.vix ?? 0)))}、最大回撤 ${pct(Math.max(...oct.map(d => d.dd ?? 0)))}；敏感層（VXN≥30）在此期間 ${sEv.some(e => f.days[e.index].date >= '2023-10-01' && f.days[e.index].date <= '2023-11-15') ? '有' : '**沒有**'}觸發。要抓到 2023-10 需要把 VXN 門檻降到 25，見第 5 節敏感度表與 us-capitulation-alert.md。`);
  out('');
}

// ── 10. Stage B slice: CFTC extreme short positioning at Stage A events (descriptive) ──
out('## 10. Stage B 背景切片：Stage A 事件當時的 CFTC 槓桿基金淨部位（描述；不是模型條件）');
out('');
out('只用事件日「已公布」的 CFTC 報告（as-of 週二、週五公布、事件日需晚於公布日）；百分位用 2019 年以來到當時為止的歷史，因此只取 2021-01-01 以後（歷史 ≥ 約 100 週）的 Stage A 事件。S&P 500 合約的槓桿基金淨部位占未平倉量位於歷史最低 10% 以內，對照其餘事件。事件很少、彼此相關，只是描述。');
out('');
for (const asset of ASSETS) {
  const { rows } = U.eventRows(frames[asset], ds, { from: '2021-01-01' });
  const groups = { '最低 10% 以內': r => r.context?.cftcES && r.context.cftcES.history >= 100 && r.context.cftcES.rank <= 10, '其餘（有資料）': r => r.context?.cftcES && r.context.cftcES.history >= 100 && r.context.cftcES.rank > 10 };
  const trs = Object.entries(groups).map(([k, fn]) => {
    const g = rows.filter(fn), c = h => g.map(r => r.out.h[h]).filter(x => x?.status === 'complete');
    const mdn = (a, key) => { const v = a.map(x => x[key]).sort((x, y) => x - y); return v.length ? sg(v[Math.floor((v.length - 1) / 2)]) : '—'; };
    return [asset, `ES 淨部位 ${k}`, g.length, mdn(c(20), 'ret'), mdn(c(60), 'ret'), mdn(c(60), 'mae')];
  });
  table(['標的', '分組', '事件數', '20日中位 %', '60日中位 %', '60日 MAE 中位'], trs);
}

writeFileSync(new URL(`../../${arg('--out', 'docs/research/us-capitulation-alert-backtest.md')}`, import.meta.url), md.join('\n') + '\n');
const jsonOut = arg('--json');
if (jsonOut) writeFileSync(new URL(`../../${jsonOut}`, import.meta.url), JSON.stringify(json) + '\n');
console.log(`wrote report (${md.length} lines)`);
