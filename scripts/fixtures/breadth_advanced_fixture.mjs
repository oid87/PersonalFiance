/** Deterministic local test input. Not historical market observations. */
export function makeAdvancedFixture() {
  const dates = [];
  const cursor = new Date('2018-01-01T00:00:00Z');
  while (dates.length < 1250) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const source = 'SYNTHETIC TEST ONLY — deterministic fixture';
  const common = { source, constituentsBasis: 'SYNTHETIC TEST ONLY, no real constituents', priceBasis: 'SYNTHETIC TEST ONLY' };
  return {
    schemaVersion: 1,
    benchmark: { symbol: 'SP500', source, priceBasis: common.priceBasis,
      data: dates.map((date, i) => ({ date, close: 1000 + i * 0.4 + Math.sin(i / 17) * 25 })) },
    sp500: { ...common, universe: 'SP500',
      data: dates.map((date, i) => ({ date, advances: [523, 1129].includes(i) ? 0 : 251,
        declines: [523, 1129].includes(i) ? 500 : 250, unchanged: 0 })) },
    nyse: { ...common, universe: 'NYSE', variant: 'ratio',
      seed: { date: '2017-12-29', ema19: 0, ema39: 0, summation: 0, source, calibration: 'provider' },
      data: dates.map((date, i) => ({ date, advances: (i >= 520 && i < 540) || (i >= 1120 && i < 1140) ? 0 : 1000,
        declines: (i >= 520 && i < 540) || (i >= 1120 && i < 1140) ? 2000 : 1000, unchanged: 0 })) }
  };
}
