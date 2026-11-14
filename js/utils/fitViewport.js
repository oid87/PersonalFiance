// 讓「一屏圖表」的高度＝視窗高度 − 圖表實際起始位置。
// 以前 CSS 寫死 calc(100vh - 194px …)，導覽列後來變成多層（分類／頁／視圖／控制列），
// 實際起點已到 250–520px，圖表底部（RSI/KD/縮放條）被推到螢幕外，大螢幕更明顯。
// 這裡在切頁與 resize 時量測元素在文件中的 top，寫進 --fit-top，CSS 用它算高度。
export const FIT_CHART_IDS = ['chart', 'penta-chart', 'macro-chart', 'corr-chart', 'sector-chart', 'breadth-chart'];

export function fitToViewport(root = document) {
  if (!root?.querySelector) return;
  for (const id of FIT_CHART_IDS) {
    const el = root.querySelector('#' + id);
    if (!el || !el.offsetParent) continue;   // 隱藏中的 tab 量不到，跳過
    const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
    el.style.setProperty('--fit-top', top + 'px');
  }
}
