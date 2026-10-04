import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { monthEnd, findAnchorIdx, fwdRet, detectSignalA, detectSignalB, computeSignalRow, groupMedians, groupCounts, computeBaseline, buildEventStudyPure, BASELINE_VERSION, BASELINE_START_MONTH, BASELINE_END_MONTH } from '../tabs/marginpeak_calc.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/marginpeak-transparency.json', import.meta.url)));
const prices = (start, length, base = 100, step = 1) => Array.from({ length }, (_, i) => ({
  date: new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), close: base + i * step,
}));
const middle = values => {
  const v = [...values].sort((a,b) => a-b), n = v.length;
  return n ? (v[Math.floor((n-1)/2)] + v[Math.floor(n/2)]) / 2 : null;
};
// Independent linear search and direct arithmetic; no production helper calls.
function oracleBaseline(spx, qqq, months) {
  const result = {};
  for (const [asset, series] of [['SPX', spx], ['QQQ', qqq]]) for (const [h, distance] of Object.entries(fixture.horizons)) {
    const values = [];
    for (const ym of months) {
      const [year, month] = ym.split('-').map(Number);
      const target = new Date(Date.UTC(year, month, 0)).toISOString().slice(0,10);
      const anchor = series.reduce((index, row, i) => row.date <= target ? i : index, -1);
      if (anchor >= 0 && anchor + distance < series.length) values.push(+((series[anchor+distance].close/series[anchor].close-1)*100).toFixed(2));
    }
    result[`${asset}_${h}`] = { n: values.length, median: middle(values) };
  }
  return result;
}

test('versioned fixed anchor window has 315 candidate months, empty population remains N/A', () => {
  assert.equal(BASELINE_VERSION, 'marginpeak-monthly-raw-v1');
  assert.equal(BASELINE_START_MONTH, '1999-04'); assert.equal(BASELINE_END_MONTH, '2025-06');
  const result = computeBaseline([], []);
  assert.equal(result.months, 315);
  for (const key of Object.keys(result.counts)) { assert.equal(result.counts[key], 0); assert.equal(result.medians[key], null); }
});

test('independent monthly oracle checks each asset/horizon with unequal coverage and sparse tail', () => {
  const s = fixture.linear, spx = prices(s.start, s.length, s.base, s.step), qqq = prices('2024-02-01', 85, 200, 2);
  const result = computeBaseline(spx, qqq, { startMonth:'2024-01', endMonth:'2024-03' });
  const expected = oracleBaseline(spx, qqq, ['2024-01','2024-02','2024-03']);
  assert.equal(result.months, 3);
  for (const [key, value] of Object.entries(expected)) { assert.equal(result.counts[key], value.n); assert.equal(result.medians[key], value.median); }
  assert.equal(result.counts.SPX_12m, 2); assert.equal(result.counts.QQQ_12m, 0);
  assert.equal(result.counts.QQQ_1m, 2);
});

test('month end anchor is last prior observation, including leap day and weekend', () => {
  assert.equal(monthEnd('2024-02-01'), '2024-02-29');
  const s = [{ date:'2024-03-28', close:100 }, { date:'2024-04-01', close:120 }];
  assert.equal(findAnchorIdx(s, monthEnd('2024-03-01')), 0);
  assert.equal(fwdRet(s, 0, 1), 20); assert.equal(findAnchorIdx(s,'2024-03-01'), -1);
});

test('horizon is observation offset, future price can extend beyond anchor window', () => {
  const s = prices('2025-06-30', 253);
  const result = computeBaseline(s,s,{startMonth:'2025-06',endMonth:'2025-06'});
  assert.equal(result.counts.SPX_12m,1); assert.equal(result.medians.SPX_12m,252);
  assert.equal(computeSignalRow({date:'2025-06-01',yoy:60},s,s).SPX_1m,21);
});

test('per-column event n uses the same non-nullish results as existing medians', () => {
  const rows=[{SPX_1m:2,QQQ_1m:undefined},{SPX_1m:null,QQQ_1m:0},{SPX_1m:-1,QQQ_1m:4}];
  assert.equal(groupCounts(rows).SPX_1m,2); assert.equal(groupCounts(rows).QQQ_1m,2);
  assert.equal(groupMedians(rows).SPX_1m,0.5); assert.equal(groupMedians(rows).QQQ_1m,2);
  assert.equal(groupCounts([{SPX_1m:NaN}]).SPX_1m,1); // Preserve existing policy, not a finite-value gate.
});

test('A retains strict >50 and >365 days without inventing a crossing rule', () => {
  const rows=[{date:'2024-01-01',yoy:50},{date:'2024-02-01',yoy:51},{date:'2025-01-31',yoy:60},{date:'2025-02-01',yoy:60}];
  assert.deepEqual(detectSignalA(rows).map(r=>r.date),['2024-02-01','2025-02-01']);
});

test('B retains clipped left edge, ties, future-six observations and no calendar-month substitution', () => {
  const rows=Array.from({length:9},(_,i)=>({date:`${2020+i}-01-01`,yoy:i<2?40:30}));
  assert.deepEqual(detectSignalB(rows).map(r=>r.date),['2020-01-01','2021-01-01']);
  assert.deepEqual(detectSignalB(rows.slice(0,6)),[]);
  assert.deepEqual(detectSignalB(rows.map(r=>({...r,yoy:30}))),[]);
});

test('event-study n is counted separately at every observation; partial paths are retained', () => {
  const series=prices('2025-01-31',22);
  const result=buildEventStudyPure('QQQ',{qqqDaily:series,spxDaily:[],sigBDates:['2025-01-01','2025-02-01']});
  // The February event can anchor to the stale last prior observation, as in HEAD.
  assert.equal(result.n,2);
  assert.equal(result.counts[0],2); assert.equal(result.counts[1],1); assert.equal(result.counts[21],1); assert.equal(result.counts[22],0);
  assert.equal(result.meanArr[0],100); assert.equal(result.meanArr[21],121); assert.equal(result.meanArr[22],null);
  assert.equal(result.p25Arr[21],121); assert.equal(result.p75Arr[21],121); assert.equal(result.counts.length,253);
});

test('existing raw arithmetic, flat/negative price behavior and rounding are unchanged', () => {
  const s=[{date:'2024-01-01',close:100},{date:'2024-01-02',close:0},{date:'2024-01-03',close:-50},{date:'2024-01-04',close:100}];
  assert.equal(fwdRet(s,0,1),-100); assert.equal(fwdRet(s,0,2),-150); assert.equal(fwdRet(s,0,3),0);
  assert.equal(fwdRet(s,2,1),-300); assert.equal(fwdRet(s,1,1),-Infinity);
  assert.equal(fwdRet(s,-1,1),null); assert.equal(fwdRet(s,3,1),null);
  assert.equal(fwdRet([{close:3},{close:4}],0,1),33.33);
});
