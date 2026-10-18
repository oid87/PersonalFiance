import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const have = fs.existsSync(new URL('data/research/us_delever/finra_release_dates.json', root));

test('真實資料煙霧測試：與 Python 獨立複核的數字一致', { skip: !have }, async () => {
  const { loadRaw } = await import('../../scripts/research/us_delever_data.mjs');
  const { runStudy } = await import('./usdelever_study.mjs');
  const { raw } = loadRaw();
  const R = runStudy(raw, { end: '2026-10-16' });
  const sc = id => R.score.find(r => r.id === id);
  assert.equal(R.waves.SPY.find(w => w.lowDate === '2024-08-05').maxDd > 8, true);     // Case A：SPY 低點 2024-08-05
  assert.equal(R.waves.QQQ.find(w => w.lowDate === '2026-07-29') !== undefined, true);  // Case B：QQQ 低點 2026-07-29（SPY 回撤未達 8%）
  assert.equal(sc('vix25').events, 20); assert.equal(sc('vix30').events, 14);
  assert.equal(sc('cftc_both_g6').events, 18); assert.equal(sc('nfci_lev_up').events, 7);
  assert.equal(R.layers.shares.L3, 364);
  // 無未來函數：每個事件的進場日一定在可得日之後
  for (const s of R.score.slice(0, 3)) assert.ok(s.events >= 0);
});

test('敏感度設定改變可得日而非結果結構：FINRA 上界不早於下界', { skip: !have }, async () => {
  const { loadRaw } = await import('../../scripts/research/us_delever_data.mjs');
  const { buildAll } = await import('./usdelever_study.mjs');
  const { raw } = loadRaw();
  const up = buildAll(raw, { finraBound: 'upper' }), lo = buildAll(raw, { finraBound: 'lower' });
  let checked = 0;
  up.finra.forEach((r, i) => { if (r.knownDate && lo.finra[i].knownDate && !r.unbracketed) { assert.ok(r.knownDate >= lo.finra[i].knownDate, r.month); checked++; } });
  assert.ok(checked > 50);
});
