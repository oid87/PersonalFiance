// bindOnce: idempotent one-time-bind guard using dataset.built.
// chipPicker: delegated single-select chip group click handler on a host element.

const pickerRegistry = new WeakMap();

export function bindOnce(el) {
  if (!el || el.dataset.built) return false;
  el.dataset.built = "1";
  return true;
}

export function chipPicker(host, attr, onPick, { onlyMatching = false } = {}) {
  if (!host) return;
  let attrs = pickerRegistry.get(host);
  if (!attrs) { attrs = new Set(); pickerRegistry.set(host, attrs); }
  if (attrs.has(attr)) return;
  attrs.add(attr);

  const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  host.addEventListener("click", e => {
    const t = e.target.closest(`.chip[data-${attr}]`);
    if (!t) return;
    const scope = onlyMatching ? host.querySelectorAll(`.chip[data-${attr}]`) : host.querySelectorAll(".chip");
    scope.forEach(c => c.classList.toggle("active", c === t));
    onPick(t.dataset[camel], t);
  });
}
