# Trend FPE endpoint display

The trend overlay reads `data/QQQ_valuation.json`. It uses the page-specific
[`interpFpe`](../js/tabs/trend_calc.mjs) calculation; the separate forward P/E
JSONL pipeline is not its source.

Product Sprint 1 defines input numeric `0` as a missing endpoint. Null, omitted
FPE, nonfinite numbers and malformed/non-number values are also missing.
Missing values never participate in interpolation arithmetic. An interval with
either endpoint missing has null interior values, while actual valid endpoint
observations remain visible. ECharts uses `connectNulls:false`; a gap hover must
not display a fabricated FPE value.

Finite negative endpoints retain existing behavior. This change introduces no
new sign policy: interpolation between two finite nonzero endpoints keeps the
original arithmetic, UTC calendar dates and three-decimal rounding, including
any zero crossing between negative and positive endpoints. The final observation
retains its original numeric precision. It does not turn calculated values into
new input endpoints.

Interpolation between distant valid endpoints remains unchanged. A maximum-gap
policy requires a separate product decision. No data file, source method,
provenance, fixed MA200 signal or strategy is changed by this display contract.

Verification: [`trend_fpe_endpoints.test.mjs`](../js/__tests__/trend_fpe_endpoints.test.mjs)
and `npm run test:browser` exercise calculation, actual rendered polyline gaps,
hover, non-FPE/all-MA regressions and desktop/390px chart interactions. Browser
fixtures are served in memory; production market JSON is never rewritten.
