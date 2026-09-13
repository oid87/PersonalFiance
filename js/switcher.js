// Tab dispatcher — owns the tab registry and the cross-cutting resize/theme
// fan-outs. Each entry is { id, module } where module exports any of
// activate / init / onThemeChange / resize. Missing methods are skipped.

const tabs = [];
const activations = new Map();
const ACTIVATION_TIMEOUT_MS = 20_000;

export function registerAll(list) {
  tabs.push(...list);
}

function removeState(section) {
  section.removeAttribute("aria-busy");
  section.querySelector(".tab-loading-status")?.remove();
}

function showLoading(section) {
  section.querySelector(".tab-load-error")?.remove();
  section.setAttribute("aria-busy", "true");
  let status = section.querySelector(".tab-loading-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "status tab-loading-status";
    status.setAttribute("role", "status");
    status.textContent = "載入中…";
    section.appendChild(status);
  }
}

function showError(section, id, err) {
  removeState(section);
  section.querySelector(".tab-load-error")?.remove();
  const banner = document.createElement("div");
  banner.className = "status tab-load-error";
  banner.setAttribute("role", "alert");

  const message = document.createElement("span");
  message.textContent = `載入失敗：${err?.message || err}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重試";
  retry.addEventListener("click", () => { void switchTo(id); });
  banner.append(message, " ", retry);
  section.appendChild(banner);
}

async function activateTab(id, section, entry) {
  showLoading(section);
  let timer;
  try {
    const run = Promise.resolve().then(() =>
      (entry.module.activate || entry.module.init)?.());
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("載入逾時，請重試")), ACTIVATION_TIMEOUT_MS);
    });
    await Promise.race([run, timeout]);
    removeState(section);
    return true;
  } catch (err) {
    showError(section, id, err);
    console.warn(`[tabs] ${id} activation failed`, err);
    return false;
  } finally {
    clearTimeout(timer);
    activations.delete(id);
  }
}

export async function switchTo(id) {
  const section = document.getElementById("tab-" + id);
  const entry = tabs.find(t => t.id === id);
  if (!section || !entry) return false;

  document.querySelectorAll(".tab-section").forEach(s => { s.hidden = true; });
  section.hidden = false;
  document.querySelectorAll(".sub-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === id));

  const pending = activations.get(id);
  if (pending) return pending;
  const activation = activateTab(id, section, entry);
  activations.set(id, activation);
  return activation;
}

export function applyThemeAll(light) {
  for (const { id, module } of tabs) {
    try {
      Promise.resolve(module.onThemeChange?.(light)).catch(err =>
        console.warn(`[tabs] ${id} theme update failed`, err));
    } catch (err) {
      console.warn(`[tabs] ${id} theme update failed`, err);
    }
  }
}

export function resizeAll() {
  for (const { id, module } of tabs) {
    try {
      Promise.resolve(module.resize?.()).catch(err =>
        console.warn(`[tabs] ${id} resize failed`, err));
    } catch (err) {
      console.warn(`[tabs] ${id} resize failed`, err);
    }
  }
}

export function setupResizeHandler() {
  if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
  window._resizeHandler = () => resizeAll();
  window.addEventListener("resize", window._resizeHandler);
}
