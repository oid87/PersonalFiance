import assert from 'node:assert/strict';
import test from 'node:test';
import { captureChartState, restoreChartState, preserveChartState, resizeVisibleCharts } from '../utils/chartLifecycle.js';

function chart(host, option) {
  return {
    option,
    actions: [],
    getDom() { return host; },
    getOption() { return this.option; },
    dispatchAction(action) { this.actions.push(action); },
  };
}

test('restores zoom percent/value and legend selection by id without replacing series', async () => {
  const host = {};
  let current = chart(host, {
    dataZoom: [{ id: 'date', start: 20, end: 80, startValue: '2020-01-01', endValue: '2024-01-01' }],
    legend: [{ id: 'main', selected: { A: false, B: true } }], series: [{ name: 'A', data: [1, 2] }],
  });
  const saved = captureChartState(current);
  await preserveChartState(() => [current], () => {
    current = chart(host, {
      dataZoom: [{ id: 'date', start: 0, end: 100 }],
      legend: [{ id: 'main', selected: { A: true, B: true } }], series: [{ name: 'A', data: [1, 2] }],
    });
  });
  assert.deepEqual(current.actions, [
    { type: 'dataZoom', dataZoomIndex: 0, start: 20, end: 80, startValue: '2020-01-01', endValue: '2024-01-01' },
    { type: 'legendUnSelect', legendIndex: 0, name: 'A' },
    { type: 'legendSelect', legendIndex: 0, name: 'B' },
  ]);
  assert.deepEqual(current.option.series, [{ name: 'A', data: [1, 2] }]);
  restoreChartState(current, saved);
});

test('resizes only charts whose visible host dimensions differ', () => {
  const host = { clientWidth: 390, clientHeight: 420 };
  const section = { hidden: true, contains: candidate => candidate === host };
  let width = 0, height = 0, calls = 0;
  const instance = {
    getDom: () => host, getWidth: () => width, getHeight: () => height,
    resize() { width = host.clientWidth; height = host.clientHeight; calls++; },
  };
  resizeVisibleCharts(() => [instance], section);
  assert.equal(calls, 0);
  section.hidden = false;
  resizeVisibleCharts(() => [instance], section);
  resizeVisibleCharts(() => [instance], section);
  assert.deepEqual([width, height, calls], [390, 420, 1]);
  host.clientWidth = 844;
  resizeVisibleCharts(() => [instance], section);
  assert.deepEqual([width, height, calls], [844, 420, 2]);
});
