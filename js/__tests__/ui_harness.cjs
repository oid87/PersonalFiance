// UI click-through harness — behavioural equivalence check for frontend refactors.
//
// Visits every tab (discovered from the rendered category/sub-nav), then clicks every
// visible .chip in DOM order. After each step it records: every chip's data-* + active
// state, a sha1 of each ECharts instance's full series data / axes / dataZoom, and a sha1
// of the tab section's whole innerText. Page errors / console.error are collected per tab.
//
// Usage:
//   export PLAYWRIGHT_MODULE=<path to playwright>   # e.g. ~/.npm/_npx/<hash>/node_modules/playwright
//   git archive HEAD | tar -x -C /tmp/ui_base                       # baseline tree = HEAD
//   node js/__tests__/ui_harness.cjs /tmp/ui_base 8901 /tmp/base1.json
//   node js/__tests__/ui_harness.cjs /tmp/ui_base 8902 /tmp/base2.json   # must equal base1
//   node js/__tests__/ui_harness.cjs .           8903 /tmp/after.json   # working tree
//   cmp /tmp/base1.json /tmp/after.json
// Run the baseline twice first: tabs that differ between base1/base2 are nondeterministic
// and must be excluded from the comparison. Same data/ in both trees (data is not archived
// separately — git archive HEAD includes it). Takes ~5 min for all tabs.
//
// Known blind spots: chips hidden at click time are skipped (e.g. a view switch that hides
// other pickers); non-ECharts canvases and hover-only UI (tooltips) are not exercised.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const [, , rootDir, portArg, outJson] = process.argv;
if (!rootDir || !portArg || !outJson) {
  console.error('usage: node harness.cjs <rootDir> <port> <outJson>');
  process.exit(1);
}
const port = Number(portArg);

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const http = require('node:http');
      const req = http.get(url, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start in time'));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', rootDir], {
    stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${port}/index.html`, 15000);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    const errorsByTab = {}; // tabId -> [errors]
    let currentTabForErrors = '__boot__';
    errorsByTab[currentTabForErrors] = [];
    page.on('pageerror', e => {
      (errorsByTab[currentTabForErrors] ||= []).push({ type: 'pageerror', message: e.message });
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        (errorsByTab[currentTabForErrors] ||= []).push({ type: 'console.error', message: msg.text() });
      }
    });

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Discover every tab id by clicking through each category button and
    // collecting the rendered sub-nav's data-tab values (CATEGORIES itself
    // is a module-local const in boot.js, not exported).
    const catIds = await page.$$eval('.cat-btn', els => els.map(e => e.dataset.cat));
    const tabIds = [];
    const seen = new Set();
    for (const catId of catIds) {
      await page.click(`.cat-btn[data-cat="${catId}"]`);
      await page.waitForTimeout(150);
      const ids = await page.$$eval('#sub-nav .sub-btn', els => els.map(e => e.dataset.tab));
      for (const id of ids) if (!seen.has(id)) { seen.add(id); tabIds.push(id); }
    }

    const switcherHandle = await page.evaluateHandle(async () => {
      const mod = await import('/js/switcher.js');
      window.__switchTo = mod.switchTo;
      return true;
    });
    void switcherHandle;

    const result = { tabs: {} };

    const snapshotFn = async (tabId) => {
      return page.evaluate((tabId) => {
        function sha1(str) {
          // Minimal sync sha1 (sufficient for change-detection, not security).
          function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
          const utf8 = unescape(encodeURIComponent(str));
          const bytes = [];
          for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
          const bitLen = bytes.length * 8;
          bytes.push(0x80);
          while (bytes.length % 64 !== 56) bytes.push(0);
          for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
          let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
          for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
            const w = new Array(80).fill(0);
            for (let i = 0; i < 16; i++) {
              w[i] = (bytes[chunkStart + i * 4] << 24) | (bytes[chunkStart + i * 4 + 1] << 16) |
                     (bytes[chunkStart + i * 4 + 2] << 8) | (bytes[chunkStart + i * 4 + 3]);
            }
            for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
            let a = h0, b = h1, c = h2, d = h3, e = h4;
            for (let i = 0; i < 80; i++) {
              let f, k;
              if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
              else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
              else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
              else { f = b ^ c ^ d; k = 0xCA62C1D6; }
              const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
              e = d; d = c; c = rotl(b, 30); b = a; a = temp;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
          }
          const toHex = n => ('00000000' + (n >>> 0).toString(16)).slice(-8);
          return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
        }

        const section = document.getElementById('tab-' + tabId);
        if (!section) return { error: 'no-section' };

        const chips = Array.from(section.querySelectorAll('.chip')).map((c, i) => ({
          index: i,
          id: c.id || null,
          data: { ...c.dataset },
          active: c.classList.contains('active'),
        }));

        const chartEls = Array.from(section.querySelectorAll('[id]')).filter(el => {
          try { return !!(window.echarts && window.echarts.getInstanceByDom(el)); } catch { return false; }
        });
        const charts = chartEls.map(el => {
          const inst = window.echarts.getInstanceByDom(el);
          const opt = inst.getOption();
          const series = (opt.series || []).map(s => {
            const data = s.data || [];
            return { name: s.name ?? null, type: s.type ?? null, data };
          });
          const axisSummary = axArr => (axArr || []).map(a => ({ min: a.min ?? null, max: a.max ?? null, data: a.data ?? null }));
          const dz = (opt.dataZoom || []).map(z => ({ start: z.start ?? null, end: z.end ?? null }));
          const summary = { series, xAxis: axisSummary(opt.xAxis), yAxis: axisSummary(opt.yAxis), dataZoom: dz };
          return { id: el.id, sha1: sha1(JSON.stringify(summary)) };
        });

        const textEls = Array.from(section.querySelectorAll('.stat-card, table'));
        const texts = textEls.map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          sha1: sha1(el.innerText || ''),
        }));

        const sectionText = sha1(section.innerText || '');

        return { chips, charts, texts, sectionText };
      }, tabId);
    };

    for (const tabId of tabIds) {
      currentTabForErrors = tabId;
      errorsByTab[tabId] = [];
      await page.evaluate((id) => window.__switchTo(id), tabId);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);

      const steps = [];
      steps.push({ step: 0, action: 'init', snapshot: await snapshotFn(tabId) });

      const chipHandles = await page.$$(`#tab-${tabId} .chip`);
      let stepIdx = 1;
      for (const handle of chipHandles) {
        const visible = await handle.isVisible().catch(() => false);
        if (!visible) continue;
        const label = await handle.evaluate(el => ({
          tag: el.tagName.toLowerCase(), id: el.id || null, data: { ...el.dataset },
        })).catch(() => null);
        try {
          await handle.click({ timeout: 5000 });
        } catch (e) {
          steps.push({ step: stepIdx++, action: 'click-failed', target: label, error: String(e.message || e) });
          continue;
        }
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(500);
        steps.push({ step: stepIdx++, action: 'click', target: label, snapshot: await snapshotFn(tabId) });
      }

      result.tabs[tabId] = { steps, errors: errorsByTab[tabId] || [] };
    }

    await browser.close();
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
    console.log(`wrote ${outJson}: ${tabIds.length} tabs`);
  } finally {
    server.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
