import test from 'node:test';
import assert from 'node:assert/strict';
import { tooltipPosition } from '../utils/tooltip.js';

test('tooltip stays inside the viewport at left and right edges', () => {
  const size = { width: 200, height: 40 };
  const viewport = { width: 320, height: 568 };
  assert.deepEqual(tooltipPosition({ left: 0, right: 30, top: 200, bottom: 220, width: 30 }, size, viewport),
    { left: 8, top: 152 });
  assert.deepEqual(tooltipPosition({ left: 300, right: 320, top: 200, bottom: 220, width: 20 }, size, viewport),
    { left: 112, top: 152 });
});

test('tooltip moves below a top-edge target and hides outside the viewport', () => {
  const size = { width: 180, height: 60 };
  const viewport = { width: 320, height: 568 };
  assert.deepEqual(tooltipPosition({ left: 40, right: 90, top: 6, bottom: 28, width: 50 }, size, viewport),
    { left: 8, top: 36 });
  assert.equal(tooltipPosition({ left: 40, right: 90, top: 600, bottom: 620, width: 50 }, size, viewport), null);
});
