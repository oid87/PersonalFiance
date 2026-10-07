import { requestJSON, clearRequestCacheForSignal } from './utils/data.js';
import { mountGroupedWatchlists } from './utils/grouped_watchlists_panel.mjs';
import { mountLeverageDiagnostics } from './tabs/leverage_diagnostics_panel.mjs';
import { mountMonthlyReturnHeatmap } from './tabs/monthly_return_heatmap_panel.mjs';
import { mountMacroCalendarStatus } from './utils/macro_calendar_status.mjs';
import { mountTaiwanObservations } from './utils/taiwan_observations_panel.mjs';
import { TOOL_INSTRUMENTS, diagnosticSettings, latestPrice, latestTask, SYNTHETIC_MONTHLY_DEMO } from './utils/tools_contracts.mjs';

const THEME_KEY = 'pf:tools-theme:v1';
export function mountToolsWorkspace(doc = document, { session } = {}) {
  const $ = id => doc.getElementById(id), disposables = [], listeners = [];
  const listen = (el, type, handler) => { el.addEventListener(type, handler); listeners.push(() => el.removeEventListener(type, handler)); };
  let storage;
  try { storage = doc.defaultView.localStorage; } catch { storage = null; }
  const theme = $('tools-theme');
  const setTheme = dark => { doc.body.classList.toggle('dark', dark); theme.textContent = dark ? '切換淺色' : '切換深色'; theme.setAttribute('aria-pressed', String(dark)); };
  try { setTheme(storage?.getItem(THEME_KEY) === 'dark'); } catch { setTheme(false); }
  if (session) setTheme(session.dark);
  listen(theme, 'click', () => {
    const dark = !doc.body.classList.contains('dark'); setTheme(dark);
    try { if (!storage) throw new Error('unavailable'); storage.setItem(THEME_KEY, dark ? 'dark' : 'light'); $('theme-status').textContent = ''; }
    catch { $('theme-status').textContent = '主題僅保留於本次畫面，瀏覽器儲存不可用。'; }
  });
  const quoteTask = latestTask(), bundleTask = latestTask(); disposables.push(quoteTask, bundleTask);
  const quoteSelect = $('quote-symbol'); quoteSelect.replaceChildren();
  for (const instrument of TOOL_INSTRUMENTS) { const option = doc.createElement('option'); option.value = instrument.key; option.textContent = instrument.label; quoteSelect.append(option); }
  let quoteKey = null;
  function showQuote(key, { force = false, focus = false } = {}) {
    const instrument = TOOL_INSTRUMENTS.find(item => item.key === key); if (!instrument) return;
    quoteKey = key; quoteSelect.value = key; $('quote-result').replaceChildren(); $('quote-status').textContent = `${key} · 讀取本地價格中…`;
    if (focus) $('quote-title').focus();
    return quoteTask.run(async signal => {
      try { return latestPrice(await requestJSON(instrument.file, { signal, force })); }
      catch (error) { clearRequestCacheForSignal(signal); throw error; }
    }, value => {
      $('quote-status').textContent = `${key} · 觀測日期 ${value.date} · 檔案更新 ${value.updated ?? '未提供'}`;
      const p = doc.createElement('p'); p.textContent = `檔案 close 原值：${value.close}（沿用既有檔案價格／調整口徑；非即時報價）`;
      const link = doc.createElement('a'); link.href = instrument.file; link.textContent = `查看 ${key} 的本地來源檔`;
      $('quote-result').append(p, link);
    }, error => { $('quote-status').textContent = `${key} · 無可用價格：${error.message}。可按查看／重試。`; });
  }
  listen($('quote-form'), 'submit', event => { event.preventDefault(); showQuote(quoteSelect.value, { force: true }); });
  const watchlists = mountGroupedWatchlists($('watchlist-host'), { instruments: TOOL_INSTRUMENTS, storage,
    initialValue: session?.watchlists, onSelect: key => showQuote(key, { focus: true }) });
  disposables.push(watchlists);
  let bundle = null, diagnostics = null;
  const form = $('leverage-form'), controls = $('leverage-controls'), retry = $('leverage-retry');
  const field = name => form.elements.namedItem(name);
  function renderDiagnostics() {
    if (!bundle) return;
    diagnostics?.destroy(); diagnostics = null; $('leverage-result').replaceChildren();
    try {
      const values = Object.fromEntries(['etf', 'from', 'to', 'initial', 'dcaAmount'].map(name => [name, field(name).value])); values.dca = field('dca').checked;
      const settings = diagnosticSettings(values, bundle.etfs.map(item => item.id));
      diagnostics = mountLeverageDiagnostics($('leverage-result'), { bundle, settings });
      $('leverage-status').textContent = `已讀取現有 leverage.json · 更新 ${bundle.updated ?? '未提供'}。`;
    } catch (error) { $('leverage-status').textContent = `診斷不可用：${error.message}。請調整設定或重新讀取資料。`; }
  }
  async function loadBundle() {
    const previous = field('etf').value;
    bundle = null; controls.disabled = true; retry.disabled = true;
    diagnostics?.destroy(); diagnostics = null; $('leverage-result').replaceChildren(); $('leverage-status').textContent = '正在讀取現有 leverage.json…';
    await bundleTask.run(async signal => {
      try {
        const value = await requestJSON('data/leverage.json', { signal, force: true });
        if (!Array.isArray(value?.etfs) || !value.etfs.length || !value.underlyings
          || !value.etfs.every(item => typeof item?.id === 'string' && Number.isFinite(item.leverage)
            && Array.isArray(item.real) && Array.isArray(value.underlyings[item.underlying]?.data)
            && value.underlyings[item.underlying].data.length)) throw new Error('本地 bundle 格式／標的資料不足');
        return value;
      } catch (error) { clearRequestCacheForSignal(signal); throw error; }
    }, value => {
      bundle = value; const select = $('leverage-etf'); select.replaceChildren();
      for (const item of bundle.etfs) { const option = doc.createElement('option'); option.value = item.id; option.textContent = `${item.id} · ${item.zh ?? item.underlying} · ${item.leverage}x`; select.append(option); }
      select.value = bundle.etfs.some(item => item.id === previous) ? previous : bundle.etfs.some(item => item.id === '00675L') ? '00675L' : bundle.etfs[0].id;
      controls.disabled = false; retry.disabled = false; renderDiagnostics();
    }, error => { retry.disabled = false; $('leverage-status').textContent = `本地槓桿資料不可用：${error.message}。可重新讀取。`; });
  }
  listen(form, 'submit', event => { event.preventDefault(); renderDiagnostics(); });
  listen(retry, 'click', loadBundle);
  let heatmap = null;
  const clearMonthly = () => { heatmap?.destroy(); heatmap = null; $('monthly-result').replaceChildren(); };
  const renderMonthly = () => {
    clearMonthly();
    try { heatmap = mountMonthlyReturnHeatmap($('monthly-result'), JSON.parse($('monthly-json').value)); $('monthly-status').textContent = heatmap.model.kind === 'synthetic' ? '已呈現合成示範，非市場資料。' : '已呈現提供的報酬；來源與計算說明由輸入者提供，未進行來源驗證。'; }
    catch (error) { $('monthly-status').textContent = `無法呈現：${error.message}。原輸入保留，請修正後重試。`; }
  };
  listen($('monthly-form'), 'submit', event => { event.preventDefault(); renderMonthly(); });
  listen($('monthly-demo'), 'click', () => { $('monthly-json').value = JSON.stringify(SYNTHETIC_MONTHLY_DEMO, null, 2); renderMonthly(); });
  listen($('monthly-clear'), 'click', () => { clearMonthly(); $('monthly-json').value = ''; $('monthly-status').textContent = '已清除。尚未提供月報酬。'; $('monthly-json').focus(); });
  disposables.push(mountMacroCalendarStatus($('macro-result')));
  disposables.push(mountTaiwanObservations($('taiwan-result')));
  if (session?.quoteKey) showQuote(session.quoteKey);
  if (session?.monthlyShown) renderMonthly();
  loadBundle();
  return { snapshot() { return { watchlists: watchlists.getState(), dark: doc.body.classList.contains('dark'),
    quoteKey, monthlyShown: Boolean(heatmap) }; },
    destroy() { listeners.forEach(remove => remove()); disposables.forEach(item => item.destroy()); diagnostics?.destroy(); clearMonthly(); } };
}

// pagehide guards late requests; persisted pageshow mounts exactly one set of handlers.
if (typeof document !== 'undefined' && document.getElementById('workspace')) {
  let mounted = mountToolsWorkspace(), session;
  window.addEventListener('pagehide', () => { if (mounted) session = mounted.snapshot(); mounted?.destroy(); mounted = null; });
  window.addEventListener('pageshow', () => { if (!mounted) mounted = mountToolsWorkspace(document, { session }); });
}
