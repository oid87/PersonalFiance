import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { NAV_ITEMS } from '../navigation-catalog.mjs';
import { ALERT_CARDS, THEME_CARDS } from '../tabs/overview_calc.mjs';

const ids = new Set(NAV_ITEMS.map(item => item.id));

test('overview cards link to existing screens and cover both markets', () => {
  assert.equal(ALERT_CARDS.length, 3);
  for (const card of ALERT_CARDS) {
    assert.ok(ids.has(card.tab), card.title);
    assert.equal(typeof card.load, 'function', card.title);
  }
  assert.deepEqual(THEME_CARDS.map(card => card.title), ['位階與估值', '情緒與部位', '籌碼與融資', '壓力與波動', '總經', '流動性與利率']);
  for (const card of THEME_CARDS) {
    for (const market of ['us', 'tw']) {
      assert.ok(ids.has(card.tab[market]), `${card.title} ${market}`);
      assert.ok(card.go[market], `${card.title} ${market}`);
      assert.ok(card.rows[market].length >= 1, `${card.title} ${market}`);
      for (const row of card.rows[market]) assert.equal(typeof row.load, 'function', row.label);
    }
  }
});

test('every detail page the overview reuses exports overviewSummary', async () => {
  // Static check only: the tab modules need a browser to run, so read their source.
  const { readFileSync } = await import('node:fs');
  for (const file of ['nonnormal', 'uscap', 'marginalert', 'marginpeak', 'fsi', 'twstress', 'usmacro', 'net_liquidity', 'yield_curve']) {
    const path = new URL(`../tabs/${file}.js`, import.meta.url);
    assert.ok(existsSync(path), file);
    assert.match(readFileSync(path, 'utf8'), /export async function overviewSummary\(/, file);
  }
});
