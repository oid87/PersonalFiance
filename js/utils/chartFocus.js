import { resizeVisibleCharts } from './chartLifecycle.js';

const PILOTS = [
  { chartId: 'chart', label: '趨勢圖表' },
  { chartId: 'stressdash-chart', label: '金融壓力圖表' },
];
const instances = new WeakMap();

function saveAttributes(element, names) {
  const values = names.map(name => [name, element.getAttribute(name)]);
  return () => {
    for (const [name, value] of values) {
      if (value == null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
  };
}

// Presentation only: the chart host, instance, options and financial state stay put.
export function initChartFocus({ document: doc = globalThis.document,
  window: win = globalThis.window, charts = PILOTS } = {}) {
  if (!doc?.body || !win) return null;
  if (instances.has(doc)) return instances.get(doc);
  const entries = [];
  let active = null;
  const frames = new Map();

  const otherDialogOpen = () => [...doc.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
    .some(dialog => dialog !== active?.section && !dialog.closest('[hidden]'));
  const resize = entry => {
    const chart = win.echarts?.getInstanceByDom(entry.host);
    resizeVisibleCharts(() => chart ? [chart] : [], entry.section);
  };
  function scheduleResize(entry) {
    if (frames.has(entry)) return;
    frames.set(entry, win.requestAnimationFrame(() => {
      frames.delete(entry);
      resize(entry);
      if (active !== entry) {
        entry.restoreTransition?.();
        entry.restoreTransition = null;
      }
    }));
  }

  function exit({ restoreFocus = true } = {}) {
    if (!active) return false;
    const entry = active;
    active = null;
    entry.section.classList.remove('chart-focus-section');
    entry.host.classList.remove('chart-focus-host');
    entry.toolbar.classList.remove('chart-focus-toolbar--active');
    entry.button.textContent = '放大圖表';
    entry.button.setAttribute('aria-expanded', 'false');
    entry.restoreAttributes();
    for (const restore of entry.restoreInert) restore();
    if (entry.overflow.value) doc.body.style.setProperty('overflow', entry.overflow.value, entry.overflow.priority);
    else doc.body.style.removeProperty('overflow');
    win.scrollTo({ left: entry.scroll.x, top: entry.scroll.y, behavior: 'instant' });
    if (restoreFocus && entry.returnFocus?.isConnected && !entry.returnFocus.closest('[hidden]')) {
      entry.returnFocus.focus({ preventScroll: true });
    }
    scheduleResize(entry);
    return true;
  }

  function enter(entry) {
    if (entry.section.hidden || otherDialogOpen()) return false;
    if (active === entry) return true;
    if (active) exit({ restoreFocus: false });
    entry.scroll = { x: win.scrollX, y: win.scrollY };
    entry.returnFocus = doc.activeElement === doc.body ? entry.button : doc.activeElement;
    entry.overflow = { value: doc.body.style.getPropertyValue('overflow'), priority: doc.body.style.getPropertyPriority('overflow') };
    if (!entry.restoreTransition) {
      const value = entry.host.style.getPropertyValue('transition');
      const priority = entry.host.style.getPropertyPriority('transition');
      entry.restoreTransition = () => value ? entry.host.style.setProperty('transition', value, priority)
        : entry.host.style.removeProperty('transition');
    }
    // The trend host normally animates height. Measure the final restored size,
    // not the first frame of that animation; restore its style after measurement.
    entry.host.style.setProperty('transition', 'none', 'important');
    entry.restoreAttributes = saveAttributes(entry.section, ['role', 'aria-modal', 'aria-label']);
    entry.restoreInert = [];
    // Keep the original subtree. Inert its siblings so keyboard/screen-reader
    // navigation cannot reach controls covered by the focused chart.
    const inert = element => {
      if (element.matches('dialog, script, style')) return;
      entry.restoreInert.push(saveAttributes(element, ['inert']));
      element.setAttribute('inert', '');
    };
    for (const child of entry.section.children) {
      if (child !== entry.host && child !== entry.toolbar) inert(child);
    }
    for (let branch = entry.section; branch !== doc.body && branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) if (sibling !== branch) inert(sibling);
    }
    active = entry;
    entry.section.setAttribute('role', 'dialog');
    entry.section.setAttribute('aria-modal', 'true');
    entry.section.setAttribute('aria-label', `${entry.label}放大檢視`);
    entry.section.classList.add('chart-focus-section');
    entry.host.classList.add('chart-focus-host');
    entry.toolbar.classList.add('chart-focus-toolbar--active');
    entry.button.textContent = '還原圖表';
    entry.button.setAttribute('aria-expanded', 'true');
    doc.body.style.setProperty('overflow', 'hidden');
    entry.button.focus({ preventScroll: true });
    scheduleResize(entry);
    return true;
  }

  for (const { chartId, label } of charts) {
    const host = doc.getElementById(chartId);
    const section = host?.closest('.tab-section');
    // The pilot's hosts are direct children; nested layouts need an explicit adapter.
    if (!section || host.parentElement !== section) continue;
    const toolbar = doc.createElement('div');
    toolbar.className = 'chart-focus-toolbar';
    const title = doc.createElement('span');
    title.className = 'chart-focus-title';
    title.textContent = label;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'chart-focus-button';
    button.textContent = '放大圖表';
    button.setAttribute('aria-label', `${label}：放大或還原`);
    button.setAttribute('aria-controls', chartId);
    button.setAttribute('aria-expanded', 'false');
    const hint = doc.createElement('span');
    hint.className = 'chart-focus-hint';
    hint.textContent = '按 Esc 還原';
    toolbar.append(title, hint, button);
    host.before(toolbar);
    const entry = { host, section, toolbar, button, label };
    button.addEventListener('click', () => active === entry ? exit() : enter(entry));
    entries.push(entry);
  }

  const reconcile = () => {
    if (active && (active.section.hidden || !active.host.isConnected || otherDialogOpen())) exit({ restoreFocus: false });
  };
  const onKey = event => {
    if (!active || event.defaultPrevented || event.isComposing || event.keyCode === 229 || otherDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exit();
    } else if (event.key === 'Tab') {
      const focusable = [active.button, ...active.host.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (doc.activeElement === first || !active.section.contains(doc.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (doc.activeElement === last || !active.section.contains(doc.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  };
  const onFocus = event => {
    reconcile();
    if (active && !active.section.contains(event.target)) active.button.focus({ preventScroll: true });
  };
  const onResize = () => { if (active) scheduleResize(active); };
  const observer = new win.MutationObserver(reconcile);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'open', 'aria-modal'] });
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('focusin', onFocus);
  win.addEventListener('resize', onResize);
  win.visualViewport?.addEventListener('resize', onResize);
  const api = {
    enter(chartId) { return entries.some(entry => entry.host.id === chartId && enter(entry)); },
    exit,
    get focusedChartId() { return active?.host.id || null; },
    destroy() {
      const focused = active;
      exit();
      for (const frame of frames.values()) win.cancelAnimationFrame(frame);
      frames.clear();
      observer.disconnect();
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('focusin', onFocus);
      win.removeEventListener('resize', onResize);
      win.visualViewport?.removeEventListener('resize', onResize);
      for (const entry of entries) {
        entry.toolbar.remove();
        entry.restoreTransition?.();
        entry.restoreTransition = null;
      }
      if (focused) resize(focused);
      instances.delete(doc);
    },
  };
  instances.set(doc, api);
  return api;
}
