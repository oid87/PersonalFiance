// 全站 dataZoom 最小範圍：拖拉 slider 或滾輪縮放時，時間軸最短只能看到約 9 個月。
// 在 echarts.init 這個入口統一處理（boot.js 安裝一次），各 tab 不用各自設定；
// tab 自己寫了 minValueSpan／minSpan 的 dataZoom 不會被改。
// 只處理控制 x 軸的 dataZoom，且 x 軸是 time 軸，或資料是日期字串（YYYY-MM／YYYY-MM-DD）的 category 軸；
// 其他軸（數值、代號、年份數字）不動。category 軸依整條資料的平均密度換算成「約 9 個月有幾根」，
// 日、週、月頻都適用。資料本身比 9 個月短時，等於鎖在全部範圍。
export const MIN_ZOOM_DAYS = 270;   // 9 個月取 270 天（使用者指定，原本半年）。1M／3M／6M 這類按鈕是篩資料、不是縮放，不受影響
const DAY = 86400000;

const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const dateMs = v => {
  const raw = v && typeof v === 'object' ? v.value : v;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}(-\d{2})?/.test(raw)) return null;
  const t = Date.parse(raw.slice(0, 10));
  return Number.isFinite(t) ? t : null;
};

/** Minimum zoom span for one x axis, in that axis's own units (ms for time axes, category count for category axes). */
export function minSpanForAxis(axis, days = MIN_ZOOM_DAYS) {
  if (!axis) return null;
  if (axis.type === 'time') return days * DAY;
  if (axis.type && axis.type !== 'category') return null;
  const data = axis.data;
  if (!Array.isArray(data) || data.length < 3) return null;
  const a = dateMs(data[0]), b = dateMs(data.at(-1));
  if (a == null || b == null || a === b) return null;
  const span = Math.floor(((data.length - 1) / (Math.abs(b - a) / DAY)) * days);
  return span >= 2 ? span : null;
}

/** Copy of `option` with a ~9-month minValueSpan on each x-axis dataZoom that does not set its own minimum.
 *  getCurrent() is only called when the update carries dataZoom but no xAxis (a merge-style partial update). */
export function withZoomFloor(option, getCurrent = () => null, days = MIN_ZOOM_DAYS) {
  if (!option || typeof option !== 'object' || option.dataZoom == null) return option;
  const zooms = list(option.dataZoom);
  if (zooms.every(z => !z || z.minValueSpan != null || z.minSpan != null)) return option;
  const axes = option.xAxis != null ? list(option.xAxis) : list(getCurrent()?.xAxis);
  let changed = false;
  const out = zooms.map(z => {
    if (!z || z.minValueSpan != null || z.minSpan != null || z.orient === 'vertical') return z;
    if (z.yAxisIndex != null && z.xAxisIndex == null) return z;
    const idx = list(z.xAxisIndex ?? 0)[0] ?? 0;
    const span = minSpanForAxis(axes[idx], days);
    if (span == null) return z;
    changed = true;
    return { ...z, minValueSpan: span };
  });
  return changed ? { ...option, dataZoom: out } : option;
}

/** Wrap echarts.init so every chart's setOption goes through withZoomFloor. Safe to call more than once. */
export function installZoomFloor(ec = globalThis.echarts) {
  if (!ec || typeof ec.init !== 'function' || ec.__zoomFloor) return false;
  const init = ec.init;
  ec.init = function (...args) {
    const chart = init.apply(this, args);
    const setOption = chart.setOption;
    chart.setOption = function (option, ...rest) {
      return setOption.call(this, withZoomFloor(option, () => this.getOption()), ...rest);
    };
    return chart;
  };
  ec.__zoomFloor = true;
  return true;
}
