// Tab dispatcher — owns the tab registry and the cross-cutting resize/theme
// fan-outs. Each entry is { id, module } where module exports any of
// activate / init / onThemeChange / resize. Missing methods are skipped.

const tabs = [];

export function registerAll(list) {
  tabs.push(...list);
}

export function switchTo(id) {
  document.querySelectorAll(".tab-section").forEach(s => { s.hidden = true; });
  const section = document.getElementById("tab-" + id);
  if (section) section.hidden = false;
  document.querySelectorAll(".sub-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === id));
  const entry = tabs.find(t => t.id === id);
  if (!entry) return;
  (entry.module.activate || entry.module.init)?.();
}

export function applyThemeAll(light) {
  for (const { module } of tabs) module.onThemeChange?.(light);
}

export function resizeAll() {
  for (const { module } of tabs) module.resize?.();
}

export function setupResizeHandler() {
  if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
  window._resizeHandler = () => resizeAll();
  window.addEventListener("resize", window._resizeHandler);
}
