import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildDataset, clusterEvents, forwardStats, singleDayFlags, evaluateFlags, rdMetrics, mergeRatio,
  ruleFlags, RULE_VARIANTS, findWaves, runFullBacktest, median,
} from './marginalert_calc.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// 合成資料：日期連續（只用 YYYY-MM-DD 字串排序，不需真實日曆）
function mkDates(n, start = '2024-01-01') {
  const out = [];
  const t0 = Date.parse(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * 86400000).toISOString().slice(0, 10));
  return out;
}
function mk(closes, margins, { opens, ratio } = {}) {
  const ds = mkDates(closes.length);
  const twii = closes.map((c, i) => ({ date: ds[i], open: opens ? opens[i] : c, high: c * 1.01, low: c * 0.99, close: c }));
  const margin = margins.map((m, i) => ({ date: ds[i], margin_money: m }));
  const r = ratio ? ratio.map((x, i) => ({ date: ds[i], ratio: x })) : [];
  return { twii, margin, ratio: r, dates: ds };
}
const CFG = { start: '2024-01-01', end: '2030-01-01', cooldown: 3, lookback: 5, horizons: [2, 3] };

test('單日融資變動＝今日/前一融資日-1；日期用各自日曆', () => {
  const d = mk([100, 100, 100], [1000, 980, 940]);
  const ds = buildDataset(d, CFG);
  near(ds.days[1].m[1], -2);
  near(ds.days[2].m[1], (940 / 980 - 1) * 100);
  assert.equal(ds.days[1].dm1, -20);
});

test('門檻為巢狀：-5% 同時算在 2/3/4/5 的觸發日，但只是一個獨立事件', () => {
  const d = mk([100, 100, 100, 100], [1000, 1000, 940, 940]);
  const ds = buildDataset(d, CFG);
  for (const th of [2, 3, 4, 5]) assert.deepEqual(singleDayFlags(ds, th), [2]);
  assert.deepEqual(singleDayFlags(ds, 6.5), []);
});

test('clusterEvents：相隔 ≤cooldown 併為同一事件，> cooldown 才是新事件', () => {
  const ev = clusterEvents([2, 3, 5, 12, 13], 3);
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].startIdx, ev[0].lastIdx, ev[0].triggerDays], [2, 5, 3]);
  assert.deepEqual([ev[1].startIdx, ev[1].triggerDays], [12, 2]);
});

test('回撤只用當時已知的滾動高點（含當日，不看未來）', () => {
  const closes = [100, 110, 105, 99, 120];
  const ds = buildDataset(mk(closes, closes.map(() => 1000)), { ...CFG, lookback: 3 });
  near(ds.days[3].dd, (1 - 99 / 110) * 100);   // 高點窗 [110,105,99]
  near(ds.days[4].dd, 0);                      // 新高
  // 改變未來資料不應改變過去的 dd
  const closes2 = [100, 110, 105, 99, 50];
  const ds2 = buildDataset(mk(closes2, closes2.map(() => 1000)), { ...CFG, lookback: 3 });
  near(ds2.days[3].dd, ds.days[3].dd);
});

test('暖機期使用 start 之前的真實歷史，不因截短區間而改變回撤', () => {
  const closes = [200, 150, 140, 130, 120, 110];
  const raw = mk(closes, closes.map(() => 1000));
  const full = buildDataset(raw, { ...CFG, lookback: 6 });
  const cut = buildDataset(raw, { ...CFG, lookback: 6, start: raw.dates[3] });
  near(cut.days[0].dd, full.days[3].dd);
  assert.ok(cut.days[0].dd > 34);
});

test('警報後進場最早為下一交易日：nextOpen 用隔日開盤、報酬從隔日算起', () => {
  const closes = [100, 90, 80, 85, 90, 95, 100];
  const opens = [100, 95, 82, 84, 88, 94, 99];
  const raw = mk(closes, [1000, 900, 800, 800, 800, 800, 800], { opens });
  const ds = buildDataset(raw, { ...CFG, entry: 'nextOpen', horizons: [2] });
  const day = ds.days[1];                         // 融資 -10%，訊號日 index1
  const f = forwardStats(ds, day, ds.cfg);
  assert.equal(f.entryDate, raw.dates[2]);
  assert.equal(f.entryPrice, 82);
  near(f.h[2].ret, (closes[3] / 82 - 1) * 100);   // 持有 2 日：e=2 → exit=e+h-1=3
  const g = forwardStats(ds, day, { ...ds.cfg, entry: 'nextClose' });
  assert.equal(g.entryPrice, 80);
  near(g.h[2].ret, (closes[4] / 80 - 1) * 100);
});

test('跌破警報日最低點與最大回撤／反彈的計算', () => {
  const closes = [100, 90, 95, 80, 100];
  const raw = mk(closes, [1000, 900, 900, 900, 900]);
  const ds = buildDataset(raw, { ...CFG, horizons: [3] });
  const f = forwardStats(ds, ds.days[1], ds.cfg);    // low[1]=89.1；後續 low[3]=79.2
  assert.equal(f.h[3].breakLow, true);
  assert.equal(f.h[3].daysToLow, 2);
  assert.ok(f.h[3].mdd < 0 && f.h[3].rally > 0);
  const f2 = forwardStats(ds, ds.days[3], ds.cfg);   // 資料不足 3 日：該 horizon 為 null，不外推
  assert.equal(f2.h[3], null);
  assert.equal(forwardStats(ds, ds.days[4], ds.cfg), null);   // 最後一天沒有下一交易日
});

test('R/D：下跌市場 R=|融資|/|指數|、D=差；跌幅不足不算；反彈中去槓桿獨立標示', () => {
  const day = (m, x) => ({ m: { 3: m }, x: { 3: x } });
  const a = rdMetrics(day(-7, -4), 3, 1);
  assert.equal(a.kind, 'fall'); near(a.R, 1.75); near(a.D, 3);
  assert.equal(rdMetrics(day(-7, -0.4), 3, 1).kind, 'none');       // 指數跌幅 <1% → R 會失真
  assert.equal(rdMetrics(day(-7, -0.6), 3, 0.5).kind, 'fall');     // 0.5% 門檻下成立
  const rb = rdMetrics(day(-3, 2), 3, 1);
  assert.equal(rb.kind, 'rebound'); assert.equal(rb.R, undefined);
  assert.equal(rdMetrics(day(2, -4), 3, 1).kind, 'none');          // 融資增加
});

test('mergeRatio：重疊日以 recon 為準並回報差異', () => {
  const r = mergeRatio([{ date: '2024-01-01', ratio_all: 150 }, { date: '2024-01-02', ratio_all: 151 }], [{ date: '2024-01-02', ratio: 151 }, { date: '2024-01-03', ratio: 152 }]);
  assert.equal(r.rows.length, 3); assert.equal(r.overlap, 1); assert.equal(r.maxAbsDiff, 0);
});

test('2/3 規則：維持率下降是「點數」差而非相對%；B 缺資料不被估算', () => {
  const closes = [100, 100, 100, 100, 84];
  const raw = mk(closes, [1000, 1000, 1000, 1000, 1000], { ratio: [200, 200, 200, 200, 170] });
  const ds = buildDataset(raw, { ...CFG, lookback: 5 });
  assert.equal(ds.days[4].ratioDrop, 30);     // 200→170 ＝ 30 個百分點
  const flagsB = ruleFlags(ds, RULE_VARIANTS[0], ds.cfg, '2of3');
  assert.deepEqual(flagsB, [4]);              // A(回撤16%)+B(30點) 成立，C 不成立
  const noRatio = buildDataset(mk(closes, closes.map(() => 1000)), { ...CFG, lookback: 5 });
  assert.deepEqual(ruleFlags(noRatio, RULE_VARIANTS[0], noRatio.cfg, '2of3'), []);   // 只剩 A，不足兩項
});

test('TWII 缺日不補：只在兩邊都有的日期當訊號日，並回報 gaps', () => {
  const raw = mk([100, 100, 100], [1000, 900, 900]);
  raw.twii.splice(1, 1);
  const ds = buildDataset(raw, CFG);
  assert.deepEqual(ds.gaps.marginOnly, [raw.dates[1]]);
  assert.equal(ds.days.length, 2);
  near(ds.days[1].m[1], 0);                   // 融資 1 日變動用融資自己的前一日（900→900）
});

test('findWaves：回撤≥進入門檻開波段、<退出門檻結束，低點為波段最低收盤', () => {
  const closes = [100, 100, 88, 80, 85, 99, 100];
  const ds = buildDataset(mk(closes, closes.map(() => 1000)), { ...CFG, lookback: 7, waveEnter: 10, waveExit: 5 });
  const w = findWaves(ds, ds.cfg);
  assert.equal(w.length, 1);
  assert.equal(w[0].lowDate, ds.days[3].date);
  assert.equal(w[0].peakClose, 100);
});

test('median 與空集合', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null);
});

test('真實資料煙霧測試：關鍵日期與已獨立複核的數字', { skip: !fs.existsSync(new URL('../../data/TWII.json', import.meta.url)) }, () => {
  const R = f => JSON.parse(fs.readFileSync(new URL(`../../data/${f}.json`, import.meta.url))).data;
  const ratio = mergeRatio(R('taiwan_margin_ratio_mm'), R('taiwan_margin_ratio')).rows;
  const res = runFullBacktest({ twii: R('TWII'), margin: R('taiwan_margin_total'), ratio }, { end: '2026-10-16' });
  const A = res.cases.find(c => c.id === 'A'), B = res.cases.find(c => c.id === 'B');
  assert.equal(A.low.date, '2024-08-05');
  assert.equal(B.low.date, '2026-07-30');
  assert.equal(res.thresholds[3].events.length, 10);
  assert.equal(res.thresholds[2].flagDays, 55);
  assert.equal(A.first[3].date, '2024-08-05');
});

test('四週(20交易日)維持率高點：值、日期、差(點)；窗外舊高點不算', () => {
  const closes = Array(8).fill(100);
  const raw = mk(closes, closes.map(() => 1000), { ratio: [190, 180, 170, 160, 165, 170, 168, 175] });
  const ds = buildDataset(raw, { ...CFG, ratioWindow: 3 });
  const d = ds.days[6];                       // 窗 [5,6]→ idx4..6：165,170,168
  assert.equal(d.r4.high, 170); assert.equal(d.r4.date, raw.dates[5]); near(d.r4.diff, -2);
  assert.equal(ds.days[7].r4.high, 175); near(ds.days[7].r4.diff, 0);
  assert.equal(ds.days[2].r4.high, 190);      // 190 在窗內（idx0..2）
});

test('恐懼貪婪：只用同日值、不補值；fearAnalysis 的條件機率與波段對照', async () => {
  const { fearAnalysis, clampFear } = await import('./marginalert_calc.mjs');
  assert.equal(clampFear(2), 5); assert.equal(clampFear(40), 25); assert.equal(clampFear(15.4), 15);
  const closes = [100, 100, 100, 100, 100, 100];
  const raw = mk(closes, [1000, 1000, 940, 940, 940, 940]);
  raw.fearGreed = [{ date: raw.dates[0], value: 50 }, { date: raw.dates[2], value: 10 }, { date: raw.dates[3], value: 0 }, { date: raw.dates[4], value: 30 }];
  const ds = buildDataset(raw, CFG);
  assert.equal(ds.days[1].fg, null);            // 缺值不補
  assert.equal(ds.days[3].fg, 0);               // 0 是合法值
  const fa = fearAnalysis(ds, 15, singleDayFlags(ds, 3), ds.cfg);
  assert.equal(fa.fgDays, 4); assert.equal(fa.fearDays, 2);
  assert.equal(fa.alarmDays, 1); assert.equal(fa.alarmDaysInFear, 1);   // 警報日(index2) fg=10 在恐懼區
  near(fa.pAlarmGivenFear, 50); near(fa.pAlarmGivenNot, 0);
  assert.equal(fa.eventsNearFear, 1);
});
