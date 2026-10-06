import { initTooltips } from './tooltip.js';

const MOMENTARY_CHIPS = new Set(['custom-ticker-btn', 'earn-prev', 'earn-next', 'mg-anchor-clear']);
const PRESSED_CLASSES = ['active', 'fear-on', 'fg-on', 'vix-on', 'vxn-on', 'ma125-on'];
const USMACRO_DETAILS = new Set(['六面向與補充證據', '通膨與信用背景', '觀察傳導鏈', '正式快照歷史']);
let initialized = false;

function syncChip(chip) {
  if (!chip.matches('.chip')) return;
  const native = chip.matches('button, a, input');
  if (!native && !chip.hasAttribute('role')) chip.setAttribute('role', 'button');
  if (!native && !chip.hasAttribute('tabindex')) chip.tabIndex = 0;
  if (!MOMENTARY_CHIPS.has(chip.id)) {
    const selected = ['series-picker', 'penta-ticker-picker'].includes(chip.parentElement?.id)
      ? !!chip.style.color : PRESSED_CLASSES.some(name => chip.classList.contains(name));
    chip.setAttribute('aria-pressed', String(selected));
  }
}

function enhanceNode(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.um-section') && node.parentElement?.id === 'usmacro-content') {
    const heading = node.querySelector(':scope > h3');
    if (heading && USMACRO_DETAILS.has(heading.textContent.trim())) {
      const details = document.createElement('details');
      details.className = 'ui-details';
      const summary = document.createElement('summary');
      summary.textContent = heading.textContent;
      heading.remove();
      node.before(details);
      details.append(summary, node);
    }
  }
  if (node.matches('.chip')) syncChip(node);
  for (const chip of node.querySelectorAll('.chip')) syncChip(chip);
  const tooltipHosts = node.matches('[data-tooltip]') ? [node] : [];
  tooltipHosts.push(...node.querySelectorAll('[data-tooltip]'));
  for (const host of tooltipHosts) {
    if (!host.matches('button, a, input, select, textarea, [tabindex]') &&
        !host.closest('[aria-hidden="true"]')) host.tabIndex = 0;
  }
}

export function initSharedUI() {
  if (initialized) return;
  initialized = true;
  initTooltips();
  enhanceNode(document.body);
  let chartTouch = null;
  document.addEventListener('touchstart', event => {
    const chart = event.touches.length === 1 && event.target.closest?.('[_echarts_instance_]');
    chartTouch = chart ? { chart, x: event.touches[0].clientX, y: event.touches[0].clientY, vertical: false } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => {
    if (!chartTouch || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - chartTouch.x;
    const dy = event.touches[0].clientY - chartTouch.y;
    if (chartTouch.vertical || Math.abs(dy) > Math.abs(dx) * 1.25) {
      event.stopPropagation();
      if (!chartTouch.vertical) {
        chartTouch.vertical = true;
        window.echarts?.getInstanceByDom(chartTouch.chart)?.dispatchAction({ type: 'hideTip' });
      }
    }
  }, { capture: true, passive: true });
  document.addEventListener('touchend', () => { chartTouch = null; }, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => { chartTouch = null; }, { capture: true, passive: true });
  document.addEventListener('keydown', event => {
    if (event.repeat || !['Enter', ' '].includes(event.key)) return;
    const chip = event.target.closest?.('.chip');
    if (!chip || !chip.matches('[role="button"]') || chip.matches('button, a, input')) return;
    if (event.target !== chip && event.target.closest?.('button, a, input, select, textarea')) return;
    event.preventDefault();
    chip.click();
  });
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName === 'class' && record.target.matches('.chip')) syncChip(record.target);
        if (record.attributeName === 'data-tooltip') enhanceNode(record.target);
      } else {
        for (const node of record.addedNodes) enhanceNode(node);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-tooltip'] });
}
