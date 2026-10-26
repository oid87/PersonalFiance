// zoomFloor — 全站 dataZoom 最短 1 年。
import assert from 'node:assert/strict';
import test from 'node:test';

const { MIN_ZOOM_DAYS, minSpanForAxis, withZoomFloor, installZoomFloor } = await import('./zoomFloor.js');

const daily = (start, n) => { const out = []; let t = Date.parse(start); while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86400000; } return out; };

test('time axis → 365 days in ms', () => {
  assert.equal(minSpanForAxis({ type: 'time' }), MIN_ZOOM_DAYS * 86400000);
});

test('date-string category axis → bars per year from the data density (daily, weekly, monthly)', () => {
  const d = daily('2020-01-01', 1500);
  const span = minSpanForAxis({ type: 'category', data: d });
  assert.ok(span >= 255 && span <= 265, String(span));
  const weekly = Array.from({ length: 300 }, (_, i) => new Date(Date.parse('2015-01-02') + i * 7 * 86400000).toISOString().slice(0, 10));
  assert.equal(minSpanForAxis({ data: weekly }), 53);
  const monthly = Array.from({ length: 120 }, (_, i) => `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  assert.equal(minSpanForAxis({ type: 'category', data: monthly }), 12);
  assert.equal(minSpanForAxis({ type: 'category', data: d.map(value => ({ value })) }), span, '{value} items read like plain strings');
});

test('mixed density (sparse early, dense late) uses the densest year, not the average', () => {
  const quarterly = Array.from({ length: 200 }, (_, i) => `${1960 + Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, '0')}`);
  const monthly = Array.from({ length: 240 }, (_, i) => `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  assert.equal(minSpanForAxis({ type: 'category', data: [...quarterly, ...monthly] }), 12);
});

test('non-date axes are left alone', () => {
  assert.equal(minSpanForAxis({ type: 'value' }), null);
  assert.equal(minSpanForAxis({ type: 'category', data: ['AAPL', 'MSFT', 'NVDA', 'TSLA'] }), null);
  assert.equal(minSpanForAxis({ type: 'category', data: [2001, 2002, 2003, 2004] }), null);
  assert.equal(minSpanForAxis({ type: 'log' }), null);
});

test('withZoomFloor adds minValueSpan to x-axis zooms only, keeps explicit minimums, does not mutate the input', () => {
  const opt = { xAxis: [{ type: 'time' }, { type: 'category', data: ['a', 'b', 'c'] }],
    dataZoom: [{ type: 'inside' }, { type: 'slider', xAxisIndex: [1] }, { type: 'slider', yAxisIndex: 0 }, { type: 'inside', minSpan: 5 }] };
  const out = withZoomFloor(opt);
  assert.notEqual(out, opt);
  assert.equal(out.dataZoom[0].minValueSpan, MIN_ZOOM_DAYS * 86400000);
  assert.equal(out.dataZoom[1].minValueSpan, undefined, 'category axis without dates');
  assert.equal(out.dataZoom[2].minValueSpan, undefined, 'y-axis zoom');
  assert.equal(out.dataZoom[3].minValueSpan, undefined, 'explicit minSpan wins');
  assert.equal(opt.dataZoom[0].minValueSpan, undefined, 'input untouched');
  const plain = { series: [] };
  assert.equal(withZoomFloor(plain), plain, 'no dataZoom → returned as is');
});

test('withZoomFloor reads the current xAxis for partial updates that carry only dataZoom', () => {
  const out = withZoomFloor({ dataZoom: { type: 'slider' } }, () => ({ xAxis: [{ type: 'category', data: daily('2022-01-03', 400) }] }));
  assert.ok(out.dataZoom[0].minValueSpan > 100);
});

test('installZoomFloor wraps init once and routes setOption through the floor', () => {
  const calls = [];
  const fake = { init: () => ({ setOption(o) { calls.push(o); }, getOption: () => ({}) }) };
  assert.equal(installZoomFloor(fake), true);
  assert.equal(installZoomFloor(fake), false);
  fake.init().setOption({ xAxis: { type: 'time' }, dataZoom: [{ type: 'slider' }] });
  assert.equal(calls[0].dataZoom[0].minValueSpan, MIN_ZOOM_DAYS * 86400000);
});

test("xAxisIndex 'all' and arrays use the first date axis", () => {
  const axes = [{ type: 'value' }, { type: 'category', data: daily('2020-01-01', 800) }];
  const out = withZoomFloor({ xAxis: axes, dataZoom: [{ type: 'inside', xAxisIndex: 'all' }, { type: 'slider', xAxisIndex: [0, 1] }] });
  assert.ok(out.dataZoom[0].minValueSpan > 250, 'all');
  assert.equal(out.dataZoom[1].minValueSpan, out.dataZoom[0].minValueSpan, 'array');
});

test('an xAxis-only merge update recomputes the floor this module set (weekly → daily)', () => {
  const weekly = Array.from({ length: 300 }, (_, i) => new Date(Date.parse('2015-01-02') + i * 7 * 86400000).toISOString().slice(0, 10));
  const owned = new Set();
  const first = withZoomFloor({ xAxis: { type: 'category', data: weekly }, dataZoom: [{ type: 'slider' }, { type: 'inside', minValueSpan: 3 }] }, undefined, undefined, owned);
  assert.equal(first.dataZoom[0].minValueSpan, 53);
  assert.deepEqual([...owned], [0]);
  const current = () => ({ dataZoom: [{ type: 'slider', xAxisIndex: [0], minValueSpan: 53 }, { type: 'inside', xAxisIndex: [0], minValueSpan: 3 }] });
  const next = withZoomFloor({ xAxis: { data: daily('2015-01-02', 1500) } }, current, undefined, owned);
  assert.ok(next.dataZoom[0].minValueSpan > 250, String(next.dataZoom[0].minValueSpan));
  assert.deepEqual(next.dataZoom[1], {}, "tab's own minimum is left alone");
  const label = { xAxis: { axisLabel: { interval: 3 } } };
  assert.equal(withZoomFloor(label, () => { throw new Error('getOption not needed'); }, undefined, owned), label);
});
