// Preserve user interactions while a tab recreates or resizes its ECharts instances.
const ZOOM_FIELDS = ["start", "end", "startValue", "endValue"];

export function captureChartState(chart) {
  if (!chart || chart.isDisposed?.()) return null;
  const option = chart.getOption?.();
  if (!option) return null;
  return {
    zoom: (option.dataZoom || []).map((zoom, index) => {
      const result = { index, id: zoom.id };
      for (const key of ZOOM_FIELDS) if (zoom[key] != null) result[key] = zoom[key];
      return result;
    }),
    legend: (option.legend || []).map((legend, index) => ({
      index, id: legend.id, selected: { ...(legend.selected || {}) },
    })),
  };
}

export function restoreChartState(chart, state) {
  if (!chart || chart.isDisposed?.() || !state) return;
  const option = chart.getOption?.();
  if (!option) return;
  for (const saved of state.zoom) {
    const index = saved.id == null ? saved.index : (option.dataZoom || []).findIndex(z => z.id === saved.id);
    if (index < 0 || index >= (option.dataZoom || []).length) continue;
    const action = { type: "dataZoom", dataZoomIndex: index };
    for (const key of ZOOM_FIELDS) if (Object.hasOwn(saved, key)) action[key] = saved[key];
    if (ZOOM_FIELDS.some(key => Object.hasOwn(action, key))) chart.dispatchAction(action);
  }
  for (const saved of state.legend) {
    const index = saved.id == null ? saved.index : (option.legend || []).findIndex(l => l.id === saved.id);
    if (index < 0 || index >= (option.legend || []).length) continue;
    for (const [name, selected] of Object.entries(saved.selected)) {
      chart.dispatchAction({ type: selected ? "legendSelect" : "legendUnSelect", legendIndex: index, name });
    }
  }
}

export async function preserveChartState(getCharts, update) {
  const before = (getCharts() || []).map(chart => ({ host: chart.getDom?.(), state: captureChartState(chart) }));
  const result = await update();
  const after = getCharts() || [];
  for (const [index, saved] of before.entries()) {
    const next = after.find(chart => chart.getDom?.() === saved.host) || after[index];
    restoreChartState(next, saved.state);
  }
  return result;
}

// ECharts measures its host when an instance is created. A chart created or
// resized while its tab is hidden can retain a zero-width canvas on reentry.
export function resizeVisibleCharts(getCharts, section) {
  if (!section || section.hidden) return;
  for (const chart of getCharts() || []) {
    if (!chart || chart.isDisposed?.()) continue;
    const host = chart.getDom?.();
    if (!host || !section.contains?.(host)) continue;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0 &&
        (chart.getWidth?.() !== width || chart.getHeight?.() !== height)) {
      chart.resize();
    }
  }
}
