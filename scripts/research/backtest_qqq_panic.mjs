// QQQ 盤中急跌 × 恐慌背離回測 CLI。
// 引擎 js/tabs/qqqpanic_calc.mjs；輸出 docs/research/qqq-panic-divergence-{backtest.md,backtest.json,events.csv,groups.csv,matches.csv}。
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
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

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

const { F, runs, byThr } = E.run(raw, C);
const main = byThr[C.main];

const fgMissing = [], vixMissing = [], vxnMissing = [];
for (let i = F.startIdx; i <= F.endIdx; i++) { if (F.fg[i] === null) fgMissing.push(F.date[i]); if (F.vixH[i] === null) vixMissing.push(F.date[i]); if (F.vxnH[i] === null) vxnMissing.push(F.date[i]); }

// ── 比較集合 ────────────────────────────────────────────────────────────
const volOK = (x = C.volSurge) => r => finite(r.volRatio) && r.volRatio >= x;
const sets = [];
for (const thr of C.thresholds) {
  const R = byThr[thr];
  sets.push({ id: `g${thr}v`, thr, unit: 'group', label: `${thr}%｜爆量｜20 日去重`, rows: R.reps.filter(volOK()) });
  sets.push({ id: `g${thr}`, thr, unit: 'group', label: `${thr}%｜不限量｜20 日去重`, rows: R.reps });
  sets.push({ id: `r${thr}v`, thr, unit: 'raw', label: `${thr}%｜爆量｜未去重逐筆`, rows: R.rows.filter(volOK()) });
  sets.push({ id: `r${thr}`, thr, unit: 'raw', label: `${thr}%｜不限量｜未去重逐筆`, rows: R.rows });
}
const sens = [
  ...C.volSensitivity.map(v => ({ id: `g${C.main}v${v}`, label: `量 ≥ ${v}× RVOL20`, rows: main.reps.filter(volOK(v)) })),
  { id: `g${C.main}vp80`, label: '成交量 ≥ 前 252 日 P80', rows: main.reps.filter(r => r.volP80) },
  { id: `g${C.main}rp80`, label: 'RVOL20 ≥ 前 252 日 P80', rows: main.reps.filter(r => r.rvolP80) },
  { id: `c${C.main}v`, label: '60 日冷卻去重｜爆量', rows: main.coolReps.filter(volOK()) },
  { id: `c${C.main}`, label: '60 日冷卻去重｜不限量', rows: main.coolReps },
];
for (const s of sens) sets.push({ ...s, thr: C.main, unit: 'group', sensitivity: true, label: `${C.main}%｜${s.label}（敏感度）` });

const rawAB = rows => {   // 逐筆不獨立：只給點估計
  const A = rows.filter(r => r.panic === 'A'), B = rows.filter(r => r.panic === 'B');
  return { A: E.describe(A, E.AB_KEYS), B: E.describe(B, E.AB_KEYS), U: rows.filter(r => r.panic === 'U').length, diff: null, block: null,
    aPanicDays: { n: A.filter(r => finite(r.post?.panicDays)).length, of: A.filter(r => r.complete || finite(r.post?.panicDays)).length, censored: A.filter(r => !r.complete && !finite(r.post?.panicDays)).length, median: E.median(A.map(r => r.post?.panicDays)) } };
};
const comparisons = sets.map(s => {
  const ab = s.unit === 'group' ? E.compareAB(s.rows, C) : rawAB(s.rows);
  return { id: s.id, label: s.label, thr: s.thr, unit: s.unit, sensitivity: !!s.sensitivity, n: s.rows.length, nA: ab.A.n, nB: ab.B.n, nU: ab.U, A: ab.A, B: ab.B, diff: ab.diff, block: ab.block, aPanicDays: ab.aPanicDays };
});

const strata = {};
for (const thr of [C.main, ...C.compare]) strata[thr] = Object.fromEntries(E.STRATA.map(s => [s.key, E.stratify(byThr[thr].reps, s.key)]));

// ── A→B 事後路徑（−3%，20 日去重）──────────────────────────────────────
const depthBucket = r => (!r.h[60] ? '右設限' : r.h[60].deep10 ? '額外跌 ≥10%' : r.h[60].deep5 ? '額外跌 5～10%' : '額外跌 <5%');
const PATHS = ['A→B ≤20日', 'A→B 21–60日', 'A 未升級', '右設限'], DEPTHS = ['額外跌 ≥10%', '額外跌 5～10%', '額外跌 <5%', '右設限'];
const pathTable = which => {
  const A = (which === 'vol' ? main.reps.filter(volOK()) : main.reps).filter(r => r.panic === 'A');
  return { n: A.length, cells: PATHS.map(p => ({ path: p, total: A.filter(r => r.path === p).length, byDepth: DEPTHS.map(d => A.filter(r => r.path === p && depthBucket(r) === d).length), dates: A.filter(r => r.path === p).map(r => r.date) })) };
};
const paths = { all: pathTable('all'), vol: pathTable('vol'), paths: PATHS, depths: DEPTHS };

// ── 事件層級配對：2026 主觀察窗的 −3% 事件 ─────────────────────────────
const targets = main.rows.filter(r => r.date >= C.focus.from && r.date <= C.focus.to);
const matches = E.matchEvents(targets, main.rows, C).map(m => ({
  target: m.target, neighbors: m.neighbors, anchor2022: m.rankOf('2022-01-05'),
}));

// ── 均線跌破研究（125／150MA）──────────────────────────────────────────
const maBy = Object.fromEntries(E.MA_BREAK.mas.map(p => [p, E.maBreakEvents(F, p)]));
const maByNoVol = Object.fromEntries(E.MA_BREAK.mas.map(p => [p, E.maBreakEvents(F, p, { ...E.MA_BREAK, rvol: 0 })]));
const maUnion = E.maBreakUnion(maBy);
const maBase = E.baselineRates(F);
const maSets = rows => {
  const ok = rows.filter(r => !r.alreadyDeep);
  return [
    ['一般跌破（主樣本，逐筆）', ok], ['一般跌破｜20 日去重', ok.filter(r => r.isRep)], ['嚴格首次跌破（子樣本）', ok.filter(r => r.strict)],
    ['一般跌破 × A 無極端恐慌', ok.filter(r => r.panic === 'A')], ['一般跌破 × B 極端恐慌', ok.filter(r => r.panic === 'B')],
    ['一般跌破 × A 且前 60 日未曾恐慌', ok.filter(r => r.panic === 'A' && r.priorPanic === false)],
  ].map(([label, rs]) => ({ label, ...E.describeMA(rs) }));
};
const maStudy = Object.fromEntries(E.MA_BREAK.mas.map(p => [p, {
  sets: maSets(maBy[p]),
  noVolReps: [['不限量｜20 日去重', maByNoVol[p].filter(r => !r.alreadyDeep && r.isRep)], ['不限量 × A｜20 日去重', maByNoVol[p].filter(r => !r.alreadyDeep && r.isRep && r.panic === 'A')], ['不限量 × B｜20 日去重', maByNoVol[p].filter(r => !r.alreadyDeep && r.isRep && r.panic === 'B')]].map(([label, rs]) => ({ label, ...E.describeMA(rs) })),
  alreadyDeep: maBy[p].filter(r => r.alreadyDeep).map(r => r.date),
}]));
// −3% A 事件依「事件日收盤是否在均線下方」分層（問題 2）
const aByMa = Object.fromEntries([125, 150].map(p => [p, ['above', 'below'].map(pos => {
  const rs = main.reps.filter(r => r.panic === 'A' && (pos === 'above' ? r.ma[p].status === 'above' : ['reclaimed', 'not_within', 'censored'].includes(r.ma[p].status)));
  return { pos, ...E.describe(rs, ['deep5_20', 'deep10_60', 'extra60', 'totalDD60', 'panicLater60']) };
})]));

// ── 區間 ────────────────────────────────────────────────────────────────
const focusProfile = E.periodProfile(F, C.focus.from, C.focus.to, runs);
const i21 = F.date.findIndex(d => d >= '2021-11-01');
const eqPre = { id: '2022-pre-eq', label: `2021/11 起等長窗（${focusProfile.days} 個交易日，補充）`, from: F.date[i21], to: F.date[i21 + focusProfile.days - 1], extra: true };
const periodList = [...E.PERIODS, eqPre];
const profiles = periodList.map(p => {
  const prof = E.periodProfile(F, p.from, p.to, runs);
  const iEnd = F.index.get(prof.to), avail = Math.min(60, F.endIdx - iEnd);
  let after = null;   // 區間結束後 60 日（事後才知道）
  if (avail >= 60) {
    let lo = Infinity; for (let k = iEnd + 1; k <= iEnd + 60; k++) lo = Math.min(lo, F.l[k]);
    after = { ret60: (F.c[iEnd + 60] / F.c[iEnd] - 1) * 100, minLowVsEndClose: (lo / F.c[iEnd] - 1) * 100 };
  }
  return { ...p, profile: prof, after, afterAvail: avail };
});

// ── CSV ─────────────────────────────────────────────────────────────────
const r4 = v => (finite(v) ? +v.toFixed(4) : '');
const b = v => (v === true ? 1 : v === false ? 0 : '');
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (header, rows) => [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';
const inPeriods = d => E.PERIODS.filter(p => d >= p.from && d <= p.to).map(p => p.id).join('|');
const EVH = ['threshold_pct', 'date', 'group_id', 'group_rank', 'is_group_rep', 'is_cool60_rep', 'prev_close', 'open', 'high', 'low', 'close', 'volume', 'vol_avg20_prior', 'vol_ratio', 'vol_surge_1p5',
  'vol_pct252_prior', 'rvol_pct252_prior', 'vol_p80', 'rvol_p80',
  'drop_low_vs_prev_close_pct', 'gap_open_pct', 'session_drop_low_vs_open_pct', 'intraday_range_low_vs_high_pct', 'close_chg_pct', 'close_from_low_pct',
  'vix_high', 'vix_close', 'vxn_high', 'vxn_close', 'fg_value', 'fg_missing', 'panic_class', 'panic_sub', 'panic_detail', 'vxn_high_ge40', 'prior60_extreme_panic', 'path_after_event',
  'pre_high_60', 'pre_high_date', 'pre_high_days_ago', 'event_drawdown_pct', 'ma150_slope20_pct',
  'pre_fg_max', 'pre_fg_min', 'pre_fg_days', 'pre_vix_high_max', 'pre_vix_low_min', 'pre_vxn_high_max', 'pre_vxn_low_min',
  'post_days_available', 'post_window_complete', 'entry_date_t1', 'entry_open_t1',
  ...C.horizons.flatMap(h => [`ret${h}_open_pct`, `ret${h}_close_pct`, `mae${h}_open_pct`, `mae${h}_close_pct`, `min_low${h}`, `rebreak${h}`, `extra_drop${h}_pct`, `deep5_${h}`, `deep10_${h}`, `total_dd${h}_pct`]),
  'min_low60_date', 'min_low60_days', 'first_rebreak_date', 'first_rebreak_days', 'max_high60', 'max_high60_date', 'mfe60_open_pct', 'recover_pre_high_date', 'recover_pre_high_days',
  'post_fg_max', 'post_fg_min', 'post_fg_min_date', 'post_fg_days', 'post_fg_below15_date', 'post_fg_below15_days', 'post_vix_high_max', 'post_vix_low_min', 'post_vxn_high_max', 'post_vxn_low_min',
  'post_vix_high_ge30_date', 'post_vix_high_ge30_days', 'post_extreme_panic_date', 'post_extreme_panic_days',
  ...[125, 150].flatMap(p => [`ma${p}`, `ma${p}_dist_pct`, `ma${p}_status`, `ma${p}_reclaim_date`, `ma${p}_reclaim_days`, `ma${p}_confirm2p5_date`, `ma${p}_confirm2p5_days`, `ma${p}_confirm2p5_status`]),
  'ma300', 'ma300_dist_pct', 'ma300_status', 'ma300_touched_on_event', 'ma300_touch_date', 'ma300_touch_days', 'ma300_touch_status', 'special_periods'];
const evRow = (thr, r) => [thr, r.date, r.groupId, r.groupRank, b(r.isRep), b(r.isCoolRep), r.prevClose, r.open, r.high, r.low, r.close, r.volume, r4(F.volAvg[r.idx]), r4(r.volRatio), b(r.volSurge),
  r4(r.volPct), r4(r.rvolPct), b(r.volP80), b(r.rvolP80),
  r4(r.dropLow), r4(r.gap), r4(r.sessionDrop), r4(r.hlRange), r4(r.closeChg), r4(r.closeFromLow),
  r.vixHigh ?? '', r.vixClose ?? '', r.vxnHigh ?? '', r.vxnClose ?? '', r.fg ?? '', b(r.fg === null), r.panic, r.panicSub, r.panicDetail, b(r.vxnAux), b(r.priorPanic), r.path,
  r.preHigh ?? '', r.preHighDate ?? '', r.preHighAgo ?? '', r4(r.eventDD), r4(r.slope150),
  r.pre?.fgMax ?? '', r.pre?.fgMin ?? '', r.pre?.fgCount ?? '', r.pre?.vixHMax ?? '', r.pre?.vixLMin ?? '', r.pre?.vxnHMax ?? '', r.pre?.vxnLMin ?? '',
  r.avail, b(r.complete), r.entryOpenDate ?? '', r.entryOpen ?? '',
  ...C.horizons.flatMap(h => { const x = r.h[h]; return x ? [r4(x.retOpen), r4(x.retClose), r4(x.maeOpen), r4(x.maeClose), x.minLow, b(x.rebreak), r4(x.extra), b(x.deep5), b(x.deep10), r4(x.totalDD)] : new Array(10).fill(''); }),
  r.h[60]?.minLowDate ?? '', r.h[60]?.minLowDays ?? '', r.firstRebreakDate ?? '', r.firstRebreakDays ?? '', r.h[60]?.maxHigh ?? '', r.h[60]?.maxHighDate ?? '', r4(r.h[60]?.mfeOpen), r.recoverPreHighDate ?? '', r.recoverPreHighDays ?? '',
  r.post?.fgMax ?? '', r.post?.fgMin ?? '', r.post?.fgMinDate ?? '', r.post?.fgCount ?? '', r.post?.fgBelow15Date ?? '', r.post?.fgBelow15Days ?? '', r.post?.vixHMax ?? '', r.post?.vixLMin ?? '', r.post?.vxnHMax ?? '', r.post?.vxnLMin ?? '',
  r.post?.vix30Date ?? '', r.post?.vix30Days ?? '', r.post?.panicDate ?? '', r.post?.panicDays ?? '',
  ...[125, 150].flatMap(p => { const m = r.ma[p]; return [r4(m.value), r4(m.dist), m.status, m.reclaimDate ?? '', m.reclaimDays ?? '', m.confirmDate ?? '', m.confirmDays ?? '', m.confirmStatus ?? '']; }),
  r4(r.ma[300].value), r4(r.ma[300].dist), r.ma[300].status, b(r.ma[300].touchedOnEvent), r.ma[300].touchDate ?? '', r.ma[300].touchDays ?? '', r.ma[300].touchStatus ?? '', inPeriods(r.date)];
writeFileSync(`${outDir}/qqq-panic-divergence-events.csv`, toCSV(EVH, runs.flatMap(R => R.rows.map(r => evRow(R.threshold, r)))));
const GH = ['group_id', 'threshold_pct', 'anchor_date', 'last_date', 'event_count', 'member_dates', 'rep_panic_class', 'rep_panic_sub', 'rep_path', 'rep_vol_surge', 'any_member_panic_b', 'later_member_panic_b', 'group_min_low', 'deepest_drop_pct',
  'rep_event_drawdown_pct', 'rep_deep5_20', 'rep_deep10_20', 'rep_deep5_60', 'rep_deep10_60', 'rep_extra_drop60_pct', 'rep_rebreak20', 'rep_rebreak60', 'rep_total_dd60_pct', 'rep_ret20_open_pct', 'rep_ret60_open_pct', 'rep_mae60_open_pct', 'rep_post_extreme_panic_days', 'rep_window_complete', 'special_periods'];
writeFileSync(`${outDir}/qqq-panic-divergence-groups.csv`, toCSV(GH, runs.flatMap(R => R.groups.map(g => [g.id, g.threshold, g.anchorDate, g.lastDate, g.count, g.memberDates.join(' '), g.rep.panic, g.rep.panicSub, g.rep.path, b(g.rep.volSurge), b(g.anyPanicB), b(g.laterPanicInGroup), g.groupMinLow, r4(g.deepestDrop),
  r4(g.rep.eventDD), b(g.rep.h[20]?.deep5), b(g.rep.h[20]?.deep10), b(g.rep.h[60]?.deep5), b(g.rep.h[60]?.deep10), r4(g.rep.h[60]?.extra), b(g.rep.h[20]?.rebreak), b(g.rep.h[60]?.rebreak), r4(g.rep.h[60]?.totalDD), r4(g.rep.h[20]?.retOpen), r4(g.rep.h[60]?.retOpen), r4(g.rep.h[60]?.maeOpen), g.rep.post?.panicDays ?? '', b(g.rep.complete), inPeriods(g.anchorDate)]))));
const MAH = ['ma', 'date', 'strict_first_break', 'is_20d_rep', 'close', 'ma_value', 'dist_pct', 'rvol20', 'intraday_drop_pct', 'close_chg_pct', 'ma150_slope20_pct', 'vix_high', 'fg_value', 'panic_class', 'prior60_extreme_panic',
  'pre_high_252', 'low_vs_pre_high252_pct', 'already_deep_20', 'post_days_available', 'entry_open_t1', 'reclaim20', 'reclaim_days', 'confirm2p5_20', 'confirm_days', 'below_share60', 'below70_60', 'extra60_vs_close_pct', 'extra120_vs_close_pct', 'mae60_open_pct', 'mae120_open_pct', 'ret60_open_pct', 'ret120_open_pct', 'deep20_120', 'deep_days', 'same_day_other_ma_break'];
const unionDates = new Map(maUnion.map(u => [u.date, u.mas]));
writeFileSync(`${outDir}/qqq-panic-divergence-ma-breaks.csv`, toCSV(MAH, E.MA_BREAK.mas.flatMap(p => maBy[p].map(r => [p, r.date, b(r.strict), b(r.isRep), r.close, r4(r.maValue), r4(r.dist), r4(r.rvol), r4(r.dropLow), r4(r.closeChg), r4(r.slope150), r.vixHigh ?? '', r.fg ?? '', r.panic, b(r.priorPanic),
  r.preHigh252 ?? '', r4(r.dd252), b(r.alreadyDeep), r.avail, r.entryOpen ?? '', r.reclaim20, r.reclaimDays ?? '', r.confirm20, r.confirmDays ?? '', r4(r.belowShare60), b(r.below70), r4(r.extra60), r4(r.extra120), r4(r.mae60), r4(r.mae120), r4(r.ret60), r4(r.ret120), r.deep120, r.deepDays ?? '', b(unionDates.get(r.date).length > 1)]))));
const MH = ['target_date', 'rank', 'neighbor_date', 'distance', ...E.MATCH_FEATURES.map(f => `nb_${f.key}`), 'nb_panic_class', 'nb_extra_drop60_pct', 'nb_deep10_60', 'nb_total_dd60_pct', 'nb_ret60_open_pct', 'nb_post_extreme_panic_days', 'nb_ma150_status'];
writeFileSync(`${outDir}/qqq-panic-divergence-matches.csv`, toCSV(MH, matches.flatMap(m => m.neighbors.map((x, k) => [m.target.date, k + 1, x.r.date, r4(x.d), ...E.MATCH_FEATURES.map(f => r4(f.get(x.r))), x.r.panic, r4(x.r.h[60]?.extra), b(x.r.h[60]?.deep10), r4(x.r.h[60]?.totalDD), r4(x.r.h[60]?.retOpen), x.r.post?.panicDays ?? '', x.r.ma[150].status]))));

// ── JSON ────────────────────────────────────────────────────────────────
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(6) : k === 'values' ? undefined : v)));
const sampleTable = runs.map(R => ({
  threshold: R.threshold, raw: R.rows.length, groups: R.groups.length, cool60: R.coolReps.length,
  rawA: R.rows.filter(r => r.panic === 'A').length, rawB: R.rows.filter(r => r.panic === 'B').length, rawU: R.rows.filter(r => r.panic === 'U').length,
  groupA: R.reps.filter(r => r.panic === 'A').length, groupB: R.reps.filter(r => r.panic === 'B').length,
  groupA0: R.reps.filter(r => r.panicSub === 'A0').length, groupA1: R.reps.filter(r => r.panicSub === 'A1').length,
  rawVol: R.rows.filter(volOK()).length, groupVol: R.reps.filter(volOK()).length,
  groupVolA: R.reps.filter(r => volOK()(r) && r.panic === 'A').length, groupVolB: R.reps.filter(r => volOK()(r) && r.panic === 'B').length,
  censoredRaw: R.rows.filter(r => !r.complete).length, censoredGroups: R.reps.filter(r => !r.complete).length,
}));
const slimMatch = m => ({
  target: m.target.date, anchor2022: m.anchor2022,
  features: Object.fromEntries(E.MATCH_FEATURES.map(f => [f.key, f.get(m.target)])),
  neighbors: m.neighbors.map(x => ({ date: x.r.date, d: x.d, panic: x.r.panic, extra60: x.r.h[60]?.extra, deep10_60: x.r.h[60]?.deep10, totalDD60: x.r.h[60]?.totalDD, ret60: x.r.h[60]?.retOpen, panicDays: x.r.post?.panicDays ?? null, ma150: x.r.ma[150].status })),
});
const out = {
  generated_for: { study: `${C.start} ～ ${C.end}`, first_trading_day: F.date[F.startIdx], last_trading_day: F.date[F.endIdx], git_head_at_run: gitHead, engine: 'js/tabs/qqqpanic_calc.mjs' },
  config: C, provenance, missing: { fearGreed: fgMissing, vixHigh: vixMissing, vxnHigh: vxnMissing },
  samples: sampleTable, comparisons: strip(comparisons), strata: strip(strata), paths, matches: strip(matches.map(slimMatch)),
  periods: strip(profiles),
  maBreak: strip({ config: E.MA_BREAK, baseline: maBase, study: maStudy, union: { events: maUnion.length, sameDayBoth: maUnion.filter(u => u.mas.length > 1).length }, aByMa }),
};
writeFileSync(`${outDir}/qqq-panic-divergence-backtest.json`, JSON.stringify(out, null, 1) + '\n');

// ── Markdown ────────────────────────────────────────────────────────────
const f1 = v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—');
const p0 = v => (finite(v) ? `${(v * 100).toFixed(0)}%` : '—');
const keyLabel = Object.fromEntries(E.METRICS.map(m => [m.key, [m.label, m.kind]]));
const cell = (o, kind) => {
  if (!o || !o.n) return '—（n=0）';
  if (kind === 'share') return `${p0(o.value)}（${o.count}/${o.n}）${o.wilson && finite(o.wilson.lo) ? ` W[${p0(o.wilson.lo)}, ${p0(o.wilson.hi)}]` : ''}`;
  return `${f1(o.value)}${o.ci && finite(o.ci.lo) ? ` [${f1(o.ci.lo)}, ${f1(o.ci.hi)}]` : ''}（n=${o.n}）`;
};
const diffTxt = (d, kind) => (!d || !finite(d.est) ? '—' : kind === 'share' ? `${f1(d.est * 100)} pt [${f1(d.lo * 100)}, ${f1(d.hi * 100)}]` : `${f1(d.est)} [${f1(d.lo)}, ${f1(d.hi)}]`);
const blockTxt = (d, kind) => (!d || !finite(d.lo) ? '—' : kind === 'share' ? `[${f1(d.lo * 100)}, ${f1(d.hi * 100)}] pt（${d.years} 年）` : `[${f1(d.lo)}, ${f1(d.hi)}]（${d.years} 年）`);
const T = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const L = [];
L.push('# QQQ 盤中急跌 × 恐慌背離 — 回測數據（自動產生）', '',
  `研究期間 ${C.start} ～ ${C.end}（實際交易日 ${F.date[F.startIdx]} ～ ${F.date[F.endIdx]}）。本檔由 \`node scripts/research/backtest_qqq_panic.mjs\` 產生，勿手改；方法與解讀見 [qqq-panic-divergence.md](qqq-panic-divergence.md)。逐筆：[events.csv](qqq-panic-divergence-events.csv)、[groups.csv](qqq-panic-divergence-groups.csv)、[matches.csv](qqq-panic-divergence-matches.csv)、[ma-breaks.csv](qqq-panic-divergence-ma-breaks.csv)；完整數值：[backtest.json](qqq-panic-divergence-backtest.json)。`, '',
  '純描述性研究，不是買賣訊號。群組統計只用每群第一筆；逐筆（未去重）統計彼此重疊，只給點估計。未來窗未滿者為**右設限**，不納入該 horizon 的統計。', '');
L.push('## 1. 資料來源與可取得時點', '', T(['資料', '檔案', '列數／涵蓋', 'SHA-256（前 16 碼）', 'updated', '來源', '可取得時點'],
  provenance.map(p => [p.key, `\`${p.path}\``, `${p.rows}｜${p.first} ～ ${p.last}`, p.sha256.slice(0, 16), p.updated ?? '—', p.origin, p.timing])), '',
  `研究期間缺漏：Fear & Greed 缺 ${fgMissing.length} 個交易日（${fgMissing[0] ?? ''} ～ ${fgMissing.at(-1) ?? ''}），不補值；VIX High 缺 ${vixMissing.length} 日；VXN High 缺 ${vxnMissing.length} 日。執行時 git HEAD：\`${gitHead ?? 'unavailable'}\`（資料以上表 SHA-256 為準）。`, '');
L.push('## 2. 樣本量', '', T(['門檻', '原始事件（A／B／未分類）', '20 日去重群組（A／B）', '其中 A0／A1', '60 日冷卻', '原始爆量', '群組爆量（A／B）', '右設限（原始／群組）'],
  sampleTable.map(s => [`${s.threshold}%${s.threshold === C.main ? '（主）' : C.appendix.includes(s.threshold) ? '（附錄）' : ''}`, `${s.raw}（${s.rawA}／${s.rawB}／${s.rawU}）`, `${s.groups}（${s.groupA}／${s.groupB}）`, `${s.groupA0}／${s.groupA1}`, s.cool60, s.rawVol, `${s.groupVol}（${s.groupVolA}／${s.groupVolB}）`, `${s.censoredRaw}／${s.censoredGroups}`])), '',
  'A＝VIX High < 30 且 F&G ≥ 15；B＝VIX High ≥ 30 或 F&G < 15；A0＝A 且前 60 日（T-60～T-1）未曾 VIX High ≥ 30 或 F&G < 15；A1＝A 且前 60 日曾經極端恐慌。爆量＝RVOL20（當日量 ÷ T-20～T-1 均量）≥ 1.5。', '');
L.push('## 3. A／B 比較', '',
  '比例：點估計（件數/有效 n）W[Wilson 95%]；B − A 用 **Newcombe 95%**（hybrid score）。中位數：點估計 [95% percentile bootstrap]；B − A 為兩組各自重抽的 bootstrap。最後一欄是**年份區塊 bootstrap**（以日曆年為重抽單位，處理同年事件與未來窗重疊）的 95% 區間，屬敏感度分析。區間只描述抽樣不確定性，不代表因果。「之後出現極端恐慌」對 B 組只反映持續性，不做差值。', '');
const order = [`g${C.main}v`, `g${C.main}`, `r${C.main}v`, `r${C.main}`, ...sens.map(s => s.id), ...C.compare.flatMap(t => [`g${t}v`, `g${t}`]), ...C.appendix.flatMap(t => [`g${t}v`, `g${t}`])];
for (const id of order) {
  const c = comparisons.find(x => x.id === id); if (!c) continue;
  const tag = c.thr === C.main && id === `g${C.main}v` ? '（主研究）' : C.appendix.includes(c.thr) ? '（極端附錄，小樣本）' : '';
  L.push(`### ${c.label}${tag}`, '',
    `n＝${c.n}（A ${c.nA}、B ${c.nB}、未分類 ${c.nU}）。A 組事後首次出現極端恐慌：${c.aPanicDays.n}/${c.aPanicDays.of} 件在 60 日內出現，中位 ${c.aPanicDays.median ?? '—'} 個交易日${c.aPanicDays.censored ? `（另 ${c.aPanicDays.censored} 件右設限，不計）` : ''}。`, '');
  const row = k => [keyLabel[k][0], cell(c.A.m[k], keyLabel[k][1]), E.A_ONLY_KEYS.has(k) ? `（持續性）${cell(c.B.m[k], keyLabel[k][1])}` : cell(c.B.m[k], keyLabel[k][1]),
    E.A_ONLY_KEYS.has(k) ? '不適用' : c.diff ? diffTxt(c.diff[k], keyLabel[k][1]) : '（逐筆不獨立，不估）', E.A_ONLY_KEYS.has(k) || !c.block ? '—' : blockTxt(c.block[k], keyLabel[k][1])];
  L.push(T(['主要指標', 'A 無極端恐慌', 'B 極端恐慌', 'B − A', '年份區塊 bootstrap'], E.MAIN_KEYS.map(row)), '',
    T(['輔助指標', 'A', 'B', 'B − A', '年份區塊 bootstrap'], [...E.AUX_KEYS, 'panicLater20', 'panicLater60'].map(row)), '');
}
L.push('## 4. A→B 事後路徑（−3%，20 日去重，A 組）', '', '只作事後描述：T 日分類不變，不能用之後是否升級來模擬當天決策。', '');
for (const [k, lab] of [['vol', '爆量'], ['all', '不限量']]) {
  const P = paths[k];
  L.push(`### ${lab}（A 組 ${P.n} 群）`, '', T(['路徑', '群數', ...DEPTHS, '日期'], P.cells.map(c => [c.path, c.total, ...c.byDepth, c.dates.join('、') || '—'])), '');
}
L.push('## 5. 分層（20 日去重，每群第一筆）', '');
for (const thr of [C.main, ...C.compare]) for (const s of E.STRATA) {
  L.push(`### ${thr}%｜${s.label}`, '', T(['分層', 'n', '20 日額外跌 ≥5%', '60 日額外跌 ≥10%', '60 日額外跌幅 中位', '60 日再破底', '60 日報酬 中位', '60 日 MAE 中位'],
    strata[thr][s.key].map(x => [x.bucket, x.n, `${p0(x.m.deep5_20.value)}（${x.m.deep5_20.count ?? 0}/${x.m.deep5_20.n}）`, `${p0(x.m.deep10_60.value)}（${x.m.deep10_60.count ?? 0}/${x.m.deep10_60.n}）`, f1(x.m.extra60.value), `${p0(x.m.rebreak60.value)}（${x.m.rebreak60.n}）`, f1(x.m.ret60.value), f1(x.m.mae60.value)])), '');
}
L.push('## 6. 事件層級配對（2026/6～10 的 −3% 事件）', '',
  `特徵（只用 T 日及以前）：${E.MATCH_FEATURES.map(f => f.label).join('、')}；權重全部為 1，事前固定。${E.MATCH_NOTE} 距離越小越相近；**相似不等於未來發生機率**。`, '');
for (const m of matches) {
  const t = m.target, a = m.anchor2022;
  L.push(`### ${t.date}（${t.panic}${t.panicSub !== t.panic ? '／' + t.panicSub : ''}｜盤中 ${f1(t.dropLow)}%｜跳空 ${f1(t.gap)}%｜RVOL ${finite(t.volRatio) ? t.volRatio.toFixed(2) : '—'}｜距 150MA ${f1(t.ma[150].dist)}%｜VIX H ${t.vixHigh}｜F&G ${t.fg ?? '缺'}｜右設限 ${t.complete ? '否' : `是（${t.avail} 日）`}）`, '',
    `2022-01-05 所屬群組在歷史池中的距離排名：${a ? `第 ${a.rank}/${a.of}（以群組內最相近的 ${a.date} 計，距離 ${a.d.toFixed(2)}）` : '不在池中'}。`, '',
    T(['名次', '歷史事件', '距離', '分類', '回撤', '距 150MA', '150MA 斜率', 'RVOL', 'VIX H', 'F&G', '前 60 日恐慌', '60 日額外跌幅', '額外跌 ≥10%', '60 日總回撤', '60 日報酬', '之後極端恐慌'],
      m.neighbors.map((x, k) => { const r = x.r; return [k + 1, r.date, x.d.toFixed(2), r.panic, f1(r.eventDD), f1(r.ma[150].dist), f1(r.slope150), finite(r.volRatio) ? r.volRatio.toFixed(2) : '—', r.vixHigh, r.fg ?? '缺', r.priorPanic === null ? '—' : r.priorPanic ? '是' : '否', f1(r.h[60]?.extra), r.h[60]?.deep10 ? '是' : '否', f1(r.h[60]?.totalDD), f1(r.h[60]?.retOpen), r.post?.panicDays != null ? `+${r.post.panicDays} 日` : '無']; })), '');
}
L.push('## 7. 均線跌破研究（125／150MA）', '',
  `一般跌破＝Close_{T-1} ≥ MA_{T-1}、Close_T < MA_T、RVOL20 ≥ ${E.MA_BREAK.rvol}；嚴格首次跌破＝另要求 T-20～T-1 收盤都在 MA 上方。訊號 T 日收盤後才成立，報酬以 T+1 開盤為基準；額外跌幅以 Close_T 為基準。各指標獨立計算，不組成互斥的「真／假跌破」分類。事件日 Low 已相對前 252 日高點跌超過 20% 的樣本另列、不納入統計。125 與 150 分開測試；兩條線同一天跌破共 ${maUnion.filter(u => u.mas.length > 1).length} 天，合併後 ${maUnion.length} 個獨立日期。`, '',
  `**基準（研究期間每個交易日，不限事件）**：60 日內相對當日收盤額外跌 ≥10% 為 ${p0(maBase.deep10_60.value)}（${maBase.deep10_60.count}/${maBase.deep10_60.n}）；120 日內首次進入 −20% 深度修正為 ${p0(maBase.deep120.value)}（${maBase.deep120.count}/${maBase.deep120.n}）。逐日樣本高度重疊，只作參照水準。`, '');
const maCell = (o, kind) => (!o || !o.n ? '—' : kind === 'share' ? `${p0(o.value)}（${o.count}/${o.n}）${finite(o.wilson?.lo) ? ` W[${p0(o.wilson.lo)}, ${p0(o.wilson.hi)}]` : ''}` : `${f1(o.value)}（n=${o.n}）`);
for (const p of E.MA_BREAK.mas) {
  const S = maStudy[p];
  L.push(`### ${p}MA`, '', T(['樣本', 'n', ...E.MA_METRICS.map(m => m.label)], [...S.sets, ...S.noVolReps.map(x => ({ ...x, label: x.label + '（敏感度：不要求 RVOL）' }))].map(x => [x.label, x.n, ...E.MA_METRICS.map(m => maCell(x.m[m.key], m.kind))])), '',
    `事件日已在 −20% 深度修正中而另列：${S.alreadyDeep.join('、') || '無'}。`, '',
    T(['日期', '嚴格首次', '分類', 'RVOL', '距 MA', '盤中', 'VIX H', 'F&G', '20 日站回', '20 日 ×1.025', '60 日低於 MA ≥70%', '60／120 日額外跌幅', '120 日進入 −20%'],
      maBy[p].map(r => [r.date, r.strict ? '是' : '否', r.panic, r.rvol.toFixed(2), f1(r.dist), f1(r.dropLow), r.vixHigh ?? '—', r.fg ?? '缺', r.reclaim20 === 'yes' ? `是（+${r.reclaimDays}）` : r.reclaim20 === 'no' ? '否' : '右設限', r.confirm20 === 'yes' ? `是（+${r.confirmDays}）` : r.confirm20 === 'no' ? '否' : '右設限',
        r.below70 === null ? '右設限' : r.below70 ? '是' : '否', `${f1(r.extra60)}／${f1(r.extra120)}`, r.deep120 === 'yes' ? `是（+${r.deepDays}）` : r.deep120 === 'no' ? '否' : r.deep120 === 'already' ? '已在其中' : '右設限'])), '');
}
L.push('### −3% A 事件 × 事件日相對均線（20 日去重）', '', T(['均線', '位置', 'n', '20 日額外跌 ≥5%', '60 日額外跌 ≥10%', '60 日額外跌幅 中位', '60 日總回撤 中位', '60 日內升級極端恐慌'],
  [125, 150].flatMap(p => aByMa[p].map(x => [`${p}MA`, x.pos === 'above' ? '收盤在上方' : '收盤在下方', x.n, `${p0(x.m.deep5_20.value)}（${x.m.deep5_20.count}/${x.m.deep5_20.n}）`, `${p0(x.m.deep10_60.value)}（${x.m.deep10_60.count}/${x.m.deep10_60.n}）`, f1(x.m.extra60.value), f1(x.m.totalDD60.value), `${p0(x.m.panicLater60.value)}（${x.m.panicLater60.count}/${x.m.panicLater60.n}）`]))), '');

L.push('## 8. 特殊區間', '', '區間輪廓只用區間內（與之前）的資料；「區間後 60 日」是事後才知道的結果，2026 區間尚無此資料。', '',
  T(['區間', '交易日', '區間報酬', '最大回撤（252 日高）', '收盤 < 150MA', '收盤 < 300MA', '150MA 斜率', '觸 300MA 日', 'VIX H 最高', 'VXN H 最高', 'VIX H≥30 日', 'F&G 最低', 'F&G 中位', 'F&G<15 日', '-3% 事件（A/B）', '-2% 事件（A/B）', '-3% 爆量 A', '60 日新低收盤次數', '區間後 60 日報酬／最低'],
    profiles.map(({ label, profile: p, after }) => [label, p.days, f1(p.ret), f1(p.maxDD252), p0(p.belowMa150), p0(p.belowMa300), f1(p.ma150Slope), p.touch300, p.vixHMax ?? '—', p.vxnHMax ?? '—', p.vixPanicDays, p.fgMin ?? '—', f1(p.fgMedian), `${p.fgPanicDays}${p.fgMissing ? `（缺 ${p.fgMissing}）` : ''}`,
      `${p.events[-3].raw}（${p.events[-3].A}/${p.events[-3].B}）`, `${p.events[-2].raw}（${p.events[-2].A}/${p.events[-2].B}）`, p.events[-3].aVolSurge, p.newLow60, after ? `${f1(after.ret60)}／${f1(after.minLowVsEndClose)}` : '尚無'])), '');
for (const p of periodList) {
  const rows = byThr[-2].rows.filter(r => r.date >= p.from && r.date <= p.to);
  L.push(`### ${p.label}（${p.from} ～ ${p.to}）`, '');
  if (!rows.length) { L.push('區間內沒有 ≤ -2% 的盤中急跌。', ''); continue; }
  L.push(T(['日期', '盤中跌幅', '跳空', '開盤後', '收盤漲跌', 'RVOL', 'VIX H/C', 'VXN H/C', 'F&G', '分類', '波段回撤', '20 日額外跌幅', '60 日額外跌幅', '20／60 日報酬', '之後極端恐慌', '150MA'],
    rows.map(r => [`${r.date}${r.dropLow <= -3 ? ' ●' : ''}`, f1(r.dropLow), f1(r.gap), f1(r.sessionDrop), f1(r.closeChg), finite(r.volRatio) ? r.volRatio.toFixed(2) : '—', `${r.vixHigh ?? '—'}/${r.vixClose ?? '—'}`, `${r.vxnHigh ?? '—'}/${r.vxnClose ?? '—'}`, r.fg ?? '缺', r.panicSub, f1(r.eventDD),
      r.h[20] ? f1(r.h[20].extra) : '右設限', r.h[60] ? f1(r.h[60].extra) : `右設限（${r.avail} 日）`,
      `${f1(r.h[20]?.retOpen)}／${f1(r.h[60]?.retOpen)}`, r.post?.panicDate ? `${r.post.panicDate}（+${r.post.panicDays}）` : r.complete ? '60 日內無' : '右設限',
      r.ma[150].status === 'above' ? '上方' : r.ma[150].status === 'reclaimed' ? `下方→+${r.ma[150].reclaimDays} 日站回` : r.ma[150].status === 'not_within' ? '下方、60 日未站回' : '下方、右設限'])), '', '● ＝同時達 -3% 主門檻。', '');
}
writeFileSync(`${outDir}/qqq-panic-divergence-backtest.md`, L.join('\n'));
console.log(`wrote ${outDir}: events ${runs.map(R => `${R.threshold}:${R.rows.length}/${R.groups.length}`).join(' ')}; matches ${matches.length}`);
