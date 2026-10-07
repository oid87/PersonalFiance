# Claude handoff — Cloud research tools, 2026-10-07

Start with [AGENT_RULES](AGENT_RULES.md), [TESTING](TESTING.md),
[scope/acceptance](docs/cloud-remaining-spec.md) and
[references/decisions](docs/references/remaining-dashboard.md).

## Repository and delivered implementation

Saved Cloud environment: `/workspace/PersonalFiance`; origin
`https://github.com/oid87/PersonalFiance.git`. Accepted feature checkpoint:
branch `agent/pf-cloud-browser-2026-10-07`; HEAD
`4b1d73fc9adc645957f55fc5108b35f4fd8878f9`; tree
`d938d10bbe1191e92f7c4345f3efeb4cf0381d76`.
Its base `7904738cc8fef78ae7b9dd64d3deed9e654fd9f1` is the direct data-only
successor of `63ecab26f76ba2ad4e7df864241247a8ab936747`;
100 data files changed in that successor, original non-data source identical.
The approved product and scoped CI changes were committed and pushed on that
feature branch. Independent GPT-6.1 Sol low acceptance of
[run37582576074](https://github.com/oid87/PersonalFiance/actions/runs/37582576074)
confirmed Python151, JavaScript345, pilot51/51 and tools14/14, strict console0,
served HTTP identity, sandboxed Chromium and cleanup.
The owner subsequently approved merging into `main` including its existing
automatic Vercel publication. The merge/deployment checkpoint must be verified
from current GitHub refs and exact-SHA runs; the accepted feature checkpoint
above does not claim later merged or published results. No market-data acquisition
or changes to data-refresh/stock-failure policy were authorized by this UI work.

Open [tools.html](tools.html) through an ordinary static server at this checkout
root. The dashboard tools section has one new link. No catalogue page was added.
The actual page provides group CRUD and local ticker-price selection, existing
leverage backtest/volatility controls, supplied monthly-return JSON presentation
and an unavailable macro-calendar status with official manual links. Synthetic
heatmap data is labeled, optional and not market data. No CDN/provider call is
needed by this tools page.

The subsequent authorized Taiwan observation panel presents stored TAIEX, TWSE
listed long-margin reconstruction, listed margin debt, monthly **period-end**
M1B/M2 YoY and stored **M1B − M2** percentage-point spread. Each row retains its own
observation date/month and file save stamp. Source-local failures, latest nulls
and inconsistent spread are explicit; retry reads existing local files only.
[Taiwan source/method notes](docs/references/taiwan-observations.md) are authoritative
for this panel. No official whole-account or MacroMicro listed+OTC series is connected.

Read-only event research used committed snapshots for 2024-08-05 and 2026-07-30.
Five-return proxy declines were −12.23pp / −23.09pp; respective prior-21 ratio-peak
declines were −30.46pp / −42.18pp. Same-anchor k varied from 1.162 to 3.142 across
the examined five-return/peak comparisons. Vendor volume units and original data
vintages remain unverified; concurrent debt shrinkage cannot prove forced liquidation.
The separately saved research package contains every session, formulas and source
hashes. It is research only: no permanent five/21-session peak policy, −30 threshold,
2× forecast, acceleration metric or washout-completion label was added to the product.

Volatility is shared with production `levvol.js`; no duplicated runtime formula.
[Legacy helper fixture](js/__tests__/fixtures/levvol-legacy-7904738.txt) contains
exact original source bytes for independent equivalence checks. Existing backtest
engine remains unchanged. Dates/basis and synthetic coverage are explicitly
separate between backtest and full-history volatility.

The product's pre-existing source edits are the dashboard anchor, production
volatility wrapper and its VM lifecycle-test import injection. Dated handoff/state
documents and scoped acceptance CI are also maintained. Added files are listed
in the exact review manifest. The
precise shared hunks are in `shared-integration.patch`; source/data hashes and
prior-candidate snapshots are packaged separately from live source.

## Local patch handoff still missing

Expected exact source materials:

- `taiwan-context-handoff/changes.patch`: 8 public overview files.
- `etf-atomic-changes.patch`: 9 public ETF files.
- `etf-private-remediated-local-only.zip`: 5 private files.
- `ETF_ATOMIC_HANDOFF.md`, `etf-atomic-qa/REPORT.md`: local evidence.

None has arrived/applied to Cloud. Do not recreate Taiwan/ETF code from prose or
report historic local test counts as Cloud results. The original local WIP repo
is excluded. Five private files stay outside public repository/site/artifacts;
inspect their actual manifest/rights before any approved local use. SEC request
403 and Taiwan issuer rights remain BLOCKED. No new financial acquisition.

## Remaining owner decisions

- Daily-price monthly conversion: endpoint convention, first month, missing month,
  current partial month, price/total-return basis and completeness. The supplied
  return heatmap is usable independently; it does not select these rules.
- Future macro feed: authoritative sources, licensing, UTC/source timezone,
  revision/coverage and actual/consensus/null contract. Current UI has zero events
  and `status: unavailable`.
- Exact local patch reconciliation: verify per-file hashes and shared hunks before
  applying; do not overwrite WIP or use reset/stash/clean to make it match.
- Local finance assistant: [final plan and read-only API contract](docs/references/local-finance-assistant.md),
  not installed. Qwen3-4B-Instruct-2507 Q4_K_M primary / Phi-4-mini-instruct backup.
  Assumed Mac mini M1 8GB/256GB unverified; measure actual hardware/RAM first.
  Deterministic calculations own facts/rules; model output is grounded 繁中 only.
  Loopback-only local access; Cloud cannot directly reach the Mac localhost API.

## Independent QA — select GPT-6.1 Sol low before execution

QA reads source/spec independently; no product mutation or softened assertions.
Source frozen hashes accompany the task. Preserve failed attempts and separate
unit/syntax/static evidence from actual UI verification. Browser launch must keep
`chromiumSandbox: true`; no `--no-sandbox` or environment/security bypass.

Existing approved task-local runtimes from prior QA:
Python 3.11.14 venv `/tmp/personalfiance-independent-qa-20261007/venv/bin`;
Node 22.23.3/npm10.9.9
`/tmp/personalfiance-independent-qa-20261007/node-v22.23.3-linux-x64/bin`;
repository Playwright 1.58.0 from unchanged lockfile. These paths are this Cloud
session's runtime evidence, not portable installation assumptions. Use scoped
PATH overrides only, never global configuration. Recheck real runtime versions.

Required checks after verifying origin/HEAD/tree/status and source manifest:

```sh
node --test js/__tests__/grouped_watchlists.test.mjs js/__tests__/leverage_diagnostics.test.mjs js/__tests__/monthly_return_heatmap.test.mjs js/__tests__/tools_contracts.test.mjs js/__tests__/taiwan_observations.test.mjs js/__tests__/levvol_lifecycle.test.mjs
python3 -B scripts/run_checks.py
npm test
python3 -B -m unittest discover -s scripts/tests -p 'test_agent_docs.py'
git diff --check
node --check scripts/test_tools_workspace_browser.cjs
node --check scripts/test_cloud_remaining_browser.cjs
node scripts/test_tools_workspace_browser.cjs --output /tmp/personalfiance-tools-browser-NEW
npm run test:browser -- --output /tmp/personalfiance-pilot-browser-NEW
```

Use fresh output directories; record commands/exit/cwd/runtime, before/after source
and data fingerprints, model identity, line/link/static wiring review. Full offline
runner covers discovered JS syntax/unit files plus Python and manifest, not browser
or data acquisition. The accepted remote checkpoint above is separate from this
portable command list; always report actual results for the current checkout.

Actual tools probe has 14 cases: dashboard link/entry, group CRUD/price selection,
reload persistence, malformed-storage session protection, monthly raw/null/zero/
partial/input/clear/retry, malformed-bundle retry/empty backtest window, missing
price retry, theme/mobile/landscape/short-height, synthetic page-transition handler
cleanup, macro unavailable, served checkout/data hashes and clean console/requests.
Taiwan cases cover six raw values, dates/units/proxy labels, independent source
failure, latest null, inconsistent spread and explicit retry. Injected fixtures
are labeled; normal source/data HTTP hashes
must equal disk. Synthetic page transitions do not prove native bfcache; Chromium
emulation does not prove Safari/native IME/screen reader/real touch. Earlier isolated
9-case probe remains available but does not replace this actual page probe.

Earlier Cloud QA had no working browser: pinned Playwright Chromium absent; authorized
normal download failed HTTP403 Domain forbidden from cdn.playwright.dev. Existing
system Chromium151 also failed normal sandbox startup. Prior failed reports are
preserved. Those blockers were subsequently resolved in GitHub Actions using
Ubuntu22.04 with the normal Chromium sandbox and explicit bash pipefail; no
security bypass was used. The first misleading green run and second failed
harness run remain recorded in the review package. If a later checkout has no
normal supported launch, its browser cases stay NOT RUN/BLOCKED;
zero console events before any page opened are not clean-UI evidence. No repeated
acquisition, alternate mirror or sandbox bypass is required to finish safe work.

## Review package and eventual local sync

Earlier candidate and QA archives remain immutable; this integrated revision has
its own frozen source/manifest/exact patches and fresh independent QA evidence.
The parent must reconcile exact incoming local public patches, preserve private
material separately and perform local smoke after transfer. Do not claim local
sync or final Taiwan/ETF integration complete until target bytes/evidence exist.
The current owner approval covers this feature merge and the existing automatic
Vercel publication. It does not authorize private ETF publication, excluded local
WIP overwrites or additional market-data acquisition. Local success still needs
separate WIP-preserving integration and actual local smoke evidence.

## Exact merged and published verification

The scoped acceptance workflow runs full offline checks, explicit npm/agent-doc
checks and sandboxed pilot/tools checks on feature and `main` push events.
`scripts/test_published_tools_browser.cjs --self-test --output <new-directory>`
checks the eight-case published-site probe against its own allowlisted localhost
server; that report is explicitly harness verification, not production evidence.
On `main`, the same probe waits for a successful Vercel status on the exact checked
out SHA, verifies all24 tools assets/data plus dashboard bytes against that
checkout and exercises the actual published tools UI in fresh browser storage.
Use `--url https://personal-fiance-nine.vercel.app --expected-sha <HEAD>
--output <new-directory>` for the published run. Zero console error/warning,
pageerror and failed requests are required. Traces/screenshots and failure reports
are always preserved. Safari/native IME/screen readers/physical touch, native
BFCache and the full72-page browser matrix remain outside these focused probes.
