import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventsOf, latestStatus, filterEvents, evidenceLabel } from './tsi_calc.mjs';

const J = JSON.parse(readFileSync(new URL('../../data/tsi_weekly.json', import.meta.url)));
const rows = J.data;

test('F1 與 F2 買進事件完全相同，F2 續亮只是 STATE', () => {
  const f1 = eventsOf(rows, 'F1'), f2 = eventsOf(rows, 'F2');
  const b1 = f1.filter(e => e.kind === 'buy').map(e => e.week), b2 = f2.filter(e => e.kind === 'buy').map(e => e.week);
  assert.deepEqual(b1, b2);
  assert.equal(b1.length, 49);
  assert.equal(f1.filter(e => e.kind === 'cont').length, 0);
  const c = f2.filter(e => e.kind === 'cont');
  assert.equal(c.length, 26);
  assert.ok(c.every(e => e.type === 'STATE'));
  assert.equal(f2.filter(e => e.type === 'EVENT').length, f1.filter(e => e.type === 'EVENT').length);
});

test('歷史範圍與錨點', () => {
  assert.equal(rows[0].week, '1999-03-15');
  assert.equal(J.last_complete_week >= '2026-11-09', true);
  const w = Object.fromEntries(rows.map(r => [r.week, r]));
  assert.ok(w['2026-11-09'].purple);
  assert.equal(evidenceLabel(w['2026-11-09']), 'PROVISIONAL_MATCH');
  assert.ok(w['2026-10-12'].sell);
  assert.equal(w['2026-10-12'].author_detail.sample, 'IN_SAMPLE');
  assert.ok(!w['2026-10-05'].sell);
  assert.equal(evidenceLabel(w['2026-10-05']), 'UNKNOWN');
  assert.equal(evidenceLabel({}), 'UNKNOWN');
});

test('篩選與最新狀態', () => {
  const ev = eventsOf(rows, 'F2');
  assert.ok(filterEvents(ev, 'sell', 'p2020').every(e => e.kind === 'sell' && e.week >= '2020'));
  const s = latestStatus(rows);
  assert.equal(s.row.week, J.last_complete_week);
  assert.equal(s.lastPurple <= s.row.week, true);
});

test('stale data warning threshold', async () => {
  const { staleDays } = await import('./tsi_calc.mjs');
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.ok(staleDays('2026-11-13T22:00:00Z', now) < 4);
  assert.ok(staleDays('2026-11-08T22:00:00Z', now) > 4);
  assert.equal(staleDays('', now), Infinity);
});
