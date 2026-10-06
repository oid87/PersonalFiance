# GitHub main integration — 2026-10-07

The user explicitly authorized merging to `main` on 2026-10-07 and stopping after merge and necessary verification. This supersedes the earlier independent-branch-only instruction for this integration. The [Mac transfer](mac-wip-2026-10-06.md) and [path manifest](mac-wip-2026-10-06.json) remain dated preservation records.

## Provenance and boundary

- Main input: `fdef064acb15891cd7f55a91c084a59792b4bb17`.
- Reviewed WIP input: `fc58f76c49853c4a0ac4d4010470fe80582a0c39`.
- Common ancestor: `5fcea8c43ebd472c27b9909f66bff6313f8dee7b`.
- Integration branch: `agent/pf-main-integration-2026-10-07` in a separate clean clone; original Mac checkout stays on its WIP branch.
- Incoming history: 30 engineering baseline commits plus the selective WIP transfer. The merge was conflict-free; the 201 incoming paths include the preserved baseline, not just the 45 newly selected WIP paths.
- Every `data/` blob remains identical to main input. No original Mac data refresh, archive, cache or deferred source was imported. GitHub merge should preserve ancestry rather than squash/rebase the reviewed history.
- Original 171 deferred paths, index and branch are retained. Original product SHA256 inventory remains `f3b3a96f012f378db78dd687a210f5635e87c34777dec49981d1c7637551b7bb`.

## CI test isolation

The previous WIP CI run `37485518920` failed one Node 22 stressdash retry test: TAP124, declaration line179, assertion line193, application-console spy count1 rather than0. The captured argument was absent from that log, so its exact warning/error payload is not established.

The test helper mutated Node's native Console.error before dynamic import. Node's runtime warning logger retains that native Console and lazily caches its error method. The helper now installs a separate global application-console spy, preserves the native logger, and restores the original global console even if import fails. Existing application-error assertions are unchanged; the retry assertion gains a diagnostic message. Production code and financial methods are unchanged by this fix.

A regression directly checks native logger identity while the spy is active, observes an emitted runtime warning, checks zero captured application errors, then proves a real application console.error is still captured. The regression fails against the old helper at logger identity and passes with the isolated helper. This does not depend on whether a prior warning primed Node's internal warning cache.

## Candidate verification

- Local Python3.13.2 / Node25.4.0: `python3 scripts/run_checks.py` passes151 Python and322 JavaScript tests, zero skipped. Isolated stressdash suite passes34/34.
- `python3 scripts/validate_data.py`: PASS, 140 root JSON files plus JSONL/macro archive contracts. `python3 scripts/validate_forward_pe.py`: PASS.
- Existing Playwright1.58.0 / Chromium145.0.7632.6: fixed-clock desktop normal-data activation of all72 registered pages passes72/72; console errors/warnings/pageerrors and HTTP/disk identity mismatches are zero. This is normal-load coverage, not every chip/fault/abort interaction.
- Existing portable trend/stressdash browser suite:51/51 PASS on desktop/mobile, zero console and request failures, browser/server cleanup complete.
- The all-page probe initially could not serve forward-P/E JSONL because the existing two-page preview helper rejects that extension. The local probe copied the helper in memory and added JSONL MIME support; no product source was changed. The failed attempt is retained locally.
- New integration-only diff passes whitespace checks. The aggregate incoming history has five inherited trailing-blank-line findings (including verbatim legacy oracle fixtures); those bytes/hashes and the whitespace-check policy are preserved, not trimmed or relaxed for this merge.
- Node22 / Python3.11 GitHub offline checks are required to pass on the exact PR head before main merge. PR checks and merge metadata carry the final CI/commit identity; local results are not a substitute for that gate.

## Remaining limits and stop boundary

The previously reviewed P2 stale-activation/global-cache cleanup concerns in emfsi/marginglobal and optional-source warning behavior in usmacro remain disclosed. Normal-load and two-page interaction checks do not verify all concurrent/fault paths. Native macOS IME, physical Safari/touch and screen-reader coverage remain unverified.

No Phase0/1 work, market fetch, schedule modification or manual deployment is part of this integration. Existing GitHub/main-connected automation is not reconfigured. After PR merge, verify the actual main SHA/tree, ancestry, immediate premerge main data and original Mac fingerprints, then stop. Do not reset/clean/pull the original dirty checkout.

Local verification evidence is retained under `/Users/orangembpm2/work/code/personal_financial/qa-artifacts/github-main-integration-2026-10-07`; private Mac preservation archives/configuration are not uploaded.
