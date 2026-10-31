// QQQ 盤中急跌 × 恐慌背離回測 CLI。
// 引擎 js/tabs/qqqpanic_calc.mjs；輸出 docs/research/qqq-panic-divergence-{backtest.md,backtest.json,events.csv,groups.csv}。
// 用法：node scripts/research/backtest_qqq_panic.mjs [--out <dir>]   （只讀 data/*.json，不抓網路、不改 data/）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as E from '../../js/tabs/qqqpanic_calc.mjs';

const root = new URL('../../', import.meta.url);
const argOut = process.argv.indexOf('--out');
const outDir = argOut > 0 ? process.argv[argOut + 1] : new URL('docs/research/', root).pathname;
mkdirSync(outDir, { recursive: true });
const C = E.DEFAULTS;

// ── 輸入與來源追溯 ──────────────────────────────────────────────────────
const SOURCES = [
  { key: 'QQQ', path: 'data/QQQ.json', origin: 'Yahoo Finance via yfinance（scripts/fetch_stocks.py，auto_adjust=False 原始價，未還原股息）', timing: '日線 OHLCV；當日 Low 與成交量需收盤後才完整' },
  { key: 'VIX', path: 'data/VIX.json', origin: 'Yahoo Finance ^VIX（scripts/fetch_stocks.py）', timing: '日線 OHLC；High 盤中即時可見，但「當日最高」收盤後才確定' },
  { key: 'VXN', path: 'data/VXN.json', origin: 'Yahoo Finance ^VXN（scripts/fetch_stocks.py）', timing: '同 VIX；僅作輔助' },
  { key: 'FG', path: 'data/fear_greed.json', origin: 'CNN Fear & Greed：2011 起歷史取自 GitHub whit3rabbit/fear-greed-data 鏡像，近期取自 CNN production.dataviz.cnn.io graphdata（scripts/fetch_fear_greed.py）', timing: '每日一值、無盤中時間戳；本研究視為「盤後才可得」' },
];
const raw = {}, provenance = [];
for (const s of SOURCES) {
  const buf = readFileSync(new URL(s.path, root)), j = JSON.parse(buf);
  raw[s.key] = j.data;
  provenance.push({ ...s, sha256: createHash('sha256').update(buf).digest('hex'), updated: j.updated ?? null, rows: j.data.length, first: j.data[0]?.date, last: j.data.at(-1)?.date });
}
let gitHead = null; try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root.pathname }).toString().trim(); } catch { /* not a git checkout */ }

const res = E.run(raw, C);
const { F, runs, byThr } = res;
const main = byThr[C.main];

// FG 缺漏（研究期間）
const fgMissing = []; for (let i = F.startIdx; i <= F.endIdx; i++) if (F.fg[i] === null) fgMissing.push(F.date[i]);
const vixMissing = [], vxnMissing = [];
for (let i = F.startIdx; i <= F.endIdx; i++) { if (F.vixH[i] === null) vixMissing.push(F.date[i]); if (F.vxnH[i] === null) vxnMissing.push(F.date[i]); }

// ── 比較集合 ────────────────────────────────────────────────────────────
const volOK = (thr = C.volSurge) => r => finite(r.volRatio) && r.volRatio >= thr;
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
const sets = [];
for (const thr of C.thresholds) {
  const R = byThr[thr];
  sets.push({ id: `g${thr}v`, thr, unit: 'group', vol: C.volSurge, label: `${thr}%｜爆量｜去重群組`, rows: R.reps.filter(volOK()) });
  sets.push({ id: `g${thr}`, thr, unit: 'group', vol: null, label: `${thr}%｜不限量｜去重群組`, rows: R.reps });
  sets.push({ id: `r${thr}v`, thr, unit: 'raw', vol: C.volSurge, label: `${thr}%｜爆量｜未去重逐筆`, rows: R.rows.filter(volOK()) });
  sets.push({ id: `r${thr}`, thr, unit: 'raw', vol: null, label: `${thr}%｜不限量｜未去重逐筆`, rows: R.rows });
}
for (const v of C.volSensitivity) sets.push({ id: `g${C.main}v${v}`, thr: C.main, unit: 'group', vol: v, label: `${C.main}%｜量 ≥ ${v}×｜去重群組（量門檻敏感度）`, rows: main.reps.filter(volOK(v)) });

const comparisons = sets.map(s => {
  const ab = s.unit === 'group' ? E.compareAB(s.rows, C) : (() => {   // 逐筆不獨立：只給點估計，不給 CI
    const A = s.rows.filter(r => r.panic === 'A'), B = s.rows.filter(r => r.panic === 'B');
    return { A: E.describe(A, E.AB_KEYS), B: E.describe(B, E.AB_KEYS), U: s.rows.filter(r => r.panic === 'U').length, diff: null,
      aPanicDays: { n: A.filter(r => finite(r.post?.panicDays)).length, of: A.filter(r => r.complete || finite(r.post?.panicDays)).length, censored: A.filter(r => !r.complete && !finite(r.post?.panicDays)).length, median: E.median(A.map(r => r.post?.panicDays)) } };
  })();
  return { id: s.id, label: s.label, thr: s.thr, unit: s.unit, vol: s.vol, n: s.rows.length, nA: ab.A.n, nB: ab.B.n, nU: ab.U, A: ab.A, B: ab.B, diff: ab.diff, aPanicDays: ab.aPanicDays };
});

const strata = {};
for (const thr of [C.main, ...C.compare]) strata[thr] = Object.fromEntries(E.STRATA.map(s => [s.key, E.stratify(byThr[thr].reps, s.key)]));

// ── 區間 ────────────────────────────────────────────────────────────────
const focus = E.PERIODS.find(p => p.id === '2026-07~10');
const focusProfile = E.periodProfile(F, focus.from, focus.to, runs);
const i22 = F.date.findIndex(d => d >= '2022-01-01');
const eq22 = { id: '2022-eq', label: `2022 年初等長窗（${focusProfile.days} 個交易日，補充）`, from: F.date[i22], to: F.date[i22 + focusProfile.days - 1], extra: true };
const periodList = [...E.PERIODS, eq22];
const profiles = periodList.map(p => {
  const prof = E.periodProfile(F, p.from, p.to, runs);
  // 區間結束後 60 個交易日的實際走勢（事後才知道；2026 視窗無此資料）
  const iEnd = F.index.get(prof.to), avail = Math.min(60, F.endIdx - iEnd);
  let after = null;
  if (avail >= 60) {
    let lo = Infinity; for (let k = iEnd + 1; k <= iEnd + 60; k++) lo = Math.min(lo, F.l[k]);
    after = { ret60: (F.c[iEnd + 60] / F.c[iEnd] - 1) * 100, minLowVsEndClose: (lo / F.c[iEnd] - 1) * 100 };
  }
  return { ...p, profile: prof, after, afterAvail: avail };
});
const periodEvents = Object.fromEntries(periodList.map(p => [p.id, Object.fromEntries(C.thresholds.map(t => [t, byThr[t].rows.filter(r => r.date >= p.from && r.date <= p.to).map(r => r.date)]))]));

// ── CSV ─────────────────────────────────────────────────────────────────
const r4 = v => (finite(v) ? +v.toFixed(4) : '');
const b = v => (v === true ? 1 : v === false ? 0 : '');
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (header, rows) => [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';
const inPeriods = d => E.PERIODS.filter(p => d >= p.from && d <= p.to).map(p => p.id).join('|');
const EVH = ['threshold_pct', 'date', 'group_id', 'group_rank', 'is_group_rep', 'prev_close', 'open', 'high', 'low', 'close', 'volume', 'vol_avg20_prior', 'vol_ratio', 'vol_surge_1p5',
  'drop_low_vs_prev_close_pct', 'hl_range_high_to_low_pct', 'close_chg_pct', 'close_from_low_pct',
  'vix_high', 'vix_close', 'vxn_high', 'vxn_close', 'fg_value', 'fg_missing', 'panic_class', 'panic_detail', 'vxn_high_ge40',
  'pre_high_60', 'pre_high_date', 'pre_high_days_ago', 'event_drawdown_pct',
  'pre_fg_max', 'pre_fg_min', 'pre_fg_days', 'pre_vix_high_max', 'pre_vix_low_min', 'pre_vxn_high_max', 'pre_vxn_low_min',
  'post_days_available', 'post_window_complete', 'entry_date_t1', 'entry_open_t1',
  ...C.horizons.flatMap(h => [`ret${h}_open_pct`, `ret${h}_close_pct`, `mae${h}_open_pct`, `mae${h}_close_pct`, `min_low${h}`, `rebreak${h}`, `extra_drop${h}_pct`, `total_dd${h}_pct`]),
  'min_low60_date', 'min_low60_days', 'first_rebreak_date', 'first_rebreak_days', 'max_high60', 'max_high60_date', 'mfe60_open_pct', 'recover_pre_high_date', 'recover_pre_high_days',
  'post_fg_max', 'post_fg_min', 'post_fg_min_date', 'post_fg_days', 'post_fg_below15_date', 'post_fg_below15_days', 'post_vix_high_max', 'post_vix_low_min', 'post_vxn_high_max', 'post_vxn_low_min',
  'post_vix_high_ge30_date', 'post_vix_high_ge30_days', 'post_extreme_panic_date', 'post_extreme_panic_days',
  ...[125, 150].flatMap(p => [`ma${p}`, `ma${p}_dist_pct`, `ma${p}_status`, `ma${p}_reclaim_date`, `ma${p}_reclaim_days`, `ma${p}_confirm2p5_date`, `ma${p}_confirm2p5_days`, `ma${p}_confirm2p5_status`]),
  'ma300', 'ma300_dist_pct', 'ma300_status', 'ma300_touched_on_event', 'ma300_touch_date', 'ma300_touch_days', 'ma300_touch_status', 'special_periods'];
const evRow = (thr, r) => [thr, r.date, r.groupId, r.groupRank, b(r.isRep), r.prevClose, r.open, r.high, r.low, r.close, r.volume, r4(F.volAvg[r.idx]), r4(r.volRatio), b(r.volSurge),
  r4(r.dropLow), r4(r.hlRange), r4(r.closeChg), r4(r.closeFromLow),
  r.vixHigh ?? '', r.vixClose ?? '', r.vxnHigh ?? '', r.vxnClose ?? '', r.fg ?? '', b(r.fg === null), r.panic, r.panicDetail, b(r.vxnAux),
  r.preHigh ?? '', r.preHighDate ?? '', r.preHighAgo ?? '', r4(r.eventDD),
  r.pre?.fgMax ?? '', r.pre?.fgMin ?? '', r.pre?.fgCount ?? '', r.pre?.vixHMax ?? '', r.pre?.vixLMin ?? '', r.pre?.vxnHMax ?? '', r.pre?.vxnLMin ?? '',
  r.avail, b(r.complete), r.entryOpenDate ?? '', r.entryOpen ?? '',
  ...C.horizons.flatMap(h => { const x = r.h[h]; return x ? [r4(x.retOpen), r4(x.retClose), r4(x.maeOpen), r4(x.maeClose), x.minLow, b(x.rebreak), r4(x.extra), r4(x.totalDD)] : ['', '', '', '', '', '', '', '']; }),
  r.h[60]?.minLowDate ?? '', r.h[60]?.minLowDays ?? '', r.firstRebreakDate ?? '', r.firstRebreakDays ?? '', r.h[60]?.maxHigh ?? '', r.h[60]?.maxHighDate ?? '', r4(r.h[60]?.mfeOpen), r.recoverPreHighDate ?? '', r.recoverPreHighDays ?? '',
  r.post?.fgMax ?? '', r.post?.fgMin ?? '', r.post?.fgMinDate ?? '', r.post?.fgCount ?? '', r.post?.fgBelow15Date ?? '', r.post?.fgBelow15Days ?? '', r.post?.vixHMax ?? '', r.post?.vixLMin ?? '', r.post?.vxnHMax ?? '', r.post?.vxnLMin ?? '',
  r.post?.vix30Date ?? '', r.post?.vix30Days ?? '', r.post?.panicDate ?? '', r.post?.panicDays ?? '',
  ...[125, 150].flatMap(p => { const m = r.ma[p]; return [r4(m.value), r4(m.dist), m.status, m.reclaimDate ?? '', m.reclaimDays ?? '', m.confirmDate ?? '', m.confirmDays ?? '', m.confirmStatus ?? '']; }),
  r4(r.ma[300].value), r4(r.ma[300].dist), r.ma[300].status, b(r.ma[300].touchedOnEvent), r.ma[300].touchDate ?? '', r.ma[300].touchDays ?? '', r.ma[300].touchStatus ?? '', inPeriods(r.date)];
writeFileSync(`${outDir}/qqq-panic-divergence-events.csv`, toCSV(EVH, runs.flatMap(R => R.rows.map(r => evRow(R.threshold, r)))));
const GH = ['group_id', 'threshold_pct', 'anchor_date', 'last_date', 'event_count', 'member_dates', 'rep_panic_class', 'rep_vol_surge', 'any_member_panic_b', 'later_member_panic_b', 'group_min_low', 'deepest_drop_pct',
  'rep_event_drawdown_pct', 'rep_rebreak20', 'rep_rebreak60', 'rep_extra_drop60_pct', 'rep_total_dd60_pct', 'rep_ret20_open_pct', 'rep_ret60_open_pct', 'rep_mae60_open_pct', 'rep_post_extreme_panic_days', 'rep_window_complete', 'special_periods'];
writeFileSync(`${outDir}/qqq-panic-divergence-groups.csv`, toCSV(GH, runs.flatMap(R => R.groups.map(g => [g.id, g.threshold, g.anchorDate, g.lastDate, g.count, g.memberDates.join(' '), g.rep.panic, b(g.rep.volSurge), b(g.anyPanicB), b(g.laterPanicInGroup), g.groupMinLow, r4(g.deepestDrop),
  r4(g.rep.eventDD), b(g.rep.h[20]?.rebreak), b(g.rep.h[60]?.rebreak), r4(g.rep.h[60]?.extra), r4(g.rep.h[60]?.totalDD), r4(g.rep.h[20]?.retOpen), r4(g.rep.h[60]?.retOpen), r4(g.rep.h[60]?.maeOpen), g.rep.post?.panicDays ?? '', b(g.rep.complete), inPeriods(g.anchorDate)]))));

// ── JSON ────────────────────────────────────────────────────────────────
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(6) : k === 'values' ? undefined : v)));
const sampleTable = runs.map(R => ({
  threshold: R.threshold, raw: R.rows.length, groups: R.groups.length,
  rawA: R.rows.filter(r => r.panic === 'A').length, rawB: R.rows.filter(r => r.panic === 'B').length, rawU: R.rows.filter(r => r.panic === 'U').length,
  groupA: R.reps.filter(r => r.panic === 'A').length, groupB: R.reps.filter(r => r.panic === 'B').length,
  rawVol: R.rows.filter(volOK()).length, groupVol: R.reps.filter(volOK()).length,
  groupVolA: R.reps.filter(r => volOK()(r) && r.panic === 'A').length, groupVolB: R.reps.filter(r => volOK()(r) && r.panic === 'B').length,
  incomplete60Raw: R.rows.filter(r => !r.complete).length, incomplete60Groups: R.reps.filter(r => !r.complete).length,
}));
const out = {
  generated_for: { study: `${C.start} ～ ${C.end}`, first_trading_day: F.date[F.startIdx], last_trading_day: F.date[F.endIdx], git_head_at_run: gitHead, engine: 'js/tabs/qqqpanic_calc.mjs' },
  config: C, provenance, missing: { fearGreed: fgMissing, vixHigh: vixMissing, vxnHigh: vxnMissing },
  samples: sampleTable, comparisons: strip(comparisons), strata: strip(strata),
  periods: strip(profiles), periodEvents,
};
writeFileSync(`${outDir}/qqq-panic-divergence-backtest.json`, JSON.stringify(out, null, 1) + '\n');

// ── Markdown ────────────────────────────────────────────────────────────
const f1 = v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—');
const p0 = v => (finite(v) ? `${(v * 100).toFixed(0)}%` : '—');
const ciTxt = (o, kind) => (o?.ci && finite(o.ci.lo) ? (kind === 'share' ? ` [${p0(o.ci.lo)}, ${p0(o.ci.hi)}]` : ` [${f1(o.ci.lo)}, ${f1(o.ci.hi)}]`) : '');
const wil = o => (o?.wilson && finite(o.wilson.lo) ? ` W[${p0(o.wilson.lo)}, ${p0(o.wilson.hi)}]` : '');
const cell = (o, kind) => (!o || !o.n ? '—（n=0）' : `${kind === 'share' ? p0(o.value) : f1(o.value)}${ciTxt(o, kind)}${kind === 'share' ? wil(o) : ''}（n=${o.n}）`);
const diffTxt = (d, kind) => (!d || !finite(d.est) ? '—' : kind === 'share' ? `${f1(d.est * 100)} pt [${f1(d.lo * 100)}, ${f1(d.hi * 100)}]` : `${f1(d.est)} [${f1(d.lo)}, ${f1(d.hi)}]`);
const T = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const L = [];
L.push(`# QQQ 盤中急跌 × 恐慌背離 — 回測數據（自動產生）`, '',
  `研究期間 ${C.start} ～ ${C.end}（實際交易日 ${F.date[F.startIdx]} ～ ${F.date[F.endIdx]}）。本檔由 \`node scripts/research/backtest_qqq_panic.mjs\` 產生，勿手改；方法與解讀見 [qqq-panic-divergence.md](qqq-panic-divergence.md)。逐筆資料：[events.csv](qqq-panic-divergence-events.csv)、[groups.csv](qqq-panic-divergence-groups.csv)；完整數值：[backtest.json](qqq-panic-divergence-backtest.json)。`, '',
  '純描述性研究，不是買賣訊號。所有群組層級統計以「每群第一筆」為樣本；逐筆（未去重）統計彼此重疊、不獨立，只給點估計、不給信賴區間。', '');
L.push('## 1. 資料來源與可取得時點', '', T(['資料', '檔案', '列數／涵蓋', 'SHA-256（前 16 碼）', 'updated', '來源', '可取得時點'],
  provenance.map(p => [p.key, `\`${p.path}\``, `${p.rows}｜${p.first} ～ ${p.last}`, p.sha256.slice(0, 16), p.updated ?? '—', p.origin, p.timing])), '',
  `研究期間缺漏：Fear & Greed 缺 ${fgMissing.length} 個交易日（${fgMissing[0] ?? ''} ～ ${fgMissing.at(-1) ?? ''}），不補值；VIX High 缺 ${vixMissing.length} 日；VXN High 缺 ${vxnMissing.length} 日。執行時 git HEAD：\`${gitHead ?? 'unavailable'}\`（資料以上表 SHA-256 為準）。`, '');
L.push('## 2. 樣本量', '', T(['門檻', '原始事件', '其中 A／B／未分類', '去重群組（錨定 20 日）', '群組 A／B', '原始爆量', '群組爆量（A／B）', '60 日觀察期不足（原始／群組）'],
  sampleTable.map(s => [`${s.threshold}%${s.threshold === C.main ? '（主）' : C.appendix.includes(s.threshold) ? '（附錄）' : ''}`, s.raw, `${s.rawA}／${s.rawB}／${s.rawU}`, s.groups, `${s.groupA}／${s.groupB}`, s.rawVol, `${s.groupVol}（${s.groupVolA}／${s.groupVolB}）`, `${s.incomplete60Raw}／${s.incomplete60Groups}`])), '',
  'A＝VIX High < 30 且 F&G ≥ 15（當日盤後皆可得）；B＝VIX High ≥ 30 或 F&G < 15；未分類＝F&G 缺值且 VIX 未達門檻。爆量＝當日量 ≥ 前 20 日（T-20～T-1）均量 × 1.5。', '');
const keyLabel = Object.fromEntries(E.METRICS.map(m => [m.key, [m.label, m.kind]]));
L.push('## 3. A／B 比較（主研究與對照）', '', '格式：點估計 [95% bootstrap 區間]（有效 n）；比例另附 W[Wilson 95% 區間]，因為比例為 0% 或 100% 時 bootstrap 區間會退化成單點。差值＝B − A（兩組各自重抽），比例以百分點表示。區間只描述抽樣不確定性，不代表因果。B 組事件日已是極端恐慌，「之後出現極端恐慌」兩列對 B 只反映持續性，不做差值。', '');
const order = [`g${C.main}v`, `g${C.main}`, `r${C.main}v`, `r${C.main}`, `g${C.main}v1.2`, `g${C.main}v2`, ...C.compare.flatMap(t => [`g${t}v`, `g${t}`]), ...C.appendix.flatMap(t => [`g${t}v`, `g${t}`])];
for (const id of order) {
  const c = comparisons.find(x => x.id === id); if (!c) continue;
  L.push(`### ${c.label}${c.thr === C.main && c.vol === C.volSurge && c.unit === 'group' ? '（主研究）' : C.appendix.includes(c.thr) ? '（極端附錄，小樣本）' : ''}`, '',
    `n＝${c.n}（A ${c.nA}、B ${c.nB}、未分類 ${c.nU}）。A 組事後首次出現極端恐慌：${c.aPanicDays.n}/${c.aPanicDays.of} 件在 60 日內出現，中位 ${c.aPanicDays.median ?? '—'} 個交易日${c.aPanicDays.censored ? `（另 ${c.aPanicDays.censored} 件觀察期不足，不計）` : ''}。`, '',
    T(['指標', 'A 無極端恐慌', 'B 極端恐慌', 'B − A'], E.AB_KEYS.map(k => [keyLabel[k][0], cell(c.A.m[k], keyLabel[k][1]), E.A_ONLY_KEYS.has(k) ? `（持續性）${cell(c.B.m[k], keyLabel[k][1])}` : cell(c.B.m[k], keyLabel[k][1]), E.A_ONLY_KEYS.has(k) ? '不適用' : c.diff ? diffTxt(c.diff[k], keyLabel[k][1]) : '（逐筆不獨立，不估）'])), '');
}
L.push('## 4. 分層（去重群組，每群第一筆）', '');
for (const thr of [C.main, ...C.compare]) for (const s of E.STRATA) {
  L.push(`### ${thr}%｜${s.label}`, '', T(['分層', 'n', '20 日再破底', '60 日再破底', '60 日額外跌幅 中位', '20 日報酬 中位', '60 日報酬 中位', '60 日 MAE 中位'],
    strata[thr][s.key].map(x => [x.bucket, x.n, `${p0(x.m.rebreak20.value)}（${x.m.rebreak20.n}）`, `${p0(x.m.rebreak60.value)}（${x.m.rebreak60.n}）`, f1(x.m.extra60.value), f1(x.m.ret20.value), f1(x.m.ret60.value), f1(x.m.mae60.value)])), '');
}
L.push('## 5. 特殊區間', '', '區間輪廓只用區間內（與之前）的資料；「區間後 60 日」是事後才知道的結果，只供對照，2026 區間尚無此資料。', '',
  T(['區間', '交易日', '區間報酬', '最大回撤（252 日高）', '收盤 < 150MA', '收盤 < 300MA', '150MA 斜率', '觸 300MA 日', 'VIX H 最高', 'VXN H 最高', 'VIX H≥30 日', 'F&G 最低', 'F&G 中位', 'F&G<15 日', '-3% 事件（A/B）', '-2% 事件（A/B）', '-3% 爆量 A', '60 日新低收盤次數', '區間後 60 日報酬／最低'],
    profiles.map(({ label, profile: p, after }) => [label, p.days, f1(p.ret), f1(p.maxDD252), p0(p.belowMa150), p0(p.belowMa300), f1(p.ma150Slope), p.touch300, p.vixHMax ?? '—', p.vxnHMax ?? '—', p.vixPanicDays, p.fgMin ?? '—', f1(p.fgMedian), `${p.fgPanicDays}${p.fgMissing ? `（缺 ${p.fgMissing}）` : ''}`,
      `${p.events[-3].raw}（${p.events[-3].A}/${p.events[-3].B}）`, `${p.events[-2].raw}（${p.events[-2].A}/${p.events[-2].B}）`, p.events[-3].aVolSurge, p.newLow60, after ? `${f1(after.ret60)}／${f1(after.minLowVsEndClose)}` : '尚無'])), '');
for (const p of periodList) {
  const rows = byThr[-2].rows.filter(r => r.date >= p.from && r.date <= p.to);
  if (!rows.length) { L.push(`### ${p.label}（${p.from} ～ ${p.to}）`, '', '區間內沒有 ≤ -2% 的盤中急跌。', ''); continue; }
  L.push(`### ${p.label}（${p.from} ～ ${p.to}）`, '', T(['日期', '盤中跌幅', '收盤漲跌', 'H→L', '量比', 'VIX H/C', 'VXN H/C', 'F&G', '分類', '波段回撤', '20 日再破底｜額外跌幅', '60 日再破底｜額外跌幅', '20／60 日報酬', '之後極端恐慌', '150MA'],
    rows.map(r => [`${r.date}${r.dropLow <= -3 ? ' ●' : ''}`, f1(r.dropLow), f1(r.closeChg), f1(r.hlRange), finite(r.volRatio) ? r.volRatio.toFixed(2) : '—', `${r.vixHigh ?? '—'}/${r.vixClose ?? '—'}`, `${r.vxnHigh ?? '—'}/${r.vxnClose ?? '—'}`, r.fg ?? '缺', r.panic, f1(r.eventDD),
      r.h[20] ? `${r.h[20].rebreak ? '是' : '否'}｜${f1(r.h[20].extra)}` : '觀察不足', r.h[60] ? `${r.h[60].rebreak ? '是' : '否'}｜${f1(r.h[60].extra)}` : `觀察不足（${r.avail} 日）`,
      `${f1(r.h[20]?.retOpen)}／${f1(r.h[60]?.retOpen)}`, r.post?.panicDate ? `${r.post.panicDate}（+${r.post.panicDays}）` : r.complete ? '60 日內無' : '觀察不足',
      r.ma[150].status === 'above' ? '上方' : r.ma[150].status === 'reclaimed' ? `下方→+${r.ma[150].reclaimDays} 日站回` : r.ma[150].status === 'not_within' ? '下方、60 日未站回' : '下方、觀察不足'])), '', '● ＝同時達 -3% 主門檻。', '');
}
writeFileSync(`${outDir}/qqq-panic-divergence-backtest.md`, L.join('\n'));
console.log(`wrote ${outDir}: events ${runs.map(R => `${R.threshold}:${R.rows.length}/${R.groups.length}`).join(' ')}`);
