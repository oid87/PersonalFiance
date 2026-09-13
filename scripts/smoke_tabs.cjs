/* Browser smoke test: npm install --no-save playwright && npx playwright install chromium
 * Start preview separately: python3 -m http.server 8765
 * Run: node scripts/smoke_tabs.cjs http://127.0.0.1:8765
 * Optional: BROWSER_CHANNEL=chrome, PLAYWRIGHT_MODULE=/path/to/playwright,
 * SMOKE_OUTPUT=/path/report.json, SMOKE_MOBILE=1. No data or source files are changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765';
const outPath = process.env.SMOKE_OUTPUT || 'smoke-report.json';
const mobile = process.env.SMOKE_MOBILE === '1';
const tableTabs = new Set(['cashking', 'earnings', 'tools']);
(async () => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  const errors = [], requests = [], checks = [];
  let current = 'startup';
  page.on('pageerror', e => errors.push({ tab: current, message: e.message }));
  page.on('console', m => {
    if ((m.type() === 'error' || (m.type() === 'warning' && /\[tabs\].*failed/.test(m.text()))) && !m.location().url.endsWith('/favicon.ico')) errors.push({ tab: current, message: m.text(), url: m.location().url });
  });
  page.on('response', r => { if (new URL(r.url()).origin === new URL(base).origin && /\/data\/.*\.json/.test(r.url())) requests.push({ tab: current, url: r.url(), status: r.status() }); });
  page.on('requestfailed', r => { if (!r.url().endsWith('/favicon.ico')) errors.push({ tab: current, message: r.failure()?.errorText, url: r.url() }); });
  try {
    await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => typeof window.echarts !== 'undefined');
    const categories = await page.locator('[data-cat]').evaluateAll(els => els.map(e => e.dataset.cat));
    const seen = new Set();
    for (const cat of categories) {
      await page.locator(`[data-cat="${cat}"]`).click();
      const tabs = await page.locator('.sub-btn').evaluateAll(els => els.map(e => ({ id: e.dataset.tab, label: e.textContent.trim() })));
      for (const tab of tabs) {
        current = tab.id;
        const startErrors = errors.length;
        await page.locator(`.sub-btn[data-tab="${tab.id}"]`).click();
        await page.waitForFunction(id => {
          const el = document.getElementById(`tab-${id}`);
          if (!el || el.hidden || el.getAttribute('aria-busy') === 'true') return false;
          const text = el.innerText;
          if (/載入中[….]|正在載入|Loading\.\.\./i.test(text)) return false;
          return el.querySelector('canvas, svg, table, .earn-grid, [role="alert"]') || text.length > 70;
        }, tab.id, { timeout: 25000 }).catch(e => errors.push({ tab: tab.id, message: `load timeout: ${e.message}` }));
        await page.waitForTimeout(300);
        const state = await page.evaluate(id => {
          const el = document.getElementById(`tab-${id}`);
          const charts = [...el.querySelectorAll('[_echarts_instance_]')].filter(x => x.clientWidth > 0 && x.clientHeight > 0).map(x => {
            const opt = echarts.getInstanceByDom(x)?.getOption();
            return { id: x.id, width: x.clientWidth, height: x.clientHeight, series: (opt?.series || []).map(s => ({ name: s.name || s.type, count: (s.data || []).length })) };
          });
          return { visible: !el.hidden, text: el.innerText.slice(0, 300), textLength: el.innerText.length, charts,
            requiredSourceErrors: id === 'marketstructure' ? ['cftc', 'cboe', 'liquidity', 'aaii', 'vix', 'putcall'].filter(key => {
              const label = el.querySelector(`#marketstructure-${key}-status`);
              return !label || label.classList.contains('is-error') || label.classList.contains('is-loading') || /來源更新失敗|尚無可用資料/.test(label.textContent);
            }) : [],
            hasTable: !!el.querySelector('table,.earn-grid'), alerts: [...el.querySelectorAll('[role="alert"]')].map(x => x.textContent),
            missingLabels: [...el.querySelectorAll('[role="status"], [id$="status"]')].map(x => x.textContent).filter(x => /暫無|未取得|無法取得|未接入|過期|較舊/.test(x)) };
        }, tab.id);
        const totalPoints = state.charts.reduce((sum, c) => sum + c.series.reduce((n, s) => n + s.count, 0), 0);
        const ok = state.visible && state.textLength > 0 && !state.alerts.length && !state.requiredSourceErrors.length &&
          (tab.id !== "marketstructure" || (state.charts.length === 3 && state.charts.every(c => c.series.some(s => s.count > 0)))) && (tableTabs.has(tab.id) ? state.hasTable : totalPoints > 0) && errors.length === startErrors;
        checks.push({ ...tab, ...state, totalPoints, ok, errors: errors.slice(startErrors) });
        seen.add(tab.id);
        console.log(`${ok ? 'PASS' : 'FAIL'} ${tab.id}: ${totalPoints} chart points`);
      }
    }
    const sections = await page.locator('.tab-section').count();
    if (seen.size !== sections) errors.push({ tab: 'wiring', message: `navigation ${seen.size} != sections ${sections}` });
    // Exercise every initialized chart under both themes and resizing, then revisit the new tab.
    for (let i = 0; i < 2; i++) { await page.locator('#theme-btn').click(); await page.waitForTimeout(200); }
    await page.setViewportSize(mobile ? { width: 844, height: 390 } : { width: 1200, height: 850 });
    await page.waitForTimeout(200);
    if (seen.has('marketstructure')) {
      await page.locator('[data-cat="analysis"]').click();
      await page.locator('.sub-btn[data-tab="marketstructure"]').click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: outPath.replace(/\.json$/, '.png'), fullPage: true });
    }
  } finally {
    const failedData = requests.filter(r => r.status >= 400);
    const result = { base, mobile, tabCount: checks.length, passed: checks.filter(c => c.ok).length, errors, failedData, checks, requests };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    await browser.close();
    if (errors.length || failedData.length || checks.some(c => !c.ok) || !checks.length) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
