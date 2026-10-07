# Remaining dashboard references — 2026-10-07

The in-repo [tools page](../../tools.html) provides grouped ticker watchlists,
existing leverage diagnostics, supplied-period-return heatmap and an unavailable
macro-source status. This is a working UI candidate, not a claim of browser QA or
integration of the pending Taiwan/ETF local patches. See [scope](../cloud-remaining-spec.md)
and [Claude handoff](../../CLAUDE_HANDOFF.md) for source identity and QA handoff.

| Feature | Source authority | Implemented boundary |
| --- | --- | --- |
| Grouped ticker watchlists | [Existing catalogue](../../js/state.js), [symbol state](../../js/utils/grouped_watchlists.mjs), [panel](../../js/utils/grouped_watchlists_panel.mjs) | Create/rename/delete groups, add/remove known tickers, select a local price file, browser persistence with visible fallback; no holdings/provider fallback |
| Leverage backtest summary | [Existing pure engine](../../js/tabs/leverage_calc.mjs), [original cards](../../js/tabs/leverage.js), [adapter](../../js/tabs/leverage_diagnostics.mjs) | ETF/date/contribution controls, original metrics and drawdown episodes, real/synthetic coverage and basis labels |
| Full-history volatility | [Production wrapper](../../js/tabs/levvol.js), [single shared calculator](../../js/tabs/levvol_calc.mjs), [frozen original oracle](../../js/__tests__/fixtures/levvol-legacy-7904738.txt) | Shared runtime calculation with exact legacy-fixture regression; distinct full-history sample labels |
| Monthly-return heatmap | [Presentation model](../../js/tabs/monthly_return_heatmap.mjs), [native table renderer](../../js/tabs/monthly_return_heatmap_panel.mjs) | Actual supplied-JSON presentation, null/missing/zero/partial details, labeled synthetic demo; daily-to-monthly conversion remains pending financial policy |
| Upcoming macro calendar | [Status contract](../../js/utils/macro_calendar_status.mjs), [existing CPI collector](../../scripts/fetch_cpi.py), [source manifest](../../scripts/source_manifest.json) | Explicit unavailable status, zero events, official manual references; no collector or claimed feed |
| Future local finance assistant | [Deployment proposal and read-only contract](local-finance-assistant.md) | Plan only, no model/API/bridge installed |
| Existing chart UX reference | [Vela record](vela.md) | Existing engineering reference; no new upstream source/dependency |

## Monthly returns: unresolved decisions

Existing arithmetic returns are `(current - previous) / previous` (a fraction),
skipping a zero denominator. `toMonthlyLast` selects the last non-null observation
per month without interpolation, counts observations, and marks the current local
calendar month partial. Its own contract excludes partial months from statistics.
Neither primitive independently establishes a monthly-return product convention.

The owner/Claude must resolve these alternatives before connecting price data:

| Decision | Options to confirm; none selected here |
| --- | --- |
| Baseline endpoint | Prior month's final available observation → this month's final observation; or first → last observation within this month |
| First observed month | Unavailable without a prior endpoint; or an explicitly labeled partial period from the first available observation |
| Missing month | Leave unavailable and resume only with appropriate consecutive endpoints; or explicitly show a multi-month period, never mislabel it as one month |
| Current month | Hide until complete; or display explicitly labeled month-to-date, excluded from complete-month statistics |
| Price basis | Existing raw-close price return; or an explicitly supplied existing total-return series, with its distinct source and label |
| Sample completeness | Whether observation coverage alone is sufficient; there is no verified exchange-calendar completeness service |

Sector `1M` is an observation-count offset, election-seasonality paths start at the
first observation within the month, and marginpeak's 1m horizon is +21 price
observations from its anchor. These cannot stand in for a new calendar-month
definition. Do not combine or alter them to make a heatmap appear complete.

The functional presentation heatmap consumes `{ month, returnPct, partial, from?, to? }` already
calculated by a future confirmed adapter. Missing/explicit null/zero are distinct;
no interpolation, compounding, annual summaries or statistics occur. `partial`
is required on supplied rows and is never inferred. The caller must give a
source, basis, calculation label and explicit kind (`supplied` or `synthetic`). The
optional synthetic demonstration contains invented test percentages, is labeled
throughout and is never offered as market returns. Imports remain only in the
current page; no JSON is written to the repository or browser storage.

## Leverage samples and basis

Backtest values retain the original contribution handling, daily-reset synthetic
costs, real-return availability logic, NAV drawdown and calendar-day underwater
duration. Synthetic-day count and inception metadata remain available. A flag
based only on a pre-inception start is not treated as the complete synthetic-day
count; the original engine may synthesize a missing real-return date as well.

Volatility retains the full real ETF/underlying inner join, positive-price log
return filtering, population standard deviation, existing 257-price-observation
admission, and 5/21/63/126/252 windows. Median, mean, p5, p95 and effective `n`
are exposed. Existing handling of invalid-price alignment is preserved, not
silently repaired as part of a summary task.

`fetch_leverage.py` uses adjusted/total-return data; TWII explicitly carries
`priceOnly: true`. The dashboard's raw-close stock files are a different basis.
The panel labels the selected backtest interval and the full-history volatility
interval separately. It does not claim these samples are directly comparable.

## Macro-calendar source assessment

Assessment of existing collectors/data is read-only. Official calendar pages were
read as documentation on 2026-10-07; no release events were collected/imported and
no provider/feed acquisition or rights approval was performed.

- `data/earnings.json` at Cloud HEAD: updated 2026-10-07, 331 rows, all currently
  `type: earnings`, 2020-02-07 through 2026-12-09. The existing UI also accepts
  corporate `conference` events. These are not macroeconomic release events.
- Manifest routes `fetch_earnings.py` through US/local and
  `fetch_investor_conf.py` through TW/local, both optional; do not replace their
  payload with macro events because their UI/schema only permits corporate types.
- `fetch_cpi.py` references
  `https://alfred.stlouisfed.org/release/downloaddates?rid=10&ff=txt`, but
  `fetch_release_dates(today)` keeps dates on/before today and at most the latest
  24, with a frozen fallback. This is a historical overlay, not a verified
  upcoming release feed. Code comments' old availability claims are not new QA.
- Current `data/cpi.json`: updated 2026-10-07, 23 release dates from 2024-08-14
  through 2026-07-14. The update stamp does not prove the release-date list is
  current. The payload does not establish whether the collector used fallback.
- The US macro diagnostic/archive supplies historical indicators and snapshot
  provenance, not a consolidated future-event feed with times/timezones,
  rescheduling status or release values.

Therefore future macro calendar remains **BLOCKED / unavailable**. A later source
assessment must establish authoritative feed, rights, event IDs, scheduled versus
confirmed dates, timezones, revisions and actual/consensus semantics before any
collector or production route. No dates, forecasts or consensus values are
fabricated in this batch.

## Official future-calendar reference assessment

The [BLS calendar](https://www.bls.gov/schedule/) documents Eastern Time and an
upcoming-release ICS subscription. This establishes a candidate reference for
BLS releases, not completeness for all macro events or an implemented ingestion
contract. The [Federal Reserve FOMC calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)
and [BEA release schedule](https://www.bea.gov/news/schedule) are additional official
manual references. None is fetched by the tools page, none supplies a live event
row here, and licensing/revision/coverage/timezone handling remains a later gate.

Proposed future calendar envelope (not an implemented provider interface):
`{schemaVersion:1,status:"available"|"partial"|"unavailable",asOf,sourceIds,events}`.
Each future event must carry an authoritative event/source ID, scheduled UTC and
source timezone, release period, verification timestamp and revision/status;
actual/consensus may be explicit null. Missing consensus cannot become zero.
The current implemented contract is `status:"unavailable", events:[]` plus a
reason and manual reference links. No fabricated event example is stored.
