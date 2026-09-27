import test from 'node:test';
import assert from 'node:assert/strict';
import { needsUsMacroRefresh } from './usmacro.js';

const ms = value => Date.parse(value);

test('refresh crosses Taipei Tue–Sat 06:00 only at the exact scheduled instant', () => {
  const asOf = '2026-09-28T21:59:00Z'; // Tuesday 05:59 Taipei.
  assert.equal(needsUsMacroRefresh(asOf, ms('2026-09-28T21:59:59Z')), false);
  assert.equal(needsUsMacroRefresh(asOf, ms('2026-09-28T22:00:00Z')), true);
  assert.equal(needsUsMacroRefresh('2026-09-28T22:00:00Z', ms('2026-09-28T22:00:00Z')), false);
  assert.equal(needsUsMacroRefresh('2026-09-29T21:59:00Z', ms('2026-09-29T22:00:00Z')), true);
  assert.equal(needsUsMacroRefresh('2026-10-02T21:59:00Z', ms('2026-10-02T22:00:00Z')), true); // Saturday.
});

test('Sunday and Monday have no scheduled refresh point', () => {
  assert.equal(needsUsMacroRefresh('2026-09-26T22:01:00Z', ms('2026-09-28T21:59:00Z')), true); // >36h.
  assert.equal(needsUsMacroRefresh('2026-09-27T00:00:00Z', ms('2026-09-28T00:00:00Z')), false);
  assert.equal(needsUsMacroRefresh('2026-09-27T10:00:00Z', ms('2026-09-28T10:00:00Z')), false);
});

test('36 hours is inclusive; refresh starts one millisecond later', () => {
  const asOf = '2026-09-26T11:00:00Z'; // Saturday 19:00 Taipei.
  assert.equal(needsUsMacroRefresh(asOf, ms('2026-09-27T23:00:00Z')), false);
  assert.equal(needsUsMacroRefresh(asOf, ms('2026-09-27T23:00:00.001Z')), true);
});
