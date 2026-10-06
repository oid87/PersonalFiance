// Tab dispatcher: selection changes immediately; activation and rendering may be async.
import { captureChartState, preserveChartState, resizeVisibleCharts, restoreChartState } from './utils/chartLifecycle.js';
import { clearRequestCacheForSignal } from './utils/data.js';

const tabs = [];
const activations = new Map();
const generations = new Map();
const ACTIVATION_TIMEOUT_MS = 20_000;

export function registerAll(list) { tabs.push(...list); }

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

function moduleFor(entry) { return entry.module || entry.loadedModule; }

async function resolveModule(entry) {
  const existing = moduleFor(entry);
  if (existing) return existing;
  const module = await entry.load();
  if (!module) throw new Error(`Tab ${entry.id} did not load a module`);
  entry.loadedModule = module;
  return module;
}

async function activateTab(id, section, entry, generation, controller) {
  showLoading(section);
  const isCurrent = () => generations.get(id) === generation && !controller.signal.aborted;
  const existingCharts = chartsFor(entry).map(chart => ({ host: chart.getDom?.(), state: captureChartState(chart) }));
  let timer;
  try {
    const run = Promise.resolve().then(async () => {
      const module = await resolveModule(entry);
      if (!isCurrent()) return;
      await (module.activate || module.init)?.({ signal: controller.signal, isCurrent });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("載入逾時，請重試"));
      }, entry.timeoutMs ?? ACTIVATION_TIMEOUT_MS);
    });
    await Promise.race([run, timeout]);
    if (isCurrent()) {
      const currentCharts = chartsFor(entry);
      resizeVisibleCharts(() => currentCharts, section);
      for (const [index, saved] of existingCharts.entries()) {
        const chart = currentCharts.find(candidate => candidate.getDom?.() === saved.host) || currentCharts[index];
        restoreChartState(chart, saved.state);
      }
      entry.activated = true;
      removeState(section);
    }
    return isCurrent();
  } catch (err) {
    clearRequestCacheForSignal(controller.signal);
    if (isCurrent() || (generations.get(id) === generation && controller.signal.aborted)) {
      showError(section, id, err);
      console.warn(`[tabs] ${id} activation failed`, err);
    }
    return false;
  } finally {
    clearTimeout(timer);
    if (generations.get(id) === generation) activations.delete(id);
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
  const generation = (generations.get(id) || 0) + 1;
  generations.set(id, generation);
  const controller = new AbortController();
  const activation = activateTab(id, section, entry, generation, controller);
  activations.set(id, activation);
  return activation;
}

function chartsFor(entry) {
  const module = moduleFor(entry);
  if (!module) return [];
  if (module.getCharts) return module.getCharts().filter(Boolean);
  const section = document.getElementById("tab-" + entry.id);
  if (!section || !globalThis.echarts?.getInstanceByDom) return [];
  return [...section.querySelectorAll("[_echarts_instance_]")]
    .map(el => globalThis.echarts.getInstanceByDom(el)).filter(Boolean);
}

export async function applyThemeAll(light) {
  await Promise.all(tabs.map(async entry => {
    const module = moduleFor(entry);
    const section = document.getElementById("tab-" + entry.id);
    if ((!entry.activated && !chartsFor(entry).length) || !module?.onThemeChange) return;
    try {
      await preserveChartState(() => chartsFor(entry), () => module.onThemeChange(light));
      resizeVisibleCharts(() => chartsFor(entry), section);
    } catch (err) { console.warn(`[tabs] ${entry.id} theme update failed`, err); }
  }));
}

export async function resizeAll() {
  await Promise.all(tabs.map(async entry => {
    const module = moduleFor(entry);
    const section = document.getElementById("tab-" + entry.id);
    if (section?.hidden) return;
    if ((!entry.activated && !chartsFor(entry).length) || !module?.resize) return;
    try {
      await preserveChartState(() => chartsFor(entry), () => module.resize());
      resizeVisibleCharts(() => chartsFor(entry), section);
    } catch (err) { console.warn(`[tabs] ${entry.id} resize failed`, err); }
  }));
}

export function setupResizeHandler() {
  if (window._resizeHandler) window.removeEventListener("resize", window._resizeHandler);
  window._resizeHandler = () => { void resizeAll(); };
  window.addEventListener("resize", window._resizeHandler);
}
