// 全站 dataZoom 最小範圍：拖拉 slider 或滾輪縮放時，時間軸最短只能看到 1 年。
// 在 echarts.init 這個入口統一處理（boot.js 安裝一次），各 tab 不用各自設定；
// tab 自己寫了 minValueSpan／minSpan 的 dataZoom 不會被改。
// 只處理控制 x 軸的 dataZoom，且 x 軸是 time 軸，或資料是日期字串（YYYY-MM／YYYY-MM-DD）的 category 軸；
// 其他軸（數值、代號、年份數字）不動。category 軸取資料最密的 1 年有幾根當下限，
// 日、週、月頻與前後密度不同的資料（早年季資料、近年月資料）都適用。資料本身比 1 年短時，等於鎖在全部範圍。
// xAxisIndex 可以是數字、陣列或 'all'（取第一個能換算的日期軸）。只換 xAxis 資料、沒帶 dataZoom 的
// merge 更新（例如日／週／月頻切換）也會重算這裡加上的下限，否則舊的根數會沿用到新密度。
export const MIN_ZOOM_DAYS = 365;   // 1 年（使用者指定；原本半年 → 9 個月）。1M／3M／6M 這類按鈕是篩資料、不是縮放，不受影響
const DAY = 86400000;

const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const dateMs = v => {
  const raw = v && typeof v === 'object' ? v.value : v;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}(-\d{2})?/.test(raw)) return null;
  const t = Date.parse(raw.slice(0, 10));
  return Number.isFinite(t) ? t : null;
};

const spanCache = new WeakMap();   // data array → { days, span }；同一份資料重複 setOption 不重算

/** Most points that fit inside any `days`-long window of ascending timestamps (two pointers, O(n)). */
function densestCount(ts, days) {
  const w = days * DAY;
  let best = 0;
  for (let i = 0, j = 0; j < ts.length; j++) {
    while (ts[j] - ts[i] >= w) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

/** Minimum zoom span for one x axis, in that axis's own units (ms for time axes, category count for category axes).
 *  Category axes use the densest `days`-long stretch of the data, so data whose density changes over time
 *  (quarterly → monthly, weekly → daily) still shows at least `days` everywhere. */
export function minSpanForAxis(axis, days = MIN_ZOOM_DAYS) {
  if (!axis) return null;
  if (axis.type === 'time') return days * DAY;
  if (axis.type && axis.type !== 'category') return null;
  const data = axis.data;
  if (!Array.isArray(data) || data.length < 3) return null;
  const hit = spanCache.get(data);
  if (hit && hit.days === days) return hit.span;
  const a = dateMs(data[0]), b = dateMs(data.at(-1));
  let span = null;
  if (a != null && b != null && a !== b) {
    const ts = data.map(dateMs);
    const sorted = ts.every((t, i) => t != null && (i === 0 || t >= ts[i - 1]));
    const k = sorted ? densestCount(ts, days) : Math.floor(((data.length - 1) / (Math.abs(b - a) / DAY)) * days);
    span = k >= 2 ? k : null;   // k 根擠在 1 年內 → 跨 k 格（k+1 根）一定 ≥ 1 年
  }
  spanCache.set(data, { days, span });
  return span;
}

const axisIndices = (z, n) => (z.xAxisIndex === 'all' ? Array.from({ length: n }, (_, i) => i) : list(z.xAxisIndex ?? 0));
const spanFor = (z, axes, days) => {
  for (const i of axisIndices(z, axes.length)) {
    const span = minSpanForAxis(axes[i], days);
    if (span != null) return span;
  }
  return null;
};
const isXZoom = z => z && z.orient !== 'vertical' && !(z.yAxisIndex != null && z.xAxisIndex == null);

/** Copy of `option` with a 1-year minValueSpan on each x-axis dataZoom that does not set its own minimum.
 *  getCurrent() is only called when the update carries dataZoom but no xAxis (a merge-style partial update).
 *  `owned` (optional) = indices of dataZooms whose minimum this module set earlier; an update that carries xAxis but
 *  no dataZoom recomputes those, so a density change (daily ↔ weekly) does not keep the old bar count. */
export function withZoomFloor(option, getCurrent = () => null, days = MIN_ZOOM_DAYS, owned = null) {
  if (!option || typeof option !== 'object') return option;
  if (option.dataZoom == null) {
    if (!owned?.size || option.xAxis == null) return option;
    const axes = list(option.xAxis);
    // 只有帶日期資料的 category 軸會改變根數；其餘（例如只改 axisLabel、time 軸）不用讀 getOption()
    if (!axes.some(a => a && a.type !== 'time' && minSpanForAxis(a, days) != null)) return option;
    const zooms = list(getCurrent()?.dataZoom);
    let changed = false;
    const out = zooms.map((z, i) => {
      if (!owned.has(i) || !isXZoom(z)) return {};
      const span = spanFor(z, axes, days);
      if (span == null || span === z.minValueSpan) return {};
      changed = true;
      return { minValueSpan: span };
    });
    return changed ? { ...option, dataZoom: out } : option;
  }
  const zooms = list(option.dataZoom);
  zooms.forEach((z, i) => { if (z && (z.minValueSpan != null || z.minSpan != null)) owned?.delete(i); });
  if (zooms.every(z => !z || z.minValueSpan != null || z.minSpan != null)) return option;
  const axes = option.xAxis != null ? list(option.xAxis) : list(getCurrent()?.xAxis);
  let changed = false;
  const out = zooms.map((z, i) => {
    if (!z || z.minValueSpan != null || z.minSpan != null || !isXZoom(z)) return z;
    const span = spanFor(z, axes, days);
    if (span == null) return z;
    changed = true;
    owned?.add(i);
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
    const owned = new Set();
    chart.setOption = function (option, ...rest) {
      const opts = rest[0];
      if (opts === true || opts?.notMerge) owned.clear();
      return setOption.call(this, withZoomFloor(option, () => this.getOption(), MIN_ZOOM_DAYS, owned), ...rest);
    };
    return chart;
  };
  ec.__zoomFloor = true;
  return true;
}
