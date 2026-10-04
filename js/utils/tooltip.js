const TOOLTIP_ID = 'shared-tooltip';

export function tooltipPosition(anchor, size, viewport) {
  if (anchor.bottom < 0 || anchor.top > viewport.height ||
      anchor.right < 0 || anchor.left > viewport.width) return null;
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - size.width / 2,
    viewport.width - size.width - 8));
  const top = anchor.top >= size.height + 12
    ? anchor.top - size.height - 8
    : Math.min(anchor.bottom + 8, viewport.height - size.height - 8);
  return { left, top: Math.max(8, top) };
}

export function initTooltips() {
  let tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) return;
  tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.className = 'shared-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);

  let host = null;
  let touchModeUntil = 0;

  function removeDescription(el) {
    if (!el) return;
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .filter(id => id !== TOOLTIP_ID);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function hide() {
    removeDescription(host);
    host = null;
    tooltip.hidden = true;
  }

  function place() {
    if (!host || !host.isConnected) { hide(); return; }
    const anchor = host.getBoundingClientRect();
    const pos = tooltipPosition(anchor, { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      { width: innerWidth, height: innerHeight });
    if (!pos) { hide(); return; }
    tooltip.style.left = `${pos.left}px`;
    tooltip.style.top = `${pos.top}px`;
  }

  function show(el) {
    const message = el?.getAttribute('data-tooltip');
    if (!message) { hide(); return; }
    if (host !== el) removeDescription(host);
    host = el;
    tooltip.textContent = message;
    tooltip.hidden = false;
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.includes(TOOLTIP_ID)) el.setAttribute('aria-describedby', [...ids, TOOLTIP_ID].join(' '));
    place();
  }

  document.addEventListener('mouseover', event => {
    const el = event.target.closest?.('[data-tooltip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', event => {
    if (performance.now() < touchModeUntil) return;
    if (host && event.target.closest?.('[data-tooltip]') === host &&
        !host.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', event => {
    const el = event.target.closest?.('[data-tooltip]');
    if (el) show(el);
  });
  document.addEventListener('focusout', event => {
    if (host && event.target === host) hide();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
  });
  document.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touchModeUntil = performance.now() + 1000;
    const el = event.target.closest?.('[data-tooltip]');
    if (el) show(el);
    else hide();
  });
  document.addEventListener('click', event => {
    if (performance.now() >= touchModeUntil) return;
    const el = event.target.closest?.('[data-tooltip]');
    if (el) show(el);
  });
  document.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
}
