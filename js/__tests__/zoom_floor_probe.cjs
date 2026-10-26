// Zoom-floor probe — 每一頁、每張圖的 x 軸 dataZoom 拉到最窄後，實際還看得到幾天。
//
// 逐頁切換（同 ui_harness.cjs 從導覽列找出所有 tab），初始狀態與每點一個可見的 .chip 之後，對每張圖的每個
// 控制 x 軸的 dataZoom 送 `dispatchAction({type:'dataZoom', start: 99.9, end: 100})`，再從 getOption() 讀回
// 實際視窗換算成日曆天數。整條資料本身不到門檻的圖不算（本來就只能看全部）。
//
// Usage:
//   node js/__tests__/zoom_floor_probe.cjs <rootDir> <port> <outJson> [minDays=365] [tabId ...]
// 輸出 {minDays, offenders: [{tab, step, chip, chart, zoom, days, dataDays}], checked}；有 offender 時 exit 1。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const [, , rootDir, portArg, outJson, minArg, ...onlyTabs] = process.argv;
if (!rootDir || !portArg || !outJson) {
  console.error('usage: node zoom_floor_probe.cjs <rootDir> <port> <outJson> [minDays] [tabId ...]');
  process.exit(2);
}
const port = Number(portArg);
const MIN_DAYS = Number(minArg || 365);

const waitForServer = (url, ms) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const once = () => http.get(url, r => { r.resume(); resolve(); }).on('error', () => (Date.now() > end ? reject(new Error('server timeout')) : setTimeout(once, 150)));
  once();
});

/** 在頁面裡跑：回傳這個 tab 每張圖、每個 x 軸 dataZoom 拉到最窄後的天數。 */
function measure(tabId) {
  const DAY = 86400000;
  const ms = v => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}(-\d{2})?/.test(v)) return null;
    const t = Date.parse(v.length === 7 ? v + '-01' : v.slice(0, 10));
    return Number.isFinite(t) ? t : null;
  };
  const section = document.getElementById('tab-' + tabId);
  if (!section) return [];
  const out = [];
  for (const el of section.querySelectorAll('div')) {
    let chart;
    try { chart = window.echarts.getInstanceByDom(el); } catch { chart = null; }
    if (!chart || chart.isDisposed?.() || !el.offsetParent) continue;
    const opt = chart.getOption();
    (opt.dataZoom || []).forEach((z, i) => {
      if (z.orient === 'vertical' || (z.yAxisIndex != null && (z.xAxisIndex == null || [].concat(z.xAxisIndex).length === 0))) return;
      const ax = (opt.xAxis || [])[[].concat(z.xAxisIndex ?? 0)[0] ?? 0];
      if (!ax) return;
      const cat = ax.type === 'category';
      const data = cat ? (ax.data || []).map(d => (d && typeof d === 'object' ? d.value : d)) : null;
      let full;
      if (cat) {
        const a = ms(data[0]), b = ms(data.at(-1));
        if (a == null || b == null) return;   // 非日期分類軸
        full = (b - a) / DAY;
      } else if (ax.type === 'time') {
        const xs = [];
        for (const s of opt.series || []) for (const p of s.data || []) { const v = Array.isArray(p) ? p[0] : p?.value?.[0] ?? p?.value; const t = ms(v); if (t != null) xs.push(t); }
        if (!xs.length) return;
        full = (Math.max(...xs) - Math.min(...xs)) / DAY;
      } else return;
      const before = { start: z.start, end: z.end };
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: i, start: 99.9, end: 100 });
      const nz = chart.getOption().dataZoom[i];
      let days;
      if (cat) {
        const a = ms(data[Math.round(nz.startValue)]), b = ms(data[Math.round(nz.endValue)]);
        days = a != null && b != null ? (b - a) / DAY : null;
      } else days = (nz.endValue - nz.startValue) / DAY;
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: i, start: before.start, end: before.end });
      out.push({ chart: el.id || el.className, zoom: i, type: z.type, axis: ax.type, days: days == null ? null : Math.round(days), dataDays: Math.round(full), minValueSpan: z.minValueSpan ?? null });
    });
  }
  return out;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', rootDir], { stdio: 'ignore' });
  const offenders = [], errors = [];
  let checked = 0;
  try {
    await waitForServer(`http://127.0.0.1:${port}/index.html`, 15000);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    let tabIds = onlyTabs;
    if (!tabIds.length) {
      tabIds = [];
      for (const cat of await page.$$eval('.cat-btn', els => els.map(e => e.dataset.cat))) {
        await page.click(`.cat-btn[data-cat="${cat}"]`);
        await page.waitForTimeout(120);
        for (const id of await page.$$eval('#sub-nav .sub-btn', els => els.map(e => e.dataset.tab))) if (!tabIds.includes(id)) tabIds.push(id);
      }
    }
    await page.evaluate(async () => { window.__switchTo = (await import('/js/switcher.js')).switchTo; });
    const record = (tab, step, chip, rows) => {
      for (const r of rows) {
        checked += 1;
        if (r.days == null || r.dataDays < MIN_DAYS) continue;
        if (r.days < MIN_DAYS - 3) offenders.push({ tab, step, chip, ...r });
      }
    };
    for (const tab of tabIds) {
      await page.evaluate(id => window.__switchTo(id), tab);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);
      // 有些圖捲到附近才畫（例如水溫走勢）：先把每張圖捲進畫面一次
      await page.evaluate(async id => { for (const el of document.querySelectorAll(`#tab-${id} div[id$="chart"]`)) { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); }, tab);
      await page.waitForTimeout(300);
      record(tab, 0, null, await page.evaluate(measure, tab));
      const chips = await page.$$(`#tab-${tab} .chip`);
      let step = 1;
      for (const h of chips) {
        if (!(await h.isVisible().catch(() => false))) continue;
        const label = await h.evaluate(el => el.textContent.trim().slice(0, 20)).catch(() => '?');
        try { await h.click({ timeout: 4000 }); } catch { continue; }
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(400);
        record(tab, step++, label, await page.evaluate(measure, tab));
      }
      process.stdout.write(`${tab} `);
    }
    await browser.close();
  } finally { server.kill(); }
  // 同一張圖同一個 zoom 只留最窄的一筆
  const worst = new Map();
  for (const o of offenders) { const k = `${o.tab}|${o.chart}|${o.zoom}`; if (!worst.has(k) || worst.get(k).days > o.days) worst.set(k, o); }
  const result = { minDays: MIN_DAYS, checked, offenders: [...worst.values()], pageErrors: errors.slice(0, 20) };
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.log(`\nchecked ${checked} zoom states; ${result.offenders.length} chart zooms narrower than ${MIN_DAYS} days → ${outJson}`);
  process.exit(result.offenders.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
