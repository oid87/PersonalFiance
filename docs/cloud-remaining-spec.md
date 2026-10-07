# Cloud integrated tools scope — 2026-10-07

Repository `/workspace/PersonalFiance`; exact origin
`https://github.com/oid87/PersonalFiance.git`; branch `work`; HEAD
`7904738cc8fef78ae7b9dd64d3deed9e654fd9f1`; tree
`cf57159c4c9c4cb67423b8263dfc1206e354d7de`.
This is the direct 100-data-file-only successor of accepted baseline
`63ecab26f76ba2ad4e7df864241247a8ab936747`.
The first isolated 14-file candidate and its QA archives are preserved separately.
This revision follows the user's later authorization to finish safe user-operable
Cloud tools without waiting for the exact local 22-file candidate.

## Product and implementation boundary

[tools.html](../tools.html) is a separate in-repo entry, reachable by one new link
in the existing dashboard tools section. It does not change the 72-page catalogue,
boot, navigation, global state, data, dependencies, environment configuration or
financial rules. Standalone CSS uses existing-style theme tokens. There is no CDN
request on the tools page, no provider fallback and no new financial dataset.

| User task | Operable flow | Boundary |
| --- | --- | --- |
| Grouped ticker watchlists | Create/rename/delete groups; add/remove known ticker keys; select a local price file with newest close/date and source link; browser persistence | Distinct from page favorites and holdings; only existing catalogue files; malformed/future/unknown stored content remains untouched and edits remain session-only |
| Existing leverage diagnostics | Select ETF, dates, initial contribution and original monthly-DCA settings; view original value/contribution return, NAV drawdown, calendar underwater duration, recovery and worst episodes plus full-history volatility | Reuses existing pure backtest engine and a single shared production volatility calculator; sample periods/basis/synthetic coverage labeled separately |
| Monthly heatmap | Paste previously calculated JSON; render a responsive native table with per-month raw-value/endpoints details; malformed input retry, clear and explicitly labeled synthetic demo | No daily-to-monthly conversion, inferred partial flags, interpolation, aggregate statistics or financial thresholds |
| Macro calendar assessment | Unavailable reason, zero events and official manual references | No hidden collector, scheduled feed, fabricated events, consensus or actuals |
| Local finance assistant | Final source-backed proposal and read-only local adapter contract | Specification only, no runtime/model/API/bridge installed |
| Taiwan observations (subsequent owner authorization) | One table of existing TAIEX, listed long-margin maintenance proxy, listed margin debt and monthly period-end M1B/M2 YoY plus stored M1B−M2 spread; independent dates, missing status and local retry | No official whole-account/MM listed+OTC relabel, monthly fill, new financial rule, event-study peak policy or market acquisition |

## Acceptance for independent QA

1. Exact origin/HEAD/tree before and after; unstaged tracked modifications limited
   to `index.html`, `js/tabs/levvol.js`, its legacy VM lifecycle test and the dated
   CURRENT_STATE append. Untracked old candidate is preserved/advanced, not removed.
   No staged, data, dependency, environment, shipping or unrelated changes.
2. Dashboard link is one line in tools section. Main catalogue remains 72.
   New HTML imports the actual controller; no unreachable-only scaffold claim.
3. Watchlists contain IDs/names/unique approved ticker keys only; no holdings,
   balances or credentials. Read never writes. Storage failure is user-visible;
   edits and page-resume retain in-memory state. User strings use text nodes.
4. Known price selection requests same-origin committed files only. Empty/malformed
   local data shows unavailable and explicit retry; no new return calculation.
5. Leverage original cards/episode semantics match the original engine. Volatility
   shared calculator equals the frozen exact helpers from committed 7904738 for
   normal/missing-date/flat/invalid-price fixtures, preserving 256/257 admission,
   positive-price filtering, population deviation, windows and percentiles.
   No silent repair of inherited invalid-price alignment.
6. Selected backtest and full-overlap-real-history volatility have separate labels.
   TWII price-only and inherited adjusted/total-return basis are explicit; synthetic
   day count is the engine's count, not guessed from inception date.
7. Heatmap requires schemaVersion/kind/source/basis/calculationLabel; supplied rows
   require month/returnPct/partial. Missing vs explicit null vs zero stay distinct;
   raw input value survives display rounding. Synthetic demo is labeled and is
   never offered as market results. Nothing imported is persisted or published.
8. Load retry, current-result guards, aborted/stale-response suppression, owned
   listener cleanup and page-resume state have meaningful targeted tests. Actual
   browser interactions, theme, mobile landscape/short height, focus and real
   served-file identity require browser evidence; Node tests cannot prove these.
9. Macro status contains no future events; existing historical CPI/corporate dates
   are not recast as a complete macro feed. References distinguish documentation
   from source acquisition and authorization.
10. Read-only local LLM contract keeps deterministic facts/rules outside the model;
    numeric/source grounding and unavailable fallback are specified, not claimed
    implemented. Mac hardware remains unverified.
11. Taiwan panel uses only the four existing files documented in
    [source/method notes](references/taiwan-observations.md). It preserves current
    missing values, zero, per-source dates/save stamps, monthly-only period-end
    basis and the owner-confirmed M1B−M2 direction. Stored spread is verified but
    never generated. One failed source leaves the other rows available; explicit
    retry, superseded/aborted results and page cleanup follow existing tools guards.
    No −30 threshold, 2× model, acceleration metric or washout-completion claim.

## Shared-file reconciliation

Only the integration owner modifies shared files. The review package includes
`shared-integration.patch`, exact original hashes and full source manifests.
`index.html` adds one anchor in `tab-tools`. `levvol.js` imports WINDOWS,
WINDOW_LABEL and computeVolatilityPair, replacing internal helper functions with
one wrapper. The lifecycle VM test injects those imports. CURRENT_STATE appends
this dated candidate status; existing historical entries remain unchanged.

Before applying to a local tree, verify target hashes and inspect actual overlap;
never overwrite WIP, reset/stash/clean, or reconstruct missing local code from prose.
Local baseline 63ecab26 and Cloud HEAD have identical tracked non-data source before
this candidate, but pending exact local patches may touch shared files. That
reconciliation is still pending; the separate tools UI can be reviewed now.

## Dependencies / stop conditions

Await exact Taiwan overview (8 public files), ETF patch (9 public files), private
ETF archive (5 files) and local QA evidence. None is present here yet. Never ask
for or transfer the excluded original local WIP repo. Private ETF material stays
outside public repository/site/artifacts. SEC 403 and Taiwan issuer rights remain
BLOCKED; no new acquisition. Monthly live-price methodology and future macro
feed remain owner decisions, not engineering substitutes.

Code is frozen before a separate GPT-6.1 Sol low QA session. It performs targeted
checks, the offline full runner/npm/docs/static review and normal supported browser
checks if runnable. Missing browser is NOT RUN/BLOCKED, not unit-test UI PASS.
Commit, push, deployment and local source integration remain unauthorized/pending.
