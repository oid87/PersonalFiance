# Stressdash missing indicators

NFCI and the existing SPY / QQQ / SOXX price sources are required. Their load failures continue to use the shared tab dispatcher error and whole-page retry. STLFSI4 and KCFSI share an optional `data/stlfsi_kcfsi.json` source.

A successful JSON load with a valid `data` array can have no observations for either auxiliary indicator, including an empty array. Nullable or omitted auxiliary fields retain the existing `—` cards and empty chart series. A finite numeric zero is an observation and keeps the existing zero threshold and formatting; missing data is never converted to zero. Present values must be finite numbers, and row dates must be valid ISO calendar dates. Malformed values are a source load failure, rather than silently becoming missing observations.

An optional request, JSON parse, or payload load failure keeps NFCI, prices and their history visible. Both auxiliary cards display `Unavailable` with neutral explanatory text, their chart series remain empty, and the status names the unavailable source. A native chip-style button retries only this optional source through the existing request cache API. Failure remains retryable; success restores the auxiliary indicators or their ordinary no-observation state. No auxiliary stress assessment is made while the source is unavailable.

The local retry disables duplicate attempts and preserves the current chart zoom and legend state. Completion from an interrupted or superseded attempt cannot replace current data. Re-entering the route keeps the required data and permits a new explicit optional retry; it does not automatically reload successful required sources. Required activation failures retain the existing dispatcher retry behavior.

Normal-data formulas, thresholds, backward date alignment, moving averages, cards, table and chart options are unchanged. The uncommitted all-three-finite gate is not part of this contract. This policy applies only to stressdash.

Offline targeted tests:

```sh
node --test js/__tests__/stressdash.test.mjs
```

With the existing Playwright and Chromium runtime, the scoped browser probe reuses the repository preview server, fixes the date and runs desktop / 390px cases. It never updates market files:

```sh
node scripts/test_stressdash_browser.cjs --output /tmp/stressdash-qa-new
```

Use `--mode baseline --root <frozen-before-tree>` to capture normal-data snapshots, run the baseline twice to establish stability, and pass `--baseline <snapshots.json>` to the candidate run for full chart/card/table comparisons. Output directories must be new. Reports distinguish explicitly injected failures from unexpected console errors, warnings, page errors and HTTP identity failures. Browser coverage is Chromium emulation; it does not certify Safari, real touch, screen readers or native IME.
