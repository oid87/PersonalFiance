import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  sensitivity, projectIndex, projectMargin, findIndexWaves, buildBetaHistory, betaStats, betaAtDepth, walkForward, betaByRegime, betaDepthPaired, analyzeHistory, scenarioView,
  scenarioBetas, pickReference, targetTable, maTable, sma, deleverObservation, signalOverlap, runStress, MANUAL_BETAS, KEY_DROP_PTS,
} from './marginstress_calc.mjs';
import { buildDataset, findWaves, mergeRatio } from './marginalert_calc.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ── 公式回歸（使用者提供的案例數字，只當公式回歸，不是已驗證的官方歷史）─────────
test('Beta：6/23→7/30（47101/201.91% → 39933/156.75%）≈ 1.47，且百分點與相對跌幅分開', () => {
  const s = sensitivity({ p0: 47101, p1: 39933, m0: 201.91, m1: 156.75 });
  assert.equal(s.ok, true);
  near(s.indexDecline, (47101 - 39933) / 47101);
  near(s.marginDecline, (201.91 - 156.75) / 201.91);
  near(s.beta, 1.47, 0.005);
  near(s.ptsDrop, 45.16, 1e-9);                  // 百分點，不是 1.47
});

test('反推指數：10/7（49806／198.92%）目標 150%、Beta 1.47 ≈ 41,473；168.92% ≈ 44,695', () => {
  const a = projectIndex({ p0: 49806, m0: 198.92, mt: 150, beta: 1.47 });
  assert.equal(a.status, 'ok');
  near(a.requiredDecline, 0.1673, 0.0005);
  near(a.projected, 41473, 2);
  const b = projectIndex({ p0: 49806, m0: 198.92, mt: 168.92, beta: 1.47 });
  near(b.projected, 44695, 2);
});

test('正反推一致：推估指數再反推維持率會回到目標', () => {
  for (const beta of [0.8, 1.0, 1.47, 1.7]) {
    for (const mt of [180, 160, 150, 130]) {
      const p = projectIndex({ p0: 49806, m0: 198.92, mt, beta });
      if (p.status !== 'ok') continue;
      const m = projectMargin({ p0: 49806, m0: 198.92, pt: p.projected, beta });
      near(m.projected, mt, 1e-9);
    }
  }
});

// ── 邊界與錯誤輸入：不得產生假預測，也不得丟例外 ─────────────────────────────────
test('Beta：缺值、起點等於終點、指數沒下跌 → ok=false 且 beta=null', () => {
  assert.equal(sensitivity({ p0: 100, p1: 100, m0: 190, m1: 160 }).reason, 'no-index-decline');
  assert.equal(sensitivity({ p0: 100, p1: 110, m0: 190, m1: 160 }).reason, 'no-index-decline');
  assert.equal(sensitivity({ p0: 100, p1: 90, m0: null, m1: 160 }).reason, 'missing');
  assert.equal(sensitivity({ p0: 100, p1: 90, m0: 190, m1: NaN }).reason, 'missing');
  assert.equal(sensitivity().reason, 'missing');
  assert.equal(sensitivity({ p0: 100, p1: 90, m0: 190, m1: 160 }).beta > 0, true);
  assert.equal(sensitivity({ p0: 100, p1: 90, m0: 0, m1: 160 }).beta, null);
});

test('反推指數：Beta=0／缺失／負值、目標高於基準、需跌幅≥100% → projected=null', () => {
  const base = { p0: 49806, m0: 198.92, mt: 150 };
  for (const beta of [0, -1, undefined, null, NaN, Infinity]) {
    const r = projectIndex({ ...base, beta });
    assert.equal(r.projected, null);
    assert.equal(r.status, 'bad-beta');
  }
  assert.equal(projectIndex({ ...base, mt: 198.92, beta: 1.47 }).status, 'target-not-below');
  assert.equal(projectIndex({ ...base, mt: 210, beta: 1.47 }).projected, null);
  assert.equal(projectIndex({ ...base, mt: 10, beta: 0.2 }).status, 'out-of-range');   // (188.92/198.92)/0.2 > 1
  assert.equal(projectIndex({ p0: 49806, m0: null, mt: 150, beta: 1.47 }).status, 'invalid');
  assert.equal(projectIndex().status, 'invalid');
});

test('反推維持率：目標指數不低於基準／推估<=0／缺值 → 不推估', () => {
  assert.equal(projectMargin({ p0: 100, m0: 190, pt: 100, beta: 1.5 }).status, 'not-below');
  assert.equal(projectMargin({ p0: 100, m0: 190, pt: 120, beta: 1.5 }).projected, null);
  assert.equal(projectMargin({ p0: 100, m0: 190, pt: 20, beta: 1.5 }).status, 'out-of-range');   // 1 - 1.5×0.8 < 0
  assert.equal(projectMargin({ p0: 100, m0: 190, pt: 50, beta: 0 }).status, 'bad-beta');
  assert.equal(projectMargin({ p0: 100, m0: undefined, pt: 50, beta: 1 }).status, 'invalid');
  near(projectMargin({ p0: 100, m0: 200, pt: 90, beta: 1.5 }).projected, 200 * (1 - 1.5 * 0.1));
});

// ── 波段與歷史 ──────────────────────────────────────────────────────
function series(n, f, start = '2024-01-01') {
  const t0 = Date.parse(start + 'T00:00:00Z');
  return Array.from({ length: n }, (_, i) => ({ date: new Date(t0 + i * 86400000).toISOString().slice(0, 10), close: f(i) }));
}

test('波段：進入≥enter、<exit 結束；peak 為進入日 lookback 高點；未結束標 open', () => {
  // 100 上升到 200，再跌到 150（-25%），回到 195（回撤 2.5% <5%）
  const path = [...Array.from({ length: 10 }, (_, i) => 100 + i * 11.1), 200, 190, 170, 150, 160, 180, 195, 196];
  const twii = series(path.length, i => path[i]);
  const w = findIndexWaves(twii, { lookback: 5, enter: 10, exit: 5 });
  assert.equal(w.length, 1);
  assert.equal(w[0].peakClose, 200);
  assert.equal(w[0].lowClose, 150);
  near(w[0].maxDd, 25, 1e-9);
  assert.equal(w[0].open, false);
  const open = findIndexWaves(twii.slice(0, 14), { lookback: 5, enter: 10, exit: 5 });
  assert.equal(open.at(-1).open, true);
});

test('波段定義與既有 findWaves 一致（2020 之後的真實資料）', () => {
  const J = f => JSON.parse(fs.readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8')).data;
  const twii = J('TWII'), margin = J('taiwan_margin_total');
  const ds = buildDataset({ twii, margin, ratio: [] }, { start: '2020-01-01', end: '2026-10-16' });
  const ref = findWaves(ds).filter(w => !w.open);
  const mine = findIndexWaves(twii).filter(w => !w.open && w.startDate >= '2020-01-01');
  assert.ok(ref.length >= 6);
  assert.deepEqual(mine.map(w => [w.peakDate, w.lowDate, w.endDate]), ref.map(w => [w.peakDate, w.lowDate, w.endDate]));
});

function synth() {
  // 三個互不重疊的波段，維持率與指數同步（M 與 P 同比例下跌的 k 倍）
  const rows = [];
  const mk = (start, peak, low, m0, beta, n = 20) => {
    const p = [];
    for (let i = 0; i < n; i++) p.push(peak - (peak - low) * i / (n - 1));
    for (let i = 0; i < n; i++) p.push(low + (peak - low) * i / (n - 1));
    rows.push(...p.map((c, i) => ({ c, m: m0 * (1 - beta * (1 - c / peak)) })));
    return start;
  };
  const flat = (c, m, n) => { for (let i = 0; i < n; i++) rows.push({ c, m }); };
  flat(100, 180, 130);                         // 暖機：lookback 內都是高點 100
  mk(0, 100, 80, 180, 1.0);                    // 波段1：-20%，beta 1.0
  flat(100, 180, 130);
  mk(0, 100, 85, 180, 1.4);                    // 波段2：-15%，beta 1.4
  flat(100, 180, 130);
  mk(0, 100, 88, 180, 0.9);                    // 波段3：-12%，beta 0.9
  flat(100, 180, 5);
  const t0 = Date.parse('2010-01-01T00:00:00Z');
  const date = i => new Date(t0 + i * 86400000).toISOString().slice(0, 10);
  return {
    twii: rows.map((r, i) => ({ date: date(i), close: r.c })),
    ratio: rows.map((r, i) => ({ date: date(i), ratio: r.m })),
    margin: rows.map((r, i) => ({ date: date(i), margin_money: 1000 })),
  };
}

test('Beta 歷史：合成資料還原已知 Beta', () => {
  const d = synth();
  const h = buildBetaHistory(d, { lookback: 120 }).filter(r => r.ok);
  assert.equal(h.length, 3);
  near(h[0].beta, 1.0, 1e-9);
  near(h[1].beta, 1.4, 1e-9);
  near(h[2].beta, 0.9, 1e-9);
  assert.ok(h.every(r => r.independent));
  const st = betaStats(h);
  assert.equal(st.n, 3);
  near(st.median, 1.0, 1e-9);
  near(st.min, 0.9, 1e-9);
  near(st.max, 1.4, 1e-9);
});

test('維持率缺值（日期錯位）→ 該波段 ok=false、不補值、不影響其他波段', () => {
  const d = synth();
  const lowDate = buildBetaHistory(d, { lookback: 120 })[1].lowDate;
  d.ratio = d.ratio.filter(r => r.date !== lowDate);
  const h = buildBetaHistory(d, { lookback: 120 });
  assert.equal(h[1].ok, false);
  assert.equal(h[1].reason, 'missing');
  assert.equal(h[1].beta, null);
  assert.equal(h[0].ok && h[2].ok, true);
});

test('回測無 look-ahead：預測第 k 波只用之前已結束的波段；改動 k 波本身不改變所用 Beta', () => {
  const d = synth();
  const h = buildBetaHistory(d, { lookback: 120 });
  const wf = walkForward(d, h).filter(r => !r.skipped);
  assert.equal(wf.length, 2);
  near(wf[0].betas.prev, 1.0, 1e-9);            // 第 2 波只能用第 1 波
  near(wf[1].betas.prev, 1.4, 1e-9);            // 第 3 波的「上一波」是第 2 波
  near(wf[1].betas.median, 1.2, 1e-9);          // 第 1、2 波中位數
  // 把第 3 波低點維持率亂改，所用 Beta 不變（只有誤差會變）
  const d2 = structuredClone(d);
  const low3 = h[2].lowDate;
  d2.ratio.find(r => r.date === low3).ratio = 100;
  const wf2 = walkForward(d2, buildBetaHistory(d2, { lookback: 120 })).filter(r => !r.skipped);
  assert.equal(wf2[1].betas.prev, wf[1].betas.prev);
  assert.equal(wf2[1].betas.median, wf[1].betas.median);
  assert.notEqual(wf2[1].predictions.prev.errMarginPts, wf[1].predictions.prev.errMarginPts);
  // 第 1 波沒有前例 → 略過
  const all = walkForward(d, h);
  assert.equal(all[0].skipped, 'no-prior');
});

test('回測：目標維持率從未觸及 → 標 not-touched，不產生誤差', () => {
  const d = synth();
  const wf = walkForward(d, buildBetaHistory(d, { lookback: 120 })).filter(r => !r.skipped);
  // 波段 2 最低維持率 = 180×(1-1.4×0.15)=142.2 → m0-30=150 觸及，150% 也觸及；波段 3 低點 180×(1-0.9×.12)=160.6 → 150 未觸及
  const t3 = wf[1].predictions.prev.targets;
  assert.equal(t3.find(t => t.key === '150').status, 'not-touched');
  assert.equal(t3.find(t => t.key === '150').errPct, undefined);
  assert.equal(t3.find(t => t.key === 'm0-30').status, 'not-touched');
});

test('回撤深度 Beta：用當日實際跌幅，不足深度的波段不計', () => {
  const d = synth();
  const h = buildBetaHistory(d, { lookback: 120 });
  const w3 = h[2];                               // 最大回撤 12%
  assert.equal(betaAtDepth(d, w3, 15), null);
  const x = betaAtDepth(d, w3, 10);
  assert.ok(x && x.indexDecline >= 0.10);
  near(x.beta, 0.9, 1e-9);
});

test('情境 Beta：歷史樣本足夠用 P25/中位/P75，不足退回手動值並標註', () => {
  const few = scenarioBetas({ n: 3, median: 1, p25: 0.9, p75: 1.2 });
  assert.equal(few.source, 'manual');
  assert.equal(few.base, MANUAL_BETAS.base);
  assert.match(few.note, /手動/);
  const many = scenarioBetas({ n: 20, median: 1.02, p25: 0.76, p75: 1.17 });
  assert.equal(many.source, 'historical');
  assert.equal(many.low, 0.76);
  assert.equal(scenarioBetas(null).source, 'manual');
});

// ── 現況、反推表、均線 ──────────────────────────────────────────────
test('參考日：預設為共同交易日內最近 lookback 日最高收盤；缺日期回 date-missing', () => {
  const d = synth();
  const r = pickReference(d, 'idxHigh');
  assert.equal(r.ok, true);
  assert.equal(r.p0, 100);
  assert.equal(pickReference(d, '1999-01-01').reason, 'date-missing');
  assert.equal(pickReference({ twii: [], ratio: [] }).ok, false);
  const latest = pickReference(d, 'latest');
  assert.equal(latest.date, d.twii.at(-1).date);
});

test('目標表：含「參考高點 -30 點」，區分「自高點跌幅」與「距目前」，Beta 大則指數較高', () => {
  const betas = { low: 0.8, base: 1.0, high: 1.2 };
  const t = targetTable({ p0: 50000, m0: 200, pNow: 47000, betas });
  const drop = t.find(r => r.key === 'drop30');
  near(drop.mt, 200 - KEY_DROP_PTS);
  const r150 = t.find(r => r.key === '150');
  near(r150.projected, 50000 * (1 - 0.25 / 1.0), 1e-6);
  near(r150.fromRefPct, -25, 1e-9);
  near(r150.fromNowPts, r150.projected - 47000, 1e-9);
  near(r150.fromNowPct, (r150.projected / 47000 - 1) * 100, 1e-9);
  assert.ok(r150.rangeLow < r150.projected && r150.projected < r150.rangeHigh);
  const above = targetTable({ p0: 50000, m0: 140, pNow: 47000, betas }).find(r => r.key === '150');
  assert.equal(above.status, 'target-not-below');
  assert.equal(above.projected, null);
});

test('均線：動態由收盤計算、資料不足的週期略過、不硬編碼', () => {
  const twii = series(130, i => 100 + i);
  const m60 = sma(twii, 60);
  near(m60.value, (100 + 70 + 100 + 129) / 2, 1e-9);        // 最後 60 日：棒 70..129 的均值
  assert.equal(sma(twii, 200), null);
  const tb = maTable({ twii, p0: 229, m0: 180, pNow: 229, betas: { low: 0.8, base: 1, high: 1.2 }, periods: [60, 100, 120, 125, 200, 300] });
  assert.deepEqual(tb.rows.map(r => r.period), [60, 100, 120, 125]);
  assert.deepEqual(tb.skipped, [200, 300]);
  const r60 = tb.rows[0];
  near(r60.base, 180 * (1 - 1 * (229 - r60.ma) / 229), 1e-9);
  assert.ok(r60.rangeLow < r60.base && r60.base < r60.rangeHigh);
  // 價格已在均線之下 → 不推估（not-below），不產生假數字
  const low = maTable({ twii, p0: 100, m0: 180, pNow: 100, betas: { low: 0.8, base: 1, high: 1.2 }, periods: [60] });
  assert.equal(low.rows[0].base, null);
});

test('去槓桿觀察：單日／5日／10日、自參考日、峰谷；維持率降而融資不降只給中性旗標', () => {
  const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const margin = dates.map((date, i) => ({ date, margin_money: 1000 + i * 5 }));
  const ratio = dates.map((date, i) => ({ date, ratio: 200 - i * 3 }));
  const o = deleverObservation({ margin, ratio }, '2026-10-02');
  assert.equal(o.ok, true);
  near(o.d1.pct, (1065 / 1060 - 1) * 100, 1e-9);
  near(o.d5.pct, (1065 / 1040 - 1) * 100, 1e-9);
  near(o.d10.amt, 1065 - 1015, 1e-9);
  near(o.sinceRef.pct, (1065 / 1005 - 1) * 100, 1e-9);
  near(o.ratioPts, 161 - 197, 1e-9);
  assert.equal(o.flag, 'ratio-down-margin-not-down');
  const down = deleverObservation({ margin: margin.map((m, i) => ({ ...m, margin_money: 1100 - i * 20 })), ratio }, '2026-10-02');
  assert.equal(down.flag, null);
  assert.equal(deleverObservation({ margin: [], ratio: [] }, '2026-10-02').ok, false);
});

test('訊號相關性：A、B 同時成立天數與事件；融資沒下降的事件被計出', () => {
  // 指數 100→80（A：回撤≥15）；維持率 190→150（B：降≥30 點）；融資不變 → 「沒有明顯下降」
  const n = 60;
  const t0 = Date.parse('2024-01-01T00:00:00Z');
  const date = i => new Date(t0 + i * 86400000).toISOString().slice(0, 10);
  const px = i => (i < 10 ? 100 : 100 - Math.min(i - 10, 20));
  const mr = i => (i < 10 ? 190 : 190 - Math.min(i - 10, 20) * 2);
  const twii = Array.from({ length: n }, (_, i) => ({ date: date(i), open: px(i), high: px(i), low: px(i), close: px(i) }));
  const margin = Array.from({ length: n }, (_, i) => ({ date: date(i), margin_money: 1000 }));
  const ratio = Array.from({ length: n }, (_, i) => ({ date: date(i), ratio: mr(i) }));
  const ds = buildDataset({ twii, margin, ratio }, { start: '2024-01-01', end: '2030-01-01', lookback: 120 });
  const o = signalOverlap(ds, { lookback: 120 });
  assert.ok(o.counts.both > 0);
  assert.ok(o.counts.A >= o.counts.both && o.counts.B >= o.counts.both);
  assert.equal(o.events.length, 1);
  assert.equal(o.events[0].noClearMarginDrop, true);
  assert.equal(o.eventsNoClearMarginDrop, 1);
  assert.ok(o.pBgivenA > 0 && o.pAgivenB > 0);
});

// ── 整合：任何缺資料都不能讓整個模組失敗 ───────────────────────────
test('runStress：空資料／缺維持率不丟例外，區塊各自回 null', () => {
  const r = runStress({ twii: [], ratio: [], margin: [] });
  assert.equal(r.ref.ok, false);
  assert.equal(r.targets, null);
  assert.equal(r.ma, null);
  assert.equal(r.stats.n, 0);
  assert.equal(r.scenario.source, 'manual');
  const noRatio = runStress({ twii: series(300, i => 100 + (i % 7)), ratio: [], margin: [] });
  assert.equal(noRatio.ref.ok, false);
});

test('真實資料煙霧測試：2026 年波段與使用者數字同量級；不使用 2026 單一案例固定成永久 Beta', () => {
  const J = f => JSON.parse(fs.readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8')).data;
  const data = { twii: J('TWII'), margin: J('taiwan_margin_total'), ratio: mergeRatio(J('taiwan_margin_ratio_mm'), J('taiwan_margin_ratio')).rows };
  const r = runStress(data);
  assert.ok(r.usable.length >= 15);
  const w26 = r.history.find(w => w.peakDate === '2026-06-22');
  near(w26.beta, 1.52, 0.02);                     // 以指數高點日 6/22 為基準
  assert.ok(r.stats.median < w26.beta, '歷史中位數應低於 2026 這一波');
  assert.ok(r.scenario.source === 'historical');
  assert.ok(r.targets.every(t => t.status !== 'ok' || (t.projected > 0 && t.projected < r.ref.p0)));
  // 不同日期的 Beta 不得混用：參考日與目標表使用同一組 (P0, M0)
  assert.equal(r.targets[0].fromRefPct, (r.targets[0].projected / r.ref.p0 - 1) * 100);
});

test('Beta 分群：以期間融資最大跌幅分大幅／輕度去槓桿；無融資資料的波段不分群', () => {
  const mk = (beta, burn) => ({ ok: true, beta, marginMaxBurn: burn === null ? null : { pct: burn }, peakDate: `d${beta}` });
  const r = betaByRegime([mk(1.5, -10), mk(1.3, -20), mk(0.7, -40), mk(0.6, -60), mk(1.0, null)], { heavyAt: -25 });
  assert.equal(r.light.n, 2);
  assert.equal(r.heavy.n, 2);
  near(r.light.median, 1.4, 1e-9);
  near(r.heavy.median, 0.65, 1e-9);
});

test('情境切換：light 情境用輕度去槓桿波段；樣本不足時退回全部波段；自訂缺欄位沿用情境值', () => {
  const J = f => JSON.parse(fs.readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8')).data;
  const data = { twii: J('TWII'), margin: J('taiwan_margin_total'), ratio: mergeRatio(J('taiwan_margin_ratio_mm'), J('taiwan_margin_ratio')).rows };
  const h = analyzeHistory(data);
  assert.ok(h.scenarioLight && h.scenarioLight.base > h.scenario.base, '輕度去槓桿的 Beta 中位數應高於全部波段');
  const light = scenarioView(data, h, { scenario: 'light' });
  assert.equal(light.betas.source, 'historical-light');
  const fallback = scenarioView(data, { ...h, scenarioLight: null }, { scenario: 'light' });
  assert.equal(fallback.betas.source, 'historical');
  const partial = scenarioView(data, h, { beta: { low: 0.9, base: -1, high: 'x' } });
  assert.equal(partial.betas.source, 'user');
  assert.equal(partial.betas.low, 0.9);
  assert.equal(partial.betas.base, h.scenario.base);
  assert.equal(partial.betas.high, h.scenario.high);
  assert.ok(partial.realized.ok, '參考日→最新的實際倍數');
  const unordered = scenarioView(data, h, { beta: { low: 1.7, base: 1.0, high: 1.3 } });
  assert.deepEqual([unordered.betas.low, unordered.betas.base, unordered.betas.high], [1.0, 1.0, 1.7]);   // 基準必在區間內
});

test('同批波段的深度 Beta：只比較達最大深度的波段，缺任一深度者排除', () => {
  const d = synth();
  const h = buildBetaHistory(d, { lookback: 120 }).filter(r => r.ok);
  const dp = betaDepthPaired(d, h, [5, 10]);
  assert.equal(dp.n, 3);                             // 三波最大回撤 20/15/12%，都 ≥10%
  assert.deepEqual(dp.depths, [5, 10]);
  near(dp.medians[0], 1.0, 1e-9);                    // 合成資料 Beta 與深度無關
  assert.equal(dp.declined, 0);
  assert.equal(betaDepthPaired(d, h, [5, 18]).n, 1); // 只有 20% 那波達到 18%
});
