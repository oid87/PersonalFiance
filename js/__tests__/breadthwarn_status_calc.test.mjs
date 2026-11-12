import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, missedEvenings } from '../tabs/breadthwarn_status_calc.mjs';

const row = (o = {}) => ({ key: 'k', name: '來源', src: 's', cadence: 'c', latest: '2026-11-12', seen: '2026-11-12T10:00:00Z', backfill: true, state: 'ok', cause: null, lag: 0, gaps: [], alert: false, ...o });
const T = s => Date.parse(s);

test('平日晚間更新次數：跨週末不算，同一天還沒到 21:30 不算', () => {
  assert.equal(missedEvenings(T('2026-11-13T14:00:00Z'), T('2026-11-16T12:00:00Z')), 0);   // 週五 22:00 → 週一 20:00（臺北）
  assert.equal(missedEvenings(T('2026-11-13T14:00:00Z'), T('2026-11-16T14:00:00Z')), 1);
  assert.equal(missedEvenings(T('2026-11-10T14:00:00Z'), T('2026-11-12T14:00:00Z')), 2);
});

test('全部最新；等待公布與休市不算失敗', () => {
  const s = summarize({ generated: '2026-11-12T12:00:00Z', rows: [row(), row({ state: 'waiting' })] }, T('2026-11-12T13:00:00Z'));
  assert.equal(s.level, 0); assert.match(s.head, /都是目前可取得的最新資料/); assert.ok(s.rows.every(r => r.current));
  const c = summarize({ generated: '2026-11-12T12:00:00Z', rows: [row({ state: 'closed' })] }, T('2026-11-12T13:00:00Z'));
  assert.equal(c.level, 1); assert.match(c.rows[0].label, /休市/); assert.doesNotMatch(c.head, /需要處理/);
});

test('落後與失敗會點名；不可回補的來源另外警告；缺漏列出來', () => {
  const s = summarize({ generated: '2026-11-12T12:00:00Z', rows: [row(), row({ name: '盤中統計', state: 'behind', lag: 1, cause: 'source', alert: true, backfill: false, gaps: ['2026-11-11'] }), row({ name: '指數', state: 'failed', cause: 'format', alert: true })] }, T('2026-11-12T13:00:00Z'));
  assert.equal(s.level, 2); assert.match(s.head, /3 個資料來源裡有 2 個需要處理：盤中統計、指數/);
  assert.equal(s.rows[1].label, '落後 1 個交易日'); assert.match(s.rows[1].why, /永久缺漏/); assert.deepEqual(s.rows[1].gaps, ['2026-11-11']);
  assert.equal(s.rows[1].current, false); assert.match(s.rows[2].why, /格式改了/);
  const g = summarize({ generated: '2026-11-12T12:00:00Z', rows: [row({ gaps: ['2026-11-11'] })] }, T('2026-11-12T13:00:00Z'));
  assert.equal(g.level, 1);                                  // 已是最新但中間有缺：留意，不是失敗
});

test('排程有跑不等於資料最新：狀態檔本身停了要蓋過各列的「最新」', () => {
  const doc = { generated: '2026-11-09T12:00:00Z', rows: [row()] };
  assert.equal(summarize(doc, T('2026-11-10T08:00:00Z')).stalled, false);
  const s = summarize(doc, T('2026-11-12T08:00:00Z'));
  assert.equal(s.stalled, true); assert.equal(s.level, 2); assert.match(s.head, /沒有更新/);
  assert.equal(summarize(null, 0), null); assert.equal(summarize({ rows: [] }, 0), null);
});
