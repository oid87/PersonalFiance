# Macro optional source and retry

The macro page requires US10Y, US2Y, M2 and CAPE. Its one optional source is BIZ (`data/taiwan_business_signal.json`), used only by the Taiwan business-cycle chart. These roles follow the required loop and the explicit optional catch in `js/tabs/macro.js` at commit `7ea5545e72c8d6cb2e9144aee4e97396357531d7`. An overlay being initially off does not make its source optional. A multiple-optional-source failure scenario does not apply to this page.

When BIZ cannot load, or has empty/invalid rows, its status explicitly says the data is unavailable and the business signal cannot be judged. US curves remain usable. The retry button calls the existing `switchTo('macro')` dispatcher, disables itself while loading, and either restores the business chart/status or offers another retry. Required sources already loaded remain cached. `requestJSON` handles requests/timeouts; failed optional payloads are evicted so retry can recover. Expired activations cannot commit optional rows or finish rendering. Returning to the page uses the existing dispatcher lifecycle. This does not introduce refresh of successful cached sources.

Successful data follows the existing yield spread, inversion zones, M2 growth, CAPE, business-light thresholds, range controls and chart options. There is no source or calculation change. US macro is a separate page.

Targeted offline tests are collected by `npm test`:

```sh
node --test js/__tests__/macro_optional.test.mjs
```

The separate browser fault/interaction test uses existing Playwright and sandboxed Chromium, and reuses the portable smoke server. See `TESTING.md` for dependency/runtime requirements.

```sh
node scripts/test_macro_browser.cjs --output /tmp/macro-qa-001
# Optional numeric comparison against a frozen actual working-tree baseline:
node scripts/test_macro_browser.cjs --before-root /absolute/path/to/before --output /tmp/macro-qa-002
```

Use a new output directory each run. Reports distinguish deliberately injected HTTP/network failures from unexpected console warnings/errors or page errors. Chromium desktop/390px emulation does not verify Safari, native touch or screen readers. Offline integration and the existing two-page regression remain separate commands in `TESTING.md`. Do not update market data to run these tests.
