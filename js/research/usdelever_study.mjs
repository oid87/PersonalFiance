// 美股去槓桿三層研究：分析層（建立在 usdelever_calc.mjs 之上）。純函式。
import {
  DEFAULTS, buildMarket, prepCftc, cftcWeekly, prepNfci, prepFinra, signalCatalog, stressFlags, vixCalm,
  evaluate, baseline, findWaves, waveCoverage, pearson, median, avg, forward, summarize, clusterEvents,
  idxOnOrBefore, addDays, dayDiff, inRange,
} from './usdelever_calc.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function buildAll(raw, cfg = {}) {
  const mk = buildMarket(raw, cfg);
  const c = mk.cfg;
  const cf = prepCftc(mk, raw.cftc, c);
  const weekly = cftcWeekly(cf);
  const nfci = prepNfci(mk, raw.nfci, c);
  const finra = prepFinra(mk, raw.finra, raw.finraRelease, c);
  const data = { weekly, nfci, finra };
  const sigs = signalCatalog(mk, data, c);
  const stress = stressFlags(mk, c);
  const waves = { SPY: findWaves(mk, 'SPY', c), QQQ: findWaves(mk, 'QQQ', c) };
  return { mk, cfg: c, cf, weekly, nfci, finra, sigs, stress, waves };
}

const sigById = (A, id) => A.sigs.find(s => s.id === id);

// ── A/B：每個訊號的記分卡（vs 波段）──────────────────────────────
export function scorecard(A) {
  const { mk, cfg } = A;
  return A.sigs.map(sig => {
    const ev = evaluate(mk, sig.flags, cfg);
    const out = { id: sig.id, layer: sig.layer, label: sig.label, flagDays: ev.flagDays, events: ev.events.length, sum: ev.sum, per: {} };
    for (const s of ['SPY', 'QQQ']) out.per[s] = waveCoverage(mk, ev.events, A.waves[s]);
    return out;
  });
}

// ── 領先／落後：相關係數（週／月格點）與每波極值時點 ───────────────
function retOnGrid(mk, sym, dates) {
  // 格點日期 → 當期報酬（前一格點收盤到本格點收盤，皆用「當日或之前最近交易日」）
  const c = mk.sym[sym].c;
  const idxs = dates.map(d => idxOnOrBefore(mk, d));
  return idxs.map((i, k) => (k > 0 && i !== null && idxs[k - 1] !== null ? (c[i] / c[idxs[k - 1]] - 1) * 100 : null));
}
function lagCorr(ind, ret, ks) {
  const out = {};
  for (const k of ks) {
    const x = [], y = [];
    for (let j = 0; j < ind.length; j++) { const jj = j + k; if (jj >= 0 && jj < ret.length) { x.push(ind[j]); y.push(ret[jj]); } }
    out[k] = pearson(x, y);
  }
  return out;
}

export function leadLag(A) {
  const { mk } = A;
  const res = {};
  const ws = A.weekly.filter(w => w.date >= addDays(mk.cal[mk.si], -7) && w.date <= mk.cal[mk.ei]);
  const wd = ws.map(w => w.date);
  const ks = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
  for (const sym of ['SPY', 'QQQ']) {
    const ret = retOnGrid(mk, sym, wd);
    res[`cftc_sp_${sym}`] = lagCorr(ws.map(w => (w.roll ? null : w.sp?.gChg ?? null)), ret, ks);
    res[`cftc_nq_${sym}`] = lagCorr(ws.map(w => (w.roll ? null : w.nq?.gChg ?? null)), ret, ks);
    res[`cftc_avg_${sym}`] = lagCorr(ws.map(w => (w.roll ? null : w.avgG)), ret, ks);
    res[`cftc_net_${sym}`] = lagCorr(ws.map(w => (w.roll ? null : w.sp?.nChgOi ?? null)), ret, ks);
    const ns = A.nfci.filter(r => r.date >= mk.cal[mk.si] && r.date <= mk.cal[mk.ei]);
    const nd = ns.map(r => r.date);
    const nret = retOnGrid(mk, sym, nd);
    res[`nfci_lev_${sym}`] = lagCorr(ns.map(r => r.dLev ?? null), nret, ks);
    res[`nfci_risk_${sym}`] = lagCorr(ns.map(r => r.dRisk ?? null), nret, ks);
    res[`nfci_credit_${sym}`] = lagCorr(ns.map(r => r.dCredit ?? null), nret, ks);
    const fs = A.finra.filter(r => r.date >= addDays(mk.cal[mk.si], -31) && r.date <= mk.cal[mk.ei]);
    res[`finra_${sym}`] = lagCorr(fs.map(r => r.mom), fs.map(r => (sym === 'SPY' ? r.retSPY : r.retQQQ) ?? null), [-2, -1, 0, 1, 2]);
  }
  return res;
}

/** 每個波段內，各指標「極端」出現的日期相對波段低點（週；正＝低點之後）與其公布日距低點（交易日） */
export function waveExtremes(A) {
  const { mk } = A;
  const rows = [];
  for (const sym of ['SPY', 'QQQ']) for (const w of A.waves[sym]) {
    const from = addDays(w.peakDate, -14), to = addDays(w.lowDate, 56);
    const pick = (arr, val, dir, dateKey = 'date') => {
      let best = null;
      for (const r of arr) if (r[dateKey] >= from && r[dateKey] <= to && isNum(val(r)) && (best === null || dir * val(r) > dir * val(best))) best = r;
      return best;
    };
    const cf = pick(A.weekly.filter(x => !x.roll), r => r.avgG, -1);
    const nl = pick(A.nfci, r => r.dLev, 1);
    const nr = pick(A.nfci, r => r.dRisk, 1);
    const fm = pick(A.finra.filter(r => r.availIdx !== null), r => r.mom, -1);
    const wk = d => Math.round(dayDiff(w.lowDate, d) / 7);
    const rel = i => (i === null || i === undefined ? null : i - w.lowIdx);
    rows.push({
      sym, peakDate: w.peakDate, lowDate: w.lowDate, maxDd: w.maxDd,
      cftc: cf ? { date: cf.date, val: cf.avgG, weeksFromLow: wk(cf.date), availTd: rel(cf.availIdx) } : null,
      nfciLev: nl ? { date: nl.date, val: nl.dLev, weeksFromLow: wk(nl.date), availTd: rel(nl.availIdx) } : null,
      nfciRisk: nr ? { date: nr.date, val: nr.dRisk, weeksFromLow: wk(nr.date), availTd: rel(nr.availIdx) } : null,
      finra: fm ? { month: fm.month, val: fm.mom, knownDate: fm.knownDate, availTd: rel(fm.availIdx), weeksFromLow: Math.round(dayDiff(w.lowDate, fm.knownDate) / 7) } : null,
    });
  }
  return rows;
}

// ── C：收縮放緩 + VIX 回落 ────────────────────────────────────────
export function stabilization(A) {
  const { mk, cfg } = A;
  const T = cfg.slowdownGross;
  const cl = A.weekly.filter(w => !w.roll && isNum(w.avgG));
  const slow = [];
  for (let k = 1; k < cl.length; k++) {
    const p = cl[k - 1], w = cl[k];
    if (w.availIdx === null) continue;
    if (p.avgG <= -T && w.avgG > p.avgG && w.avgG >= -1) slow.push({ idx: w.availIdx, date: w.date });
  }
  const slowIdx = slow.map(x => x.idx);
  const stressRecent = (i, win = 15) => { for (let j = Math.max(0, i - win); j <= i; j++) if (A.stress.stress[j]) return true; return false; };
  const variants = [
    { id: 'slow', label: 'CFTC 收縮放緩（前週 avg gross ≤-3%，本週較前週好且 ≥-1%）', flags: slowIdx },
    { id: 'slow_vix', label: '… ∧ VIX 回落（≤近10日高×0.85 且低於5日前）', flags: slowIdx.filter(i => vixCalm(mk, i, cfg)) },
    { id: 'slow_vix_dd5', label: '… ∧ VIX 回落 ∧ SPY 回撤≥5%', flags: slowIdx.filter(i => vixCalm(mk, i, cfg) && mk.sym.SPY.dd[i] >= 5) },
    { id: 'vix_only', label: '僅 VIX 回落（近15日內曾有 L3 壓力）', flags: (() => { const o = []; for (let i = mk.si; i <= mk.ei; i++) if (vixCalm(mk, i, cfg) && stressRecent(i)) o.push(i); return o; })() },
    { id: 'vix_dd8', label: '僅 VIX 回落 ∧ SPY 回撤≥8%', flags: (() => { const o = []; for (let i = mk.si; i <= mk.ei; i++) if (vixCalm(mk, i, cfg) && mk.sym.SPY.dd[i] >= 8) o.push(i); return o; })() },
  ];
  const rows = variants.map(v => {
    const ev = evaluate(mk, v.flags, cfg);
    const timing = { SPY: [], QQQ: [] };
    for (const s of ['SPY', 'QQQ']) for (const e of ev.events) {
      const w = A.waves[s].find(x => e.idx >= x.peakIdx && e.idx <= x.endIdx);
      timing[s].push(!w ? 'outside' : e.idx >= w.lowIdx ? 'afterLow' : 'beforeLow');
    }
    const cnt = (s, k) => timing[s].filter(x => x === k).length;
    return { ...v, flagDays: ev.flagDays, events: ev.events.length, sum: ev.sum,
      timing: { SPY: { before: cnt('SPY', 'beforeLow'), after: cnt('SPY', 'afterLow'), outside: cnt('SPY', 'outside') }, QQQ: { before: cnt('QQQ', 'beforeLow'), after: cnt('QQQ', 'afterLow'), outside: cnt('QQQ', 'outside') } },
      list: ev.events.map(e => ({ date: mk.cal[e.idx], spyDd: mk.sym.SPY.dd[e.idx], qqqDd: mk.sym.QQQ.dd[e.idx], vix: mk.vix[e.idx],
        f20: forward(mk, 'SPY', e.idx, cfg)?.h?.[20] ?? null, q20: forward(mk, 'QQQ', e.idx, cfg)?.h?.[20] ?? null })) };
  });
  return { slow, rows };
}

// ── D：三層 vs VIX-only ───────────────────────────────────────────
export function layered(A) {
  const { mk, cfg } = A;
  const n = mk.N;
  const within = (idxs, win) => {                      // idxs 升冪；回傳 bool[]：過去 win 日（含當日）內有事件
    const f = new Array(n).fill(false);
    for (const i of idxs) for (let j = i; j <= Math.min(n - 1, i + win); j++) f[j] = true;
    return f;
  };
  // L2 主定義（先於看結果前訂下）：ES 與 NQ 同週 gross 收縮≥6%（集中）或 NFCI-leverage 週變動 z≥1.5；10 日內有效。
  // L2b 為較寬鬆版本（ES/NQ/RTY 任兩個同週收縮≥6%），僅供比較，避免主定義長時間恆亮。
  const L2 = within([...sigById(A, 'cftc_both_g6').flags, ...sigById(A, 'nfci_lev_up').flags].filter(i => i !== null), 10);
  const L2b = within([...sigById(A, 'cftc_three_g6').flags, ...sigById(A, 'nfci_lev_up').flags].filter(i => i !== null), 10);
  const L1 = new Array(n).fill(false);
  const fin = A.finra.filter(r => r.availIdx !== null).sort((a, b) => a.availIdx - b.availIdx);
  fin.forEach((r, k) => { const end = k + 1 < fin.length ? fin[k + 1].availIdx : n; if (isNum(r.mom) && r.mom <= -3) for (let j = r.availIdx; j < end && j < r.availIdx + 45; j++) L1[j] = true; });
  const L3 = A.stress.stress;
  const day = f => { const o = []; for (let i = mk.si; i <= mk.ei; i++) if (f(i)) o.push(i); return o; };
  const alarms = [
    { id: 'vix25', label: 'VIX≥25（單獨）', layers: 'D', flags: day(i => isNum(mk.vix[i]) && mk.vix[i] >= cfg.vixHi) },
    { id: 'vix30', label: 'VIX≥30（單獨）', layers: 'D', flags: day(i => isNum(mk.vix[i]) && mk.vix[i] >= 30) },
    { id: 'L3', label: 'L3 日頻壓力（≥2/5 項）', layers: 'D', flags: day(i => L3[i]) },
    { id: 'L2', label: 'L2 週頻去槓桿（ES∧NQ 同週收縮≥6% 或 NFCI-lev 急升，10日內）', layers: 'W', flags: day(i => L2[i]) },
    { id: 'L2b', label: 'L2b 較寬鬆（ES/NQ/RTY 任兩個收縮≥6% 或 NFCI-lev 急升）', layers: 'W', flags: day(i => L2b[i]) },
    { id: 'L1', label: 'L1 月頻（FINRA 最近一次公布月減≥3%）', layers: 'M', flags: day(i => L1[i]) },
    { id: 'L3_L2', label: 'L3 ∧ L2', layers: 'D+W', flags: day(i => L3[i] && L2[i]) },
    { id: 'L3_L2orL1', label: 'L3 ∧ (L2 ∨ L1)（三層確認）', layers: 'D+W+M', flags: day(i => L3[i] && (L2[i] || L1[i])) },
    { id: 'L3_L2_L1', label: 'L3 ∧ L2 ∧ L1（三層全中）', layers: 'D+W+M', flags: day(i => L3[i] && L2[i] && L1[i]) },
  ];
  const rows = alarms.map(a => {
    const ev = evaluate(mk, a.flags, cfg);
    const per = {};
    for (const s of ['SPY', 'QQQ']) per[s] = waveCoverage(mk, ev.events, A.waves[s]);
    return { ...a, flagDays: ev.flagDays, events: ev.events.length, sum: ev.sum, per };
  });
  return { rows, shares: { L2b: L2b.slice(mk.si, mk.ei + 1).filter(Boolean).length, L1: L1.slice(mk.si, mk.ei + 1).filter(Boolean).length, L2: L2.slice(mk.si, mk.ei + 1).filter(Boolean).length, L3: L3.slice(mk.si, mk.ei + 1).filter(Boolean).length, days: mk.ei - mk.si + 1 } };
}

// ── 恐懼貪婪 ───────────────────────────────────────────────────────
export function fearStudy(A, thr = A.cfg.fearThr) {
  const { mk } = A;
  const fear = i => isNum(mk.fg[i]) && mk.fg[i] < thr;
  let fn = 0, nn = 0, fs = 0, ns = 0;
  const L3 = A.stress.stress;
  for (let i = mk.si; i <= mk.ei; i++) {
    if (!isNum(mk.fg[i])) continue;
    if (fear(i)) { fn++; if (L3[i]) fs++; } else { nn++; if (L3[i]) ns++; }
  }
  const sigStats = ['cftc_three_g6', 'cftc_both_g6', 'nfci_lev_up', 'nfci_risk_up', 'finra_mom3'].map(id => {
    const ev = clusterEvents([...new Set(sigById(A, id).flags.filter(i => inRange(mk, i)))].sort((a, b) => a - b), A.cfg.cooldown);
    const near = ev.filter(e => { for (let k = 0; k <= 5; k++) if (e.idx - k >= 0 && fear(e.idx - k)) return true; return false; }).length;
    return { id, label: sigById(A, id).label, events: ev.length, nearFear: near };
  });
  const waves = [];
  for (const sym of ['SPY', 'QQQ']) for (const w of A.waves[sym]) {
    let mn = null;
    for (let i = w.peakIdx; i <= w.endIdx; i++) if (isNum(mk.fg[i]) && (mn === null || mk.fg[i] < mk.fg[mn])) mn = i;
    let first = null; for (let i = w.peakIdx; i <= w.endIdx; i++) if (fear(i)) { first = i; break; }
    waves.push({ sym, peakDate: w.peakDate, lowDate: w.lowDate, maxDd: w.maxDd, fgMin: mn === null ? null : mk.fg[mn], fgMinDate: mn === null ? null : mk.cal[mn],
      fgMinToLow: mn === null ? null : mn - w.lowIdx, firstFearDate: first === null ? null : mk.cal[first], firstFearToLow: first === null ? null : w.lowIdx - first });
  }
  return { thr, fearDays: fn, fgDays: fn + nn, pStressGivenFear: fn ? fs / fn * 100 : null, pStressGivenNot: nn ? ns / nn * 100 : null, sigStats, waves };
}

// ── 個案時間線 ─────────────────────────────────────────────────────
export function caseTimeline(A, from, to) {
  const { mk } = A;
  const day = d => idxOnOrBefore(mk, d);
  const cftc = A.weekly.filter(w => w.date >= addDays(from, -21) && w.date <= to).map(w => ({
    report: w.date, release: w.availIdx !== null ? mk.cal[w.availIdx] : null, roll: w.roll, spG: w.sp?.gChg ?? null, nqG: w.nq?.gChg ?? null, ruG: w.ru?.gChg ?? null,
    spNet: w.sp?.net ?? null, spLong: w.sp?.long ?? null, spShort: w.sp?.short ?? null, span: w.sp?.span ?? null,
  }));
  const nfci = A.nfci.filter(r => r.date >= addDays(from, -21) && r.date <= to).map(r => ({
    date: r.date, avail: r.availIdx !== null ? mk.cal[r.availIdx] : null, lev: r.lev, dLev: r.dLev ?? null, zLev: r.zLev ?? null, risk: r.risk, dRisk: r.dRisk ?? null, credit: r.credit, dCredit: r.dCredit ?? null }));
  const finra = A.finra.filter(r => r.month >= addDays(from, -62).slice(0, 7) && r.month <= to.slice(0, 7)).map(r => ({
    month: r.month, debit: r.debit, mom: r.mom, knownModel: r.knownDate, notYet: r.notYet, retSPY: r.retSPY ?? null, retQQQ: r.retQQQ ?? null }));
  const daily = [];
  for (let i = day(addDays(from, -1)) ?? 0; i <= (day(to) ?? mk.N - 1); i++) {
    if (mk.cal[i] < from) continue;
    daily.push({ date: mk.cal[i], spy: mk.sym.SPY.c[i], spyDd: mk.sym.SPY.dd[i], qqq: mk.sym.QQQ.c[i], qqqDd: mk.sym.QQQ.dd[i], vix: mk.vix[i], vxn: mk.vxn[i], ts: mk.ts[i],
      oas: mk.oas[i], hyp20: mk.hyp20[i], br50: mk.breadth50[i], fg: mk.fg[i], stress: A.stress.count[i] });
  }
  return { cftc, nfci, finra, daily };
}

export function runStudy(raw, cfg = {}) {
  const A = buildAll(raw, cfg);
  const { mk } = A;
  const all = i => i >= mk.si && i <= mk.ei;
  const base = {
    all: baseline(mk, all, A.cfg),
    dd8: baseline(mk, i => all(i) && mk.sym.SPY.dd[i] >= 8, A.cfg),
    qdd10: baseline(mk, i => all(i) && mk.sym.QQQ.dd[i] >= 10, A.cfg),
    dd5: baseline(mk, i => all(i) && mk.sym.SPY.dd[i] >= 5, A.cfg),
  };
  return {
    A, cfg: A.cfg, base,
    waves: A.waves, score: scorecard(A), lead: leadLag(A), extremes: waveExtremes(A),
    stab: stabilization(A), layers: layered(A), fear: fearStudy(A),
    cases: { A: caseTimeline(A, '2024-07-01', '2024-08-16'), B: caseTimeline(A, '2026-06-22', '2026-08-14') },
  };
}
void DEFAULTS; void median; void avg; void summarize;
