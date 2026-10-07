// Summary adapter used by the standalone tools workspace.
// Financial formulas are the existing leverage.js cards and leverage_calc.mjs.
import { buildBacktestPure, maxDrawdown, longestUnderwater,
  drawdownEpisodes } from './leverage_calc.mjs';
import { computeVolatilityPair } from './levvol_calc.mjs';

export function summarizeBacktest(result) {
  if (!result) return null;
  const leveragedValue = result.levVal[result.levVal.length - 1];
  const underlyingValue = result.oneVal[result.oneVal.length - 1];
  return {
    contributed: result.contributed,
    leveragedValue,
    underlyingValue,
    leveragedReturn: leveragedValue / result.contributed - 1,
    underlyingReturn: underlyingValue / result.contributed - 1,
    maxDrawdown: maxDrawdown(result.levNav),
    longestUnderwaterDays: longestUnderwater(result.dates, result.levNav),
    recoveredContribution: leveragedValue >= result.contributed,
    leveragedEpisodes: drawdownEpisodes(result.dates, result.levNav),
    underlyingEpisodes: drawdownEpisodes(result.dates, result.oneNav),
    startDate: result.actualStart,
    endDate: result.lastDate,
    observationCount: result.dates.length,
    syntheticDays: result.synthDays,
    synthetic: result.synthetic,
    annualCost: result.annualCost,
    inception: result.inc,
  };
}

export function buildLeverageDiagnostics(bundle, settings) {
  const etf = bundle.etfs.find(item => item.id === settings.etf);
  if (!etf) return null;
  const underlying = bundle.underlyings[etf.underlying];
  return {
    id: etf.id,
    name: etf.zh,
    underlying: etf.underlying,
    underlyingName: underlying?.name,
    underlyingPriceOnly: underlying?.priceOnly === true,
    theoreticalLeverage: etf.leverage,
    updated: bundle.updated,
    backtest: summarizeBacktest(buildBacktestPure(bundle, settings)),
    // levvol uses full overlapping real history, independently of settings dates.
    volatility: computeVolatilityPair(bundle, etf),
  };
}
