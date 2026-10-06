# Tab runtime contracts

## Data requests

`requestJSON(url, { signal, force = false, ttlMs = 300000, timeoutMs = 15000 } = {})` returns the complete parsed JSON payload. It rejects HTTP, malformed JSON, network, and timeout failures with a URL-bearing error. `fetchJSON(url, { raw })` retains its existing return shape (`payload.data || payload`, or complete payload when `raw: true`); `loadSeries` retains its parsed series contract.

The URL is resolved against `document.baseURI`. Concurrent calls for the same URL share one network request. Each consumer receives a deep clone. A consumer abort rejects only that consumer; it does not stop the shared fetch. A failed fetch leaves no pending or successful cache entry. A successful payload remains in the session cache for `ttlMs` measured from completion. `force: true` starts a new request; an older completion cannot replace its cache entry. `clearRequestCache(url?)` removes one URL or the complete cache for explicit refresh and tests. `clearRequestCacheForSignal(signal)` removes only entries used by an activation that failed payload validation; it checks entry identity so a late failure cannot evict a newer retry. The dispatcher calls it on activation failure. A call already in flight may still resolve to its own consumers after cache clearing.

Tabs must validate required payload fields and throw on missing or unusable required data. Optional sources should be caught locally, with an explicit partial-data status. Pass the activation signal to `requestJSON` and check `isCurrent()` before committing module state or rendering. Keep computed values local until all required data is valid. A module's own successful data cache remains independent of the five-minute request cache: once a tab has loaded, it uses its existing in-memory rows until that module implements explicit refresh.

## Tab registration and activation

`registerAll([{ id, module }])` remains valid. A registry entry may instead contain `load: () => Promise<module>` for lazy loading. A rejected loader is retried on the next activation. `switchTo(id)` selects the section and sub-nav button immediately and returns `Promise<boolean>`. The dispatcher calls `module.activate({ signal, isCurrent })` or `module.init({ signal, isCurrent })`, waits for its first render, and returns `false` with a retry button on rejection or timeout. Existing chart zoom and legend selections are restored after a successful reactivation, including when a tab was hidden during a theme change; a timed-out old generation cannot restore over the newer one. A late attempt cannot clear the current attempt's loading or error state. Modules that ignore the context still work, but cannot prevent their own late writes after timeout.

## Chart interaction state

`captureChartState(chart)` extracts dataZoom `id`/index and effective `start`, `end`, `startValue`, `endValue`, plus each legend's `selected` map. `restoreChartState(chart, state)` applies these controls to a new chart with ECharts actions, without replacing series, axes, colors, or other options. `preserveChartState(getCharts, update)` captures current instances, awaits `update`, reacquires instances, and restores by DOM host then index.

A migrated tab exports `getCharts()` returning its current ECharts instances and retains `onThemeChange(light)` and `resize()`. `applyThemeAll(light)` and `resizeAll()` invoke successfully activated tabs and tabs with already rendered chart instances, and preserve interactions. They return promises; callers may await completion when sequencing subsequent work. During migration, tabs without `getCharts()` are discovered from their section's `[_echarts_instance_]` elements via `echarts.getInstanceByDom`. This fallback has no effect on a tab that has never activated.
