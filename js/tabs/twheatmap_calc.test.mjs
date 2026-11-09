import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRows } from './twheatmap_calc.mjs';

test('等權平均、缺行情不當 0%、依漲跌排序', () => {
  const c = groupRows([['1', 'a', '半導體', 2], ['2', 'b', '半導體', 4], ['3', 'c', '半導體', null], ['4', 'd', '光電', -1], ['5', 'e', '金融保險', 1], ['6', 'f', '新產業', 0]]);
  const tech = c.find(x => x.id === 'tech');
  assert.equal(tech.groups[0].name, '半導體');
  assert.equal(tech.groups[0].avg, 3);
  assert.equal(tech.groups[0].total, 3);
  assert.equal(tech.groups[0].stocks.length, 2);
  assert.equal(tech.groups[1].name, '光電');
  assert.equal(tech.n, 4);
  assert.ok(c.some(x => x.id === 'other'));
});
