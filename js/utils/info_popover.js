// Click-to-toggle ⓘ help: one click opens the explanation, a second click (or Esc / clicking elsewhere) closes it.
// Hover-only tooltips (utils/tooltip.js) are unreliable on touch and flash away; this is for per-control explanations.
import { tooltipPosition } from './tooltip.js';

let pop = null;
let current = null;
let wired = false;

export function closeInfoPopover() {
  if (current) { current.setAttribute('aria-expanded', 'false'); current.removeAttribute('aria-describedby'); }
  if (pop) pop.hidden = true;
  current = null;
}

function place() {
  if (!pop || !current) return;
  if (!current.isConnected || current.offsetParent === null) { closeInfoPopover(); return; }
  const at = tooltipPosition(current.getBoundingClientRect(), { width: pop.offsetWidth, height: pop.offsetHeight }, { width: innerWidth, height: innerHeight });
  if (!at) { closeInfoPopover(); return; }
  pop.style.left = `${at.left}px`;
  pop.style.top = `${at.top}px`;
}

export function toggleInfoPopover(button) {
  if (current === button) { closeInfoPopover(); return; }
  closeInfoPopover();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'info-pop';
    pop.id = 'info-popover';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document.body.append(pop);
  }
  current = button;
  pop.textContent = button.dataset.info || '';
  pop.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', pop.id);
  place();
}

/** Build a ⓘ button; `text` is plain text (set through textContent, never HTML). */
export function infoButton(text, label = '說明') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-pop-btn info-icon';
  button.textContent = 'ⓘ';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', 'false');
  button.dataset.info = text || '';
  return button;
}

/** Idempotent: wires delegated listeners once for every .info-pop-btn on the page. */
export function initInfoPopovers() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.info-pop-btn');
    if (button) { event.preventDefault(); toggleInfoPopover(button); return; }
    if (current && !(pop && pop.contains(event.target))) closeInfoPopover();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeInfoPopover(); });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('hashchange', closeInfoPopover);
}
